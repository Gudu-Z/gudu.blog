import { Group, createEntityHitboxLines, getEntityHitbox } from './vendor/mc-engine.mjs';

const sameVector = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function localBounds(state, type) {
  const bounds = getEntityHitbox({ id: type, pos: state.pos, rotation: [state.yaw ?? 0, state.pitch ?? 0], nbt: state.nbt });
  if (type !== 'minecraft:player' || !bounds) return bounds;
  const pose = String(state.nbt?.Pose ?? state.nbt?.pose ?? '').toLowerCase().replace(/^minecraft:/, '');
  // Java 1.21.10 Avatar.POSES. Standing and sleeping already use the correct
  // dimensions in the shared renderer; the dying pose is fixed at any scale.
  const f = Math.fround;
  if (pose === 'dying') {
    bounds.width = f(.2);
    bounds.min = [-bounds.width / 2, 0, -bounds.width / 2];
    bounds.max = [bounds.width / 2, f(.2), bounds.width / 2];
    bounds.eyeHeight = f(1.62);
  } else if (pose === 'crouching' || pose === 'swimming' || pose === 'fall_flying' || pose === 'spin_attack') {
    // These poses retain the player's standing width, including all scale modifiers.
    const scale = f(bounds.width / f(.6));
    bounds.max[1] = pose === 'crouching' ? f(1.5 * scale) : bounds.width;
    bounds.eyeHeight = f(f(pose === 'crouching' ? 1.27 : .4) * scale);
  }
  return bounds;
}

function worldBounds(bounds, position) {
  return { min: bounds.min.map((v, i) => v + position[i]), max: bounds.max.map((v, i) => v + position[i]) };
}

export function replayEntityBounds(state) {
  if (!state?.pos) return null;
  const bounds = localBounds(state, state.type ?? 'minecraft:player');
  return bounds && !bounds.invisible ? worldBounds(bounds, state.pos) : null;
}

function sameShape(a, b) {
  return a.eyeHeight === b.eyeHeight && a.living === b.living && sameVector(a.min, b.min) && sameVector(a.max, b.max)
    && a.parts.length === b.parts.length && a.parts.every((part, i) => {
      const other = b.parts[i];
      return sameVector(part.min, other.min) && sameVector(part.max, other.max);
    });
}

// The shared debug renderer ends every overlay with the blue two-block view
// vector and two arrowhead segments. A turn changes only those six vertices.
function updateDirection(line, bounds) {
  const point = line.geometry.getAttribute('position');
  const first = point.count - 6, eye = bounds.eyeHeight;
  const [x, y, z] = bounds.direction;
  const [sx, sy, sz] = Math.abs(y) > .9 ? [0, z, -y] : [-z, 0, x];
  const side = .06 / Math.hypot(sx, sy, sz);
  const origin = [0, eye, 0];
  const [ex, ey, ez] = bounds.direction.map((component, axis) => origin[axis] + 2 * component);
  point.setXYZ(first, 0, eye, 0);
  point.setXYZ(first + 1, ex, ey, ez);
  for (const [i, sign] of [[2, -1], [4, 1]]) {
    point.setXYZ(first + i, ex, ey, ez);
    point.setXYZ(first + i + 1, ex - .12*x + sign*sx*side, ey - .12*y + sign*sy*side, ez - .12*z + sign*sz*side);
  }
  point.clearUpdateRanges();
  point.addUpdateRange(first * 3, 18);
  point.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

function clearLine(record) {
  if (!record.line) return;
  record.line.removeFromParent();
  record.line.geometry.dispose();
  record.line.material.dispose();
  record.line = null;
}

// Logical hitboxes get their own world-aligned anchors. The skin's yaw, limb
// animations and 0.9375 player model scale do not belong to a physics box.
export function createReplayHitboxes(renderer) {
  const layer = new Group();
  layer.name = 'replay-hitboxes';
  renderer.scene.add(layer);
  const records = new Map();

  function show(record) {
    const bounds = record.bounds;
    if (bounds.invisible) {
      if (record.line) record.line.visible = false;
      return;
    }
    if (record.line && !sameShape(record.drawn, bounds)) clearLine(record);
    if (!record.line) {
      record.line = createEntityHitboxLines({ bounds, anchor: layer.matrix, ridingOffset: null });
      record.anchor.add(record.line);
    } else if (!sameVector(record.drawn.direction, bounds.direction)) {
      updateDirection(record.line, bounds);
    }
    record.drawn = bounds;
    record.line.visible = true;
  }

  function remove(id, record) {
    clearLine(record);
    record.anchor.removeFromParent();
    records.delete(id);
  }

  function syncEntity(id, type, state) {
    let record = records.get(id);
    if (record?.state === state) return;
    const bounds = localBounds(state, type);
    if (!bounds) {
      if (record) remove(id, record);
      return;
    }
    if (!record) {
      const anchor = new Group();
      anchor.name = 'replay-hitbox:' + id;
      layer.add(anchor);
      record = { anchor, line: null, drawn: null };
      records.set(id, record);
    }
    record.state = state;
    record.bounds = bounds;
    record.anchor.position.fromArray(state.pos);
    if (layer.visible) show(record);
  }

  return {
    sync(players, entities) {
      for (const [id, record] of records) if (!players?.has(id) && !entities?.has(id)) remove(id, record);
      for (const [id, state] of players ?? []) syncEntity(id, 'minecraft:player', state);
      for (const [id, state] of entities ?? []) syncEntity(id, state.type, state);
      renderer.requestRender();
    },
    setVisible(value) {
      if (layer.visible === !!value) return;
      layer.visible = !!value;
      if (layer.visible) for (const record of records.values()) show(record);
      renderer.requestRender();
    },
    boundsFor(id) {
      const record = records.get(id);
      if (!record || record.bounds.invisible) return null;
      const { bounds, state } = record;
      return worldBounds(bounds, state.pos);
    },
    destroy() {
      for (const [id, record] of records) remove(id, record);
      layer.removeFromParent();
    },
  };
}
