// The recorder uses local "x,y,z" coordinate keys. The renderer packs those
// coordinates against one fixed box so seeking never changes the camera origin.
export function readPalette(states) {
  return states.map(state => {
    const bracket = state.indexOf('[');
    if (bracket < 0) return { name: state, properties: {} };
    const properties = Object.fromEntries(state.slice(bracket + 1, -1).split(',').map(entry => entry.split('=')));
    return { name: state.slice(0, bracket), properties };
  });
}

export function replayBounds(scene) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  function include(pos) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], pos[axis]);
      max[axis] = Math.max(max[axis], pos[axis]);
    }
  }
  for (const block of scene.blocks) include(block);
  for (const event of scene.events) if (event.pos && event.after !== undefined) include(event.pos);
  if (!Number.isFinite(min[0])) include([0, 0, 0]);
  const [width, height, depth] = max.map((value, i) => value - min[i] + 1);
  if (!Number.isSafeInteger(width * height * depth)) throw new RangeError('录制区域跨度过大。');
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2], width, height, depth };
}

export function renderData(palette, bounds, blockMap, pistonMap) {
  const blocks = new Map(), tileEntities = [];
  for (const [key, state] of blockMap) {
    const [x, y, z] = key.split(',').map(Number);
    const index = x - bounds.minX + bounds.width * ((z - bounds.minZ) + (y - bounds.minY) * bounds.depth);
    blocks.set(index, state);
    const piston = pistonMap?.get(key);
    if (!piston || palette[state].name !== 'minecraft:moving_piston') continue;
    const moved = palette[piston.state];
    tileEntities.push({ id: 'minecraft:piston', x, y, z, nbt: {
      facing: piston.direction, extending: piston.extending, source: piston.source, progress: piston.progress,
      blockState: { Name: moved.name, Properties: moved.properties },
    } });
  }
  return { bounds, palette, blocks, tileEntities, entities: [], regions: [] };
}
