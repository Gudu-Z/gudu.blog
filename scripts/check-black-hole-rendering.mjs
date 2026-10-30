import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await Promise.all(['particle-sky', 'black-hole'].map(name =>
  readFile(new URL(`../js/${name}.js`, import.meta.url), 'utf8')))).join('\n');

// This WebGL double models the destructive effect of canvas resizing and the
// asynchronous GPU queue. The real renderer runs unchanged; no browser or GPU
// is needed to prove that a presented frame survives deferred work.
async function browser({ timerQuery = false, webgl2 = false, style = 'minimal', viewport = [1440, 900], dpr = 1,
  drawMilliseconds = 0, pollMilliseconds = 0 } = {}) {
  let id = 0;
  let framebuffer = null;
  let presented = false;
  let disjoint = false;
  let resultReads = 0;
  let width = 300;
  let height = 150;
  let now = 0;
  let nullFence = false;
  let activeTexture = 0;
  let activeProgram = null;
  const calls = [];
  const objects = [];
  const events = new Map();
  const queries = new Set();
  const syncs = new Set();
  const warnings = [];
  const textureUnits = new Map();
  const drawBindings = [];
  const bounds = { left: 0, top: 0, right: viewport[0], bottom: viewport[1], width: viewport[0], height: viewport[1] };
  const heading = { left: 120, top: 150, width: 550, height: 300 };
  const record = (name, ...args) => calls.push({ name, args });
  const create = type => {
    const object = { type, id: ++id };
    objects.push(object);
    return object;
  };
  const ext = {
    TIME_ELAPSED_EXT: 200, QUERY_RESULT_AVAILABLE_EXT: 201, QUERY_RESULT_EXT: 202, GPU_DISJOINT_EXT: 203,
    createQueryEXT() {
      const query = { id: ++id, available: false, nanoseconds: 0 };
      queries.add(query);
      record('createQuery', query);
      return query;
    },
    beginQueryEXT: (target, query) => record('beginQuery', query),
    endQueryEXT: () => record('endQuery'),
    getQueryObjectEXT(query, property) {
      assert.ok(queries.has(query), 'deleted queries must never be polled');
      if (property === this.QUERY_RESULT_AVAILABLE_EXT) return query.available;
      assert.equal(property, this.QUERY_RESULT_EXT);
      assert.ok(query.available, 'reading an unfinished GPU result would block');
      assert.equal(disjoint, false, 'invalid GPU timing must not be consumed');
      resultReads++;
      return query.nanoseconds;
    },
    deleteQueryEXT(query) {
      assert.ok(queries.delete(query), 'each query must be released once');
      record('deleteQuery', query);
    },
  };
  const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS', 'ACTIVE_UNIFORMS',
    'ARRAY_BUFFER', 'STATIC_DRAW', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
    'LINEAR', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE', 'FRAMEBUFFER',
    'COLOR_ATTACHMENT0', 'RGBA', 'UNSIGNED_BYTE', 'MAX_TEXTURE_SIZE', 'FRAMEBUFFER_COMPLETE',
    'FLOAT', 'TEXTURE0', 'TRIANGLES', 'POINTS', 'BLEND', 'ONE', 'COLOR_BUFFER_BIT',
    'ALIASED_POINT_SIZE_RANGE', 'LINEAR_MIPMAP_LINEAR', 'REPEAT', 'SYNC_GPU_COMMANDS_COMPLETE',
    'TIMEOUT_EXPIRED', 'ALREADY_SIGNALED', 'CONDITION_SATISFIED', 'WAIT_FAILED', 'UNPACK_FLIP_Y_WEBGL'];
  const gl = Object.fromEntries(constants.map((name, index) => [name, index + 1]));
  Object.assign(gl, {
    getExtension(name) {
      record('getExtension', name);
      if (name === 'EXT_disjoint_timer_query') return timerQuery ? ext : null;
      if (name === 'OES_standard_derivatives' || name === 'EXT_shader_texture_lod') return {};
      if (name === 'WEBGL_lose_context') return { loseContext: () => record('loseContext') };
      return null;
    },
    getParameter(name) {
      if (name === gl.MAX_TEXTURE_SIZE) return 8192;
      if (name === gl.ALIASED_POINT_SIZE_RANGE) return [1, 1024];
      if (name === ext.GPU_DISJOINT_EXT) return disjoint;
      throw new Error(`Unexpected GL parameter ${name}`);
    },
    createShader: () => create('shader'),
    createProgram: () => create('program'),
    createTexture: () => create('texture'),
    createFramebuffer: () => create('framebuffer'),
    createBuffer: () => create('buffer'),
    getProgramParameter(program, name) {
      if (name === gl.LINK_STATUS) return true;
      if (name === gl.ACTIVE_UNIFORMS) return program.uniforms.length;
      throw new Error(`Unexpected program parameter ${name}`);
    },
    getAttribLocation: (program, name) => ({ a_position: 0, a_style: 1, a_wrap: 2 })[name] ?? -1,
    getActiveUniform: (program, index) => program.uniforms[index],
    getUniformLocation: (program, name) => ({ program, name }),
    NO_ERROR: 0,
    getError: () => 0,
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    bindFramebuffer(target, value) { framebuffer = value; record('bindFramebuffer', value); },
    drawArrays(mode, first, count) {
      const samplers = activeProgram.uniforms.filter(uniform => uniform.type === 'sampler2D').map(uniform => {
        const unit = activeProgram.samplerUnits.get(uniform.name) ?? 0;
        const texture = textureUnits.get(unit);
        assert.ok(texture, `active sampler ${uniform.name} must have a bound texture`);
        if (framebuffer) assert.notEqual(texture, framebuffer.texture,
          `active sampler ${uniform.name} must not sample the current framebuffer attachment`);
        return { name: uniform.name, unit, texture };
      });
      drawBindings.push({ program: activeProgram, framebuffer, samplers });
      record('draw', framebuffer, mode, first, count);
      now += drawMilliseconds;
      if (mode === gl.POINTS) record('particleDraw', framebuffer, count);
      if (framebuffer === null) presented = true;
    },
    finish() { throw new Error('Rendering and disposal must not block on gl.finish'); },
    readPixels() { throw new Error('Rendering and disposal must not use blocking readback'); },
  });
  if (webgl2) Object.assign(gl, {
    fenceSync(condition, flags) {
      assert.equal(condition, gl.SYNC_GPU_COMMANDS_COMPLETE);
      assert.equal(flags, 0);
      if (nullFence) { record('failedFence'); return null; }
      const sync = { id: ++id, status: gl.TIMEOUT_EXPIRED };
      syncs.add(sync);
      record('fenceSync', sync);
      return sync;
    },
    clientWaitSync(sync, flags, timeout) {
      assert.ok(syncs.has(sync), 'deleted or lost fences must never be polled');
      assert.equal(flags, 0, 'polling must not ask the driver to synchronously flush');
      assert.equal(timeout, 0, 'animation must only perform nonblocking fence polls');
      record('clientWaitSync', sync, flags, timeout);
      now += pollMilliseconds;
      return sync.status;
    },
    deleteSync(sync) {
      assert.ok(syncs.delete(sync), 'each fence must be released exactly once');
      record('deleteSync', sync);
    },
    flush: () => record('flush'),
    waitSync() { throw new Error('Rendering must not wait synchronously for a GPU fence'); },
  });
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader',
    'bindTexture', 'texParameteri', 'framebufferTexture2D', 'bindBuffer', 'bufferData', 'texImage2D',
    'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer', 'viewport', 'activeTexture',
    'uniform1i', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4fv',
    'enable', 'disable', 'blendFunc', 'clearColor', 'clear', 'generateMipmap', 'disableVertexAttribArray', 'pixelStorei',
    'deleteProgram', 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer']) {
    gl[name] = (...args) => record(name, ...args);
  }
  Object.assign(gl, {
    shaderSource(shader, text) { shader.source = text; record('shaderSource', shader, text); },
    attachShader(program, shader) { (program.shaders ||= []).push(shader); record('attachShader', program, shader); },
    linkProgram(program) {
      // ANGLE may expose samplers from a constant-false theme branch. Keep all
      // declared uniforms active so the test models that conservative driver.
      const uniforms = new Map();
      for (const shader of program.shaders) {
        for (const match of shader.source.matchAll(/\buniform\s+(\w+)\s+(\w+)\s*;/g)) {
          uniforms.set(match[2], { type: match[1], name: match[2] });
        }
      }
      program.uniforms = [...uniforms.values()];
      program.samplerUnits = new Map();
      record('linkProgram', program);
    },
    useProgram(program) { activeProgram = program; record('useProgram', program); },
    activeTexture(unit) { activeTexture = unit - gl.TEXTURE0; record('activeTexture', unit); },
    bindTexture(target, texture) { textureUnits.set(activeTexture, texture); record('bindTexture', target, texture); },
    framebufferTexture2D(target, attachment, textarget, texture, level) {
      framebuffer.texture = texture;
      record('framebufferTexture2D', target, attachment, textarget, texture, level);
    },
    uniform1i(location, value) {
      if (location) location.program.samplerUnits.set(location.name, value);
      record('uniform1i', location, value);
    },
  });
  const figure = {
    getBoundingClientRect: () => ({ left: 90, top: -42, right: 1755, bottom: 1068, width: 1665, height: 1110 }),
    closest: () => ({
      getBoundingClientRect: () => bounds,
      querySelector: () => ({ getBoundingClientRect: () => heading }),
    }),
    classList: { add: name => record('addClass', name), remove: name => record('removeClass', name) },
  };
  const canvas = {
    style: {}, parentElement: figure,
    getContext(type) { record('getContext', type); return type === 'webgl2' ? (webgl2 ? gl : null) : gl; },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
    get width() { return width; },
    set width(value) { width = value; presented = false; record('canvasWidth', value); },
    get height() { return height; },
    set height(value) { height = value; presented = false; record('canvasHeight', value); },
  };
  const window = {};
  runInNewContext(source, {
    window, devicePixelRatio: dpr,
    performance: { now: () => now },
    Image: class { set src(value) { this.url = value; Promise.resolve().then(() => this.onload()); } },
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout, clearTimeout,
  });
  const renderer = new window.BlackHole(canvas, { style });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(renderer.ready, true);
  assert.deepEqual(warnings, []);
  return {
    renderer, canvas, calls, objects, events, queries, syncs, bounds, heading, drawBindings,
    get presented() { return presented; },
    get resultReads() { return resultReads; },
    set disjoint(value) { disjoint = value; },
    set nullFence(value) { nullFence = value; },
    advance(milliseconds) { now += milliseconds; },
    async switchStyle(style) {
      renderer.setStyle(style);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      assert.equal(renderer.ready, true);
      assert.deepEqual(warnings, []);
    },
    failWait() { renderer.gpuSync.status = gl.WAIT_FAILED; },
    lose() {
      events.get('webglcontextlost')({ preventDefault() {} });
      syncs.clear();
      queries.clear();
    },
    count: name => calls.filter(call => call.name === name).length,
    complete(milliseconds = 16) {
      if (webgl2) {
        assert.ok(renderer.gpuSync, 'a submitted frame must have an outstanding fence');
        renderer.gpuSync.status = gl.CONDITION_SATISFIED;
        return;
      }
      assert.ok(renderer.gpuQuery, 'a submitted frame must have an outstanding query');
      renderer.gpuQuery.available = true;
      renderer.gpuQuery.nanoseconds = milliseconds * 1e6;
    },
  };
}

function costWindow(site, lower, upper = lower, step = 50) {
  for (let i = 0; i < 8; i++) {
    site.advance(step);
    site.renderer.recordGpuCost(lower, upper);
  }
}

await test('WebGL 2 preserves native 1080p and 1440p detail while bounding high-DPI work', async () => {
  for (const viewport of [[1920, 1080], [2560, 1440]]) {
    const site = await browser({ webgl2: true, viewport });
    assert.equal(site.renderer.render(12, 0, 0), true);
    assert.equal(site.canvas.width, viewport[0]);
    assert.equal(site.canvas.height, viewport[1]);
    assert.equal(site.renderer.frameInterval, 1000 / 30);
    site.renderer.dispose();
  }
  const dense = await browser({ webgl2: true, viewport: [2560, 1440], dpr: 3 });
  dense.renderer.render(12, 0, 0);
  assert.ok(dense.canvas.width <= 3200);
  assert.ok(dense.canvas.width * dense.canvas.height < 3705000,
    'a high-DPI display must not bypass the bounded pixel budget');
  assert.ok(dense.canvas.width >= 2560, 'the high-DPI cap must retain native desktop detail');
  dense.renderer.dispose();
  const small = await browser({ webgl2: true, viewport: [390, 844], dpr: 3 });
  small.renderer.render(12, 0, 0);
  assert.equal(small.canvas.width, 780, 'small screens should stop at 2x device resolution');
  assert.equal(small.canvas.height, 1688);
  small.renderer.dispose();
  for (const [timerQuery, budget] of [[true, 1800000], [false, 900000]]) {
    const legacy = await browser({ timerQuery, viewport: [2560, 1440], dpr: 2 });
    legacy.renderer.render(12, 0, 0);
    assert.ok(legacy.canvas.width * legacy.canvas.height <= budget + 3000,
      'higher native detail must not increase legacy-context GPU budgets');
    legacy.renderer.dispose();
  }
});

await test('adaptive resizing keeps the presented frame until its replacement is drawn', async () => {
  const site = await browser();
  const { renderer } = site;
  assert.equal(renderer.render(12, 0, 0), true);
  const width = site.canvas.width;
  const pixels = renderer.sceneTarget.width;
  const allocations = site.count('texImage2D');
  const clears = site.count('canvasWidth');
  renderer.sampleFrame(1);
  for (let i = 1; i <= 135; i++) {
    site.advance(120);
    renderer.sampleFrame(1 + i * 120);
  }
  assert.equal(renderer.frameInterval, 1000 / 15);
  assert.ok(renderer.quality >= 0.7 && renderer.quality < 1,
    'the legacy fallback should lower resolution only after reducing cadence');
  assert.equal(site.canvas.width, width);
  assert.equal(site.count('canvasWidth'), clears);
  assert.equal(site.count('texImage2D'), allocations);
  assert.equal(site.presented, true, 'sampling performance must not erase the just-drawn frame');
  assert.equal(renderer.render(13, 0, 0), true);
  assert.ok(renderer.sceneTarget.width < pixels);
  assert.equal(site.canvas.width, width, 'measured load resizes offscreen targets, never the canvas');
  assert.equal(site.count('canvasWidth'), clears, 'resizing a canvas would wait for the GPU process');
  assert.equal(site.count('texImage2D'), allocations + 2);
  assert.equal(site.presented, true, 'the resizing task must also draw the replacement');
  renderer.dispose();
});

await test('heading/layout updates with unchanged buffer size do not clear or reallocate', async () => {
  const site = await browser();
  const { renderer } = site;
  renderer.render(12, 0, 0);
  const allocations = site.count('texImage2D');
  const clears = site.count('canvasWidth');
  const previousQuiet = [...renderer.quiet];
  site.heading.width += 40;
  renderer.resize();
  assert.notDeepEqual([...renderer.quiet], previousQuiet);
  assert.equal(site.presented, true);
  renderer.render(13, 0, 0);
  assert.equal(site.count('canvasWidth'), clears);
  assert.equal(site.count('texImage2D'), allocations);
  renderer.dispose();
});

await test('particle atlas drawing and filtering are covered by the same GPU budget as the scene', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  const firstFrame = site.calls.length;
  assert.equal(renderer.render(12, 0, 0), true);
  const frame = site.calls.slice(firstFrame);
  const begin = frame.findIndex(call => call.name === 'beginQuery');
  const particle = frame.findIndex(call => call.name === 'particleDraw');
  const filter = frame.findIndex(call => call.name === 'generateMipmap');
  const scene = frame.findIndex(call => call.name === 'draw'
    && call.args[0] === renderer.sceneTarget.buffer);
  const end = frame.findIndex(call => call.name === 'endQuery');
  assert.ok(begin >= 0 && particle > begin, 'particle rendering must obey the shared in-flight query');
  assert.ok(filter > particle && scene > filter, 'the scene must sample the completed, filtered particle atlas');
  assert.ok(end > scene, 'the GPU measurement must include both atlas and scene work');
  assert.equal(frame.filter(call => call.name === 'particleDraw').length, 1,
    'all stars should share a single particle batch');
  assert.ok(frame[particle].args[0], 'particles must render offscreen for lensed background sampling');
  assert.ok(frame[particle].args[1] > 0, 'the particle batch must contain stars');
  const allocations = site.count('texImage2D');
  const uploads = site.count('bufferData');
  site.complete();
  assert.equal(renderer.render(13, 0.4, -0.3), true);
  assert.equal(site.count('texImage2D'), allocations, 'particle animation must reuse its texture allocation');
  assert.equal(site.count('bufferData'), uploads, 'particle motion must not upload a fresh star array each frame');
  renderer.dispose();
});

await test('a busy GPU preserves the presented frame and defers pending resize and draws', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  site.bounds.width = site.bounds.right = 1000;
  renderer.resize();
  const allocations = site.count('texImage2D');
  const clears = site.count('canvasWidth');
  const draws = site.count('draw');
  const particleDraws = site.count('particleDraw');
  const mipmaps = site.count('generateMipmap');
  const width = site.canvas.width;
  assert.equal(renderer.render(13, 0, 0), false);
  assert.equal(site.count('draw'), draws);
  assert.equal(site.count('particleDraw'), particleDraws);
  assert.equal(site.count('generateMipmap'), mipmaps, 'a pending GPU frame must also defer atlas work');
  assert.equal(site.count('texImage2D'), allocations);
  assert.equal(site.count('canvasWidth'), clears);
  assert.equal(site.presented, true);
  assert.equal(site.resultReads, 0);
  assert.equal(site.queries.size, 1);
  site.complete();
  assert.equal(renderer.render(14, 0, 0), true);
  assert.notEqual(site.canvas.width, width);
  assert.equal(site.count('draw'), draws + 4);
  assert.equal(site.count('particleDraw'), particleDraws + 1);
  assert.equal(site.presented, true);
  assert.equal(site.queries.size, 1, 'only the replacement frame should remain in flight');
  renderer.dispose();
});

await test('disjoint GPU timing discards even an unfinished query instead of stalling rendering', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  renderer.gpuTimes.push(100);
  site.disjoint = true;
  assert.equal(renderer.render(13, 0, 0), true);
  assert.equal(site.count('deleteQuery'), 1);
  assert.equal(site.resultReads, 0);
  assert.equal(renderer.gpuTimes.length, 0);
  assert.equal(renderer.quality, 1);
  assert.equal(site.presented, true);
  renderer.dispose();
});

await test('sustained measured GPU overload reduces pixels before cadence and respects the cooldown', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  const width = renderer.sceneTarget.width;
  for (let i = 0; i < 8; i++) {
    site.advance(50);
    site.complete(50);
    assert.equal(renderer.render(13 + i, 0, 0), true);
    assert.equal(site.presented, true);
  }
  assert.equal(renderer.frameInterval, 1000 / 30);
  assert.equal(renderer.quality, 0.75, 'measured pressure should reduce pixel work on its first sample window');
  assert.ok(renderer.sceneTarget.width < width);
  const reducedWidth = renderer.sceneTarget.width;
  assert.equal(site.resultReads, 8);
  assert.equal(site.queries.size, 1);
  costWindow(site, 80);
  assert.equal(renderer.quality, 0.75, 'changes must not repeat during the cooldown');
  site.advance(750);
  costWindow(site, 80);
  assert.equal(renderer.frameInterval, 1000 / 30);
  assert.equal(renderer.quality, 0.6, 'heavy pressure reaches the bounded pixel floor before slowing motion');
  assert.equal(renderer.sceneTarget.width, reducedWidth, 'a scheduled resize must preserve the displayed frame');
  site.advance(750);
  costWindow(site, 80);
  assert.equal(renderer.frameInterval, 1000 / 20, 'cadence is the fallback once pixel work reaches its floor');
  site.advance(750);
  costWindow(site, 80);
  assert.equal(renderer.frameInterval, 1000 / 15);
  site.complete(80);
  renderer.render(24, 0, 0);
  assert.ok(renderer.sceneTarget.width < width);
  assert.equal(site.presented, true);
  for (let i = 0; i < 12; i++) {
    site.advance(2000);
    costWindow(site, 200);
  }
  assert.equal(renderer.quality, 0.6, 'continued overload must respect the measured-context quality floor');
  renderer.dispose();
});

await test('interactive cadence is bounded by completion support and respects adaptive slowdowns', async () => {
  for (const options of [{ webgl2: true }, { timerQuery: true }, {}]) {
    const site = await browser(options);
    const { renderer } = site;
    const bounded = options.webgl2 || options.timerQuery;
    assert.equal(renderer.getFrameInterval(true), bounded ? 1000 / 60 : 1000 / 30);
    assert.equal(renderer.getFrameInterval(false), 1000 / 30);
    const quality = renderer.quality;
    for (const interval of [50, 1000 / 15]) {
      renderer.frameInterval = interval;
      assert.equal(renderer.getFrameInterval(true), interval, 'input must not override GPU load reduction');
    }
    assert.equal(renderer.quality, quality, 'camera motion must not change render resolution');
    renderer.dispose();
  }
});

await test('one driver stall does not permanently lower rendering quality', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  for (let i = 0; i < 8; i++) {
    site.complete(i === 0 ? 250 : 16);
    renderer.render(13 + i, 0, 0);
  }
  assert.equal(renderer.quality, 1);
  assert.equal(renderer.frameInterval, 1000 / 30);
  renderer.dispose();
});

await test('recovery uses sustained upper-bound headroom to restore cadence before detail', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.quality = 0.6;
  renderer.frameInterval = 1000 / 15;
  renderer.resize();
  renderer.render(12, 0, 0);
  const width = renderer.sceneTarget.width;
  for (let i = 0; i < 16; i++) costWindow(site, 0, 50);
  assert.equal(renderer.quality, 0.6,
    'a completed first poll is not zero-cost evidence when its upper bound has insufficient headroom');
  for (let i = 0; i < 12; i++) costWindow(site, 4, 8);
  assert.equal(renderer.frameInterval, 1000 / 15, 'recovery must wait at least five seconds of good samples');
  for (let i = 0; i < 2; i++) costWindow(site, 4, 8);
  assert.equal(renderer.frameInterval, 1000 / 20);
  assert.equal(renderer.quality, 0.6, 'motion must recover before restoring pixel density');
  for (let i = 0; i < 20; i++) costWindow(site, 4, 8);
  assert.equal(renderer.frameInterval, 1000 / 30);
  assert.equal(renderer.quality, 0.6);
  for (let i = 0; i < 20; i++) costWindow(site, 4, 8);
  assert.ok(Math.abs(renderer.quality - 0.65) < 1e-9);
  assert.equal(renderer.sceneTarget.width, width, 'upscaling must keep the old frame intact until its replacement');
  assert.equal(site.presented, true);
  site.complete();
  renderer.render(13, 0, 0);
  assert.ok(renderer.sceneTarget.width > width);
  assert.equal(site.presented, true);
  for (let i = 0; i < 5; i++) costWindow(site, 4, 8);
  assert.ok(Math.abs(renderer.quality - 0.65) < 1e-9,
    'good samples within the cooldown cannot cause another immediate upscale');
  for (let i = 0; i < 180; i++) costWindow(site, 4, 8);
  assert.equal(renderer.quality, 1);
  assert.equal(renderer.frameInterval, 1000 / 30);
  renderer.dispose();
});

await test('near-threshold timing interrupts recovery instead of causing resolution oscillation', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.quality = 0.8;
  renderer.frameInterval = 50;
  for (let i = 0; i < 12; i++) costWindow(site, 4, 8);
  costWindow(site, 30, 35);
  for (let i = 0; i < 12; i++) costWindow(site, 4, 8);
  assert.equal(renderer.quality, 0.8, 'headroom must be sustained rather than accumulated across busy windows');
  assert.equal(renderer.frameInterval, 50);
  renderer.dispose();
});

await test('recovery budgets the additional pixels instead of only checking current GPU cost', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.quality = 0.8;
  renderer.frameInterval = 1000 / 30;
  for (let i = 0; i < 20; i++) costWindow(site, 4, 20);
  assert.equal(renderer.quality, 0.8,
    'a cost below the current headroom threshold can still be too high after the proposed upscale');
  assert.equal(renderer.frameInterval, 1000 / 30);
  renderer.dispose();
});

await test('legacy JS frame cadence alone cannot prove enough GPU headroom to raise quality', async () => {
  const site = await browser();
  const { renderer } = site;
  renderer.quality = 0.8;
  renderer.frameInterval = 1000 / 15;
  for (let i = 0; i < 600; i++) {
    site.advance(16);
    renderer.sampleFrame(1 + i * 16);
  }
  assert.equal(renderer.quality, 0.8);
  assert.equal(renderer.frameInterval, 1000 / 15);
  renderer.dispose();
});

await test('disposal releases each resource and pending query once without blocking', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  assert.equal(site.count('particleDraw'), 1);
  assert.equal(site.objects.filter(object => object.type === 'program').length, 4,
    'the particle shader must participate in normal resource ownership');
  assert.ok(site.objects.filter(object => object.type === 'buffer').length >= 2,
    'the fullscreen triangle and star geometry both need owned buffers');
  assert.ok(site.objects.filter(object => object.type === 'texture').length >= 5,
    'the offscreen particle atlas must be included in disposal coverage');
  renderer.dispose();
  assert.equal(renderer.ready, false);
  assert.equal(site.events.size, 0);
  assert.equal(site.queries.size, 0);
  assert.equal(site.count('loseContext'), 0, 'exit must not force synchronous driver context destruction');
  const deletes = { program: 'deleteProgram', texture: 'deleteTexture', framebuffer: 'deleteFramebuffer', buffer: 'deleteBuffer' };
  for (const [type, name] of Object.entries(deletes)) {
    const expected = site.objects.filter(object => object.type === type).map(object => object.id);
    const removed = site.calls.filter(call => call.name === name).map(call => call.args[0].id);
    assert.deepEqual(removed.sort((a, b) => a - b), expected.sort((a, b) => a - b));
  }
  const calls = site.calls.length;
  renderer.dispose();
  assert.equal(renderer.render(20, 0, 0), false);
  renderer.resize();
  assert.equal(site.calls.length, calls, 'disposed renderers must not touch GL again');
});

await test('WebGL 2 uses one completion fence after all passes without enabling timer queries', async () => {
  const site = await browser({ webgl2: true, timerQuery: true });
  const { renderer } = site;
  assert.equal(renderer.webgl2, true);
  assert.deepEqual(site.calls.filter(call => call.name === 'getContext').map(call => call.args[0]), ['webgl2']);
  assert.equal(site.calls.some(call => call.name === 'getExtension' && /disjoint_timer_query/.test(call.args[0])), false,
    'the WebGL 2 path must avoid timer-query instrumentation of large shader draws');
  for (const call of site.calls.filter(call => call.name === 'shaderSource')) {
    assert.match(call.args[1], /^#version 300 es\n/);
    assert.doesNotMatch(call.args[1], /\b(?:attribute|varying|gl_FragColor|texture2DGradEXT)\b/);
  }
  const start = site.calls.length;
  assert.equal(renderer.render(12, 0, 0), true);
  const frame = site.calls.slice(start);
  const lastDraw = frame.findLastIndex(call => call.name === 'draw');
  const fence = frame.findIndex(call => call.name === 'fenceSync');
  const flush = frame.findIndex(call => call.name === 'flush');
  assert.ok(fence > lastDraw && flush > fence, 'the fence must cover the atlas, scene, bloom and composite');
  assert.equal(frame.filter(call => call.name === 'draw').length, 4);
  assert.equal(frame.filter(call => call.name === 'fenceSync').length, 1);
  assert.equal(site.count('createQuery'), 0);
  assert.equal(site.syncs.size, 1);
  renderer.dispose();
});

await test('completion polling measures both timing bounds without drawing or reallocating', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  const samples = [];
  renderer.recordGpuCost = (...sample) => samples.push(sample);
  renderer.render(12, 0, 0);
  const draws = site.count('draw');
  const allocations = site.count('texImage2D');
  site.advance(12);
  assert.equal(renderer.pollGpu(), false);
  site.advance(6);
  site.complete();
  assert.equal(renderer.pollGpu(), true);
  assert.deepEqual(samples, [[12, 18]],
    'the last unfinished poll and first completed poll must bracket GPU completion');
  assert.equal(site.count('draw'), draws);
  assert.equal(site.count('texImage2D'), allocations);
  assert.equal(site.syncs.size, 0);
  assert.equal(site.presented, true);
  renderer.render(13, 0, 0);
  site.advance(16);
  site.complete();
  renderer.pollGpu();
  assert.deepEqual(samples[1], [0, 16],
    'an already complete first poll still has a nonzero cost upper bound');
  renderer.dispose();
  const calls = site.calls.length;
  assert.equal(renderer.pollGpu(), false);
  assert.equal(site.calls.length, calls, 'polling a disposed renderer must not touch GL');
});

await test('completion upper bounds include overlapping draw submission and the native fence poll', async () => {
  const site = await browser({ webgl2: true, drawMilliseconds: 5, pollMilliseconds: 7 });
  const { renderer } = site;
  const samples = [];
  renderer.recordGpuCost = (...sample) => samples.push(sample);
  renderer.render(12, 0, 0);
  assert.equal(site.count('draw'), 4, 'all four passes contribute submission time');
  site.advance(16);
  site.complete();
  assert.equal(renderer.pollGpu(), true);
  assert.deepEqual(samples, [[0, 43]],
    'upper bound must cover 20 ms of draw submission, 16 ms until polling and 7 ms inside the native poll');
  renderer.render(13, 0, 0);
  site.advance(12);
  assert.equal(renderer.pollGpu(), false);
  site.advance(6);
  site.complete();
  assert.equal(renderer.pollGpu(), true);
  assert.deepEqual(samples[1], [12, 52],
    'an unfinished poll keeps its conservative post-fence lower bound while the upper includes both native calls');
  renderer.dispose();
});

await test('resetting timing discards stale samples while retaining cadence, quality and the in-flight fence', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.quality = 0.8;
  renderer.frameInterval = 50;
  renderer.resize();
  renderer.render(12, 0, 0);
  const fence = renderer.gpuSync;
  costWindow(site, 4, 8);
  renderer.recordGpuCost(4, 8);
  assert.notEqual(renderer.headroomSince, null);
  assert.equal(renderer.gpuTimes.length, 1);
  renderer.resetTiming();
  assert.equal(renderer.quality, 0.8);
  assert.equal(renderer.frameInterval, 50);
  assert.equal(renderer.gpuSync, fence, 'pausing must not discard the GPU submission gate');
  assert.equal(renderer.gpuTimes.length, 0);
  assert.equal(renderer.gpuUpperTimes.length, 0);
  assert.equal(renderer.headroomSince, null);
  site.advance(60000);
  assert.equal(renderer.pollGpu(), false, 'the pending frame remains gated after a pause');
  site.complete();
  assert.equal(renderer.pollGpu(), true);
  assert.equal(renderer.gpuTimes.length, 0, 'the stale frame must never enter adaptation');
  for (let i = 0; i < 12; i++) costWindow(site, 4, 8);
  assert.equal(renderer.quality, 0.8, 'time spent paused must not count toward recovery');
  renderer.dispose();
});

await test('a long scheduling gap discards partial recovery evidence even without a lifecycle callback', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.quality = 0.8;
  renderer.frameInterval = 50;
  costWindow(site, 4, 8);
  renderer.recordGpuCost(4, 8);
  renderer.render(12, 0, 0);
  site.advance(10000);
  site.complete();
  assert.equal(renderer.pollGpu(), true);
  assert.equal(renderer.gpuTimes.length, 0);
  assert.equal(renderer.gpuUpperTimes.length, 0);
  assert.equal(renderer.headroomSince, null, 'scheduler suspension is not evidence of idle GPU capacity');
  for (let i = 0; i < 12; i++) costWindow(site, 4, 8);
  assert.equal(renderer.quality, 0.8);
  renderer.dispose();
});

await test('an unfinished WebGL 2 fence defers all particle work, target resizing and frame submission', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  assert.equal(renderer.render(12, 0, 0), true);
  const firstFence = renderer.gpuSync;
  site.bounds.width = site.bounds.right = 1000;
  renderer.resize();
  const start = site.calls.length;
  site.advance(40);
  assert.equal(renderer.render(13, 0, 0), false);
  const pending = site.calls.slice(start);
  assert.deepEqual(pending.map(call => call.name), ['clientWaitSync'],
    'a busy frame may only poll its fence, without uploading, clearing or drawing');
  assert.equal(site.presented, true);
  assert.equal(renderer.gpuSync, firstFence);
  site.complete();
  assert.equal(renderer.render(14, 0, 0), true);
  assert.equal(site.calls.filter(call => call.name === 'deleteSync' && call.args[0] === firstFence).length, 1);
  assert.notEqual(renderer.gpuSync, firstFence);
  assert.equal(site.syncs.size, 1, 'only the replacement frame may remain in flight');
  assert.equal(site.presented, true);
  assert.equal(renderer.resizePending, false);
  renderer.dispose();
});

await test('disposing with a pending WebGL 2 fence deletes it once and never polls or waits for completion', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  renderer.dispose();
  assert.equal(site.syncs.size, 0);
  assert.equal(site.count('deleteSync'), 1);
  assert.equal(site.count('clientWaitSync'), 0);
  assert.equal(site.count('loseContext'), 0);
  const calls = site.calls.length;
  renderer.dispose();
  assert.equal(renderer.render(13, 0, 0), false);
  renderer.resize();
  assert.equal(site.calls.length, calls);
});

await test('page-exit disposal abandons pending fences and queries without any GPU calls', async () => {
  for (const options of [{ webgl2: true }, { timerQuery: true }]) {
    const site = await browser(options);
    const { renderer } = site;
    assert.equal(renderer.render(12, 0, 0), true);
    assert.ok(renderer.gpuSync || renderer.gpuQuery, 'a frame must still be in flight at exit');
    const lost = renderer.handleContextLost;
    const restored = renderer.handleContextRestored;
    const calls = site.calls.length;
    for (const api of [renderer.gl, renderer.timerQuery].filter(Boolean)) {
      for (const [name, value] of Object.entries(api)) {
        if (typeof value === 'function') api[name] = () => assert.fail(`page exit must not call ${name}`);
      }
    }
    renderer.dispose({ releaseGpu: false });
    assert.equal(renderer.disposed, true);
    assert.equal(renderer.ready, false);
    assert.equal(renderer.initialized, false);
    assert.equal(renderer.gpuSync, null);
    assert.equal(renderer.gpuQuery, null);
    assert.equal(renderer.resources.length, 0);
    assert.equal(renderer.themePrograms.size, 0);
    assert.equal(renderer.particleSky, null);
    assert.equal(site.events.size, 0);
    assert.equal(site.syncs.size + site.queries.size, 1,
      'the discarded context retains its handles for browser-owned cleanup');
    renderer.dispose({ releaseGpu: false });
    renderer.dispose();
    lost({ preventDefault() { assert.fail('disposed listeners must be inert'); } });
    restored();
    assert.equal(renderer.render(13, 0, 0), false);
    renderer.resize();
    assert.equal(site.calls.length, calls, 'exit and late callbacks must not touch the GPU or canvas');
  }
});

await test('context loss invalidates a pending fence without polling or deleting lost-context objects', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  site.lose();
  const calls = site.calls.length;
  assert.equal(renderer.render(13, 0, 0), false);
  renderer.dispose();
  assert.equal(site.calls.length, calls);
  assert.equal(site.count('clientWaitSync'), 0);
  assert.equal(site.count('deleteSync'), 0);
  assert.equal(renderer.gpuSync, null);
});

await test('a failed fence poll falls back safely instead of submitting unbounded replacement frames', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  const draws = site.count('draw');
  site.failWait();
  assert.equal(renderer.render(13, 0, 0), false);
  assert.equal(renderer.ready, false);
  assert.equal(renderer.initialized, false);
  assert.equal(site.count('draw'), draws);
  assert.equal(site.syncs.size, 0);
  assert.equal(site.count('deleteSync'), 1);
  assert.equal(site.calls.at(-1).name, 'removeClass');
  const calls = site.calls.length;
  assert.equal(renderer.render(14, 0, 0), false);
  assert.equal(site.calls.length, calls);
  renderer.dispose();
});

await test('failure to create a completion fence restores fallback and stops further GPU work', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  site.nullFence = true;
  assert.equal(renderer.render(12, 0, 0), false);
  assert.equal(renderer.ready, false);
  assert.equal(site.count('failedFence'), 1);
  assert.equal(site.count('flush'), 0);
  assert.equal(site.syncs.size, 0);
  const calls = site.calls.length;
  assert.equal(renderer.render(13, 0, 0), false);
  assert.equal(site.calls.length, calls);
  renderer.dispose();
});

await test('repeated unfinished fences reduce pixels while preserving cadence and the displayed frame', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  const width = renderer.sceneTarget.width;
  for (let i = 0; i < 8; i++) {
    site.advance(50);
    assert.equal(renderer.render(13 + i, 0, 0), false);
    assert.equal(site.presented, true);
    site.complete();
    assert.equal(renderer.render(13 + i, 0, 0), true);
    assert.equal(site.presented, true);
  }
  assert.equal(renderer.frameInterval, 1000 / 30);
  assert.equal(renderer.quality, 0.75);
  assert.ok(renderer.sceneTarget.width < width);
  assert.equal(site.syncs.size, 1);
  renderer.dispose();
});

await test('a long pause followed by an already completed fence is not treated as slow GPU rendering', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  for (let i = 0; i < 8; i++) {
    site.advance(60000);
    site.complete();
    assert.equal(renderer.render(13 + i, 0, 0), true);
  }
  assert.equal(renderer.quality, 1, 'tab suspension or delayed scheduling must not lower resolution');
  assert.equal(site.syncs.size, 1);
  renderer.dispose();
});

await test('retained inactive-theme samplers remain safe across consecutive minimal, ink and cached-minimal frames', async () => {
  const site = await browser({ webgl2: true });
  const { renderer } = site;
  let frame = 12;
  for (const style of ['minimal', 'ink', 'minimal']) {
    if (renderer.style !== style) await site.switchStyle(style);
    for (let i = 0; i < 2; i++) {
      if (renderer.gpuSync) site.complete();
      const start = site.drawBindings.length;
      const particles = site.count('particleDraw');
      assert.equal(renderer.render(frame++, 0, 0), true);
      const scene = site.drawBindings.slice(start).find(draw => draw.program === renderer.scene.value);
      assert.ok(scene);
      assert.deepEqual(scene.samplers.map(sampler => sampler.name).sort(), ['u_inkAtlas', 'u_inkLight', 'u_starSky'],
        'both theme sampler sets must remain reflected to reproduce the ANGLE driver case');
      for (const sampler of scene.samplers) {
        assert.notEqual(sampler.texture, renderer.sceneTarget.texture,
          `${style} sampler ${sampler.name} cannot inherit the composite pass scene attachment`);
      }
      if (style === 'ink') assert.equal(site.count('particleDraw'), particles);
    }
  }
  renderer.dispose();
});

await test('ink-only rendering binds a safe inactive star sampler even when no particle atlas exists', async () => {
  const site = await browser({ webgl2: true, style: 'ink' });
  const { renderer } = site;
  assert.equal(renderer.particleSky, null);
  for (let i = 0; i < 2; i++) {
    if (renderer.gpuSync) site.complete();
    const start = site.drawBindings.length;
    assert.equal(renderer.render(12 + i, 0, 0), true);
    const scene = site.drawBindings.slice(start).find(draw => draw.program === renderer.scene.value);
    const inactiveStars = scene.samplers.find(sampler => sampler.name === 'u_starSky');
    assert.ok(inactiveStars?.texture, 'an optimized branch may still leave its star sampler active');
    assert.notEqual(inactiveStars.texture, renderer.sceneTarget.texture);
  }
  assert.equal(site.count('particleDraw'), 0);
  renderer.dispose();
});

await test('chapter frames reuse the hero passes and never mipmap or refilter the bloom target', async () => {
  // WebGL 1 cannot mipmap this non-power-of-two bloom target at all.
  for (const options of [{ webgl2: true }, { viewport: [1001, 777] }]) {
    const site = await browser(options);
    const { renderer } = site;
    const gl = renderer.gl;
    const bloomOperations = start => {
      let unit = gl.TEXTURE0;
      const bindings = new Map();
      return site.calls.flatMap((call, index) => {
        if (call.name === 'activeTexture') unit = call.args[0];
        if (call.name === 'bindTexture') bindings.set(unit, call.args[1]);
        return index >= start && bindings.get(unit) === renderer.bloomTarget.texture
          && ['generateMipmap', 'texParameteri'].includes(call.name) ? [call] : [];
      });
    };

    const heroStart = site.calls.length;
    const drawsBefore = site.count('draw');
    assert.equal(renderer.render(12, 0, 0, 0), true);
    const heroDraws = site.count('draw') - drawsBefore;
    if (options.webgl2) site.complete();

    const chapterDraws = site.count('draw');
    const fencesBefore = site.count('fenceSync');
    assert.equal(renderer.render(13, 0, 0, 1), true);
    assert.equal(site.count('draw') - chapterDraws, heroDraws,
      'the distant disk must reuse the hero render passes');
    if (options.webgl2) assert.equal(site.count('fenceSync') - fencesBefore, 1);
    assert.deepEqual(bloomOperations(heroStart), [],
      'neither view builds a bloom mip chain or changes its single-level sampler');
    renderer.dispose();
  }
});

await test('entrance light is a clamped composite-only input that resets by default and keeps the frame budget', async () => {
  for (const webgl2 of [false, true]) {
    const site = await browser({ webgl2 });
    const { renderer } = site;
    const capture = glow => {
      if (webgl2 && renderer.gpuSync) site.complete();
      const start = site.calls.length;
      assert.equal(renderer.render(12, 0.2, -0.3, 0.5, glow), true);
      return site.calls.slice(start);
    };
    const upload = calls => calls.find(call => call.name === 'uniform1f'
      && call.args[0]?.name === 'u_entranceGlow');
    const sceneInputs = calls => calls.filter(call => call.name.startsWith('uniform')
      && call.args[0]?.program === renderer.scene.value)
      .map(call => [call.name, call.args[0].name, ...call.args.slice(1)]);
    const base = capture(0);
    const pulse = capture(1);
    assert.equal(upload(pulse).args[1], 1);
    assert.equal(upload(pulse).args[0].program, renderer.composite.value);
    assert.equal(renderer.scene.uniforms.u_entranceGlow, undefined);
    assert.deepEqual(sceneInputs(pulse), sceneInputs(base),
      'the accent cannot alter disk geometry, scene emission, sky inputs, or camera uniforms');
    for (const name of ['draw', 'generateMipmap', 'fenceSync']) {
      assert.equal(pulse.filter(call => call.name === name).length, base.filter(call => call.name === name).length,
        `the pulse cannot add ${name} operations`);
    }
    if (webgl2) {
      const before = site.calls.length;
      assert.equal(renderer.render(12, 0.2, -0.3, 0.5, 0), false);
      assert.equal(upload(site.calls.slice(before)), undefined, 'a busy GPU defers the composite update');
    }
    assert.equal(upload(capture(undefined)).args[1], 0, 'omitting the transient input must clear the previous pulse');
    assert.equal(upload(capture(4)).args[1], 1);
    assert.equal(upload(capture(-1)).args[1], 0);
    assert.equal(upload(capture(Number.NaN)).args[1], 0);
    renderer.dispose();
  }
});
