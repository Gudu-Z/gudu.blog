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
