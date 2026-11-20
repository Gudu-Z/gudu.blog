import assert from 'node:assert/strict';
import { test } from 'node:test';
import { axisEnds, axisView } from '../js/mc-axes.mjs';

const identity = { x: 0, y: 0, z: 0, w: 1 };

// OrbitControls turns about world Y, then tilts about the camera's local X.
function orbitQuaternion({ azimuth, polar }) {
  const yaw = azimuth / 2, tilt = (polar - Math.PI / 2) / 2;
  return {
    x: Math.cos(yaw) * Math.sin(tilt), y: Math.sin(yaw) * Math.cos(tilt),
    z: -Math.sin(yaw) * Math.sin(tilt), w: Math.cos(yaw) * Math.cos(tilt),
  };
}

const oblique = orbitQuaternion({ azimuth: Math.PI / 6, polar: Math.PI / 3 });

function checkProjection(ends, axis, sign, x, y, depth, tolerance = 1e-9) {
  const end = ends.find(end => end.axis === axis && end.sign === sign);
  assert.ok(end, 'missing end ' + axis + ' ' + sign);
  for (const [key, value] of Object.entries({ x, y, depth })) {
    assert.ok(Math.abs(end[key] - value) < tolerance, axis + ' ' + sign + ' ' + key + ' = ' + end[key] + ', expected ' + value);
  }
}

await test('the identity camera sees east on the right, up above, and south in front', () => {
  const ends = axisEnds(identity);
  checkProjection(ends, 'X', 1, 1, 0, 0);
  checkProjection(ends, 'Y', 1, 0, -1, 0);
  checkProjection(ends, 'Z', 1, 0, 0, 1);
  checkProjection(ends, 'X', -1, -1, 0, 0);
  checkProjection(ends, 'Y', -1, 0, 1, 0);
  checkProjection(ends, 'Z', -1, 0, 0, -1);
});

await test('looking from the east puts the eastern bulb in front and north on the right', () => {
  const ends = axisEnds({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
  checkProjection(ends, 'X', 1, 0, 0, 1);
  checkProjection(ends, 'Z', -1, 1, 0, 0);
});

await test('each clicked end places the camera on its side of the orbit target', () => {
  for (const axis of ['X', 'Y', 'Z']) {
    for (const sign of [-1, 1]) {
      const { azimuth, polar } = axisView(axis, sign, oblique);
      assert.ok(polar > 0 && polar < Math.PI, 'stay clear of the OrbitControls poles');
      const offset = {
        X: Math.sin(azimuth) * Math.sin(polar),
        Y: Math.cos(polar),
        Z: Math.cos(azimuth) * Math.sin(polar),
      };
      for (const [component, value] of Object.entries(offset)) {
        assert.ok(Math.abs(value - (component === axis ? sign : 0)) < .001, 'wrong offset for ' + axis + ' ' + sign);
      }
    }
  }
});

await test('the top and bottom views keep north up, with east on the right when seen from above', () => {
  for (const sign of [-1, 1]) {
    const ends = axisEnds(orbitQuaternion(axisView('Y', sign, oblique)));
    checkProjection(ends, 'Z', -1, 0, -1, 0, .001);
    checkProjection(ends, 'X', 1, sign, 0, 0, .001);
  }
});

await test('clicking the facing bulb again flips to its opposite on all six sides', () => {
  for (const axis of ['X', 'Y', 'Z']) {
    for (const sign of [-1, 1]) {
      const aligned = orbitQuaternion(axisView(axis, sign, oblique));
      const flipped = orbitQuaternion(axisView(axis, sign, aligned));
      checkProjection(axisEnds(flipped), axis, -sign, 0, 0, 1, .001);
    }
  }
});

await test('an oblique view draws all six ends in order from farthest to nearest', () => {
  const ends = axisEnds(oblique);
  checkProjection(ends, 'X', 1, Math.sqrt(3) / 2, .25, Math.sqrt(3) / 4);
  checkProjection(ends, 'Y', 1, 0, -Math.sqrt(3) / 2, .5);
  checkProjection(ends, 'Z', 1, -.5, Math.sqrt(3) / 4, .75);
  assert.deepEqual(ends.map(end => end.axis + end.sign), ['Z-1', 'Y-1', 'X-1', 'X1', 'Y1', 'Z1']);
});
