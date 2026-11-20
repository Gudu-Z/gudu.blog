import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseSpot, clearAxes, spotBeside } from '../js/mc-callout.mjs';

// The free part of a view: inside its margins, under the label, and left of
// a timeline floating over its right side.
const area = { left: 22, top: 40, right: 700, bottom: 540 };
const box = { left: 300, top: 200, right: 340, bottom: 260 };

await test('the event card stands beside its target, centred on it, a short way off', () => {
  const spot = chooseSpot(box, 200, 80, area);
  assert.deepEqual(spot, { side: 'right', fits: true, left: 364, top: 190, right: 564, bottom: 270 });
  assert.deepEqual(spotBeside('bottom', box, 200, 80, area), { side: 'bottom', fits: true, left: 220, top: 284, right: 420, bottom: 364 });
});

await test('the card flips to another side only when its own runs out of room', () => {
  // Near the free area's right edge it goes left of the target.
  const nearEdge = { left: 600, top: 200, right: 640, bottom: 260 };
  assert.equal(chooseSpot(nearEdge, 200, 80, area).side, 'left');
  // While the view turns it keeps the side in use for as long as that fits.
  assert.equal(chooseSpot(box, 200, 80, area, [], 'left').side, 'left');
  assert.equal(chooseSpot(nearEdge, 200, 80, area, [], 'right').side, 'left');
  // A button in the way sends it to the next side.
  assert.equal(chooseSpot(box, 200, 80, area, [{ left: 400, top: 180, right: 460, bottom: 220 }]).side, 'left');
});

await test('the card slides along its side to stay inside the view', () => {
  const nearTop = { left: 300, top: 30, right: 340, bottom: 60 };
  const spot = chooseSpot(nearTop, 200, 80, area);
  assert.equal(spot.side, 'right');
  assert.equal(spot.top, area.top);
  // A target filling the view: the side with most room, pushed wholly inside.
  const huge = chooseSpot({ left: 30, top: 50, right: 690, bottom: 530 }, 200, 80, area);
  assert.equal(huge.fits, false);
  assert.ok(huge.left >= area.left && huge.right <= area.right && huge.top >= area.top && huge.bottom <= area.bottom);
});

await test('the card clears the axes even when every side is blocked or the card is parked', () => {
  const axes = { left: 592, top: 24, right: 696, bottom: 128 };
  const target = { left: 80, right: 550, top: -300, bottom: 560 };
  const fallback = chooseSpot(target, 200, 100, area, [axes]);
  assert.equal(fallback.fits, false);
  assert.ok(fallback.top < axes.bottom && fallback.right > axes.left);
  assert.ok(clearAxes(fallback, axes, area).top > axes.bottom);

  const parked = { left: 22, top: 40, right: 292, bottom: 120 };
  const tightAxes = { left: 168, top: 24, right: 272, bottom: 128 };
  assert.ok(clearAxes(parked, tightAxes, area).top > tightAxes.bottom);
  assert.equal(clearAxes(parked, axes, area), parked);

  const nearLeftEdge = { left: 400, top: 56, right: 600, bottom: 136 };
  const shifted = clearAxes(nearLeftEdge, axes, area);
  assert.ok(shifted.right < axes.left);
  assert.equal(shifted.top, nearLeftEdge.top);
});
