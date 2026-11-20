// Run with Java 21+, official Mojang-mapped 1.21.10 client and its libraries on the classpath.
// Arguments: original client.jar, output model JSON, output auxiliary texture JSON.
import com.google.gson.*;
import net.minecraft.client.model.*;
import net.minecraft.client.model.geom.*;
import net.minecraft.client.model.geom.builders.*;
import org.joml.Vector3fc;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import java.lang.reflect.*;

class MinecraftEntityModels {
  static Object field(Object o,String name) throws Exception {
    Field f=o.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(o);
  }
  static Map<String,Object> parts(PartDefinition parent) throws Exception {
    Map<String,Object> result=new TreeMap<>();
    for(var child:parent.getChildren()) {
      PartDefinition p=child.getValue(); PartPose pose=(PartPose)field(p,"partPose");
      var boxes=new ArrayList<Map<String,Object>>();
      for(var c:(List<?>)field(p,"cubes")) {
        var uv=(UVPair)field(c,"texCoord");
        var pos=(Vector3fc)field(c,"origin"); var dim=(Vector3fc)field(c,"dimensions");
        Object grow=field(c,"grow");
        var box=new LinkedHashMap<String,Object>();
        box.put("u",uv.u()); box.put("v",uv.v());
        box.put("x",pos.x()); box.put("y",pos.y()); box.put("z",pos.z());
        box.put("dx",dim.x()); box.put("dy",dim.y()); box.put("dz",dim.z());
        box.put("dil",List.of(field(grow,"growX"),field(grow,"growY"),field(grow,"growZ")));
        box.put("mirror",field(c,"mirror")); boxes.add(box);
      }
      var part=new LinkedHashMap<String,Object>();
      part.put("pivot",List.of(pose.x(),pose.y(),pose.z()));
      part.put("rot",List.of(pose.xRot(),pose.yRot(),pose.zRot()));
      part.put("scale",List.of(pose.xScale(),pose.yScale(),pose.zScale()));
      part.put("cuboids",boxes); part.put("children",parts(p)); result.put(child.getKey(),part);
    }
    return result;
  }
  public static void main(String[] args) throws Exception {
    var models=new TreeMap<String,Object>(); var paintings=new TreeMap<String,Object>(); var png=new TreeMap<String,String>();
    for(String id:List.of("Arrow","EndCrystal","EvokerFangs","LeashKnot","LlamaSpit","ShulkerBullet","Trident","WindCharge","WitherSkull","Player","PlayerSlim")) {
      LayerDefinition layer;
      if(id.startsWith("Player")) layer=LayerDefinition.create(PlayerModel.createMesh(CubeDeformation.NONE,id.endsWith("Slim")),64,64);
      else if(id.equals("WitherSkull")) layer=net.minecraft.client.renderer.entity.WitherSkullRenderer.createSkullLayer();
      else {
        Method method=Arrays.stream(Class.forName("net.minecraft.client.model."+id+"Model").getDeclaredMethods())
          .filter(m->m.getParameterCount()==0 && m.getReturnType()==LayerDefinition.class).findFirst().orElseThrow();
        layer=(LayerDefinition)method.invoke(null);
      }
      var mesh=(MeshDefinition)field(layer,"mesh"); Object mat=field(layer,"material");
      var model=new LinkedHashMap<String,Object>();
      model.put("w",field(mat,"xTexSize"));model.put("h",field(mat,"yTexSize"));
      model.put("parts",parts(mesh.getRoot()));models.put(id,model);
    }
    try(var zip=new ZipFile(args[0])) {
      for(var e:Collections.list(zip.entries())) {
        String name=e.getName(), prefix="assets/minecraft/textures/";
        if(name.startsWith("data/minecraft/painting_variant/") && name.endsWith(".json")){
          var descriptor=JsonParser.parseString(new String(zip.getInputStream(e).readAllBytes(),java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
          String key=name.substring(name.lastIndexOf('/')+1,name.length()-5);
          paintings.put(key,List.of(descriptor.get("asset_id").getAsString(),descriptor.get("width").getAsInt(),descriptor.get("height").getAsInt()));
        }
        if(name.startsWith(prefix) && name.endsWith(".png")){
          String key=name.substring(prefix.length(),name.length()-4);
          if(key.startsWith("painting/") || Set.of("particle/effect_0").contains(key))
            png.put(key,Base64.getEncoder().encodeToString(zip.getInputStream(e).readAllBytes()));
        }
      }
    }
    var gson=new GsonBuilder().disableHtmlEscaping().create();
    var ids=Arrays.stream(net.minecraft.world.entity.EntityType.class.getDeclaredFields()).filter(f->Modifier.isStatic(f.getModifiers()) && f.getType()==net.minecraft.world.entity.EntityType.class).map(f->f.getName().toLowerCase(Locale.ROOT)).sorted().toList();
    var data=new LinkedHashMap<String,Object>(); data.put("entityIds",ids); data.put("models",models);data.put("paintings",paintings);
    Files.writeString(Path.of(args[1]),gson.toJson(data)+"\n"); Files.writeString(Path.of(args[2]),gson.toJson(png)+"\n");
  }
}
