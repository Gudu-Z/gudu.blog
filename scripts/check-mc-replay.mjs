import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createReplay, validateScene } from '../js/mc-replay.mjs';
import { readPalette, replayBounds, renderData } from '../js/mc-render-data.mjs';
import { adjacentCursor, createTickAxis, indexTicks, phaseStops, playbackCursor } from '../js/mc-timeline.mjs';
import { indexEventRows } from '../js/mc-event-list.mjs';
import { getDefaultSpeed, saveDefaultSpeed } from '../js/mc-playback-settings.mjs';
import { exportScene } from './mc-export.mjs';
import { readStateRegistry } from './mc-export-registry.mjs';

await test('seeking preserves nested tick order, failed writes and air across forward and backward jumps', () => {
  const block = { x: -9, y: 64, z: 2 };
  const set = (from, to, extra = {}) => ({
    type: 'setBlock', ...block, oldStateId: from, newStateId: to, ...extra,
  });
  const palette = ['minecraft:air', 'minecraft:redstone_lamp[lit=false]', 'minecraft:redstone_lamp[lit=true]'];
  const record = { areas: [{ dimension: 'minecraft:overworld', blocks: [{ ...block, stateId: 1 }] }] };
  const profile = { frames: [{ tick: 12, events: [{
    type: 'update', updateName: 'NeighbourUpdate', ...block, children: [
      set(1, 2, { succeed: false }), set(1, 2), set(2, 0),
    ],
  }] }] };
  const scene = validateScene(exportScene(profile, record, palette, '1.21.10'));
  assert.deepEqual(scene.origin, [-9, 64, 2]);
  assert.deepEqual(scene.events.map(e => e.parent), [undefined, 0, 0, 0]);
  assert.ok(scene.events.every(e => e.tick === 12));
  assert.match(scene.events[1].detail, /失败/);
  const replay = createReplay(scene);
  for (const [step, state] of [[0, 1], [1, 1], [2, 1], [3, 2], [4, undefined], [0, 1], [4, undefined], [2, 1]]) {
    replay.seek(step);
    assert.equal(replay.blocks.get('0,0,0'), state);
  }
  const version = replay.revision;
  replay.seek(1);
  assert.equal(replay.revision, version, 'Notification-only seeks keep the same geometry.');
});

await test('piston progress, removal and bookmark seeking are reversible', () => {
  const piston = { state: 1, direction: 1, extending: true, source: false, progress: 0 };
  const scene = validateScene({ version: 1, dimension: 'minecraft:overworld', origin: [0,0,0],
    palette: ['minecraft:moving_piston[facing=up,type=normal]', 'minecraft:stone'],
    blocks: [[0,0,0,0]], pistons: [[0,0,0,piston]], bookmarks: { middle: { step: 1 } },
    events: [{ tick: 0, type: 'movingPistonTick', pos: [0,0,0], piston: { ...piston, progress: .5 } },
      { tick: 1, type: 'movingPiston', pos: [0,0,0], piston: null }] });
  const replay = createReplay(scene);
  replay.seek(2);
  assert.equal(replay.pistons.size, 0);
  replay.seek(scene.bookmarks.middle.step);
  assert.equal(replay.pistons.get('0,0,0').progress, .5);
  const palette = readPalette(scene.palette);
  const frame = renderData(palette, replayBounds(scene), replay.blocks, replay.pistons);
  assert.equal(frame.blocks.get(0), 0);
  assert.equal(frame.palette[0].properties.facing, 'up');
  const { id, nbt: tile } = frame.tileEntities[0];
  assert.equal(id, 'minecraft:piston');
  assert.equal(tile.progress, .5);
  assert.equal(tile.blockState.Name, 'minecraft:stone');
  replay.seek(0);
  assert.equal(replay.pistons.get('0,0,0').progress, 0);
  assert.throws(() => replay.seek(3));
  assert.throws(() => validateScene({ ...scene, bookmarks: { broken: { step: 3 } } }));
});

await test('native frames retain local positions and can be rendered after the replay moves on', () => {
  const scene = validateScene({
    version: 1, dimension: 'minecraft:overworld', origin: [100, 64, 200],
    palette: ['minecraft:air', 'minecraft:stone', 'minecraft:redstone_lamp[lit=true]'],
    blocks: [[-3, -1, 2, 1]],
    events: [{ tick: 1, type: 'setBlock', pos: [2, 1, -2], after: 2 },
      { tick: 2, type: 'setBlock', pos: [-3, -1, 2], after: 0 }],
  });
  const replay = createReplay(scene), palette = readPalette(scene.palette), bounds = replayBounds(scene);
  assert.deepEqual(bounds, { minX: -3, minY: -1, minZ: -2, maxX: 2, maxY: 1, maxZ: 2, width: 6, height: 3, depth: 5 });
  const frame = () => renderData(palette, bounds, replay.blocks, replay.pistons);
  const initial = frame();
  replay.seek(2);
  const changed = frame();
  assert.deepEqual([...initial.blocks], [[24, 1]]);
  assert.deepEqual([...changed.blocks], [[65, 2]]);
  assert.equal(changed.palette[2].properties.lit, 'true');
  replay.seek(0);
  assert.deepEqual(frame().blocks, initial.blocks);
  assert.deepEqual([...changed.blocks], [[65, 2]]);
});

await test('the deployed engine resolves powered and unpowered lamps from the blog resource pack', async t => {
  const { AssetProvider, BlockModelResolver } = await import('../js/vendor/mc-engine.mjs');
  const packURL = new URL('../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url);
  const fetchPack = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), packURL.href);
    return new Response(await readFile(packURL));
  });
  const assets = new AssetProvider();
  const resources = await assets.ready();
  const models = new BlockModelResolver(assets);
  for (const [lit, texture] of [['false', 'block/redstone_lamp'], ['true', 'block/redstone_lamp_on']]) {
    const model = await models.resolve('minecraft:redstone_lamp', { lit });
    assert.equal(model.quads.length, 6);
    assert.ok(model.quads.every(face => face.texKey === texture));
    assert.equal(Buffer.from(resources.png[texture], 'base64').readUInt32BE(), 0x89504e47);
  }
  await new AssetProvider().ready();
  assert.equal(fetchPack.mock.callCount(), 1);
});

await test('the bundled registry includes vanilla 1.21.10 state properties', async () => {
  const states = await readStateRegistry('1.21.10');
  assert.ok(states.includes('minecraft:redstone_lamp[lit=true]'));
  assert.ok(states.includes('minecraft:redstone_lamp[lit=false]'));
  assert.equal(states[0], 'minecraft:air');
});

await test('timeline keeps contiguous game ticks in recording order and resets hierarchy at boundaries', () => {
  const events = [
    { tick: 25 }, { tick: 25, parent: 0 }, { tick: 25, parent: 1 },
    { tick: 65 }, { tick: 65, parent: 3 }, { tick: 25, parent: 0 },
  ];
  const { groups, depths } = indexTicks(events);
  assert.deepEqual(groups, [{ tick: 25, first: 1, last: 3 }, { tick: 65, first: 4, last: 5 }, { tick: 25, first: 6, last: 6 }]);
  assert.deepEqual([...depths], [0, 1, 2, 0, 1, 0]);
  assert.deepEqual(indexTicks([]).groups, []);
});

await test('playback uses 20 gt/s, accepts an article speed, and only persists an explicit reader default', () => {
  const storage = new Map();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  } });
  try {
    assert.equal(getDefaultSpeed(), 20);
    assert.equal(getDefaultSpeed(2.5), 2.5);
    assert.equal(getDefaultSpeed(-3), 20);
    assert.equal(saveDefaultSpeed(8.5), true);
    assert.equal(getDefaultSpeed(4), 8.5);
    for (const value of [0, -1, NaN, Infinity]) assert.equal(saveDefaultSpeed(value), false);
    assert.equal(getDefaultSpeed(), 8.5);
    assert.equal(saveDefaultSpeed(null), true);
    assert.equal(getDefaultSpeed(4), 4);
    window.localStorage.getItem = () => { throw new Error('Storage blocked'); };
    window.localStorage.setItem = window.localStorage.getItem;
    assert.equal(getDefaultSpeed(2.5), 2.5);
    assert.equal(saveDefaultSpeed(12), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
});

await test('export keeps leading and trailing empty recorded ticks and accepts legacy appended segments', () => {
  const source = { areas: [{ dimension: 'minecraft:overworld', blocks: [{ x: 1, y: 2, z: 3, stateId: 1 }] }] };
  const palette = ['minecraft:air', 'minecraft:stone'];
  const exportFrames = frames => validateScene(exportScene({ frames }, source, palette, '1.21.10'));
  const empty = tick => ({ tick, events: [] });
  const update = tick => ({ tick, events: [{ type: 'phase', phaseName: 'ScheduledTickPhase' }] });
  const scene = exportFrames([empty(0), update(25), update(199), empty(200)]);
  assert.deepEqual(scene.tickRange, [0, 200]);
  assert.deepEqual(scene.events.map(event => event.tick), [25, 199]);
  assert.deepEqual(exportFrames([empty(10), empty(20)]).tickRange, [10, 20]);
  assert.throws(() => validateScene({ ...scene, tickRange: [30, 200] }), /tickRange/);
  assert.throws(() => validateScene({ ...scene, tickRange: [0, 20] }), /tickRange/);
  assert.throws(() => validateScene({ ...scene, tickRange: [200, 0] }), /tickRange/);
  const appended = exportFrames([update(10), update(20), update(1)]);
  assert.equal(appended.tickRange, undefined);
  assert.deepEqual(appended.events.map(event => event.tick), [10, 20, 1]);
});

await test('the continuous event list maps every tick, visible phase and microstep without paging', () => {
  const groups = [{ tick: 2, first: 1, last: 3 }, { tick: 4, first: 4, last: 4 }];
  const rows = mode => indexEventRows(groups, [2, 4], [1, 3, 4], 4, mode, 0, 5);
  const labels = model => Array.from({ length: model.length }, (_, i) => {
    const row = model.rowAt(i);
    return row.step === undefined ? 't' + row.tick : 's' + row.step;
  });
  assert.deepEqual(labels(rows('tick')), ['t0', 't1', 't2', 't3', 't4', 't5']);
  assert.deepEqual(labels(rows('phase')), ['t0', 't1', 't2', 's1', 's3', 't3', 't4', 's4', 't5']);
  assert.deepEqual(labels(rows('event')), ['t0', 't1', 't2', 's1', 's2', 's3', 't3', 't4', 's4', 't5']);
  assert.equal(rows('phase').selectedRow(2, 2), 3);
  assert.equal(rows('event').selectedRow(2, 2), 4);
  assert.equal(rows('event').selectedRow(3, 3), 6);
  const longGap = indexEventRows([], [], [], 0, 'event', 0, 1_000_000);
  assert.equal(longGap.length, 1_000_001);
  assert.equal(longGap.rowAt(999_999).tick, 999_999);
});

await test('tick-time playback preserves blank frames and the real duration independently of event density', () => {
  const events = [
    { tick: 2, type: 'phase' }, { tick: 2, type: 'setBlock' },
    { tick: 2, type: 'levelTick' }, { tick: 2, type: 'setBlock' }, { tick: 5, type: 'setBlock' },
  ];
  const { groups } = indexTicks(events);
  const axis = createTickAxis(groups, [0, 6]);
  const phases = phaseStops(events, groups);
  assert.deepEqual(phases, [1, 3, 5]);
  assert.deepEqual(axis.offsets, [2, 5]);
  assert.equal(axis.maxOffset, 6);
  const stepsAt = (mode, times) => times.map(time => playbackCursor(axis, phases, time, mode).step);
  const times = [0, 1.9, 2, 2.26, 2.51, 2.8, 3, 4.99, 5, 6, 7];
  assert.deepEqual(stepsAt('event', times), [0, 0, 1, 2, 3, 4, 4, 4, 5, 5, 5]);
  assert.deepEqual(stepsAt('phase', times), [0, 0, 1, 1, 3, 3, 4, 4, 5, 5, 5]);
  assert.deepEqual(stepsAt('tick', times), [0, 0, 4, 4, 4, 4, 4, 4, 5, 5, 5]);
  assert.deepEqual(axis.at(3), { offset: 3, tick: 3, groupIndex: -1, step: 4 });
  assert.deepEqual(axis.forStep(4, 3), axis.at(3), 'an empty tick can be shared with the previous state');
  assert.equal(axis.forStep(3, 4).tick, 2, 'a gap hint must agree with the stored microstep');
  assert.deepEqual(axis.forStep(0, 1), axis.at(1));
  assert.deepEqual(adjacentCursor(axis, phases, axis.at(2), 'tick', 1), axis.at(3));
  assert.equal(adjacentCursor(axis, phases, axis.forStep(1), 'phase', 1).step, 3);
  assert.equal(adjacentCursor(axis, phases, axis.forStep(1), 'event', 1).step, 2);
  assert.equal(adjacentCursor(axis, phases, axis.at(3), 'event', -1).step, 4);

  const reset = createTickAxis(indexTicks([{ tick: 10 }, { tick: 12 }, { tick: 3 }]).groups);
  assert.deepEqual([0, 1, 2, 3].map(offset => reset.at(offset).tick), [10, 11, 12, 3]);
  const empty = createTickAxis([], [31, 33]);
  assert.deepEqual(playbackCursor(empty, [], 2, 'event'), { offset: 2, tick: 33, groupIndex: -1, step: 0 });
});

await test('a late render and coarse stepping converge on the same state as every raw event', () => {
  const scene = validateScene({ version: 1, dimension: 'minecraft:overworld', origin: [0, 0, 0],
    tickRange: [3, 9], palette: ['minecraft:air', 'minecraft:stone'], blocks: [], events: [
      { tick: 3, type: 'phase' }, { tick: 3, type: 'setBlock', pos: [0,0,0], after: 1 },
      { tick: 5, type: 'phase' }, { tick: 5, type: 'setBlock', pos: [1,0,0], after: 1 },
      { tick: 6, type: 'setBlock', pos: [0,0,0], after: 0 },
      { tick: 9, type: 'phase' }, { tick: 9, type: 'setBlock', pos: [2,0,0], after: 1 },
    ] });
  const { groups } = indexTicks(scene.events);
  const axis = createTickAxis(groups, scene.tickRange);
  const phases = phaseStops(scene.events, groups);
  const direct = createReplay(scene);
  for (let step = 0; step <= scene.events.length; step++) direct.seek(step);
  for (const mode of ['phase', 'tick', 'event']) {
    const replay = createReplay(scene);
    for (const time of [0.1, 2.15, 6.2, 7]) replay.seek(playbackCursor(axis, phases, time, mode).step);
    assert.equal(replay.step, scene.events.length);
    assert.deepEqual([...replay.blocks.entries()].sort(), [...direct.blocks.entries()].sort());
    assert.equal(replay.blocks.has('0,0,0'), false);
    assert.equal(replay.blocks.get('2,0,0'), 1, 'last leaf of final tick must be applied even in phase mode');
  }
});
