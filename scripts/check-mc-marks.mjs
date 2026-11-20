import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxEdgeSides, entryPoint, lockOnFrame, lockOnPath } from '../js/mc-viewer.mjs';
import { eventSource } from '../js/mc-replay.mjs';
import { eventKind, eventPending } from '../js/mc-event-list.mjs';
import { cellLines, markerCells } from '../js/mc-markers.mjs';
import { readPalette } from '../js/mc-render-data.mjs';

const unit = { min: [0, 0, 0], max: [1, 1, 1] };

await test('a box seen from above a corner shows nine edges and hides three', () => {
  const { visible, hidden } = boxEdgeSides(unit.min, unit.max, [3, 2, 4], null);
  assert.equal(visible.length, 9);
  // The three edges meeting at the far, low corner (corner 0: min x, y, z).
  assert.deepEqual(hidden, [[0, 1], [0, 2], [0, 4]]);
});

await test('looking straight at one face shows only that face\'s four edges', () => {
  const { visible, hidden } = boxEdgeSides(unit.min, unit.max, [5, .5, .5], null);
  assert.deepEqual(visible, [[1, 3], [1, 5], [3, 7], [5, 7]]);
  assert.equal(hidden.length, 8);
});

await test('an orthographic camera decides by the way it looks', () => {
  const { visible, hidden } = boxEdgeSides(unit.min, unit.max, null, [-1, -1, -1]);
  assert.equal(visible.length, 9);
  assert.deepEqual(hidden, [[0, 1], [0, 2], [0, 4]]);
});

await test('a cause\'s arrow ends on the face it comes in through', () => {
  // From the centre of the block east of the unit block: the shared face.
  assert.deepEqual(entryPoint([1.5, .5, .5], unit.min, unit.max), [1, .5, .5]);
  // From two blocks up: the top face's centre.
  assert.deepEqual(entryPoint([.5, 2.5, .5], unit.min, unit.max), [.5, 1, .5]);
  // From a diagonal, the last slab the line enters decides the face.
  const point = entryPoint([3.5, .5, 1.5], unit.min, unit.max);
  assert.equal(point[0], 1);
  assert.ok(point[2] > .5 && point[2] < 1);
});

await test('updates split into neighbour and shape kinds, and queued work is pending', () => {
  assert.equal(eventKind({ type: 'update', detail: 'NeighbourUpdate' }), 'neighbour');
  assert.equal(eventKind({ type: 'update', detail: 'ShapeUpdate' }), 'shape');
  assert.equal(eventKind({ type: 'setBlock', detail: '写入失败' }), 'set');
  assert.equal(eventKind({ type: 'queue', detail: 'ExecuteBlockTick' }), 'tick');
  assert.equal(eventKind({ type: 'queue', detail: 'ExecuteBlockEvent' }), 'event');
  assert.equal(eventKind({ type: 'movingPistonTick' }), 'piston');
  assert.equal(eventKind({ type: 'postGameEvent' }), 'game');
  assert.equal(eventPending({ type: 'addScheduleTick' }), true);
  assert.equal(eventPending({ type: 'addBlockEvent' }), true);
  assert.equal(eventPending({ type: 'queue', detail: 'ExecuteBlockTick' }), false);
});

await test('an event\'s source is the nearest ancestor somewhere else, stopping at phases', () => {
  const replay = { players: new Map(), entities: new Map() };
  const scene = { events: [
    { type: 'phase', detail: 'BlockEventPhase' },
    { type: 'setBlock', pos: [0, 0, 0], parent: 0, after: 1 },
    { type: 'update', detail: 'ShapeUpdate', pos: [1, 0, 0], parent: 1, stage: 'enter' },
    { type: 'update', detail: 'ShapeUpdate', pos: [1, 0, 0], parent: 2, stage: 'leaf' },
    { type: 'update', detail: 'NeighbourUpdate', pos: [2, 0, 0], parent: 0 },
    { type: 'entityMove', actorId: 'entity-1', pos: [5, 0, 0], parent: 1 },
    { type: 'setBlock', pos: [6, 0, 0], parent: 5, after: 2 },
  ] };
  // The handled update skips its same-cell twin back to the write next door.
  assert.equal(eventSource(scene, replay, scene.events[3]).event, scene.events[1]);
  assert.deepEqual(eventSource(scene, replay, scene.events[3]).block, [0, 0, 0]);
  assert.equal(eventSource(scene, replay, scene.events[2]).event, scene.events[1]);
  // Inside a phase only: no source.
  assert.equal(eventSource(scene, replay, scene.events[4]), null);
  assert.equal(eventSource(scene, replay, scene.events[1]), null);
  // An actor can be the source, and has one.
  assert.equal(eventSource(scene, replay, scene.events[6]).actorId, 'entity-1');
  assert.deepEqual(eventSource(scene, replay, scene.events[5]).block, [0, 0, 0]);
  // A phase itself has no target and so no source.
  assert.equal(eventSource(scene, replay, scene.events[0]), null);
});

// The current target's rectangle on screen, in stage pixels.
const box = { left: 100, right: 150, top: 70, bottom: 100 };

await test('four lock-on corners close around the current screen rectangle', () => {
  assert.equal(lockOnPath(box, lockOnFrame(0).offset),
    'M80,40H70V50M170,40H180V50M170,130H180V120M80,130H70V120');
  assert.equal(lockOnPath(box, lockOnFrame(220).offset),
    'M106,66H96V76M144,66H154V76M144,104H154V94M106,104H96V94');
});

await test('small or thin targets limit each arm to 35 percent of the shorter side', () => {
  assert.equal(lockOnPath({ left: 100, right: 110, top: 70, bottom: 100 }, 4),
    'M99.5,66H96V69.5M110.5,66H114V69.5M110.5,104H114V100.5M99.5,104H96V100.5');
  assert.equal(lockOnPath({ left: 100, right: 150, top: 70, bottom: 80 }, 4),
    'M99.5,66H96V69.5M150.5,66H154V69.5M150.5,84H154V80.5M99.5,84H96V80.5');
});

await test('the lock-on eases out, holds still, and fades to zero', () => {
  assert.deepEqual(lockOnFrame(0), { offset: 30, opacity: 1 });
  const middle = lockOnFrame(110);
  assert.ok(middle.offset > 4 && middle.offset < 17);
  assert.equal(middle.opacity, 1);
  for (const elapsed of [220, 440, 670]) {
    assert.deepEqual(lockOnFrame(elapsed), { offset: 4, opacity: 1 });
  }
  assert.deepEqual(lockOnFrame(795), { offset: 4, opacity: .5 });
  for (const elapsed of [920, 1100]) {
    assert.deepEqual(lockOnFrame(elapsed), { offset: 4, opacity: 0 });
  }
});

await test('marker blocks take their game icons and moving pistons their cells', () => {
  const palette = readPalette(['minecraft:air', 'minecraft:barrier', 'minecraft:light[level=7,waterlogged=false]',
    'minecraft:light[level=15,waterlogged=true]', 'minecraft:structure_void', 'minecraft:moving_piston[facing=east,type=normal]',
    'minecraft:stone']);
  const blocks = new Map([['0,0,0', 1], ['1,0,0', 2], ['2,0,0', 3], ['3,0,0', 4], ['4,0,0', 5], ['5,0,0', 5], ['6,0,0', 6]]);
  const pistons = new Map([['4,0,0', { progress: .5 }]]);
  assert.deepEqual(markerCells(palette, blocks, pistons), [
    { key: '0,0,0', icon: 'item/barrier' },
    { key: '1,0,0', icon: 'item/light_07' },
    { key: '2,0,0', icon: 'item/light_15' },
    { key: '3,0,0', icon: 'item/structure_void' },
    { key: '4,0,0', moving: true, carried: true },
    { key: '5,0,0', moving: true, carried: false },
  ]);
});

await test('a moving piston cell gets corner marks, or its whole outline when nothing moves into it', () => {
  const corners = cellLines([2, 3, 4], false);
  // Eight corners, three quarter-block arms each, two points of three numbers.
  assert.equal(corners.length, 8 * 3 * 6);
  const whole = cellLines([2, 3, 4], true);
  assert.equal(whole.length, 12 * 6);
  // A hair outside the cell on every side.
  const xs = whole.filter((_, i) => i % 3 === 0);
  assert.ok(Math.min(...xs) < 2 && Math.min(...xs) > 1.98 && Math.max(...xs) > 3 && Math.max(...xs) < 3.02);
  // Each arm is a quarter of a block long.
  const [ax, ay, az, bx, by, bz] = corners;
  assert.ok(Math.abs(Math.hypot(bx - ax, by - ay, bz - az) - .25) < 1e-9);
});
