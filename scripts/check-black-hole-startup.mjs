import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/black-hole.js', import.meta.url), 'utf8');

function browser({ parallel = true, broken = false } = {}) {
  let complete = !parallel;
  let id = 0;
  const calls = [];
  let timerId = 0;
  const timers = new Map();
  const warnings = [];
  const events = new Map();
  const extension = { COMPLETION_STATUS_KHR: 0x91b1 };
  const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS', 'ACTIVE_UNIFORMS',
    'ARRAY_BUFFER', 'STATIC_DRAW', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
    'LINEAR', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE', 'FRAMEBUFFER',
    'COLOR_ATTACHMENT0', 'RGBA', 'UNSIGNED_BYTE'];
  const gl = Object.fromEntries(constants.map((name, i) => [name, i + 1]));
  Object.assign(gl, {
    getExtension(name) {
      if (name === 'KHR_parallel_shader_compile') return parallel ? extension : null;
      if (name === 'WEBGL_lose_context') return { loseContext: () => calls.push('lose-context') };
      if (name === 'OES_standard_derivatives' || name === 'EXT_shader_texture_lod') return {};
      return null;
    },
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
    'bindTexture', 'texParameteri', 'bindFramebuffer', 'framebufferTexture2D', 'bindBuffer', 'bufferData', 'texImage2D',
    'deleteProgram', 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer']) {
    gl[name] = () => calls.push(name);
  }
  const canvas = {
    getContext: () => gl,
    parentElement: { classList: { remove() {} } },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
  };
  const window = {};
  runInNewContext(source, {
    window, console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
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
    get pendingPolls() { return timers.size; },
    get listeners() { return events.size; },
    complete() { complete = true; },
    lose() { events.get('webglcontextlost')({ preventDefault() {} }); },
    restore() { complete = false; events.get('webglcontextrestored')(); },
    async tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
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

await test('disposing during compilation cancels polling and prevents late setup or restoration', async () => {
  const site = browser();
  assert.equal(site.pendingPolls, 1);
  const oldRestore = site.renderer.handleContextRestored;
  site.renderer.dispose();
  assert.equal(site.pendingPolls, 0);
  assert.equal(site.listeners, 0);
  assert.equal(site.renderer.ready, false);
  assert.equal(site.calls.filter(name => name === 'deleteProgram').length, 3);
  assert.equal(site.calls.filter(name => name === 'lose-context').length, 0,
    'exit must not force synchronous driver context destruction');
  site.complete();
  oldRestore();
  await site.tick();
  assert.equal(site.calls.includes('link-status'), false);
  assert.equal(site.calls.includes('resize'), false);
  assert.equal(site.readySignals, 0);
  assert.equal(site.pendingPolls, 0);
  const callsAfterDispose = site.calls.length;
  site.renderer.dispose();
  assert.equal(site.calls.length, callsAfterDispose);
  assert.deepEqual(site.warnings, []);
});
