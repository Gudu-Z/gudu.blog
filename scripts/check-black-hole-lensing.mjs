import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/black-hole.js', import.meta.url), 'utf8');

function shaderFunction(name) {
  const start = source.search(new RegExp(`\\b(?:float|vec3|RayHit) ${name}\\(`));
  assert(start >= 0, `Missing shader function ${name}`);
  let end = source.indexOf('{', start), depth = 1;
  while (depth && ++end < source.length) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') depth -= 1;
  }
  assert.equal(depth, 0, `Unclosed shader function ${name}`);
  return source.slice(start, end + 1).replace(/\/\/[^\n]*/g, '');
}

// Execute the actual GLSL ray integrator on the CPU. This deliberately small
// expression translator supplies GLSL vector arithmetic, rather than copying
// the acceleration, step sizes, branch thresholds or sky-mapping equations.
// It does not test float32/GPU precision, texture filtering or shader linking.
function expression(input) {
  const tokens = input.match(/\d*\.\d+(?:e[-+]?\d+)?|\d+(?:e[-+]?\d+)?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[()+,*/-]/gi) || [];
  assert.equal(tokens.join(''), input.replace(/\s/g, ''), `Unsupported GLSL expression: ${input}`);
  let index = 0;
  function value() {
    const token = tokens[index++];
    if (token === '-') return `mul(-1,${value()})`;
    if (token === '+') return value();
    if (token === '(') {
      const result = binary(0);
      assert.equal(tokens[index++], ')');
      return `(${result})`;
    }
    assert(token && !/^[),*/]$/.test(token), `Invalid GLSL expression: ${input}`);
    if (tokens[index] !== '(') return token;
    index += 1;
    const args = [];
    if (tokens[index] !== ')') {
      do {
        args.push(binary(0));
        if (tokens[index] !== ',') break;
        index += 1;
      } while (true);
    }
    assert.equal(tokens[index++], ')');
    return `${token}(${args.join(',')})`;
  }
  function binary(minimum) {
    let result = value();
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const operation = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
    while ((precedence[tokens[index]] || 0) > minimum) {
      const operator = tokens[index++];
      result = `${operation[operator]}(${result},${binary(precedence[operator])})`;
    }
    return result;
  }
  const result = binary(0);
  assert.equal(index, tokens.length, `Unconsumed GLSL expression: ${input}`);
  return result;
}

function declarations(input) {
  let depth = 0;
  return input.replace(/[(),]/g, token => {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    return token === ',' && depth === 0 ? '\0' : token;
  }).split('\0').map(part => {
    const [name, rhs] = part.split('=');
    return rhs === undefined ? name.trim() : `${name.trim()} = ${expression(rhs)}`;
  }).join(', ');
}

function javaScript(glsl) {
  return glsl
    .replace(/^(?:float|vec3|RayHit) (\w+)\(([^)]*)\)/, (_, name, args) =>
      `function ${name}(${args.replace(/\b(?:float|vec3|RayHit)\s+/g, '')})`)
    .replace(/\bRayHit (\w+);/g, 'let $1 = {};')
    .replace(/\b(?:float|vec3|int)\s+([^;]+);/g, (_, list) => `let ${declarations(list)};`)
    .replace(/(^|\n)(\s*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*([^;]+);/g,
      (_, prefix, indent, name, rhs) => `${prefix}${indent}${name} = ${expression(rhs)};`)
    .replace(/\breturn ([^;]+);/g, (_, rhs) => `return ${expression(rhs)};`);
}

function vector(...values) {
  const result = Object.fromEntries(values.map((value, i) => ['xyz'[i], value]));
  Object.defineProperties(result, {
    xy: { get: () => vector(result.x, result.y), set: v => { result.x = v.x; result.y = v.y; } },
    xz: { get: () => vector(result.x, result.z) },
  });
  return result;
}
const components = value => ['x', 'y', 'z'].filter(key => key in value);
function arithmetic(a, b, operation) {
  if (typeof a === 'number' && typeof b === 'number') return operation(a, b);
  return vector(...components(typeof a === 'number' ? b : a)
    .map(key => operation(typeof a === 'number' ? a : a[key], typeof b === 'number' ? b : b[key])));
}
const add = (a, b) => arithmetic(a, b, (x, y) => x + y);
const sub = (a, b) => arithmetic(a, b, (x, y) => x - y);
const mul = (a, b) => a?.matrix
  ? vector(a.matrix[0] * b.x + a.matrix[2] * b.y, a.matrix[1] * b.x + a.matrix[3] * b.y)
  : arithmetic(a, b, (x, y) => x * y);
const div = (a, b) => arithmetic(a, b, (x, y) => x / y);
const dot = (a, b) => components(a).reduce((sum, key) => sum + a[key] * b[key], 0);
const length = a => Math.sqrt(dot(a, a));
const normalize = a => div(a, length(a));
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const context = vm.createContext({
  add, sub, mul, div, dot, length, normalize, clamp,
  vec3: (x, y = x, z = x) => vector(x, y, z),
  mat2: (...matrix) => ({ matrix }),
  cross: (a, b) => vector(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x),
  mix: (a, b, t) => add(mul(a, 1 - t), mul(b, t)),
  smoothstep: (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
  step: (edge, x) => Number(x >= edge),
  ...Object.fromEntries(['min', 'max', 'abs', 'sqrt', 'sin', 'cos'].map(name => [name, Math[name]])),
  atan: Math.atan2, u_ink: 0, u_time: 12,
});
vm.runInContext(['acceleration', 'inkHeight', 'traceLayers', 'orientSky']
  .map(name => javaScript(shaderFunction(name))).join('\n'), context);

const radius = Number(source.match(/float cameraDistance = ([\d.]+);/)?.[1]);
assert(Number.isFinite(radius), 'Camera radius must come from the shader');
const origin = vector(0, 0, radius);
const right = vector(1, 0, 0), up = vector(0, 1, 0), forward = vector(0, 0, -1);
function ray(impact, ink = 0) {
  context.u_ink = ink;
  const direction = vector(impact / radius, 0, -Math.sqrt(1 - (impact / radius) ** 2));
  const hit = context.traceLayers(origin, direction, 0);
  return { direction, hit, mapped: context.orientSky(structuredClone(hit), origin, direction, right, up, forward, 0) };
}
const angle = value => Math.atan2(value.x, -value.z);

test('background mapping is continuous across the former distant-ray shortcut', () => {
  // Historical cutoff is a regression location, not a current implementation parameter.
  const boundary = Math.sqrt(140), delta = 0.0001;
  const before = ray(boundary - delta), after = ray(boundary + delta);
  assert.equal(before.hit.material, -1);
  assert.equal(after.hit.material, -1);
  assert(Math.abs(angle(after.mapped.ray) - angle(before.mapped.ray)) < 0.0001,
    'Far sky suddenly switches from bent to straight rays');
});

test('aligned distant source retains its full lens ring instead of a compressed one', () => {
  // With this camera, the outer axis crossing lies near b=8.7. The former
  // background blend moved it to b=5.54. Broad bounds allow integration tuning.
  assert(ray(8.4).mapped.ray.x < 0);
  assert(ray(9.0).mapped.ray.x > 0);
  assert(ray(5.6).mapped.ray.x < -0.2, 'Background image has been compressed toward the shadow');
});

test('far background rays keep smoothly decreasing nonzero gravitational deflection', () => {
  let previous = Infinity;
  for (const impact of [12, 16, 20, 25, 30]) {
    const { direction, hit, mapped } = ray(impact);
    assert.equal(hit.material, -1, `Ray at b=${impact} did not escape within the shader budget`);
    const bend = angle(direction) - angle(mapped.ray);
    assert(bend > 0.005 && bend < previous, `Incorrect far-field bending at b=${impact}: ${bend}`);
    assert(Math.abs(length(mapped.ray) - 1) < 1e-12);
    previous = bend;
  }
});

test('sky orientation is a rotation of escaped light, preserving angular separation', () => {
  context.u_ink = 0;
  const first = vector(0.2, 0.3, -0.7), second = vector(-0.4, 0.1, -0.8);
  const map = direction => context.orientSky({ material: -1, ray: direction }, origin,
    forward, right, up, forward, 0.37).ray;
  assert(Math.abs(dot(map(first), map(second)) - dot(normalize(first), normalize(second))) < 1e-12,
    'Sky orientation changed the relative directions of escaped rays');
});

test('sky-only remapping preserves accretion disk intersections and black-hole capture', () => {
  context.u_ink = 0;
  const camera = vector(0, radius * Math.cos(81 * Math.PI / 180), radius * Math.sin(81 * Math.PI / 180));
  const target = vector(6, 0, 4);
  const direction = normalize(sub(target, camera));
  const hit = context.traceLayers(camera, direction, 0);
  assert.equal(hit.material, 1, 'Disk fixture must actually intersect the accretion disk');
  assert(length(hit.point.xz) > 3 && length(hit.point.xz) < 11);
  const before = structuredClone(hit);
  const after = context.orientSky(hit, camera, direction, right, up, forward, 0.37);
  assert.deepEqual(structuredClone(after), before, 'Sky mapping modified a disk hit');
  const captured = ray(1).mapped;
  assert.equal(captured.material, 0);
  assert.equal(captured.alpha, 1);
});

test('ink keeps its existing distant-ray shortcut and sky orientation', () => {
  const { direction, hit, mapped } = ray(16, 1);
  assert.equal(hit.material, -1);
  assert.deepEqual(structuredClone(hit.ray), structuredClone(direction));
  assert.deepEqual(structuredClone(mapped), structuredClone(hit));
  assert(Math.abs(angle(ray(16).mapped.ray) - angle(direction)) > 0.05,
    'The ink-only shortcut also bypassed minimal background tracing');
});
