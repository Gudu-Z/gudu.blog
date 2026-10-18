import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/black-hole.js', import.meta.url), 'utf8');

function browser({ parallel = true, broken = false } = {}) {
  let complete = !parallel;
  let id = 0;
  const calls = [];
  const timers = [];
  const warnings = [];
  const events = new Map();
  const extension = { COMPLETION_STATUS_KHR: 0x91b1 };
  const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS', 'ACTIVE_UNIFORMS',
    'ARRAY_BUFFER', 'STATIC_DRAW', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
    'LINEAR', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE', 'FRAMEBUFFER',
    'COLOR_ATTACHMENT0', 'RGBA', 'UNSIGNED_BYTE'];
  const gl = Object.fromEntries(constants.map((name, i) => [name, i + 1]));
  Object.assign(gl, {
    getExtension: name => name === 'KHR_parallel_shader_compile' ? (parallel ? extension : null) : {},
    createShader: () => ({ id: ++id }),
    createProgram: () => ({ id: ++id }),
    createTexture: () => ({}), createFramebuffer: () => ({}), createBuffer: () => ({}),
    getShaderParameter() { throw new Error('Startup must not synchronously wait for COMPILE_STATUS'); },
    getProgramParameter(program, name) {
      if (name === extension.COMPLETION_STATUS_KHR) return complete;
      assert.ok(complete, 'LINK_STATUS and uniforms must wait for background compilation');
      if (name === gl.LINK_STATUS) { calls.push('link-status'); return !broken; }
      if (name === gl.ACTIVE_UNIFORMS) return 0;
    },
    getProgramInfoLog: () => 'Test shader failed to link',
    getAttribLocation: () => 0,
  });
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader',
    'bindTexture', 'texParameteri', 'bindFramebuffer', 'framebufferTexture2D', 'bindBuffer', 'bufferData', 'texImage2D']) {
    gl[name] = () => calls.push(name);
  }
  const canvas = {
    getContext: () => gl,
    parentElement: { classList: { remove() {} } },
    addEventListener: (name, fn) => events.set(name, fn),
  };
  const window = {};
  runInNewContext(source, {
    window, console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout: fn => timers.push(fn),
  });
  // Allocation sizing is covered by browser checks; these tests isolate
  // compilation, readiness and context restoration without a GPU driver.
  window.BlackHole.prototype.resize = () => calls.push('resize');
  const renderer = new window.BlackHole(canvas);
  let readySignals = 0;
  renderer.onRestore = () => readySignals++;
  return {
    renderer, calls, warnings,
    get readySignals() { return readySignals; },
    get pendingPolls() { return timers.length; },
    complete() { complete = true; },
    lose() { events.get('webglcontextlost')({ preventDefault() {} }); },
    restore() { complete = false; events.get('webglcontextrestored')(); },
    async tick() {
      for (const fn of timers.splice(0)) fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

await test('cold compilation returns control before querying link status or allocating the scene', async () => {
  const site = browser();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.calls.filter(name => name === 'compileShader').length, 6);
  assert.equal(site.calls.includes('link-status'), false);
  assert.equal(site.calls.includes('resize'), false);
  await site.tick();
  assert.equal(site.pendingPolls, 1);
  assert.equal(site.readySignals, 0);
  site.complete();
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.initialized, true);
  assert.equal(site.readySignals, 1);
  assert.equal(site.calls.filter(name => name === 'link-status').length, 3);
  assert.deepEqual(site.warnings, []);
});

await test('a lost context cancels its pending compile and only the restored generation becomes ready', async () => {
  const site = browser();
  site.lose();
  site.restore();
  site.complete();
  await site.tick();
  assert.equal(site.readySignals, 1);
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.generation, 2);
  assert.equal(site.calls.filter(name => name === 'resize').length, 1);
  assert.deepEqual(site.warnings, []);
});

await test('a failed link keeps the fallback and never announces a usable scene', async () => {
  const site = browser({ broken: true });
  site.complete();
  await site.tick();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.readySignals, 0);
  assert.equal(site.pendingPolls, 0);
  assert.equal(site.warnings.length, 1);
  assert.match(site.warnings[0], /failed to link/);
});

await test('browsers without parallel compilation still finish deferred setup', async () => {
  const site = browser({ parallel: false });
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.readySignals, 1);
  assert.equal(site.pendingPolls, 0);
  assert.deepEqual(site.warnings, []);
});
