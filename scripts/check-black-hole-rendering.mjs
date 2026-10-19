import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/black-hole.js', import.meta.url), 'utf8');

// This WebGL double models the destructive effect of canvas resizing and the
// asynchronous GPU queue. The real renderer runs unchanged; no browser or GPU
// is needed to prove that a presented frame survives deferred work.
async function browser({ timerQuery = false } = {}) {
  let id = 0;
  let framebuffer = null;
  let presented = false;
  let disjoint = false;
  let resultReads = 0;
  let width = 300;
  let height = 150;
  const calls = [];
  const objects = [];
  const events = new Map();
  const queries = new Set();
  const warnings = [];
  const bounds = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
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
    'FLOAT', 'TEXTURE0', 'TRIANGLES'];
  const gl = Object.fromEntries(constants.map((name, index) => [name, index + 1]));
  Object.assign(gl, {
    getExtension(name) {
      if (name === 'EXT_disjoint_timer_query') return timerQuery ? ext : null;
      if (name === 'OES_standard_derivatives' || name === 'EXT_shader_texture_lod') return {};
      if (name === 'WEBGL_lose_context') return { loseContext: () => record('loseContext') };
      return null;
    },
    getParameter(name) {
      if (name === gl.MAX_TEXTURE_SIZE) return 8192;
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
      if (name === gl.ACTIVE_UNIFORMS) return 0;
      throw new Error(`Unexpected program parameter ${name}`);
    },
    getAttribLocation: () => 0,
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    bindFramebuffer(target, value) { framebuffer = value; record('bindFramebuffer', value); },
    drawArrays() { record('draw', framebuffer); if (framebuffer === null) presented = true; },
    finish() { throw new Error('Rendering and disposal must not block on gl.finish'); },
    readPixels() { throw new Error('Rendering and disposal must not use blocking readback'); },
  });
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader',
    'bindTexture', 'texParameteri', 'framebufferTexture2D', 'bindBuffer', 'bufferData', 'texImage2D',
    'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer', 'viewport', 'activeTexture',
    'uniform1i', 'uniform1f', 'uniform2f', 'uniform4fv',
    'deleteProgram', 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer']) {
    gl[name] = (...args) => record(name, ...args);
  }
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
    getContext: () => gl,
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); },
    get width() { return width; },
    set width(value) { width = value; presented = false; record('canvasWidth', value); },
    get height() { return height; },
    set height(value) { height = value; presented = false; record('canvasHeight', value); },
  };
  const window = {};
  runInNewContext(source, {
    window, devicePixelRatio: 1,
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout, clearTimeout,
  });
  const renderer = new window.BlackHole(canvas);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(renderer.ready, true);
  assert.deepEqual(warnings, []);
  return {
    renderer, canvas, calls, objects, events, queries, bounds, heading,
    get presented() { return presented; },
    get resultReads() { return resultReads; },
    set disjoint(value) { disjoint = value; },
    count: name => calls.filter(call => call.name === name).length,
    complete(milliseconds = 16) {
      assert.ok(renderer.gpuQuery, 'a submitted frame must have an outstanding query');
      renderer.gpuQuery.available = true;
      renderer.gpuQuery.nanoseconds = milliseconds * 1e6;
    },
  };
}

await test('adaptive resizing keeps the presented frame until its replacement is drawn', async () => {
  const site = await browser();
  const { renderer } = site;
  assert.equal(renderer.render(12, 0, 0), true);
  const width = site.canvas.width;
  const allocations = site.count('texImage2D');
  const clears = site.count('canvasWidth');
  for (let i = 0; i <= 45; i++) renderer.sampleFrame(1 + i * 50);
  assert.ok(renderer.quality < 1, 'slow frames should request a lower resolution');
  assert.equal(site.canvas.width, width);
  assert.equal(site.count('canvasWidth'), clears);
  assert.equal(site.count('texImage2D'), allocations);
  assert.equal(site.presented, true, 'sampling performance must not erase the just-drawn frame');
  assert.equal(renderer.render(13, 0, 0), true);
  assert.ok(site.canvas.width < width);
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

await test('a busy GPU preserves the presented frame and defers pending resize and draws', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  site.bounds.width = site.bounds.right = 1000;
  renderer.resize();
  const allocations = site.count('texImage2D');
  const clears = site.count('canvasWidth');
  const draws = site.count('draw');
  const width = site.canvas.width;
  assert.equal(renderer.render(13, 0, 0), false);
  assert.equal(site.count('draw'), draws);
  assert.equal(site.count('texImage2D'), allocations);
  assert.equal(site.count('canvasWidth'), clears);
  assert.equal(site.presented, true);
  assert.equal(site.resultReads, 0);
  assert.equal(site.queries.size, 1);
  site.complete();
  assert.equal(renderer.render(14, 0, 0), true);
  assert.notEqual(site.canvas.width, width);
  assert.equal(site.count('draw'), draws + 3);
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

await test('valid GPU duration lowers resolution before drawing the replacement frame', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
  const width = site.canvas.width;
  for (let i = 0; i < 8; i++) {
    site.complete(50);
    assert.equal(renderer.render(13 + i, 0, 0), true);
    assert.equal(site.presented, true);
  }
  assert.ok(site.canvas.width < width);
  assert.ok(renderer.quality >= 0.5);
  assert.equal(site.resultReads, 8);
  assert.equal(site.queries.size, 1);
  renderer.dispose();
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
  renderer.dispose();
});

await test('disposal releases each resource and pending query once without blocking', async () => {
  const site = await browser({ timerQuery: true });
  const { renderer } = site;
  renderer.render(12, 0, 0);
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
