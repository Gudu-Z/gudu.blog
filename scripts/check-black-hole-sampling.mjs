import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/black-hole.js', import.meta.url), 'utf8');

// Execute the small scalar/vec2 subset of the real shader, not a duplicate
// implementation of its filter. This checks numerical output invariants;
// shader compilation, ray differentials, and later passes need browser QA.
function shaderFunction(name) {
  const start = source.search(new RegExp(`\\b(?:float|vec3) ${name}\\(`));
  assert(start >= 0, `Missing shader function ${name}`);
  let end = source.indexOf('{', start);
  let depth = 1;
  while (depth && end < source.length) {
    end += 1;
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') depth -= 1;
  }
  assert.equal(depth, 0, `Unclosed shader function ${name}`);
  return source.slice(start, end + 1);
}

function scalarJavaScript(glsl) {
  return glsl
    .replace(/^float (\w+)\(([^)]*)\)/, (_, name, args) =>
      `function ${name}(${args.replace(/\b(?:float|vec2)\s+/g, '')})`)
    .replace(/\bconst (?:float|vec3)\s+/g, 'const ')
    .replace(/\b(?:float|int|vec3)\s+(\w+)/g, 'let $1')
    .replace(/\bfloat\(/g, 'Number(');
}

const context = vm.createContext({
  ...Object.fromEntries(['min', 'max', 'floor', 'sin', 'cos', 'exp', 'sqrt', 'pow']
    .map(name => [name, Math[name]])),
  PI: Math.PI,
  abs: value => typeof value === 'number' ? Math.abs(value)
    : { x: Math.abs(value.x), y: Math.abs(value.y) },
  dot: (a, b) => a.x * b.x + a.y * b.y,
  vec2: (x, y = x) => ({ x, y }),
  fract: value => value - Math.floor(value),
  clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
  mix: (a, b, weight) => a * (1 - weight) + b * weight,
  smoothstep: (low, high, value) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  },
});
vm.runInContext(['laneIntegral', 'filteredLane']
  .map(name => scalarJavaScript(shaderFunction(name))).join('\n'), context);
const lane = context.filteredLane;

// Each color channel follows the same scalar arithmetic in this emission
// tail. Testing the actual tail catches a nonlinear tone curve accidentally
// applied after filtering. It does not emulate subsequent rendering passes.
const disk = shaderFunction('diskEmission');
const toneStart = disk.indexOf('const float diskExposure');
assert(toneStart >= 0, 'Update the scalar emission harness if diskExposure is refactored');
const toneBody = scalarJavaScript(disk.slice(toneStart, disk.lastIndexOf('}')));
vm.runInContext(`function displayedLane(color, energy, bundles, flow, innerEdge, edgeLight, filament) {
  ${toneBody}
}`, context);

function phaseSamples(duty, dx, dy, count = 2048) {
  return Float64Array.from({ length: count }, (_, i) => lane(i / count, duty, { x: dx, y: dy }));
}

function aliasRms(values, frequency) {
  let energy = 0;
  for (let harmonic = 1; harmonic <= 48; harmonic += 1) {
    if (harmonic * frequency <= 0.5) continue;
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < values.length; i += 1) {
      const angle = 2 * Math.PI * harmonic * i / values.length;
      real += values[i] * Math.cos(angle);
      imaginary += values[i] * Math.sin(angle);
    }
    energy += 2 * (real * real + imaginary * imaginary) / values.length ** 2;
  }
  return Math.sqrt(energy);
}

test('lane coverage stays bounded and preserves its phase-averaged light at every scale', () => {
  for (const duty of [0.036, 0.09, 0.13]) {
    for (const dx of [0.006, 0.02, 0.05, 0.08, 0.14, 0.26, 0.49, 0.65, 1.3]) {
      for (const slope of [0, 0.3, 1]) {
        const values = phaseSamples(duty, dx, dx * slope);
        let mean = 0;
        for (const value of values) {
          assert(value >= -1e-8 && value <= 1 + 1e-8, `Coverage ${value} outside [0, 1]`);
          mean += value / values.length;
        }
        assert(Math.abs(mean - duty) < 1e-4,
          `Pixel size changed lane energy: duty=${duty}, dx=${dx}, slope=${slope}, mean=${mean}`);
      }
    }
  }
});

test('compressed lanes have no harmonics beyond the screen pixel Nyquist limit', () => {
  for (const duty of [0.036, 0.09, 0.13]) {
    for (const dx of [0.14, 0.19, 0.26, 0.34, 0.49, 0.65]) {
      for (const slope of [0, 0.3, 1]) {
        const rms = aliasRms(phaseSamples(duty, dx, dx * slope), dx);
        assert(rms < 1e-8, `Aliasing RMS ${rms} at duty=${duty}, dx=${dx}, slope=${slope}`);
      }
    }
  }
});

test('thin subpixel lanes filter before widely spaced lane centres can alias', () => {
  for (const dx of [0.04, 0.05, 0.06, 0.08]) {
    const rms = aliasRms(phaseSamples(0.036, dx, dx * 0.3), dx);
    assert(rms < 1e-8, `Subpixel strand still contains high harmonics at dx=${dx}: ${rms}`);
  }
});

test('coverage is periodic and independent of derivative axis order or sign', () => {
  for (const phase of [-21.27, -1.001, -0.001, 0.127, 0.499, 0.999, 14.23]) {
    const value = lane(phase, 0.09, { x: 0.19, y: -0.07 });
    for (const offset of [-7, 0, 7]) {
      for (const gradient of [{ x: 0.19, y: 0.07 }, { x: -0.19, y: -0.07 }, { x: 0.07, y: 0.19 }]) {
        assert(Math.abs(value - lane(phase + offset, 0.09, gradient)) < 1e-11);
      }
    }
  }
});

test('fully resolved strands keep a bright centre and clean spaces between lanes', () => {
  for (const duty of [0.036, 0.09, 0.13]) {
    const gradient = { x: duty / 5, y: 0 };
    assert(Math.abs(lane(0.5, duty, gradient) - 1) < 1e-10, 'Resolved lane centre was softened');
    assert(Math.abs(lane(0, duty, gradient)) < 1e-10, 'Resolved gap was filled');
    assert(Math.abs(lane(0.5 + duty, duty, gradient)) < 1e-10, 'Resolved strand spread beyond its edge');
  }
});

test('displayed disk light stays affine in filtered coverage and preserves its cutoff', () => {
  for (const color of [0.48, 0.79, 1]) {
    const radiance = coverage => context.displayedLane(color, 2.1, 0.9, 0.88, 1, 0.04, coverage);
    const base = radiance(0);
    const full = radiance(1);
    assert(base >= 0 && full <= 1 && full > base);
    for (const coverage of [0.036, 0.13, 0.25, 0.5, 0.9]) {
      assert(Math.abs(radiance(coverage) - (base * (1 - coverage) + full * coverage)) < 1e-12,
        'Tone mapping filtered coverage introduced new frequencies');
    }
    const values = phaseSamples(0.13, 0.19, 0.07).map(radiance);
    assert(aliasRms(values, 0.19) < 1e-8, 'Displayed light reintroduced removed harmonics');
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    assert(Math.abs(mean - (base * 0.87 + full * 0.13)) < 1e-5);
  }
});
