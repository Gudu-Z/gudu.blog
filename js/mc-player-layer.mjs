import { createEntityRig, MeshLambertMaterial, DoubleSide } from './vendor/mc-engine.mjs';

const rad = Math.PI / 180;

// Java 1.21.10 PlayerModel. Cuboids use ModelPart pixels and 64×64 skin UVs;
// the outer sleeve, pants, jacket and hat share each underlying joint.
function playerModel(slim) {
  function part(pivot, corner, size, uv, overlay, dilation = 0.25) {
    const [x, y, z] = corner, [dx, dy, dz] = size;
    const cuboid = { x, y, z, dx, dy, dz };
    return { pivot, cuboids: [
      { ...cuboid, u: uv[0], v: uv[1] },
      { ...cuboid, u: overlay[0], v: overlay[1], dil: [dilation, dilation, dilation] },
    ] };
  }
  const arm = [slim ? 3 : 4, 12, 4], leg = [4, 12, 4];
  return { w: 64, h: 64, parts: {
    head: part([0,0,0], [-4,-8,-4], [8,8,8], [0,0], [32,0], 0.5),
    body: part([0,0,0], [-4,0,-2], [8,12,4], [16,16], [16,32]),
    right_arm: part([-5,2,0], [slim ? -2 : -3,-2,-2], arm, [40,16], [40,32]),
    left_arm: part([5,2,0], [-1,-2,-2], arm, [32,48], [48,48]),
    right_leg: part([-1.9,12,0], [-2,0,-2], leg, [0,16], [0,32]),
    left_leg: part([1.9,12,0], [-2,0,-2], leg, [16,48], [0,48]),
  } };
}

const models = { slim: playerModel(true), wide: playerModel(false) };

export async function createPlayerLayer(scene, renderer, assets, signal) {
  const hashes = new Set(), defaults = new Set();
  function appearance(player) {
    if (!player?.pos) return;
    defaults.add(player.model === 'slim' ? 'slim' : 'wide');
    if (player.skin && Object.hasOwn(scene.skins ?? {}, player.skin)) hashes.add(player.skin);
  }
  for (const player of scene.players ?? []) appearance(player);
  for (const event of scene.events) appearance(event.player);
  if (!defaults.size) return null;
  // Preload the appearances referenced by this recording. Playback, reverse
  // seeks and spawn/despawn then update the scene synchronously on the same frame.
  const textures = new Map();
  await Promise.all([
    ...Array.from(hashes, async hash => {
      try {
        textures.set(hash, await assets.getRecordedSkin(hash, scene.skins[hash]));
      } catch (error) {
        if (!signal.aborted) console.warn('玩家皮肤无法解码，将使用默认皮肤。', error);
      }
    }),
    ...Array.from(defaults, async model => textures.set(model, await assets.getTexture(
      model === 'slim' ? 'entity/player/slim/alex' : 'entity/player/wide/steve'))),
  ]);
  signal.throwIfAborted();
  const visible = new Map();
  assets.setTextureUsage(visible, [...textures.values()].filter(Boolean));

  function remove(mesh) {
    mesh.removeFromParent();
    mesh.geometry.dispose(); // The rig also owns and releases its skeleton.
    mesh.material.dispose();
  }
  function sync(players) {
    let resourcesChanged = false;
    for (const [id, mesh] of visible) {
      if (!players?.has(id)) {
        remove(mesh);
        visible.delete(id);
        resourcesChanged = true;
      }
    }
    for (const [id, player] of players ?? []) {
      const model = player.model === 'slim' ? 'slim' : 'wide';
      const texture = textures.get(player.skin) ?? textures.get(model);
      let mesh = visible.get(id);
      if (!mesh || mesh.userData.playerModel !== model) {
        if (mesh) remove(mesh);
        const material = new MeshLambertMaterial({ map: texture, alphaTest: 0.1, side: DoubleSide });
        mesh = createEntityRig(models[model], material);
        mesh.name = 'replay-player:' + id;
        mesh.userData.playerModel = model;
        mesh.scale.setScalar(0.9375); // AvatarRenderer.scale in Java 1.21.10.
        renderer.scene.add(mesh);
        visible.set(id, mesh);
        resourcesChanged = true;
      } else if (mesh.material.map !== texture) {
        mesh.material.map = texture;
        mesh.material.needsUpdate = true;
        resourcesChanged = true;
      }
      // ModelPart's bind pose is feet at zero, face towards +Z (Minecraft south).
      mesh.position.fromArray(player.pos);
      mesh.rotation.y = -(player.yaw ?? 0) * rad;
      mesh.userData.parts.head.rotation.x = (player.pitch ?? 0) * rad;
    }
    renderer.requestRender(resourcesChanged);
  }
  return {
    sync,
    destroy() {
      for (const mesh of visible.values()) remove(mesh);
      visible.clear();
      assets.releaseTextureUsage(visible);
    },
  };
}


// How well cameras at `eyes` ([x, y, z] each) would see the recorded players,
// estimated along short rays through the sparse block map: for each eye, the
// share of sample points left in view (`visible`, 0 to 1) and a `score` that
// also favours nearer views, `reference` being a typical camera distance. Null
// when there is nothing to judge: no players, or no block near them.
export function playerVisibility({ players, blocks: initialBlocks, geometryBounds: bounds, palette }, eyes, reference) {
  if (!players?.length || !initialBlocks?.length) return null;
  const targets = players.slice(0, 4);
  // Only the original cells within reach of our short rays can obscure the
  // starting shot. A deep link and a normal opening must choose the same view.
  const blocks = new Map();
  for (const [x, y, z, state] of initialBlocks) {
    if (targets.some(({ pos }) => Math.abs(x - pos[0]) <= 21 && Math.abs(y - pos[1]) <= 23 && Math.abs(z - pos[2]) <= 21)) {
      blocks.set(x - bounds.minX + bounds.width * (z - bounds.minZ + (y - bounds.minY) * bounds.depth), state);
    }
  }
  if (!blocks.size) return null;
  const samples = [];
  for (const { pos: [x,y,z] } of targets) {
    samples.push([x,y+1.68,z], [x,y+1.49,z], [x-.14,y+1.14,z], [x+.14,y+1.14,z], [x,y+.74,z], [x,y+.28,z]);
  }
  const opacity = palette.map(({ name, baked }) => {
    if (/glass|ice$|water$/.test(name)) return 0.2;
    if (/redstone_wire$|torch$|lever$/.test(name)) return 0.05;
    return baked?.fullCube ? 1 : 0.45;
  });
  function visibility(sample, dx, dy, dz, distance) {
    const [sx,sy,sz] = sample;
    let visible = 1, previous = -1;
    const limit = Math.min(20, distance);
    for (let t = .18; t < limit; t += .32) {
      const x = Math.floor(sx + dx*t) - bounds.minX, y = Math.floor(sy + dy*t) - bounds.minY;
      const z = Math.floor(sz + dz*t) - bounds.minZ;
      if (x < 0 || x >= bounds.width || y < 0 || y >= bounds.height || z < 0 || z >= bounds.depth) continue;
      const key = x + bounds.width * (z + y * bounds.depth);
      if (key === previous) continue;
      previous = key;
      const state = blocks.get(key);
      if (state !== undefined) visible *= 1 - opacity[state];
      if (visible < .01) break;
    }
    return visible;
  }
  return eyes.map(([cx, cy, cz]) => {
    let visible = 0, score = 0;
    for (const sample of samples) {
      const dx = cx - sample[0], dy = cy - sample[1], dz = cz - sample[2];
      const distance = Math.max(.01, Math.hypot(dx, dy, dz));
      const value = visibility(sample, dx/distance, dy/distance, dz/distance, distance);
      visible += value;
      score += value * reference / distance;
    }
    return { visible: visible / samples.length, score };
  });
}
