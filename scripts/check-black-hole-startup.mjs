import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await Promise.all(['particle-sky', 'black-hole'].map(name =>
  readFile(new URL(`../js/${name}.js`, import.meta.url), 'utf8')))).join('\n');

function browser({ parallel = true, broken = false, style = 'minimal', contextAvailable = true, derivatives = true } = {}) {
  let complete = !parallel;
  let id = 0;
  const calls = [];
  let timerId = 0;
  const timers = new Map();
  const warnings = [];
  const events = new Map();
  const images = [];
  const shaderSources = [];
  const extension = { COMPLETION_STATUS_KHR: 0x91b1 };
  const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS', 'ACTIVE_UNIFORMS',
    'ARRAY_BUFFER', 'STATIC_DRAW', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
    'LINEAR', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE', 'FRAMEBUFFER',
    'COLOR_ATTACHMENT0', 'RGBA', 'UNSIGNED_BYTE', 'MAX_TEXTURE_SIZE', 'ALIASED_POINT_SIZE_RANGE',
    'FRAMEBUFFER_COMPLETE', 'LINEAR_MIPMAP_LINEAR', 'REPEAT', 'TEXTURE0', 'UNPACK_FLIP_Y_WEBGL'];
  const gl = Object.fromEntries(constants.map((name, i) => [name, i + 1]));
  Object.assign(gl, {
    getExtension(name) {
      if (name === 'KHR_parallel_shader_compile') return parallel ? extension : null;
      if (name === 'WEBGL_lose_context') return { loseContext: () => calls.push('lose-context') };
      if (name === 'OES_standard_derivatives') return derivatives ? {} : null;
      if (name === 'EXT_shader_texture_lod') return {};
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
    getAttribLocation: (program, name) => ({ a_position: 0, a_style: 1, a_wrap: 2 })[name] ?? -1,
    getParameter(name) {
      if (name === gl.MAX_TEXTURE_SIZE) return 8192;
      if (name === gl.ALIASED_POINT_SIZE_RANGE) return [1, 1024];
      throw new Error(`Unexpected GL parameter ${name}`);
    },
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    NO_ERROR: 0,
    getError: () => 0,
  });
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader',
    'bindTexture', 'texParameteri', 'bindFramebuffer', 'framebufferTexture2D', 'bindBuffer', 'bufferData', 'texImage2D',
    'generateMipmap', 'activeTexture', 'pixelStorei',
    'deleteProgram', 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer']) {
    gl[name] = () => calls.push(name);
  }
  gl.shaderSource = (shader, text) => { calls.push('shaderSource'); shaderSources.push(text); };
  const canvas = {
    getContext: type => contextAvailable && type === 'webgl' ? gl : null,
    parentElement: { classList: { remove() {} } },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
  };
  const window = {};
  runInNewContext(source, {
    window, console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    Image: class { constructor() { images.push(this); } },
    performance: { now: () => 0 },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  // Allocation sizing is covered by browser checks; these tests isolate
  // compilation, readiness and context restoration without a GPU driver.
  window.BlackHole.prototype.resize = () => calls.push('resize');
  const renderer = new window.BlackHole(canvas, { style });
  let readySignals = 0;
  renderer.onRestore = () => readySignals++;
  return {
    renderer, calls, warnings, images, shaderSources,
    get readySignals() { return readySignals; },
    get pendingPolls() { return timers.size; },
    get listeners() { return events.size; },
    complete() { complete = true; },
    pauseCompilation() { complete = false; },
    loadImages() { for (const image of images.splice(0)) image.onload(); },
    lose() { events.get('webglcontextlost')({ preventDefault() {} }); },
    restore() { complete = false; events.get('webglcontextrestored')(); },
    async tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
  };
}

await test('cold compilation returns control before querying link status or allocating the scene', async () => {
  const site = browser();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.calls.filter(name => name === 'compileShader').length, 0,
    'cold shader submission must yield to a microtask before starting work');
  assert.equal(site.calls.includes('link-status'), false);
  assert.equal(site.calls.includes('resize'), false);
  await site.tick();
  assert.equal(site.calls.filter(name => name === 'compileShader').length, 8);
  assert.equal(site.pendingPolls, 1);
  assert.equal(site.readySignals, 0);
  site.complete();
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.initialized, true);
  assert.equal(await site.renderer.initialization, true);
  assert.equal(site.readySignals, 1);
  assert.equal(site.calls.filter(name => name === 'link-status').length, 4);
  assert.deepEqual(site.warnings, []);
});

await test('a lost context cancels its pending compile and only the restored generation becomes ready', async () => {
  const site = browser();
  const originalInitialization = site.renderer.initialization;
  site.lose();
  site.restore();
  site.complete();
  await site.tick();
  assert.equal(await originalInitialization, false, 'an obsolete generation cannot announce successful initialization');
  assert.equal(await site.renderer.initialization, true);
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
  assert.equal(await site.renderer.initialization, false);
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

await test('unsupported contexts resolve initialization immediately without shader work', async () => {
  for (const options of [{ contextAvailable: false }, { derivatives: false }]) {
    const site = browser(options);
    assert.equal(site.renderer.unavailable, true);
    assert.equal(await site.renderer.initialization, false);
    assert.equal(site.renderer.ready, false);
    assert.equal(site.pendingPolls, 0);
    assert.equal(site.calls.includes('compileShader'), false);
    assert.deepEqual(site.warnings, []);
    site.renderer.dispose({ releaseGpu: false });
  }
});

await test('failed ink images resolve initialization false without waiting for unrelated image requests', async () => {
  const site = browser({ parallel: false, style: 'ink' });
  await site.tick();
  assert.equal(site.images.length, 2);
  site.images[0].onerror();
  await site.tick();
  assert.equal(await site.renderer.initialization, false);
  assert.equal(site.renderer.ready, false);
  assert.equal(site.readySignals, 0);
  assert.equal(site.warnings.length, 1);
  const calls = site.calls.length;
  site.images[1].onload();
  await site.tick();
  assert.equal(site.calls.length, calls, 'a later image must not revive failed initialization');
  site.renderer.dispose();
});

await test('disposing during compilation cancels polling and prevents late setup or restoration', async () => {
  const site = browser();
  await site.tick();
  assert.equal(site.pendingPolls, 1);
  const oldRestore = site.renderer.handleContextRestored;
  site.renderer.dispose();
  assert.equal(site.pendingPolls, 0);
  assert.equal(site.listeners, 0);
  assert.equal(site.renderer.ready, false);
  assert.equal(site.calls.filter(name => name === 'deleteProgram').length, 4);
  assert.equal(site.calls.filter(name => name === 'lose-context').length, 0,
    'exit must not force synchronous driver context destruction');
  site.complete();
  oldRestore();
  await site.tick();
  assert.equal(await site.renderer.initialization, false);
  assert.equal(site.calls.includes('link-status'), false);
  assert.equal(site.calls.includes('resize'), false);
  assert.equal(site.readySignals, 0);
  assert.equal(site.pendingPolls, 0);
  const callsAfterDispose = site.calls.length;
  site.renderer.dispose();
  assert.equal(site.calls.length, callsAfterDispose);
  assert.deepEqual(site.warnings, []);
});

await test('page exit cancels pending compilation without entering the GPU driver', async () => {
  const site = browser();
  await site.tick();
  assert.equal(site.pendingPolls, 1);
  const oldRestore = site.renderer.handleContextRestored;
  const calls = site.calls.length;
  for (const [name, value] of Object.entries(site.renderer.gl)) {
    if (typeof value === 'function') site.renderer.gl[name] = () => assert.fail(`page exit must not call ${name}`);
  }
  site.renderer.dispose({ releaseGpu: false });
  assert.equal(site.pendingPolls, 0);
  assert.equal(site.listeners, 0);
  assert.equal(site.renderer.ready, false);
  assert.equal(site.renderer.resources.length, 0);
  assert.equal(site.renderer.themePrograms.size, 0);
  site.complete();
  oldRestore();
  await site.tick();
  site.renderer.dispose({ releaseGpu: false });
  site.renderer.dispose();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.renderer.initialized, false);
  assert.equal(site.readySignals, 0);
  assert.equal(site.pendingPolls, 0);
  assert.equal(site.calls.length, calls, 'cancelled compilation must never resume setup or delete GPU handles');
  assert.deepEqual(site.warnings, []);
});

await test('late ink image success or failure after page exit cannot upload or restore the scene', async () => {
  for (const outcome of ['onload', 'onerror']) {
    const site = browser({ parallel: false, style: 'ink' });
    await site.tick();
    assert.equal(site.images.length, 2);
    assert.equal(site.renderer.ready, false);
    const images = site.images.splice(0);
    const calls = site.calls.length;
    for (const [name, value] of Object.entries(site.renderer.gl)) {
      if (typeof value === 'function') site.renderer.gl[name] = () => assert.fail(`late images must not call ${name}`);
    }
    site.renderer.dispose({ releaseGpu: false });
    for (const image of images) image[outcome]();
    await site.tick();
    assert.equal(await site.renderer.initialization, false);
    site.renderer.dispose();
    assert.equal(site.renderer.disposed, true);
    assert.equal(site.renderer.ready, false);
    assert.equal(site.renderer.initialized, false);
    assert.equal(site.renderer.inkLoaded, false);
    assert.equal(site.renderer.inkSplatter, null);
    assert.equal(site.readySignals, 0);
    assert.equal(site.pendingPolls, 0);
    assert.equal(site.listeners, 0);
    assert.equal(site.calls.length, calls, 'late images must not enter upload, mipmap or disposal work');
    assert.deepEqual(site.warnings, []);
  }
});

await test('an ink-only visit compiles only ink shaders and never allocates particle geometry', async () => {
  const site = browser({ style: 'ink' });
  await site.tick();
  assert.equal(site.calls.filter(name => name === 'compileShader').length, 4);
  assert.equal(site.shaderSources.filter(text => text.includes('const float u_ink = 1.0;')).length, 2);
  assert.equal(site.shaderSources.some(text => text.includes('attribute float a_wrap;')), false);
  site.complete();
  await site.tick();
  assert.equal(site.images.length, 2);
  assert.equal(site.renderer.ready, false, 'ink must wait for both material images');
  site.loadImages();
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.particleSky, null);
  assert.equal(site.renderer.bloom, null);
  assert.equal(site.calls.filter(name => name === 'bufferData').length, 1,
    'ink-only startup should upload only the fullscreen triangle');
  assert.equal(site.readySignals, 1);
  assert.deepEqual(site.warnings, []);
  site.renderer.dispose();
});

await test('switching back during lazy theme compilation cannot activate a stale theme', async () => {
  const site = browser();
  site.complete();
  await site.tick();
  const minimalScene = site.renderer.scene;
  site.pauseCompilation();
  site.renderer.setStyle('ink');
  await site.tick();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.pendingPolls, 1);
  site.renderer.setStyle('minimal');
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.scene, minimalScene);
  const signals = site.readySignals;
  site.complete();
  await site.tick();
  assert.equal(site.renderer.style, 'minimal');
  assert.equal(site.renderer.scene, minimalScene);
  assert.equal(site.readySignals, signals, 'late ink compilation must not announce a replacement frame');
  assert.equal(site.images.length, 0, 'obsolete theme activation must not start image requests');
  assert.equal(site.pendingPolls, 0);
  assert.deepEqual(site.warnings, []);
  site.renderer.dispose();
});

await test('late ink images respect the latest theme and switching back reuses cached shaders and particles', async () => {
  const site = browser({ parallel: false });
  await site.tick();
  const minimalScene = site.renderer.scene;
  const particles = site.renderer.particleSky;
  site.renderer.setStyle('ink');
  await site.tick();
  assert.equal(site.images.length, 2);
  site.renderer.setStyle('minimal');
  await site.tick();
  const signals = site.readySignals;
  site.loadImages();
  await site.tick();
  assert.equal(site.readySignals, signals);
  assert.equal(site.renderer.scene, minimalScene);
  assert.equal(site.renderer.particleSky, particles);
  const compiles = site.calls.filter(name => name === 'compileShader').length;
  const uploads = site.calls.filter(name => name === 'bufferData').length;
  site.renderer.setStyle('ink');
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.particleSky, null);
  const inkScene = site.renderer.scene;
  assert.notEqual(inkScene, minimalScene);
  site.renderer.setStyle('minimal');
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.scene, minimalScene);
  assert.equal(site.renderer.particleSky, particles);
  assert.equal(site.calls.filter(name => name === 'compileShader').length, compiles);
  assert.equal(site.calls.filter(name => name === 'bufferData').length, uploads);
  assert.equal(site.images.length, 0);
  assert.deepEqual(site.warnings, []);
  site.renderer.dispose();
});

await test('context restoration rebuilds only the active theme and rejects images from the lost generation', async () => {
  const site = browser();
  site.complete();
  await site.tick();
  const oldScene = site.renderer.scene;
  site.renderer.setStyle('ink');
  await site.tick();
  const staleImages = site.images.splice(0);
  assert.equal(staleImages.length, 2);
  site.lose();
  site.restore();
  site.complete();
  await site.tick();
  assert.equal(site.images.length, 2);
  assert.equal(site.renderer.themePrograms.size, 1);
  assert.equal(site.renderer.themePrograms.has('ink'), true);
  const uploads = site.calls.filter(name => name === 'texImage2D').length;
  for (const image of staleImages) image.onload();
  await site.tick();
  assert.equal(site.renderer.ready, false);
  assert.equal(site.calls.filter(name => name === 'texImage2D').length, uploads,
    'stale image callbacks must not upload into restored-context textures');
  site.loadImages();
  await site.tick();
  assert.equal(site.renderer.ready, true);
  assert.equal(site.renderer.style, 'ink');
  assert.notEqual(site.renderer.scene, oldScene);
  assert.equal(site.renderer.particleSky, null);
  assert.deepEqual(site.warnings, []);
  site.renderer.dispose();
});
