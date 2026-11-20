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
    requireField(['blocks', 'events', 'palette', 'pistons', 'players', 'entities', 'skins'].every(field => scene[field] === undefined), '静态投影不能包含回放数据');
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
    const actorKinds = new Map();
    const validId = value => typeof value === 'string' && id.test(value);
    function register(actorId, kind) {
      requireField(!actorKinds.has(actorId) || actorKinds.get(actorId) === kind, '实体 ID 重复');
      actorKinds.set(actorId, kind);
    }
    const validPose = p => object(p) && validId(p.id) && p.removed === undefined
      && vector(p.pos, Number.isFinite) && Number.isFinite(p.yaw) && Number.isFinite(p.pitch)
      && (p.nbt === undefined || object(p.nbt));
    const validEntity = p => validPose(p) && typeof p.type === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(p.type);
    const skinHash = /^[a-f0-9]{64}$/;
    const validPlayer = p => validPose(p)
      && (p.model === undefined || ['wide', 'slim'].includes(p.model))
      && (p.skin === undefined || (typeof p.skin === 'string' && skinHash.test(p.skin)));
    for (const [field, check] of [['players', validPlayer], ['entities', validEntity]]) {
      if (scene[field] === undefined) continue;
      requireField(Array.isArray(scene[field]), field);
      for (const actor of scene[field]) {
        requireField(check(actor) && !actorKinds.has(actor.id), field);
        register(actor.id, field);
      }
    }
    if (scene.skins !== undefined) {
      requireField(object(scene.skins), 'skins');
      for (const [hash, png] of Object.entries(scene.skins)) {
        requireField(skinHash.test(hash) && typeof png === 'string' && png.length <= 1398104
          && png.length % 4 === 0 && png.startsWith('iVBORw0KGgo') && /^[a-zA-Z0-9+/]+={0,2}$/.test(png), 'skins');
      }
    }
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
      for (const [field, kind, check] of [['player', 'players', validPlayer], ['entity', 'entities', validEntity]]) {
        const actor = event[field];
        if (actor === undefined) continue;
        requireField(check(actor) || (object(actor) && validId(actor.id) && actor.removed === true), `events[${i}].${field}`);
        register(actor.id, kind);
      }
      if (event.actorId !== undefined) requireField(validId(event.actorId), `events[${i}].actorId`);
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
  const keysByStep = [];
  function record(key, step, value) {
    if (!history.has(key)) history.set(key, []);
    history.get(key).push({ step, value });
    keysByStep[step] = key;
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
  function seek(from, to) {
    let keys = history.keys();
    if (Math.abs(to - from) < history.size) {
      const crossed = new Set();
      for (let step = Math.min(from, to) + 1; step <= Math.max(from, to); step++) {
        if (keysByStep[step] !== undefined) crossed.add(keysByStep[step]);
      }
      keys = crossed;
    }
    let changed = false;
    for (const key of keys) {
      if (restore(key, to)) changed = true;
    }
    return changed;
  }
  return { current, record, seek };
}

// Older exports stored poses only on movement and omitted the actor on idle ticks.
export function eventTarget(replay, event) {
  if (!event?.type.startsWith('entity')) return { block: event?.pos };
  let actorId = event.actorId ?? event.player?.id ?? event.entity?.id;
  if (!actorId && event.detail === 'minecraft:player' && event.pos) {
    const matches = [...replay.players.values()].filter(player =>
      player.pos.every((n, axis) => Math.floor(n) === event.pos[axis]));
    if (matches.length === 1) actorId = matches[0].id;
  }
  return { actorId };
}

export function createReplay(scene) {
  const air = scene.palette.indexOf('minecraft:air');
  const base = cellMap(scene.blocks);
  for (const [key, state] of base) if (state === air) base.delete(key);
  const blocks = stateTrack(base, value => value === undefined || value === air);
  const pistons = stateTrack(cellMap(scene.pistons ?? []), value => value == null);
  const players = stateTrack(new Map((scene.players ?? []).map(p => [p.id, p])), value => value == null);
  const entities = stateTrack(new Map((scene.entities ?? []).map(e => [e.id, e])), value => value == null);
  for (const [i, event] of scene.events.entries()) {
    if (event.entity) entities.record(event.entity.id, i + 1, event.entity.removed ? null : event.entity);
    if (event.player) players.record(event.player.id, i + 1, event.player.removed ? null : event.player);
    if (event.after === undefined && event.piston === undefined) continue;
    const key = positionKey(event.pos);
    if (event.after !== undefined) blocks.record(key, i + 1, event.after);
    if (event.piston !== undefined) pistons.record(key, i + 1, event.piston);
  }
  let step = 0, revision = 0, playerRevision = 0, entityRevision = 0;
  return {
    blocks: blocks.current, pistons: pistons.current, players: players.current, entities: entities.current,
    get entityRevision() { return entityRevision; },
    get playerRevision() { return playerRevision; },
    get step() { return step; },
    get revision() { return revision; },
    get event() { return step ? scene.events[step - 1] : null; },
    seek(target) {
      requireField(integer(target) && target >= 0 && target <= scene.events.length, '回放步数');
      if (step === target) return;
      const blocksChanged = blocks.seek(step, target);
      const pistonsChanged = pistons.seek(step, target);
      if (blocksChanged || pistonsChanged) revision++;
      if (players.seek(step, target)) playerRevision++;
      if (entities.seek(step, target)) entityRevision++;
      step = target;
    },
  };
}
