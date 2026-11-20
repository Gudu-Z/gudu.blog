// Model layers and painting sizes come from the installed Java 1.21.10 client.
// The block and item paths use the same resolvers and resource stack as the schematic.
import * as THREE from 'three';
import definitions from './mc-special-models-1.21.10.json';
import { BlockModelResolver } from '@lwv/blocks.js';
import { buildEquippedItem, quadsToMesh } from '@lwv/entities.js';
import { createEntityModelMesh } from '@lwv/entityModel.js';

const { models, paintings } = definitions;
const rad = Math.PI / 180;
const strip = name => typeof name === 'string' ? name.replace(/^minecraft:/, '') : '';
const material = (map, options) => new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide, alphaTest: .1, ...options });
const groupAt = entity => { const root = new THREE.Group(); root.position.fromArray(entity.pos); return root; };

// Keep model-part pivots, scaling and UVs. The viewer converts cuboids to world
// axes when compiling a model, so undo that conversion once before parenting.
const partTemplates = new WeakMap();
function vanillaModel(recipe, mat) {
  function build(parts, parent) {
    for (const [name, part] of Object.entries(parts)) {
      const node = new THREE.Group();
      node.name = name;
      node.position.fromArray(part.pivot).multiplyScalar(1 / 16);
      node.rotation.set(...part.rot, 'ZYX');
      node.scale.fromArray(part.scale);
      if (part.cuboids.length) {
        let template = partTemplates.get(part);
        if (!template) {
          template = { w: recipe.w, h: recipe.h, parts: { body: { cuboids: part.cuboids } } };
          partTemplates.set(part, template);
        }
        const mesh = createEntityModelMesh(template, mat);
        // Entity model geometries may be shared by the viewer; keep this transform on the mesh.
        mesh.scale.set(1, -1, -1);
        mesh.position.y = 1.5;
        node.add(mesh);
      }
      parent.add(node);
      build(part.children, node);
    }
  }
  const root = new THREE.Group();
  build(recipe.parts, root);
  return root;
}

const layers = {
  arrow: ['Arrow', 'entity/projectiles/arrow'],
  spectral_arrow: ['Arrow', 'entity/projectiles/spectral_arrow'],
  trident: ['Trident', 'entity/trident'],
  end_crystal: ['EndCrystal', 'entity/end_crystal/end_crystal'],
  evoker_fangs: ['EvokerFangs', 'entity/illager/evoker_fangs'],
  leash_knot: ['LeashKnot', 'entity/lead_knot'],
  llama_spit: ['LlamaSpit', 'entity/llama/spit'],
  shulker_bullet: ['ShulkerBullet', 'entity/shulker/spark'],
  wither_skull: ['WitherSkull', 'entity/wither/wither'],
  breeze_wind_charge: ['WindCharge', 'entity/projectiles/wind_charge'],
  wind_charge: ['WindCharge', 'entity/projectiles/wind_charge'],
};

async function projectileOrDecoration(id, n, rotation, assets) {
  const [recipe, base] = layers[id], [yaw, pitch] = rotation;
  let key = base;
  if (id === 'arrow' && (n.Color != null && n.Color !== -1 || n.item?.components?.['minecraft:potion_contents'])) key = 'entity/projectiles/tipped_arrow';
  if (id === 'wither_skull' && n.dangerous) key = 'entity/wither/wither_invulnerable';
  const model = vanillaModel(models[recipe], material(await assets.getTexture(key)));
  if (['arrow', 'spectral_arrow', 'llama_spit', 'trident'].includes(id)) {
    model.rotation.set(0, (yaw - 90) * rad, (pitch + (id === 'trident' ? 90 : 0)) * rad, 'YXZ');
    if (id === 'llama_spit') model.position.y = .15;
  } else if (id === 'end_crystal') {
    model.scale.setScalar(2);
    model.position.y = -1;
    model.getObjectByName('base').visible = !!(n.ShowBottom ?? n.show_bottom ?? true);
    model.getObjectByName('outer_glass').position.y -= .55;
    const axis = new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2);
    for (const name of ['outer_glass','inner_glass','cube']) model.getObjectByName(name)?.rotateOnAxis(axis, Math.PI / 3);
  } else if (id === 'evoker_fangs') {
    model.rotation.y = (90 - yaw) * rad;
    model.scale.set(-1,-1,1);
    model.position.y = 1.501;
  } else if (id === 'leash_knot' || id === 'wither_skull') {
    model.scale.set(-1,-1,1);
    if (id === 'wither_skull') model.getObjectByName('head').rotation.set(pitch * rad, yaw * rad, 0, 'YXZ');
  } else if (id === 'shulker_bullet') {
    model.position.y = .15;
    model.scale.set(-.5,-.5,.5);
    model.rotation.set(pitch * rad, -yaw * rad, 0, 'YXZ');
  }
  return model;
}

async function blockBody(state, assets, origin) {
  const name = typeof state === 'string' ? state : state?.Name ?? state?.name;
  if (!name || strip(name) === 'air') return null;
  const baked = await new BlockModelResolver(assets).resolve(name, state.Properties ?? state.properties ?? {});
  if (!baked?.quads?.length) return null;
  const materials = new Map();
  await Promise.all([...new Set(baked.quads.map(q => q.texKey))].map(async key => {
    const map = await assets.getTexture(key);
    if (map) materials.set(key, material(map, { vertexColors: true, transparent: !!baked.translucent }));
  }));
  return quadsToMesh(baked.quads, origin, key => materials.get(key), true);
}

async function itemBody(stack, assets, context) {
  const item = typeof stack === 'string' ? { id: stack } : stack;
  if (!item?.id || strip(item.id) === 'air' || item.count === 0 || item.Count === 0) return null;
  return buildEquippedItem(item, assets, context);
}

function displayTransform(holder, t) {
  if (Array.isArray(t) && t.length === 16 && t.every(Number.isFinite)) {
    holder.matrix.set(...t);
    holder.matrixAutoUpdate = false;
  } else if (t && typeof t === 'object') {
    const left = new THREE.Quaternion().fromArray(t.left_rotation ?? [0,0,0,1]);
    const right = new THREE.Quaternion().fromArray(t.right_rotation ?? [0,0,0,1]);
    holder.matrix.compose(new THREE.Vector3().fromArray(t.translation ?? [0,0,0]), left,
      new THREE.Vector3().fromArray(t.scale ?? [1,1,1])).multiply(new THREE.Matrix4().makeRotationFromQuaternion(right));
    holder.matrixAutoUpdate = false;
  }
  holder.matrixWorldNeedsUpdate = true;
}

function displayFacing(pivot, mode) {
  if (!['center','horizontal','vertical'].includes(mode)) return;
  const world = new THREE.Quaternion(), cameraAngles = new THREE.Euler(0,0,0,'YXZ');
  const fixed = new THREE.Euler().setFromQuaternion(pivot.quaternion, 'YXZ');
  const previous = new THREE.Quaternion();
  pivot.traverse(child => {
    if (!child.isMesh) return;
    child.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldQuaternion(world);
      cameraAngles.setFromQuaternion(world, 'YXZ');
      if (mode === 'vertical') cameraAngles.x = fixed.x;
      if (mode === 'horizontal') cameraAngles.y = fixed.y;
      cameraAngles.z = 0;
      pivot.quaternion.copy(pivot.parent.getWorldQuaternion(previous)).invert()
        .multiply(world.setFromEuler(cameraAngles));
      pivot.updateMatrixWorld(true);
    };
    child.frustumCulled = false;
  });
}

function plainText(component) {
  if (typeof component === 'string') {
    if (/^[\[{"]/.test(component)) { try { return plainText(JSON.parse(component)); } catch {} }
    return component;
  }
  if (Array.isArray(component)) return component.map(plainText).join('');
  return component ? String(component.text ?? component.translate ?? '') + plainText(component.extra ?? '') : '';
}

function textBody(n) {
  const text = plainText(n.text);
  if (!text || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const font = '16px monospace';
  ctx.font = font;
  const max = Math.max(16, Math.min(4096, (n.line_width || 200) * 2));
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > max) { lines.push(line); line = ''; }
      line += char;
    }
    lines.push(line);
    if (lines.length >= 225) break;
  }
  lines.length = Math.min(225, lines.length);
  canvas.width = Math.max(2, Math.ceil(Math.max(...lines.map(line => ctx.measureText(line).width))) + 4);
  canvas.height = lines.length * 18 + 4;
  ctx.font = font;
  const background = (n.background ?? 0x40000000) >>> 0;
  ctx.fillStyle = '#' + ((background & 0xffffff) * 256 + (background >>> 24)).toString(16).padStart(8,'0');
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#fff'; ctx.globalAlpha = ((n.text_opacity ?? 255) & 255) / 255;
  ctx.textAlign = n.alignment === 'left' || n.alignment === 'right' ? n.alignment : 'center';
  const x = ctx.textAlign === 'left' ? 2 : ctx.textAlign === 'right' ? canvas.width - 2 : canvas.width / 2;
  lines.forEach((line,i) => ctx.fillText(line,x,16 + i * 18));
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(canvas.width / 80, canvas.height / 80),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
  mesh.position.y = canvas.height / 160;
  return mesh;
}

async function painting(n, assets) {
  const desc = typeof n.variant === 'object' ? [n.variant.asset_id,n.variant.width,n.variant.height] : paintings[strip(n.variant ?? n.Motive ?? 'kebab')];
  if (!desc) return null;
  const [name,w,h] = desc;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const [face,back] = await Promise.all(['painting/' + strip(name), 'painting/back'].map(key => assets.getTexture(key)));
  if (!face) return null;
  const frontMat = material(face), backMat = material(back);
  const model = new THREE.Mesh(new THREE.BoxGeometry(w,h,1/16), [backMat,backMat,backMat,backMat,frontMat,backMat]);
  // Three's box UVs have the opposite V origin to the packed Minecraft textures.
  const uv = model.geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const facing = n.facing ?? n.Facing ?? 'south';
  model.rotation.y = ({ north: Math.PI, south: 0, east: Math.PI/2, west: -Math.PI/2 })[facing]
    ?? [0,-Math.PI/2,Math.PI,Math.PI/2][facing] ?? 0;
  return model;
}

async function avatar(n, rotation, assets, data) {
  let skin;
  try {
    const properties = n.profile?.properties;
    const entry = properties?.find?.(p => p.name === 'textures') ?? properties?.textures?.[0];
    const info = entry && JSON.parse(atob(entry.value)).textures?.SKIN;
    const hash = info?.url?.match(/^https?:\/\/textures\.minecraft\.net\/texture\/([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    if (hash) skin = { hash, slim: info.metadata?.model === 'slim' };
  } catch {}
  const slim = !!skin?.slim;
  let map;
  if (skin && data?.skins?.[skin.hash]) {
    try { map = await assets.getRecordedSkin?.(skin.hash, data.skins[skin.hash]); }
    catch { /* A corrupt optional skin still leaves a visible avatar. */ }
  }
  const model = vanillaModel(models[slim ? 'PlayerSlim' : 'Player'], material(map || await assets.getTexture(slim ? 'entity/player/slim/alex' : 'entity/player/wide/steve')));
  model.scale.set(-.9375,-.9375,.9375); model.position.y = .9375 * 1.5;
  model.rotation.y = (180 - rotation[0]) * rad;
  model.getObjectByName('head').rotation.x = rotation[1] * rad;
  return model;
}

function billboard(map, width, height, options = {}) {
  if (!map) return null;
  // The sprite uses its own UV frame; changing it must not change the shared texture.
  const texture = map.clone();
  const [u,v,w,h] = options.uv ?? [0,0,1,1];
  texture.offset.set(u,v+h); texture.repeat.set(w,-h); texture.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: options.color ?? 0xffffff, transparent:true, alphaTest:.05, depthWrite:false }));
  sprite.scale.set(width,height,1); sprite.position.y = options.lift ?? 0;
  return sprite;
}

function orbFrame(value) {
  return [3,7,17,37,73,149,307,617,1237,2477].filter(v => value >= v).length;
}

// Redraw particle-only entities as a deterministic still. MTR doesn't store the
// client's random samples, particle motion, or the lightning renderer's seed.
async function effect(id, n, assets) {
  if (id === 'lightning_bolt') {
    const group = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color:0xbcc8ff, transparent:true, opacity:.8 });
    for (const points of [[[0,0,0],[.4,3,0],[-.45,5,.2],[.7,9,.1],[0,12,-.2],[1.2,16,0]],
      [[-.45,5,.2],[-1.8,6.8,.5],[-2.4,8,.7]]]) {
      for (let i=1; i<points.length; i++) {
        const a=new THREE.Vector3(...points[i-1]), b=new THREE.Vector3(...points[i]);
        const direction=b.clone().sub(a);
        const segment = new THREE.Mesh(new THREE.CylinderGeometry(.035,.09,direction.length(),4),mat);
        segment.position.copy(a).lerp(b,.5); segment.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()); group.add(segment);
      }
    }
    return group;
  }
  if (id === 'area_effect_cloud') {
    const texture = await assets.getTexture('particle/effect_0');
    if (!texture) return null;
    const radius = Math.min(32, Math.max(.1, n.Radius ?? n.radius ?? 3));
    const group = new THREE.Group();
    const sample = billboard(texture,.12,.12,{ color: n.Color ?? n.color ?? 0xaaa4c4 });
    for (let i=0; i<24; i++) {
      const r=radius*Math.sqrt((i+.5)/24), angle=i*2.399963;
      const particle = i === 0 ? sample : sample.clone();
      particle.position.set(r*Math.cos(angle),.05+.08*(i%3),r*Math.sin(angle)); group.add(particle);
    }
    return group;
  }
  const spriteKeys = { dragon_fireball:'entity/enderdragon/dragon_fireball', fireball:'item/fire_charge', small_fireball:'item/fire_charge',
    fishing_bobber:'entity/fishing_hook', experience_orb:'entity/experience_orb' };
  if (id === 'experience_orb') {
    const frame = orbFrame(n.Value ?? n.value ?? 1);
    return billboard(await assets.getTexture(spriteKeys[id]),.5,.5,{ color:0x88ff39, lift:.125, uv:[(frame%4)/4,Math.floor(frame/4)/4,.25,.25] });
  }
  const size = ({ dragon_fireball:2, fireball:1, small_fireball:.3125, fishing_bobber:.5 })[id];
  return billboard(await assets.getTexture(spriteKeys[id]),size,size);
}

const thrownItems = { egg:'egg', ender_pearl:'ender_pearl', snowball:'snowball', experience_bottle:'experience_bottle',
  eye_of_ender:'ender_eye', firework_rocket:'firework_rocket', splash_potion:'splash_potion', lingering_potion:'lingering_potion', potion:'splash_potion' };

export async function supplementalEntity(entity, assets, data) {
  const id = strip(entity.id), n = entity.nbt ?? {}, rotation = entity.rotation ?? [0,0];
  const root = groupAt(entity);
  let body;
  if (id === 'marker' || id === 'interaction') return root;
  if (id === 'player' || id === 'mannequin') body = await avatar(n,rotation,assets,data);
  else if (Object.hasOwn(layers,id)) body = await projectileOrDecoration(id,n,rotation,assets);
  else if (id === 'painting') body = await painting(n,assets);
  else if (id === 'tnt' || id === 'falling_block') {
    const state = n.block_state ?? n.BlockState ?? (id === 'tnt' ? 'minecraft:tnt' : 'minecraft:sand');
    body = await blockBody(state,assets,[-.5,0,-.5]);
    const fuse = n.fuse ?? n.Fuse;
    if (id === 'tnt' && body && Number.isFinite(fuse)) {
      const swell = Math.min(1, Math.max(0, 1 - (fuse + 1) / 10));
      body.scale.setScalar(1 + .3 * swell ** 4);
      if (Math.floor(fuse / 5) % 2 === 0) body.traverse(part => part.material?.emissive?.setHex(0x999999));
    }
  } else if (id === 'item' || id === 'ominous_item_spawner' || Object.hasOwn(thrownItems,id)) {
    const stack = n.Item ?? n.item ?? n.FireworksItem ?? (thrownItems[id] && 'minecraft:' + thrownItems[id]);
    body = await itemBody(stack,assets,'ground');
    if (body) {
      if (id === 'item') body.position.y += .15;
      if (Object.hasOwn(thrownItems,id) && id !== 'firework_rocket') {
        const pivot = new THREE.Group(); pivot.add(body); body = pivot;
        displayFacing(pivot,'center');
      } else root.rotation.y = -rotation[0] * rad;
    }
  } else if (['block_display','item_display','text_display'].includes(id)) {
    const content = id === 'block_display' ? await blockBody(n.block_state ?? n.BlockState,assets,[0,0,0])
      : id === 'item_display' ? await itemBody(n.item ?? n.Item,assets,n.item_display || 'none') : textBody(n);
    if (content) {
      const transformed = new THREE.Group(); transformed.add(content);
      displayTransform(transformed,n.transformation);
      body = new THREE.Group(); body.add(transformed);
      body.rotation.set(rotation[1]*rad,-rotation[0]*rad,0,'YXZ');
      displayFacing(body,n.billboard);
    }
  } else if (['dragon_fireball','fireball','small_fireball','experience_orb','fishing_bobber','area_effect_cloud','lightning_bolt'].includes(id)) {
    body = await effect(id,n,assets);
  } else return null;
  if (body) root.add(body);
  return root;
}
