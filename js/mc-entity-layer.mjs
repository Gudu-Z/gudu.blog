import { Group, buildEntityMesh, isAssetTexture, minecartRenderPose } from './vendor/mc-engine.mjs';

// Living entities may change pose where they touch water or sleep on a bed.
// Match the block lookup used by the projection renderer, including negative bounds.
function blockAt(data, pos) {
  const b = data.bounds;
  const x = Math.floor(pos[0]) - b.minX, y = Math.floor(pos[1]) - b.minY, z = Math.floor(pos[2]) - b.minZ;
  if (x < 0 || y < 0 || z < 0 || x >= b.width || y >= b.height || z >= b.depth) return undefined;
  return data.blocks.get(x + (z + y * b.depth) * b.width);
}

function modelResources(mesh) {
  const resources = new Set();
  mesh?.traverse(part => {
    if (part.isInstancedMesh) resources.add(part);
    // Sprite geometries are shared by the Three.js runtime. Entity rigs dispose
    // their skeleton from their own geometry's dispose event.
    if (part.geometry && !part.isSprite) resources.add(part.geometry);
    for (const material of [].concat(part.material ?? [])) {
      resources.add(material);
      if (material.map && !isAssetTexture(material.map)) resources.add(material.map);
    }
  });
  return resources;
}

// Blocks rebuild inside Renderer.clear(); keep the actor roots in their own layer
// so stepping a piston or moving one actor does not discard the other models.
export function createReplayEntityLayer(renderer, assets, signal) {
  const layer = new Group();
  layer.name = 'replay-entities';
  renderer.scene.add(layer);
  const records = new Map(), refs = new Map();
  let modelsChanged = false;

  function release(record) {
    if (record.mesh) {
      record.mesh.removeFromParent();
      modelsChanged = true;
    }
    for (const resource of record.resources) {
      const count = refs.get(resource) - 1;
      if (count) refs.set(resource, count);
      else {
        refs.delete(resource);
        resource.dispose();
      }
    }
  }

  async function update(state, data) {
    const previous = records.get(state.id);
    const cart = state.type === 'minecraft:minecart' || state.type.endsWith('_minecart');
    const cell = blockAt(data, state.pos);
    const visual = previous?.state === state ? previous.visual : JSON.stringify(state.nbt);
    const entity = { id: state.type, pos: state.pos, rotation: [state.yaw, state.pitch], nbt: state.nbt ?? {} };
    if (previous && previous.state.type === state.type && visual === previous.visual &&
        (cart || (state.yaw === previous.state.yaw && state.pitch === previous.state.pitch && cell === previous.cell))) {
      if (previous.mesh) {
        previous.mesh.position.fromArray(state.pos).add(previous.offset);
        if (previous.cartBody) {
          const pose = minecartRenderPose(entity, data);
          previous.cartBody.position.fromArray(pose.offset);
          previous.cartBody.rotation.set(0, pose.yaw, pose.pitch, 'YXZ');
        }
      }
      previous.state = state;
      return;
    }
    let mesh;
    try {
      mesh = await buildEntityMesh(entity, assets, data);
    } catch (error) {
      if (!signal.aborted) console.warn('无法绘制回放实体', state.type, error);
    }
    const resources = modelResources(mesh);
    for (const resource of resources) refs.set(resource, (refs.get(resource) ?? 0) + 1);
    const offset = mesh?.position.clone();
    if (offset) offset.set(offset.x - state.pos[0], offset.y - state.pos[1], offset.z - state.pos[2]);
    const record = { state, visual, cell, mesh, resources, offset, cartBody: cart && mesh?.getObjectByName('minecart-model') };
    if (previous) release(previous);
    records.set(state.id, record);
    if (mesh) {
      mesh.name = 'replay-entity:' + state.id;
      mesh.userData.replayEntityType = state.type;
      layer.add(mesh);
      modelsChanged = true;
    }
  }

  return {
    // The viewer serializes frame builds. This map is a snapshot of the step
    // being displayed; the playback cursor can already be at a later step.
    async sync(states, data) {
      for (const [id, record] of records) {
        if (states.has(id)) continue;
        release(record);
        records.delete(id);
      }
      const actors = states.values();
      const finish = assets.beginTextureLoad();
      try {
        await Promise.all(Array.from({ length: Math.min(states.size, 8) }, async () => {
          for (const state of actors) {
            if (signal.aborted) break;
            await update(state, data);
          }
        }));
        renderer.requestRender(modelsChanged);
        // Pin all currently attached texture sources before ending the transaction.
        // This also accounts for animated maps and cloned feature-layer textures.
        if (modelsChanged) renderer._syncSceneResources(assets);
        modelsChanged = false;
      } finally {
        finish();
      }
    },
    destroy() {
      for (const record of records.values()) release(record);
      records.clear();
      layer.removeFromParent();
    },
  };
}
