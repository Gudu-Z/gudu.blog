import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateScene } from '../js/mc-replay.mjs';
import { actorTracks } from './mc-export-players.mjs';
import { attachPlayerSkins } from './mc-player-skins.mjs';
import { readRecordingNbt } from './mc-export-nbt.mjs';
import { blockStateName, readStateRegistry } from './mc-export-registry.mjs';

const axes = ['x', 'y', 'z'];
const directions = ['down', 'up', 'north', 'south', 'west', 'east'];
function coords(tag) {
  const pos = axes.map(axis => tag[axis]);
  if (!pos.every(Number.isSafeInteger)) throw Error('方块坐标无效。');
  return pos;
}
function array(value, field) {
  if (!Array.isArray(value)) throw Error(`录制中缺少 ${field} 列表。`);
  return value;
}
function piston(state, direction, extending, source, progress) {
  if (typeof direction === 'string') direction = directions.indexOf(direction);
  if (!Number.isInteger(direction) || direction < 0 || direction >= directions.length ||
      !Number.isFinite(progress) || progress < 0 || progress > 1) throw Error('运动活塞的朝向或进度无效。');
  return { state, direction, extending: Boolean(extending), source: Boolean(source), progress };
}
function detail(tag) {
  switch (tag.type) {
    case 'update': return tag.updateName;
    case 'phase': case 'levelTick': return tag.phaseName;
    case 'queue': return tag.queueName;
    case 'addScheduleTick': return `${tag.typeId} · 计划刻 ${tag.triggerTick} · 优先级 ${tag.priority} · 同刻序号 ${tag.subTickOrder}`;
    case 'addBlockEvent': return `方块事件 ${tag.b0}，参数 ${tag.b1}`;
    case 'pistonStructure': return tag.resolved ? '活塞能推动此结构' : '活塞移动受阻';
    case 'itemTransfer': return `${tag.itemId} × ${tag.count}`;
    case 'blockEntityTick': case 'blockEntityCreation': return tag.blockEntityType;
    default: return tag.entityType;
  }
}

export function exportScene(profile, record, registry, minecraftVersion, selectedDimension, diagnostics = {}) {
  const recordedAreas = array(record.areas, 'record.dat: areas');
  const dimensions = new Set(recordedAreas.map(area => area.dimension));
  if (dimensions.size === 0) throw Error('初始快照没有选区。请先框选电路，再开始一次新录制。');
  if (!selectedDimension && dimensions.size > 1) throw Error(`该录制包含多个维度，请用 --dimension 选择一个：${[...dimensions].join('、')}。`);
  const dimension = selectedDimension ?? [...dimensions][0];
  if (typeof dimension !== 'string' || !dimension || !dimensions.has(dimension)) throw Error(`快照没有所选维度 ${dimension}。`);
  const areas = recordedAreas.filter(area => area.dimension === dimension);
  const boxes = areas.map(area => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const block of array(area.blocks, 'area.blocks')) {
      for (const [axis, n] of coords(block).entries()) {
        min[axis] = Math.min(min[axis], n);
        max[axis] = Math.max(max[axis], n);
      }
    }
    if (!area.blocks.length) throw Error(`快照选区 ${area.name} 没有方块坐标。`);
    return { min, max };
  });
  const origin = axes.map((_, i) => boxes.reduce((low, box) => Math.min(box.min[i], low), Infinity));
  const local = pos => pos.map((n, i) => n - origin[i]);
  const contains = pos => boxes.some(box => pos.every((n, i) => n >= box.min[i] && n <= box.max[i]));
  const palette = ['minecraft:air'];
  const names = new Map([['minecraft:air', 0]]);
  function intern(name) {
    if (!names.has(name)) {
      names.set(name, palette.length);
      palette.push(name);
    }
    return names.get(name);
  }
  function fromId(id) {
    if (!Number.isSafeInteger(id) || id < 0 || typeof registry[id] !== 'string') {
      throw Error(`状态表中找不到编号 ${id}，请用 --registry 提供这次录制的实际方块注册表。`);
    }
    return intern(registry[id]);
  }
  const blocks = new Map(), pistons = new Map();
  for (const area of areas) {
    for (const block of area.blocks) {
      const state = fromId(block.stateId);
      if (state === 0) continue;
      const pos = local(coords(block));
      const key = pos.join(',');
      blocks.set(key, [...pos, state]);
      const be = block.nbt;
      if (be?.id === 'minecraft:piston' && be.blockState) {
        const moved = intern(blockStateName(be.blockState.Name, be.blockState.Properties));
        pistons.set(key, [...pos, piston(moved, be.facing ?? 0, be.extending, be.source, be.progress ?? 0)]);
      }
    }
  }
  const frames = array(profile.frames, 'profile.dat: frames');
  const actors = actorTracks(areas, frames, local);
  diagnostics.omittedEntities = actors.omittedEntities;
  const actorInArea = pos => boxes.some(box => pos.every((n, i) => n >= box.min[i] && n <= box.max[i] + 1));
  const events = [];
  function visit(tag, tick, parent, inheritedDimension) {
    const type = tag.type;
    if (typeof type !== 'string' || !type) throw Error('录制中存在没有类型的事件。');
    const children = array(tag.children ?? [], 'event.children');
    const eventDimension = tag.dimension || inheritedDimension;
    const hasPosition = axes.some(axis => Object.hasOwn(tag, axis));
    const world = hasPosition ? axes.map(axis => Math.floor(tag[axis])) : null;
    if (world && !world.every(Number.isSafeInteger)) throw Error(`${type} 的事件坐标无效。`);
    // Updates in this fork can omit their own dimension. Use their enclosing
    // levelTick/setBlock, or the sole dimension of a one-dimension recording.
    if (world && !eventDimension && dimensions.size > 1 && contains(world)) {
      throw Error(`多维度录制包含无法确定维度的 ${type} 事件，请使用单维度录制。`);
    }
    let inArea = !world || contains(world);
    if (world && typeof tag.entityUuid === 'string') {
      inArea = actorInArea([tag.x, tag.y, tag.z])
        || (actors.isActive(tag) && ((type === 'entitySpawn' && tag.despawn)
          || (['entityMove', 'entityCollideAxis'].includes(type) && actorInArea([tag.oldX, tag.oldY, tag.oldZ]))));
    }
    const include = (!eventDimension || eventDimension === dimension) && inArea;
    let nextParent = parent;
    if (include) {
      const event = { tick, type, stage: children.length ? 'enter' : 'leaf' };
      if (parent !== undefined) event.parent = parent;
      if (world) event.pos = local(world);
      const description = detail(tag);
      if (typeof description === 'string' && description) event.detail = description;
      if (type === 'setBlock') {
        if (!world) throw Error('setBlock 缺少位置。');
        if (tag.succeed === 0 || tag.succeed === false) event.detail = '写入失败';
        else {
          event.before = fromId(tag.oldStateId);
          event.after = fromId(tag.newStateId);
        }
      }
      if (type === 'movingPiston' || type === 'movingPistonTick') {
        if (!world) throw Error(`${type} 缺少位置。`);
        event.piston = tag.despawn ? null : piston(fromId(tag.stateId ?? tag.movedBlockStateId),
          tag.directionId, tag.extending, tag.isSourcePiston, tag.progress ?? 0);
      }
      actors.apply(tag, event);
      nextParent = events.length;
      events.push(event);
    }
    // EXIT is bookkeeping in MTR's visible timeline. ENTER (including
    // successful setBlock) runs before its children, once only.
    for (const child of children) visit(child, tick, nextParent, eventDimension);
  }
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.tick)) throw Error('帧的游戏刻无效。');
    for (const tag of array(frame.events, 'frame.events')) visit(tag, frame.tick);
  }
  // A snapshot can stay unchanged for many ticks before its first event or after its last.
  // Older appended recordings can reset the tick counter, so retain their segment ordering.
  const monotonic = frames.every((frame, i) => i === 0 || frame.tick >= frames[i - 1].tick);
  const tickRange = frames.length && monotonic ? [frames[0].tick, frames.at(-1).tick] : undefined;
  return { version: 1, minecraftVersion, dimension, ...(tickRange ? { tickRange } : {}), origin, palette, blocks: [...blocks.values()],
    pistons: [...pistons.values()], ...(actors.players.length ? { players: actors.players } : {}),
    ...(actors.entities.length ? { entities: actors.entities } : {}), events, bookmarks: {} };
}

const usage = '用法：node scripts/mc-export.mjs <录制目录> <输出 scene.json> --minecraft <游戏版本> [--registry <blocks.json>] [--dimension minecraft:overworld] [--skin-cache <assets/skins>]';
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    minecraft: { type: 'string' }, registry: { type: 'string' }, dimension: { type: 'string' },
    'skin-cache': { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 2 || !values.minecraft) throw Error(usage);
  const [source, destination] = positionals;
  const readNbt = async filename => {
    try { return readRecordingNbt(await readFile(join(source, filename))); }
    catch (error) { throw Error(`${filename}：${error.message}`); }
  };
  const [profile, record, registry] = await Promise.all([
    readNbt('profile.dat'), readNbt('record.dat'), readStateRegistry(values.minecraft, values.registry)
  ]);
  const diagnostics = {};
  const scene = exportScene(profile, record, registry, values.minecraft, values.dimension, diagnostics);
  await attachPlayerSkins(scene, source, values['skin-cache']);
  validateScene(scene);
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.mc-export-${randomUUID()}.tmp`);
  try {
    // Keep author-edited bookmarks on their own line, even for large captures.
    const fields = Object.entries(scene).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
    await writeFile(temporary, `{\n${fields.join(',\n')}\n}\n`, { flag: 'wx' });
    // Publish a complete file, without overwriting author-added bookmarks,
    // even when two exports finish concurrently.
    try { await link(temporary, output); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error(`输出已存在，请选择新路径，以保留原场景及书签：${output}`);
      throw error;
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(`已导出 ${scene.blocks.length} 个方块、${scene.events.length} 个事件 → ${output}`);
  if (diagnostics.omittedEntities) console.log(`另有 ${diagnostics.omittedEntities} 条缺少类型或身份的实体快照未导出。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
