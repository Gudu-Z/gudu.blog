import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachPlayerSkins } from './mc-player-skins.mjs';
import { readRecordingNbt } from './mc-export-nbt.mjs';
import { createReplayHitboxes, replayEntityBounds } from '../js/mc-entity-hitboxes.mjs';
import { Group } from '../js/vendor/mc-engine.mjs';
import { createReplay, eventTarget, validateScene } from '../js/mc-replay.mjs';
import { createCameraFollow } from '../js/mc-camera-follow.mjs';
import { readPalette, replayBounds, renderData } from '../js/mc-render-data.mjs';
import { adjacentCursor, createTickAxis, indexTicks, phaseStops, playbackCursor, timeFor } from '../js/mc-timeline.mjs';
import { branchShapes, indexEventRows, visibleSteps } from '../js/mc-event-list.mjs';
import { fromClockRate, getDefaultPlayback, normalizeSpeedUnit, saveDefaultPlayback, toClockRate } from '../js/mc-playback-settings.mjs';
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

await test('camera tracks use the recorded move step and keep each following area independent across seeks', () => {
  const area = (name, x, y, z) => ({ name, x1: x, y1: y, z1: z, x2: x + 1, y2: y + 2, z2: z + 3 });
  const start = area('机头', 30, -7, 9), east = area('机头', 31, -7, 9);
  const tail = area('机尾', 40, -7, 9), raised = area('机尾', 40, -6, 9);
  const move = (before, after) => ({ type: 'areaMove', before, after });
  const record = { areas: [{ dimension: 'minecraft:overworld', blocks: [{ x: 30, y: -7, z: 9, stateId: 1 }] }] };
  const profile = { frames: [{ tick: 8, events: [
    { type: 'phase', children: [move(start, east), move(tail, raised)] },
    move(east, start),
  ] }] };
  const scene = validateScene(exportScene(profile, record, ['minecraft:air', 'minecraft:slime_block'], '1.21.10'));
  assert.deepEqual(scene.events[1].areaMove, { name: '机头', from: [[0,0,0],[1,2,3]], to: [[1,0,0],[2,2,3]] });
  const replay = createReplay(scene);
  assert.deepEqual(replay.followAreas, ['机头', '机尾']);
  for (const [step, dx, dy] of [[4,0,1],[0,0,0],[2,1,0],[3,1,1],[1,0,0]]) {
    replay.seek(step);
    assert.deepEqual(replay.followOffsetAt('机头', step), [dx,0,0]);
    assert.deepEqual(replay.followOffsetAt('机尾', step), [0,dy,0]);
    assert.equal(replay.revision, 0);
  }
  const legacy = { ...scene, events: [{ tick: 8, type: 'areaMove', pos: [5,0,0] }] };
  assert.deepEqual(createReplay(validateScene(legacy)).followAreas, []);
  assert.throws(() => validateScene({ ...scene, events: [{ tick: 8, type: 'areaMove', areaMove: { name: '机头', from: [], to: [] } }] }), /areaMove/);
});

await test('camera follow eases on the frame clock, redirects from the visible pose and seeks exactly', () => {
  let now = 0, nextFrame = 0;
  const pending = new Map();
  const clock = {
    performance: { now: () => now },
    requestAnimationFrame(callback) { pending.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { pending.delete(id); },
  };
  function advance(ms) {
    now += ms;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(now);
  }
  const position = [0, 0, 0];
  const follow = createCameraFollow((x, y, z) => {
    position[0] += x;
    position[1] += y;
    position[2] += z;
  }, clock);
  follow.to([8, -4, 2], 100);
  advance(25);
  assert.deepEqual(position, [1.25, -.625, .3125]);
  assert.deepEqual(follow.offset, position);
  follow.to([8, -4, 2], 100);
  follow.to(null);
  advance(25);
  assert.deepEqual(position, [4, -2, 1], 'presenting the same move again keeps its original start time');
  follow.to([-4, 2, 3], 100);
  assert.deepEqual(position, [4, -2, 1]);
  advance(50);
  assert.deepEqual(position, [0, 0, 2], 'a new target starts from the displayed translation');
  advance(300);
  assert.deepEqual(position, [-4, 2, 3], 'a late frame lands exactly on all three axes');
  assert.equal(pending.size, 0);

  follow.to([4, 2, 3], 100);
  advance(50);
  assert.deepEqual(follow.hold(), [0, 2, 3]);
  advance(100);
  assert.deepEqual(position, [0, 2, 3], 'a fixed camera stops mid-move');
  follow.to([4, 2, 3], 100);
  advance(25);
  follow.finish();
  assert.deepEqual(position, [4, 2, 3], 'pausing uses the exact recorded offset');
  follow.to([8, 2, 3], 100);
  advance(25);
  follow.to([8, 2, 3], 0);
  assert.deepEqual(position, [8, 2, 3], 'seeking to the active target cancels the remaining motion');
  follow.to([12, 2, 3], 100);
  follow.reset([40, 0, 0]);
  advance(200);
  assert.deepEqual(position, [8, 2, 3], 'restoring the camera externally only resets the follow baseline');
  follow.to([38, 0, 0]);
  assert.deepEqual(position, [6, 2, 3]);
  assert.equal(pending.size, 0);
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

await test('the NBT reader retains the four UUID ints that link player proxies to movement events', () => {
  const words = Buffer.alloc(16);
  [1, -1, 0x40008000, 2].forEach((word, i) => words.writeInt32BE(word, i * 4));
  const tag = key => Buffer.concat([
    Buffer.from([11, 0, key.length]), Buffer.from(key), Buffer.from([0, 0, 0, 4]), words,
  ]);
  const nbt = readRecordingNbt(Buffer.concat([
    Buffer.from([10, 0, 0]), tag('UUID'), tag('id'), Buffer.from([0]),
  ]));
  assert.deepEqual(nbt.UUID, [1, -1, 0x40008000, 2]);
  assert.deepEqual(nbt.id, nbt.UUID);
});

await test('players keep fractional poses and their own reversible lifecycle across entity events', () => {
  const uuidA = '00000001-0000-4000-8000-000000000001';
  const uuidB = '00000002-0000-4000-8000-000000000002';
  const still = { entityType: 'minecraft:player', entityUuid: uuidA, x: -0.75, y: 64.1, z: 1.5 };
  const move = { ...still, type: 'entityMove', y: 64.25, yaw: 90, pitch: -15 };
  const join = { ...still, type: 'entitySpawn', entityUuid: uuidB, x: 0.125, yaw: 35, pitch: 5 };
  const profile = { frames: [{ tick: 0, events: [{ ...still, type: 'entityTick' }, move] },
    { tick: 1, events: [join, { ...move, type: 'entitySpawn', despawn: true }] }] };
  const snap = { id: 'minecraft:mannequin', UUID: uuidA, Pos: [-0.75, 64.1, 1.5], Rotation: [10, 5] };
  const blocks = [{ x: -1, y: 64, z: 1, stateId: 1 }, { x: 0, y: 65, z: 2, stateId: 0 }];
  const area = { entities: [snap], blocks, dimension: 'minecraft:overworld' };
  const scene = validateScene(exportScene(profile, { areas: [area, area] }, ['minecraft:air', 'minecraft:stone'], '1.21.10'));
  assert.equal(scene.players.length, 1);
  assert.ok(!JSON.stringify(scene).includes(uuidA));
  const initial = scene.players[0];
  assert.equal(initial.pos[0], .25);
  assert.equal(initial.yaw, 10);
  const replay = createReplay(scene);
  replay.seek(1);
  assert.equal(replay.playerRevision, 0);
  assert.deepEqual(replay.players.get(initial.id), initial);
  replay.seek(2);
  assert.deepEqual(replay.players.get(initial.id).pos, [.25, .25, .5]);
  assert.equal(replay.players.get(initial.id).pitch, -15);
  replay.seek(4);
  const second = scene.events[2].player.id;
  assert.deepEqual([...replay.players.keys()], [second]);
  replay.seek(3);
  assert.equal(replay.players.size, 2);
  replay.seek(0);
  assert.deepEqual([...replay.players.values()], [initial]);
  assert.equal(replay.revision, 0, 'Player transforms do not invalidate the block meshes.');
  assert.throws(() => validateScene({ ...scene, players: [initial, initial] }));
});

await test('entity ticks select the recorded actor across movement, despawn and backward seeks', () => {
  const key = '00000001-0000-4000-8000-000000000001';
  const entityType = 'minecraft:pig';
  const pos = [10.25, 64, -1.5];
  const snapshot = { UUID: key, id: entityType, Pos: pos, Rotation: [0, 0], Age: -24000 };
  const tag = { entityUuid: key, entityType, x: pos[0], y: pos[1], z: pos[2] };
  const area = { dimension: 'minecraft:overworld', entities: [snapshot], blocks: [
    { x: 10, y: 64, z: -2, stateId: 0 }, { x: 11, y: 65, z: -1, stateId: 0 },
  ] };
  const events = [{ ...tag, type: 'entityTick' }, { ...tag, type: 'entityMove', x: 10.75, yaw: 90 },
    { ...tag, type: 'entitySpawn', despawn: true }, { ...tag, type: 'entitySpawn' }];
  const scene = validateScene(exportScene({ frames: [{ tick: 1, events }] }, { areas: [area, area] }, ['minecraft:air'], '1.21.10'));
  assert.equal(scene.entities.length, 1);
  const [actor] = scene.entities;
  assert.equal(actor.type, entityType);
  assert.equal(actor.nbt.Age, -24000);
  assert.equal(JSON.stringify(scene).includes(key), false);
  assert.ok(scene.events.every(event => event.actorId === actor.id));
  assert.equal(scene.events[0].entity, undefined);
  const replay = createReplay(scene);
  replay.seek(1);
  assert.deepEqual(eventTarget(replay, replay.event), { actorId: actor.id });
  assert.equal(replay.entityRevision, 0);
  for (const [step, x] of [[2, .75], [3, undefined], [4, .25], [0, .25], [2, .75]]) {
    replay.seek(step);
    assert.equal(replay.entities.get(actor.id)?.pos[0], x);
  }
  assert.equal(replay.revision, 0);
  assert.equal(replay.playerRevision, 0);
  assert.deepEqual(eventTarget(replay, { type: 'blockEntityTick', pos: [1, 2, 3] }), { block: [1, 2, 3] });
});

await test('hitboxes use unscaled world axes and update the eye vector independently of movement and visibility', () => {
  const renderer = { scene: new Group(), requestRender() {} };
  const layer = createReplayHitboxes(renderer);
  const pose = { id: 'player-1', pos: [5.25, 10.5, -3.75], yaw: 0, pitch: 0 };
  const update = state => layer.sync(new Map([[state.id, state]]), new Map());
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`);
  update(pose);
  const base = layer.boundsFor(pose.id);
  [.6, 1.8, .6].forEach((width, axis) => close(base.max[axis] - base.min[axis], width));
  close(base.min[1], pose.pos[1]);
  const line = renderer.scene.getObjectByName('entity-hitbox');
  const points = line.geometry.getAttribute('position');
  const start = points.count - 6;
  close(points.getY(start), 1.62);
  close(points.getZ(start + 1), 2);
  update({ ...pose, yaw: 90, pitch: 30 });
  assert.deepEqual(layer.boundsFor(pose.id), base);
  close(points.getX(start + 1), -Math.sqrt(3));
  close(points.getY(start + 1), .62);
  layer.setVisible(false);
  update({ ...pose, pos: [5.25, 11.5, -3.75] });
  layer.setVisible(true);
  assert.equal(renderer.scene.getObjectByName('entity-hitbox'), line);
  close(layer.boundsFor(pose.id).min[1], 11.5);
  update({ ...pose, nbt: { Pose: 'crouching' } });
  const crouched = layer.boundsFor(pose.id);
  close(crouched.max[1] - crouched.min[1], 1.5);
  const crouchedPoints = renderer.scene.getObjectByName('entity-hitbox').geometry.getAttribute('position');
  close(crouchedPoints.getY(crouchedPoints.count - 6), 1.27);
  update({ ...pose, nbt: { Invisible: 1 } });
  assert.equal(layer.boundsFor(pose.id), null);
  update(pose);
  assert.deepEqual(layer.boundsFor(pose.id), base);
  assert.equal(replayEntityBounds({ ...pose, type: 'example:unknown' }), null);
  layer.sync(new Map(), new Map());
  assert.equal(layer.boundsFor(pose.id), null);
  layer.destroy();
  assert.equal(renderer.scene.children.length, 0);
});

await test('player skin export uses the Java cache key and embeds the matching PNG exactly once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-player-skin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = JSON.parse(await readFile(new URL('../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url)));
  const png = Buffer.from(catalog.png['entity/player/wide/steve'], 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const key = createHash('sha1').update(hash, 'utf16le').digest('hex');
  const cache = join(dir, 'assets', 'skins', key.slice(0, 2));
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, key), png);
  const scene = { players: [{ skin: hash }], events: [{ player: { skin: hash } }] };
  await attachPlayerSkins(scene, join(dir, 'versions', 'game', 'config', 'mtr', 'recording'));
  assert.deepEqual(scene.skins, { [hash]: png.toString('base64') });
});

await test('export resolves only a recorded account, embeds its skin once, and keeps replay and account UUIDs private', async () => {
  const account = 'abcd1234-1234-4abc-8abc-abcde1234567';
  const proxy = '11111111-1234-3abc-8abc-000000000001';
  const unknownProxy = '22222222-1234-3abc-8abc-000000000002';
  const snapshot = { id: 'minecraft:mannequin', Pos: [0, 1, 0], UUID: proxy, profile: { id: account, name: 'private-test-name' } };
  const move = { type: 'entityMove', entityType: 'minecraft:player', entityUuid: proxy, x: .5, y: 1, z: 0 };
  const area = { dimension: 'minecraft:overworld', blocks: [{ x: 0, y: 1, z: 0, stateId: 0 }],
    entities: [snapshot, { ...snapshot, UUID: unknownProxy, profile: undefined }] };
  const diagnostics = {};
  const scene = exportScene({ frames: [{ tick: 1, events: [move, { ...move, entityUuid: unknownProxy }] }] },
    { areas: [area] }, ['minecraft:air'], '1.21.10', area.dimension, diagnostics);
  assert.deepEqual([...diagnostics.playerAccounts.values()], [account]);
  const catalog = JSON.parse(await readFile(new URL('../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url)));
  const png = Buffer.from(catalog.png['entity/player/slim/alex'], 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const url = 'https://textures.minecraft.net/texture/' + hash;
  const data = { textures: { SKIN: { url, metadata: { model: 'slim' } } } };
  const property = { name: 'textures', value: Buffer.from(JSON.stringify(data)).toString('base64') };
  const queries = [];
  const fetchImpl = async (address, options) => {
    queries.push(address);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (address === url) return new Response(png);
    return Response.json({ id: account.replaceAll('-', ''), properties: [property] });
  };
  await attachPlayerSkins(scene, '.', undefined, { accounts: diagnostics.playerAccounts, fetchImpl });
  assert.deepEqual(queries, ['https://sessionserver.mojang.com/session/minecraft/profile/' + account.replaceAll('-', ''), url]);
  for (const player of [scene.players[0], scene.events[0].player]) {
    assert.equal(player.skin, hash);
    assert.equal(player.model, 'slim');
  }
  assert.equal(scene.players[1].skin, undefined);
  assert.deepEqual(scene.skins, { [hash]: png.toString('base64') });
  const serialized = JSON.stringify(validateScene(scene));
  for (const secret of [account, proxy, unknownProxy, 'private-test-name']) assert.ok(!serialized.includes(secret));
});

await test('recorded player, mannequin and passenger skin hashes use the texture CDN without account queries', async () => {
  const catalog = JSON.parse(await readFile(new URL('../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url)));
  const png = Buffer.from(catalog.png['entity/player/wide/steve'], 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const url = 'https://textures.minecraft.net/texture/' + hash;
  const data = { textures: { SKIN: { url } } };
  const profile = { properties: [{ name: 'textures', value: Buffer.from(JSON.stringify(data)).toString('base64') }] };
  const actor = { nbt: { profile } };
  for (const scene of [
    { players: [{ id: 'p', skin: hash }], events: [] },
    { entities: [actor], events: [] },
    { events: [{ entity: actor }, { entity: actor }] },
    { events: [{ entity: { nbt: { Passengers: [{ id: 'minecraft:mannequin', profile }] } } }] },
  ]) {
    const queries = [];
    await attachPlayerSkins(scene, '.', undefined, { accounts: new Map([['p', 'abcd1234-1234-4abc-8abc-abcde1234567']]),
      fetchImpl: async address => { queries.push(address); return new Response(png); } });
    assert.deepEqual(queries, [url]);
    assert.deepEqual(scene.skins, { [hash]: png.toString('base64') });
  }
});

await test('failed player skin lookup or corrupt content falls back without publishing a texture', async t => {
  t.mock.method(console, 'warn', () => {});
  const hash = '1'.repeat(64);
  for (const respond of [() => { throw new TypeError('offline'); }, () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => new Response('unavailable', { status: 429 }), () => new Response('broken PNG'),
    () => new Response('excessive', { headers: { 'content-length': 2 ** 25 } })]) {
    const scene = { players: [{ skin: hash }, { skin: hash }], events: [] };
    let calls = 0;
    await attachPlayerSkins(scene, '.', undefined, { fetchImpl: async () => { calls++; return respond(); } });
    assert.equal(calls, 1);
    assert.equal(scene.skins, undefined);
  }
  const scene = { players: [{ id: 'offline' }, { id: 'a' }, { id: 'b' }], events: [] };
  const accounts = new Map([['offline', '11111111-1234-3abc-8abc-000000000001'], ['a', 'abcd1234-1234-4abc-8abc-abcde1234567'],
    ['b', 'abcd1234-1234-4abc-8abc-abcde1234568']]);
  const queries = [];
  await attachPlayerSkins(scene, '.', undefined, { accounts, fetchImpl: async url => {
    queries.push(url); return new Response(null, { status: 429 });
  } });
  assert.deepEqual(queries, ['https://sessionserver.mojang.com/session/minecraft/profile/abcd123412344abc8abcabcde1234567']);
  assert.equal(scene.skins, undefined);
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

await test('the local preview server serves the default resource pack as the original ZIP', { timeout: 10000 }, async t => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const exited = once(server, 'exit');
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
  });
  const lines = createInterface({ input: server.stdout });
  const [message] = await once(lines, 'line', { signal: t.signal });
  const address = new URL(message.match(/http:\/\/localhost:\d+/)[0]);
  address.hostname = '127.0.0.1';
  const path = '/assets/minecraft/resource-packs/xk-redstone-display-26.3.0.zip';
  const response = await fetch(new URL(path, address), { signal: t.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('..' + path, import.meta.url)));
});

await test('the deployed engine resolves powered and unpowered lamps from the blog resource pack', async t => {
  const { AssetProvider, BlockModelResolver } = await import('../js/vendor/mc-engine.mjs');
  const packURL = new URL('../assets/minecraft/vanilla-resources/vanilla.json', import.meta.url);
  const xkURL = new URL('../assets/minecraft/resource-packs/xk-redstone-display-26.3.0.zip', import.meta.url);
  const fetchPack = t.mock.method(globalThis, 'fetch', async url => {
    assert.ok([packURL.href, xkURL.href].includes(String(url)));
    return new Response(await readFile(url));
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
  assert.deepEqual(fetchPack.mock.calls.map(call => String(call.arguments[0])).sort(), [packURL.href, xkURL.href].sort());
  for (const power of ['0', '7', '15']) {
    const wire = await models.resolve('minecraft:redstone_wire', { north: 'side', south: 'side', east: 'none', west: 'none', power });
    assert.ok(wire.quads.some(q => q.texKey === 'block/redstone_dust_p' + power.padStart(2, '0')));
  }
});

await test('an unavailable default pack leaves the current figure on vanilla and the next figure can retry', async t => {
  const { AssetProvider } = await import('../js/vendor/mc-engine.mjs?pack-recovery');
  let attempts = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.pathname.endsWith('.zip')) {
      attempts++;
      if (attempts === 1) return new Response(null, { status: 404 });
      if (attempts === 2) return new Response('<html>not a resource pack</html>');
    }
    return new Response(await readFile(url));
  });
  const wire = 'blockstates/redstone_wire.json';
  const first = new AssetProvider(), concurrent = new AssetProvider();
  const [vanilla] = await Promise.all([first.ready(), concurrent.ready()]);
  assert.deepEqual(await concurrent.getJSON(wire), vanilla.json[wire]);
  assert.equal(attempts, 1);

  const invalidZip = new AssetProvider();
  assert.deepEqual(await invalidZip.getJSON(wire), vanilla.json[wire]);
  const recovered = new AssetProvider();
  const packed = await recovered.getJSON(wire);
  assert.ok(packed && JSON.stringify(packed).includes('redstone_dust_p07'));
  assert.deepEqual(await first.getJSON(wire), vanilla.json[wire]);
  assert.equal(attempts, 3);
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

await test('speed units round-trip through the same game clock', () => {
  for (const [raw, input, rate] of [['GT/s', 5, 5], ['s/gt', 0.2, 5], ['×', 0.25, 5], ['x', 2, 40], ['event/s', 3, 3], ['phase/s', .5, .5]]) {
    const unit = normalizeSpeedUnit(raw);
    assert.equal(toClockRate(input, unit), rate);
    assert.equal(fromClockRate(rate, unit), input);
  }
  assert.equal(toClockRate(20), 20);
  assert.equal(normalizeSpeedUnit('0'), undefined);
  assert.equal(toClockRate(Number.MIN_VALUE, 's/gt'), undefined);
  assert.equal(toClockRate(Number.MAX_VALUE, 'x'), undefined);
  assert.equal(toClockRate(Number.MAX_VALUE, 's/gt'), undefined);
  assert.equal(fromClockRate(Number.MIN_VALUE, 'x'), undefined);
});

await test('playback uses 20 gt/s, accepts an article speed, and only persists an explicit reader default', () => {
  const storage = new Map();
  const saveDefaultSpeed = value => saveDefaultPlayback(value, 'gt/s');
  const getDefaultSpeed = value => getDefaultPlayback(value).rate;
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
    assert.equal(saveDefaultPlayback(3.5, 'event/s'), true);
    assert.deepEqual(getDefaultPlayback(2, 'phase/s'), { rate: 3.5, unit: 'event/s' });
    assert.equal(saveDefaultPlayback(null), true);
    assert.deepEqual(getDefaultPlayback(2, 'phase/s'), { rate: 2, unit: 'phase/s' });
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

await test('the continuous event list maps every tick, open row and microstep without paging', () => {
  const groups = [{ tick: 2, first: 1, last: 3 }, { tick: 4, first: 4, last: 4 }];
  const shownAt = { tick: [], phase: [1, 3, 4], event: null };
  const rows = (mode, shown = shownAt[mode]) => indexEventRows(groups, [2, 4], shown, 4, mode, 0, 5);
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
  // A row is numbered by its place in the tick, whatever is folded above it.
  assert.deepEqual([3, 4].map(i => rows('phase').rowAt(i).ordinal), [1, 3]);
  // A tick opened at the tick level shows its rows; the cursor stays on its station.
  assert.deepEqual(labels(rows('tick', [1])), ['t0', 't1', 't2', 's1', 't3', 't4', 't5']);
  assert.equal(rows('tick', [1]).selectedRow(1, 2), 2);
  assert.equal(rows('tick', [1]).rowOf(1, 2), 3);
  const longGap = indexEventRows([], [], null, 0, 'event', 0, 1_000_000);
  assert.equal(longGap.length, 1_000_001);
  assert.equal(longGap.rowAt(999_999).tick, 999_999);
});

await test('each level opens the tree to its own depth and a double-click flips one row', () => {
  // Tick 1 nests s1 > (s2 > s3, s4); tick 2 holds s5.
  const groups = [{ tick: 1, first: 1, last: 4 }, { tick: 2, first: 5, last: 5 }];
  const depths = [0, 1, 2, 1, 0];
  const flipped = (defaults, flips) => key => key in flips ? flips[key] : defaults(key);
  assert.deepEqual(visibleSteps(groups, depths, () => true), [1, 2, 3, 4, 5]);
  assert.deepEqual(visibleSteps(groups, depths, () => false), []);
  // The phase level opens the ticks and s1, which holds the phases s2 and s4.
  const phase = key => key < 0 || key === 1;
  assert.deepEqual(visibleSteps(groups, depths, phase), [1, 2, 4, 5]);
  assert.deepEqual(visibleSteps(groups, depths, flipped(phase, { 2: true })), [1, 2, 3, 4, 5]);
  // Closing s1 hides its whole branch, even rows opened below it.
  assert.deepEqual(visibleSteps(groups, depths, flipped(phase, { 1: false, 2: true })), [1, 5]);
  // Closing a tick hides all its rows.
  assert.deepEqual(visibleSteps(groups, depths, flipped(() => true, { [-1]: false })), [5]);
});

await test('the event list draws each tick as a tree of branches from parent to children', () => {
  // Tick 1 nests s1 > s2 > (s3, s4 > s5) and s1 > s6; tick 2 nests s7 > s8.
  const depths = [0, 1, 2, 2, 3, 1, 0, 1];
  const groups = [{ tick: 1, first: 1, last: 6 }, { tick: 2, first: 7, last: 8 }];
  const shape = (tree, step) => ({
    depth: tree.depth[step - 1], pass: tree.pass[step - 1],
    next: Boolean(tree.flags[step - 1] & 1), child: Boolean(tree.flags[step - 1] & 2),
  });
  const tree = branchShapes(groups, depths);
  assert.deepEqual(shape(tree, 1), { depth: 0, pass: 0, next: false, child: true });
  assert.deepEqual(shape(tree, 2), { depth: 1, pass: 0, next: true, child: true });
  assert.deepEqual(shape(tree, 3), { depth: 2, pass: 0b1, next: true, child: false });
  assert.deepEqual(shape(tree, 4), { depth: 2, pass: 0b1, next: false, child: true });
  // s2's line still runs on to s6 past s5; s4's line ends at s5.
  assert.deepEqual(shape(tree, 5), { depth: 3, pass: 0b1, next: false, child: false });
  assert.deepEqual(shape(tree, 6), { depth: 1, pass: 0, next: false, child: false });
  // A branch never crosses into the next tick.
  assert.deepEqual(shape(tree, 7), { depth: 0, pass: 0, next: false, child: true });
  assert.deepEqual(shape(tree, 8), { depth: 1, pass: 0, next: false, child: false });
  // A level that hides rows hands their children to the nearest shown ancestor.
  const phases = branchShapes(groups, depths, [1, 3, 6, 8]);
  assert.deepEqual([1, 3, 6, 8].map(step => phases.depth[step - 1]), [0, 1, 1, 0]);
  assert.deepEqual(shape(phases, 3), { depth: 1, pass: 0, next: true, child: false });
  assert.deepEqual(shape(phases, 1), { depth: 0, pass: 0, next: false, child: true });
  // Nesting deeper than the cap shares the last column as siblings.
  const deep = branchShapes([{ tick: 0, first: 1, last: 4 }], [0, 1, 2, 3], null, 2);
  assert.deepEqual(Array.from(deep.depth), [0, 1, 2, 2]);
  assert.deepEqual(shape(deep, 3), { depth: 2, pass: 0, next: true, child: false });
});

await test('replays retain model appearance without publishing profile, inventory or command NBT', () => {
  const vehicle = '00000001-0000-4000-8000-000000000001';
  const itemId = '00000002-0000-4000-8000-000000000002';
  const secret = 'private-test-value';
  const stack = { id: 'minecraft:diamond_sword', count: 1, components: {
    'minecraft:custom_data': { secret }, 'minecraft:enchantment_glint_override': 1,
  } };
  const entity = { UUID: vehicle, id: 'minecraft:minecart', Pos: [0, 0, 0], Rotation: [90, 0],
    Items: [stack], Passengers: [{ id: 'minecraft:pig', Variant: 'minecraft:warm', Owner: secret }] };
  const original = { areas: [{ dimension: 'minecraft:overworld', entities: [entity],
    blocks: [{ x: 0, y: 0, z: 0, stateId: 0 }] }] };
  const tag = { entityUuid: itemId, entityType: 'minecraft:item_display', x: 0, y: 0, z: 0 };
  const pose = { translation: [.25, 0, .25], scale: [1, 2, 1], left_rotation: [0, 0, 0, 1] };
  const spawn = { ...tag, type: 'entitySpawn', entityNbt: { id: tag.entityType, item: stack,
    transformation: pose, profile: { secret } } };
  const scene = validateScene(exportScene({frames:[{tick: 0, events:[spawn,
    {...tag,type:'entitySpawn',despawn:true}] }]}, original, ['minecraft:air'], '1.21.10'));
  const replay = createReplay(scene);
  assert.deepEqual([...replay.entities.values()][0].nbt.Passengers, [{id:'minecraft:pig', Variant:'minecraft:warm', Owner:true}]);
  replay.seek(1);
  const appearance = replay.entities.get(scene.events[0].actorId).nbt;
  assert.deepEqual(appearance.transformation, pose);
  assert.deepEqual(appearance.item, {id:stack.id,count:1,components:{enchantment_glint_override:true}});
  replay.seek(2);
  assert.equal(replay.entities.size, 1);
  replay.seek(1);
  assert.deepEqual(replay.entities.get(scene.events[0].actorId).nbt, appearance);
  assert.ok(!JSON.stringify(scene).includes(secret));
  assert.ok(!JSON.stringify(scene).includes(vehicle));
});

await test('event and phase clocks count recorded stops across tick gaps and arbitrary seeks', () => {
  const events = [{ tick: 0, type: 'phase' }, { tick: 0, type: 'setBlock' }, { tick: 0, type: 'phase' },
    { tick: 5, type: 'phase' }, { tick: 5, type: 'setBlock' }];
  const groups = indexTicks(events).groups, axis = createTickAxis(groups, [0, 10]), stops = phaseStops(events, groups);
  for (const mode of ['tick', 'phase', 'event']) {
    const steps = (clock, times) => times.map(t => playbackCursor(axis, stops, t, mode, clock).step);
    assert.deepEqual(steps('event', [0, .99, 1, 2, 3, 4, 5, 50]), [0, 0, 1, 2, 3, 4, 5, 5]);
    assert.deepEqual(steps('phase', [0, .99, 1, 2, 3, 4, 50]), [0, 0, 1, 3, 4, 5, 5]);
    assert.equal(timeFor(axis.forStep(2), axis, stops, mode, 'event'), 2);
    assert.equal(timeFor(axis.forStep(2), axis, stops, mode, 'phase'), 1);
  }
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
