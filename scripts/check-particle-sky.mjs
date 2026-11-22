import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/particle-sky.js', import.meta.url), 'utf8');
const window = {};
runInNewContext(source, { window });
const { ParticleSky } = window;
const geometry = ParticleSky.geometry();
const stride = 8;
const copies = 3;

await test('particle geometry contains finite positions and usable luminous material in a bounded 3D volume', () => {
  assert.ok(geometry.length > 0);
  assert.equal(geometry.length % (stride * copies), 0);
  assert.ok(geometry.every(Number.isFinite));
  let front = 0;
  let back = 0;
  for (let i = 0; i < geometry.length; i += stride * copies) {
    const [x, y, z, radius, luminosity, warmth] = geometry.subarray(i, i + stride);
    const distance = Math.hypot(x, y, z);
    assert.ok(Math.abs(x) <= 1600 && Math.abs(y) <= 1600,
      'stars must stay inside the complete periodic XY cell');
    assert.ok(Math.abs(z) >= 119.999 && Math.abs(z) <= 1500.001,
      'both depth volumes must stay outside the black hole');
    assert.ok(radius > 0 && radius < distance, 'each star needs a finite physical radius');
    assert.ok(luminosity > 0);
    assert.ok(warmth >= 0 && warmth <= 1);
    if (z < 0) front++;
    else back++;
  }
  assert.ok(front > 0 && back > 0, 'strongly deflected rays need stars in both hemispheres');
});

await test('stars occupy continuous varied depths rather than a few discrete sky shells', () => {
  const depths = new Set();
  const ranges = new Set();
  for (let i = 0; i < geometry.length; i += stride * copies) {
    const depth = Math.abs(geometry[i + 2]);
    depths.add(Math.round(depth));
    ranges.add(depth < 400 ? 'near' : depth < 1000 ? 'middle' : 'far');
  }
  assert.ok(depths.size > 1000, 'continuous spatial depth is required for genuine perspective');
  assert.deepEqual([...ranges].sort(), ['far', 'middle', 'near']);
});

await test('star populations fill the entire periodic domain so long camera drifts do not reveal empty corners', () => {
  const cells = Array.from({ length: 64 }, () => ({ front: 0, back: 0 }));
  const population = geometry.length / (stride * copies);
  const expected = population / cells.length;
  for (let i = 0; i < geometry.length; i += stride * copies) {
    const x = Math.min(7, Math.floor((geometry[i] + 1600) / 400));
    const y = Math.min(7, Math.floor((geometry[i + 1] + 1600) / 400));
    const cell = cells[y * 8 + x];
    cell[geometry[i + 2] < 0 ? 'front' : 'back']++;
  }
  for (const [index, cell] of cells.entries()) {
    assert.ok(cell.front + cell.back >= expected * 0.5,
      `periodic cell ${index} must retain a substantial population, including corner cells`);
    assert.ok(cell.front >= expected * 0.2 && cell.back >= expected * 0.2,
      `periodic cell ${index} must contain stars for direct and strongly deflected views`);
  }
});

await test('seeded star positions and material remain stable across initialization and population sizes', () => {
  const first = ParticleSky.geometry(257);
  const second = ParticleSky.geometry(257);
  assert.deepEqual(Buffer.from(first.buffer), Buffer.from(second.buffer));
  assert.deepEqual(Buffer.from(first.buffer), Buffer.from(geometry.buffer, 0, first.byteLength),
    'changing the population must not relocate every surviving star');
});

await test('longitude seam copies preserve each star position and appearance exactly', () => {
  for (let i = 0; i < geometry.length; i += stride * copies) {
    const original = Array.from(geometry.subarray(i, i + 7));
    for (let copy = 0; copy < copies; copy++) {
      const offset = i + copy * stride;
      assert.deepEqual(Array.from(geometry.subarray(offset, offset + 7)), original,
        'seam wrapping must duplicate one star, not create mismatched neighbours');
    }
    assert.deepEqual([geometry[i + 7], geometry[i + stride + 7], geometry[i + stride * 2 + 7]], [-1, 0, 1]);
  }
});

const fill = ParticleSky.fill(6000);

await test('the fill population is seeded, bounded and copied across the seam only behind the observer', () => {
  assert.deepEqual(Buffer.from(ParticleSky.fill(6000).buffer), Buffer.from(fill.buffer));
  let stars = 0;
  for (let i = 0; i < fill.length; i += stride) {
    const [x, y, z, radius, luminosity, warmth, , wrap] = fill.subarray(i, i + stride);
    assert.ok(Math.abs(x) <= 1600 && Math.abs(y) <= 1600 && Math.abs(z) >= 119.999 && Math.abs(z) <= 1500.001);
    assert.ok(radius > 0 && luminosity > 0 && warmth >= 0 && warmth <= 1);
    if (z < 0) {
      assert.equal(wrap, 0, 'stars ahead never reach the seam behind the observer');
      stars++;
    } else if (wrap === -1) {
      assert.deepEqual([fill[i + stride + 7], fill[i + stride * 2 + 7]], [0, 1]);
      stars++;
    }
  }
  assert.equal(stars, 6000);
});

await test('fill stars look as bright near as far, so distance does not thin them out', () => {
  // Projected energy goes with luminosity times (radius / distance)^2.
  const shown = { near: [], far: [] };
  for (let i = 0; i < fill.length; i += stride) {
    const [, , z, radius, luminosity, , , wrap] = fill.subarray(i, i + stride);
    if (wrap) continue;
    shown[Math.abs(z) < 600 ? 'near' : Math.abs(z) > 1000 ? 'far' : 'middle']?.push(luminosity * (radius / Math.abs(z)) ** 2);
  }
  const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const ratio = median(shown.far) / median(shown.near);
  assert.ok(ratio > 0.8 && ratio < 1.25, `far and near fill stars should share one brightness scale (ratio ${ratio})`);
});

// A fake GL that records uniforms, enough to call render().
function recorder() {
  const values = {};
  const gl = new Proxy({}, { get: (_, name) => {
    if (name === 'uniform3f' || name === 'uniform2f') return (location, ...v) => { values[location] = v; };
    if (name === 'getParameter') return () => 4096;
    return typeof name === 'string' && /^[A-Z_0-9]+$/.test(name) ? 0 : () => {};
  } });
  const uniforms = { u_observer: 'u_observer', u_sweep: 'u_sweep', u_chart: 'u_chart', u_maxPoint: 'u_maxPoint' };
  return { gl, values, owner: { gl, program: () => ({ value: {}, position: 0, uniforms }) } };
}

await test('an orbiting observer sweeps the far stars past fastest; a translating one the near stars', () => {
  // Angular drift over ten seconds of a star at depth z, along the drift direction,
  // from the shader's p.xy = position - observer - sweep * |z|.
  function drift(orbit, z) {
    const { values, owner } = recorder();
    const sky = new ParticleSky(owner, { orbit });
    sky.target = {}; sky.size = 1024; sky.inset = 0.03; sky.maxPoint = 48; sky.count = 0;
    const at = time => {
      sky.render(time, 0, 0);
      const [ox, oy] = values.u_observer, [sx, sy] = values.u_sweep;
      return [-(ox + sx * Math.abs(z)) / Math.abs(z), -(oy + sy * Math.abs(z)) / Math.abs(z)];
    };
    const [x0, y0] = at(20), [x1, y1] = at(30);
    return { x: x1 - x0, y: y1 - y0 };
  }
  const near = drift(true, 140), far = drift(true, 1500);
  assert.ok(far.x < 0 && far.y < 0 && near.x < 0 && near.y < 0, 'every star drifts the same way, toward the lower left');
  assert.ok(Math.hypot(far.x, far.y) > 2.5 * Math.hypot(near.x, near.y), 'far stars sweep past fastest');
  const still = drift(false, 1500), close = drift(false, 140);
  assert.ok(Math.hypot(close.x, close.y) > 5 * Math.hypot(still.x, still.y), 'a translating observer passes near stars fastest');
});

await test('a lift moves the observer straight up or down, so stars shift by their nearness, and whole volumes of it wrap away', () => {
  for (const orbit of [true, false]) {
    const { values, owner } = recorder();
    const sky = new ParticleSky(owner, { orbit });
    sky.target = {}; sky.size = 1024; sky.inset = 0.03; sky.maxPoint = 48; sky.count = 0;
    const observer = (...lift) => { sky.render(20, 0.3, -0.2, ...lift); return values.u_observer; };
    const [x0, y0, z0] = observer();
    const [x1, y1, z1] = observer(-12);
    assert.equal(x1, x0, 'the lift leaves the observer\'s x');
    assert.equal(z1, z0, 'and its depth');
    assert.ok(Math.abs(y1 - (y0 - 12)) < 1e-9, 'it lowers the observer by the lift');
    // From p = position - observer, a star at depth z shifts by lift / z:
    // ten times as far at 140 units as at 1400.
    assert.deepEqual(observer(-12 - 3200 * 5), [x1, y1, z1], 'a lift of whole volumes changes nothing, so the uniform stays small');
  }
});
