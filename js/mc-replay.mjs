import { validSpeed } from './mc-playback-settings.mjs';

const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const blockState = /^[a-z0-9_.-]+:[a-z0-9_./-]+(?:\[[a-z0-9_-]+=[a-z0-9_.-]+(?:,[a-z0-9_-]+=[a-z0-9_.-]+)*\])?$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = Number.isSafeInteger;
const vector = (value, test = integer) => Array.isArray(value) && value.length === 3 && value.every(test);
const positionKey = pos => pos.join(',');

function requireField(valid, field) {
  if (!valid) throw new Error(`场景字段无效：${field}`);
}

function asset(path, extensions) {
  return typeof path === 'string' && path === path.trim() && extensions.test(path)
    && !/[\\:%?#\u0000-\u001f\u007f]/.test(path)
    && path.split('/').every(part => part && !part.startsWith('.'));
}

function validateCamera(camera) {
  requireField(object(camera), 'camera');
  requireField(camera.projection === undefined || ['perspective', 'orthographic'].includes(camera.projection), 'camera.projection');
  if (camera.position !== undefined || camera.target !== undefined) {
    const axis = value => Number.isFinite(value) && Math.abs(value) <= 1e9;
    requireField(vector(camera.position, axis) && vector(camera.target, axis)
      && camera.position.some((n, i) => n !== camera.target[i]), 'camera.position / target');
  }
  if (camera.zoom !== undefined) requireField(Number.isFinite(camera.zoom) && camera.zoom >= .01 && camera.zoom <= 100, 'camera.zoom');
  if (camera.height !== undefined) requireField(Number.isFinite(camera.height) && camera.height >= .01 && camera.height <= 1e9, 'camera.height');
}

export function validateScene(scene) {
  requireField(object(scene) && scene.version === 1, 'version（需要 1）');
  if (scene.playbackSpeed !== undefined) requireField(validSpeed(scene.playbackSpeed), 'playbackSpeed');
  const isStatic = scene.schematic !== undefined;
  const poster = path => asset(path, /\.(?:avif|webp|png|jpe?g|gif)$/i);
  if (scene.poster !== undefined) requireField(poster(scene.poster), 'poster');
  if (isStatic) {
    requireField(asset(scene.schematic, /\.(?:litematic|litematica|nbt)$/i), 'schematic');
    requireField(['blocks', 'events', 'palette', 'pistons'].every(field => scene[field] === undefined), '静态投影不能包含回放数据');
  } else {
    requireField(vector(scene.origin), 'origin');
    if (scene.tickRange !== undefined) {
      const range = scene.tickRange;
      requireField(Array.isArray(range) && range.length === 2 && range.every(integer)
        && range[0] <= range[1] && integer(range[1] - range[0]), 'tickRange');
    }
    requireField(typeof scene.dimension === 'string' && scene.dimension.length > 0, 'dimension');
    requireField(Array.isArray(scene.palette) && scene.palette.length > 0
      && scene.palette.every(state => typeof state === 'string' && blockState.test(state)), 'palette');
    const validIndex = value => integer(value) && value >= 0 && value < scene.palette.length;
    const validPiston = value => object(value) && validIndex(value.state) && integer(value.direction)
      && value.direction >= 0 && value.direction <= 5 && typeof value.extending === 'boolean'
      && typeof value.source === 'boolean' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1;
    const checkCells = (cells, field, validValue) => {
      requireField(Array.isArray(cells), field);
      const occupied = new Set();
      for (const [i, cell] of cells.entries()) {
        requireField(Array.isArray(cell) && cell.length === 4 && vector(cell.slice(0, 3)) && validValue(cell[3]), `${field}[${i}]`);
        const key = positionKey(cell.slice(0, 3));
        requireField(!occupied.has(key), `${field}[${i}] 坐标重复`);
        occupied.add(key);
      }
    };
    checkCells(scene.blocks, 'blocks', validIndex);
    if (scene.pistons !== undefined) checkCells(scene.pistons, 'pistons', validPiston);
    requireField(Array.isArray(scene.events), 'events');
    for (const [i, event] of scene.events.entries()) {
      requireField(object(event) && integer(event.tick) && typeof event.type === 'string' && event.type.length > 0, `events[${i}]`);
      if (scene.tickRange) requireField(event.tick >= scene.tickRange[0] && event.tick <= scene.tickRange[1]
        && (i === 0 || event.tick >= scene.events[i - 1].tick), `events[${i}].tick / tickRange`);
      if (event.pos !== undefined) requireField(vector(event.pos), `events[${i}].pos`);
      for (const field of ['before', 'after']) {
        if (event[field] !== undefined) requireField(event.pos && validIndex(event[field]), `events[${i}].${field}`);
      }
      if (event.piston !== undefined) requireField(event.pos && (event.piston === null || validPiston(event.piston)), `events[${i}].piston`);
      if (event.parent !== undefined) requireField(integer(event.parent) && event.parent >= 0 && event.parent < i, `events[${i}].parent`);
      if (event.detail !== undefined) requireField(typeof event.detail === 'string', `events[${i}].detail`);
    }
  }
  const marks = scene.bookmarks ?? {};
  requireField(object(marks), 'bookmarks');
  for (const [name, mark] of Object.entries(marks)) {
    requireField(id.test(name) && object(mark), `bookmarks.${name}`);
    const step = isStatic ? (mark.step ?? 0) : mark.step;
    requireField(integer(step) && step >= 0 && step <= (isStatic ? 0 : scene.events.length), `bookmarks.${name}.step`);
    if (mark.tick !== undefined) requireField(!isStatic && integer(mark.tick)
      && (!scene.tickRange || (mark.tick >= scene.tickRange[0] && mark.tick <= scene.tickRange[1])), `bookmarks.${name}.tick`);
    if (mark.focus !== undefined) requireField(vector(mark.focus), `bookmarks.${name}.focus`);
    if (mark.camera !== undefined) validateCamera(mark.camera);
    if (mark.poster !== undefined) requireField(poster(mark.poster), `bookmarks.${name}.poster`);
  }
  return scene;
}

function cellMap(cells) {
  return new Map(cells.map(([x, y, z, value]) => [`${x},${y},${z}`, value]));
}

// Each position has its own history. A long seek probes changing positions only,
// without replaying every notification or cloning the entire structure per tick.
function stateTrack(initial, empty) {
  const current = new Map(initial);
  const history = new Map();
  function record(key, step, value) {
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ step, value });
  }
  function restore(key, step) {
    const versions = history.get(key);
    let low = 0, high = versions.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (versions[mid].step <= step) low = mid + 1;
      else high = mid;
    }
    const value = low ? versions[low - 1].value : initial.get(key);
    if (empty(value)) return current.delete(key);
    if (current.get(key) === value) return false;
    current.set(key, value);
    return true;
  }
  return { current, history, record, restore };
}

export function createReplay(scene) {
  const air = scene.palette.indexOf('minecraft:air');
  const base = cellMap(scene.blocks);
  for (const [key, state] of base) if (state === air) base.delete(key);
  const blocks = stateTrack(base, value => value === undefined || value === air);
  const pistons = stateTrack(cellMap(scene.pistons ?? []), value => value == null);
  const changes = [];
  for (const [i, event] of scene.events.entries()) {
    if (event.after === undefined && event.piston === undefined) continue;
    const key = positionKey(event.pos);
    if (event.after !== undefined) blocks.record(key, i + 1, event.after);
    if (event.piston !== undefined) pistons.record(key, i + 1, event.piston);
    changes[i] = key;
  }
  let step = 0, revision = 0;
  return {
    blocks: blocks.current, pistons: pistons.current,
    get step() { return step; },
    get revision() { return revision; },
    get event() { return step ? scene.events[step - 1] : null; },
    seek(target) {
      requireField(integer(target) && target >= 0 && target <= scene.events.length, '回放步数');
      let changed = false;
      const distance = Math.abs(target - step);
      let affected;
      if (distance <= blocks.history.size + pistons.history.size) {
        affected = new Set();
        for (let i = Math.min(step, target); i < Math.max(step, target); i++) {
          if (changes[i] !== undefined) affected.add(changes[i]);
        }
      }
      for (const track of [blocks, pistons]) {
        for (const key of affected ?? track.history.keys()) {
          if (track.history.has(key) && track.restore(key, target)) changed = true;
        }
      }
      step = target;
      if (changed) revision++;
    },
  };
}
