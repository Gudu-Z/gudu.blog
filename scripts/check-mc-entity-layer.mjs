import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group } from '../js/vendor/mc-engine.mjs';
import { createReplayEntityLayer } from '../js/mc-entity-layer.mjs';
import { createPlayerLayer } from '../js/mc-player-layer.mjs';
import { createReplayHitboxes, replayEntityBounds } from '../js/mc-entity-hitboxes.mjs';

const renderer = () => ({ scene: new Group(), requestRender() {}, _syncSceneResources() {} });
const assets = {
  beginTextureLoad: () => () => {}, setTextureUsage() {}, releaseTextureUsage() {},
  async getTexture() { return null; },
};
const data = {
  bounds: { minX: 0, minY: 0, minZ: 0, width: 3, height: 1, depth: 3 },
  blocks: new Map([[4, 0]]), palette: [{ name: 'minecraft:detector_rail', properties: { shape: 'north_south' } }],
};
const cart = { id: 'cart', type: 'minecraft:minecart', pos: [1.5,.0625,1.5], yaw: 0, pitch: 0 };
const states = (...actors) => new Map(actors.map(actor => [actor.id, actor]));

await test('cart meshes follow replay motion and rail direction independently of the debug hitboxes', async () => {
  const view = renderer(), signal = new AbortController().signal;
  const layer = createReplayEntityLayer(view, assets, signal), boxes = createReplayHitboxes(view);
  const draw = async (actor, world) => {
    const frame = states(actor);
    boxes.sync(null, frame);
    await layer.sync(frame, world);
  };
  await draw(cart, data);
  const model = view.scene.getObjectByName('minecart-body');
  assert.ok(model?.isMesh && model.geometry.getAttribute('position').count > 0);
  boxes.setVisible(false);
  assert.equal(view.scene.getObjectByName('replay-hitboxes').visible, false);
  assert.equal(view.scene.getObjectByName('replay-entities').visible, true);
  const pose = view.scene.getObjectByName('minecart-model'), yaw = pose.rotation.y;
  const moved = { ...cart, pos: [1.75,.0625,1.5] };
  const turned = { ...data, palette: [{ name: 'minecraft:rail', properties: { shape: 'east_west' } }] };
  await draw(moved, turned);
  assert.deepEqual(view.scene.getObjectByName('replay-entity:cart').position.toArray(), moved.pos);
  assert.equal(view.scene.getObjectByName('minecart-body'), model);
  assert.notEqual(pose.rotation.y, yaw);
  await draw(cart, data);
  assert.equal(pose.rotation.y, yaw);
  assert.deepEqual(view.scene.getObjectByName('replay-entity:cart').position.toArray(), cart.pos);
  await layer.sync(states(), data);
  assert.equal(view.scene.getObjectByName('minecart-body'), undefined);
  await draw(cart, data);
  assert.ok(view.scene.getObjectByName('minecart-body').isMesh);
  boxes.destroy();
  layer.destroy();
  assert.equal(view.scene.children.length, 0);
});

await test('an invalid mob appearance does not interrupt other actors or their hitboxes', async t => {
  t.mock.method(console, 'warn', () => {});
  const view = renderer(), signal = new AbortController().signal;
  const layer = createReplayEntityLayer(view, assets, signal);
  const malformed = { ...cart, id: 'mob', type: 'minecraft:zombie', nbt: { attributes: [null] } };
  assert.ok(replayEntityBounds(malformed));
  await layer.sync(states(malformed, cart), data);
  assert.ok(view.scene.getObjectByName('minecart-body'));
  layer.destroy();
});

await test('a corrupted embedded skin retains the player model with the default skin', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const view = renderer(), hash = 'a'.repeat(64), actor = { ...cart, id: 'player', skin: hash, model: 'wide' };
  const fallback = { isTexture: true };
  const layer = await createPlayerLayer({ players: [actor], events: [], skins: { [hash]: '' } }, view, {
    ...assets, getRecordedSkin: async () => { throw Error('corrupt PNG'); }, getTexture: async () => fallback,
  }, new AbortController().signal);
  layer.sync(states(actor));
  assert.equal(view.scene.getObjectByName('replay-player:player').material.map, fallback);
  assert.equal(warning.mock.callCount(), 1);
  layer.destroy();
});
