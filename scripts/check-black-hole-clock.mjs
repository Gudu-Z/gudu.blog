import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, event = {}) {
      for (const listener of listeners.get(name) || []) listener(event);
    },
  };
}

function classes(initial = []) {
  const values = new Set(initial);
  return { contains: name => values.has(name), add: name => values.add(name), remove: name => values.delete(name) };
}

// Execute the real main.js against controlled browser events and a monotonic
// clock. Assertions observe the time and camera passed to the renderer.
function browser({ reduced = false, loading = false, deferInk = false, deferReady = false } = {}) {
  let now = 0;
  let sequence = 0;
  let renderCost = 0;
  let renderer;
  let intersection;
  let resize;
  let nextStyle = 'minimal';
  const frames = new Map();
  const timers = new Map();
  const renders = [];
  const renderers = [];
  const samples = [];
  const media = {
    '(prefers-reduced-motion: reduce)': eventTarget({ matches: reduced }),
    '(pointer: fine)': eventTarget({ matches: true }),
  };
  const hero = eventTarget({
    dataset: {}, classList: classes(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  });
  const canvas = eventTarget({ parentElement: { classList: classes() } });
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} };
  const stars = { getContext: () => context };
  const clockParts = [{ textContent: '' }, { textContent: '' }];
  const clock = {
    querySelector: name => clockParts[name === '[data-clock-date]' ? 0 : 1],
    setAttribute() {},
  };
  const layers = ['1', '2'].map(depth => ({
    dataset: { depth }, style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
  }));
  const nodes = { '.hero': hero, '#starfield': stars, '#black-hole-canvas': canvas, '#local-time': clock };
  const document = eventTarget({
    hidden: false,
    documentElement: { classList: classes(loading ? ['is-loading', 'has-site-intro'] : []) },
    querySelector: name => nodes[name], querySelectorAll: () => layers,
  });
  const window = eventTarget({
    BlackHoleTheme: { apply: style => style || nextStyle, resolve: () => nextStyle },
    BlackHole: class {
      constructor(_canvas, options) {
        renderer = this;
        renderers.push(this);
        this.style = options.style;
        this.ready = !deferReady;
        this.lost = false;
        this.disposed = false;
        this.busy = false;
        this.resizes = 0;
        canvas.addEventListener('webglcontextlost', () => { this.ready = false; this.lost = true; });
      }
      resize() { this.resizes++; }
      resetTiming() {}
      sampleFrame(timestamp) { samples.push(timestamp); }
      dispose() { this.disposed = true; this.ready = false; }
      setStyle(style) { this.style = style; this.ready = !(deferInk && style === 'ink'); }
      render(time, x, y) {
        if (!this.ready || this.lost || this.disposed || this.busy) return false;
        renders.push({ time, x, y, at: now });
        now += renderCost;
        return true;
      }
    },
  });
  runInNewContext(source, {
    window, document, console, Date, Intl, devicePixelRatio: 1,
    performance: { now: () => now },
    matchMedia: query => media[query],
    requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe() {} },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} },
  }, { timeout: 1000 });

  // Flush only the deferred renderer task, leaving wall-clock timers alone.
  // Ordinary phase tests use the ready scene as their time-zero baseline.
  function setupRenderer() {
    for (const [id, timer] of [...timers]) {
      if (timer.callback.name !== 'initializeRenderer') continue;
      timers.delete(id);
      timer.callback();
    }
  }
  if (!loading) setupRenderer();

  function at(time) {
    assert.ok(time >= now, 'the synthetic performance clock must stay monotonic');
    now = time;
  }
  return {
    renders, layers, renderers, samples,
    get renderer() { return renderer; },
    get pendingFrames() { return frames.size; },
    get pendingTimers() { return timers.size; },
    get pendingDrawTasks() { return [...timers.values()].filter(timer => timer.callback.name === 'retryDraw').length; },
    get last() { return renders.at(-1); },
    set renderCost(value) { renderCost = value; },
    frame(time) {
      at(time);
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    move(time, clientX = 620, clientY = 30) {
      at(time);
      hero.emit('pointermove', { clientX, clientY, pointerType: 'mouse' });
    },
    resize(time) { at(time); resize(); },
    hidden(time, hidden) { at(time); document.hidden = hidden; document.emit('visibilitychange'); },
    visible(time, visible) { at(time); intersection([{ isIntersecting: visible }]); },
    motion(time, reduced) {
      at(time);
      media['(prefers-reduced-motion: reduce)'].matches = reduced;
      media['(prefers-reduced-motion: reduce)'].emit('change');
    },
    page(time, event, detail = {}) { at(time); window.emit(event, detail); setupRenderer(); },
    finishIntro(time) { at(time); hero.emit('animationend', { animationName: 'hero-scroll-enter' }); setupRenderer(); },
    theme(time, style) { at(time); nextStyle = style; window.emit('popstate'); },
    lose(time) { at(time); canvas.emit('webglcontextlost'); },
    restore(time, target = renderer) { at(time); target.ready = true; target.lost = false; target.onRestore(); },
    queuedTimers() { return [...timers.values()].map(timer => timer.callback); },
    queuedDrawTasks() { return [...timers.values()].filter(timer => timer.callback.name === 'retryDraw').map(timer => timer.callback); },
    retry(time) {
      at(time);
      for (const [id, timer] of [...timers]) {
        if (timer.callback.name !== 'retryDraw') continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function phase(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected orbital time ${expected}, got ${actual}`);
}

await test('fast, slow and uneven rAF schedules reach the same orbital phase', () => {
  const schedules = [
    Array.from({ length: 50 }, (_, index) => (index + 1) * 20),
    [250, 500, 750, 1000],
    [10, 60, 110, 730, 1000],
  ];
  for (const schedule of schedules) {
    const site = browser();
    assert.equal(site.renderer.style, 'minimal');
    phase(site.last.time, 12);
    for (const time of schedule) site.frame(time);
    phase(site.last.time, 13);
  }
});

await test('a pointer storm changes the camera but not the orbital speed on slow frames', () => {
  const idle = browser();
  const moving = browser();
  for (let time = 10; time <= 2000; time += 10) {
    moving.move(time, time % 400 < 200 ? 40 : 620, 50);
    if (time % 200 === 0) {
      idle.frame(time);
      moving.frame(time);
      phase(moving.last.time, idle.last.time);
    }
  }
  phase(moving.last.time, 14);
  assert.notEqual(moving.last.x, idle.last.x);
  assert.notEqual(moving.layers[0].style.values['--pointer-x'], '0px');
});

await test('expensive draws and extra resize draws do not discard or add orbital time', () => {
  const site = browser();
  site.renderCost = 180;
  site.frame(200);
  phase(site.last.time, 12.2);
  site.move(400);
  site.resize(450);
  phase(site.last.time, 12.45);
  site.frame(800);
  phase(site.last.time, 12.8);
  site.renderCost = 0;
  site.page(1000, 'pageshow');
  site.frame(1200);
  phase(site.last.time, 13.2);
});

await test('overlapping hidden and offscreen pauses freeze at the event, without a catch-up jump', () => {
  const site = browser();
  site.frame(500);
  site.hidden(850, true);
  site.visible(900, false);
  assert.equal(site.pendingFrames, 0);
  site.hidden(10000, false);
  assert.equal(site.pendingFrames, 0);
  site.resize(11000);
  phase(site.last.time, 12.85);
  site.visible(12000, true);
  site.frame(12500);
  phase(site.last.time, 13.35);
});

await test('repeated page lifecycle events neither accumulate a pause nor reset active time', () => {
  const site = browser();
  site.frame(500);
  site.page(750, 'pagehide');
  site.page(1000, 'pagehide');
  const renderCount = site.renders.length;
  site.resize(5000);
  assert.equal(site.renders.length, renderCount, 'a closed page must not draw on resize');
  site.page(6000, 'pageshow');
  site.page(6250, 'pageshow');
  site.frame(6500);
  phase(site.last.time, 13.25);
});

await test('reduced motion freezes the scene and resuming adds no synthetic first-frame delta', () => {
  const site = browser({ reduced: true });
  site.resize(1000);
  phase(site.last.time, 12);
  site.motion(10000, false);
  site.frame(10500);
  phase(site.last.time, 12.5);
  site.motion(10750, true);
  phase(site.last.time, 12.75);
  assert.equal(site.pendingFrames, 0);
  site.resize(20000);
  phase(site.last.time, 12.75);
  site.motion(30000, false);
  site.frame(30500);
  phase(site.last.time, 13.25);
});

await test('loading and entrance time are excluded from the scene clock', () => {
  const site = browser({ loading: true });
  site.move(1000);
  assert.equal(site.pendingFrames, 0);
  site.page(5000, 'site:revealed');
  assert.equal(site.renderer, undefined);
  site.finishIntro(5500);
  site.frame(6000);
  phase(site.last.time, 12.5);
});

await test('cold renderer initialization waits until the logo and page entrance finish', () => {
  const site = browser({ loading: true });
  assert.equal(site.pendingFrames, 0);
  site.page(5000, 'site:revealing');
  site.frame(5250);
  assert.equal(site.renderer, undefined);
  assert.equal(site.renders.length, 0);
  site.page(5420, 'site:revealed');
  assert.equal(site.renderer, undefined);
  site.finishIntro(6000);
  phase(site.last.time, 12);
  const firstRenderer = site.renderer;
  site.page(6500, 'site:revealed');
  site.frame(7000);
  assert.equal(site.renderer, firstRenderer);
  phase(site.last.time, 13);
});

await test('context loss pauses immediately, and restoration while hidden stays frozen', () => {
  const site = browser();
  site.frame(500);
  site.lose(750);
  assert.equal(site.pendingFrames, 0);
  site.hidden(1000, true);
  const renderCount = site.renders.length;
  site.restore(10000);
  assert.equal(site.renders.length, renderCount, 'a hidden page must not draw on context restoration');
  assert.equal(site.pendingFrames, 0);
  site.hidden(15000, false);
  site.frame(15500);
  phase(site.last.time, 13.25);
});

await test('pointer-only fallback and asynchronous theme loading do not advance the disk', () => {
  const site = browser({ deferInk: true });
  site.frame(500);
  site.theme(750, 'ink');
  site.move(1000);
  site.frame(1500);
  site.hidden(2000, true);
  const renderCount = site.renders.length;
  site.restore(5000);
  assert.equal(site.renders.length, renderCount, 'a hidden page must not draw when a theme finishes loading');
  assert.equal(site.pendingFrames, 0);
  site.hidden(6000, false);
  site.frame(6500);
  phase(site.last.time, 13.25);
});

await test('pagehide disposes the renderer and rejects late initialization, input and timer callbacks', () => {
  const site = browser({ deferReady: true });
  const oldRenderer = site.renderer;
  const queuedTimers = site.queuedTimers();
  site.page(500, 'pagehide', { persisted: false });
  assert.equal(oldRenderer.disposed, true);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.pendingTimers, 0);
  site.restore(1000, oldRenderer);
  site.move(1500);
  site.resize(2000);
  site.visible(2500, true);
  site.hidden(3000, false);
  site.motion(3500, false);
  site.page(4000, 'site:revealed');
  for (const callback of queuedTimers) callback();
  assert.equal(site.renders.length, 0);
  assert.equal(oldRenderer.resizes, 0);
  assert.equal(site.renderers.length, 1, 'only pageshow may reopen a disposed scene');
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.pendingTimers, 0);

  site.page(5000, 'pageshow');
  const currentRenderer = site.renderer;
  assert.notEqual(currentRenderer, oldRenderer);
  assert.equal(site.renderers.length, 2);
  site.restore(5500, oldRenderer);
  assert.equal(site.pendingFrames, 0, 'an obsolete renderer cannot restart its replacement');
  site.restore(6000, currentRenderer);
  site.frame(6500);
  phase(site.last.time, 12.5);
});

await test('BFCache preserves the renderer, freezes late callbacks and resumes without a time jump', () => {
  const site = browser();
  site.frame(500);
  const renderer = site.renderer;
  site.page(750, 'pagehide', { persisted: true });
  assert.equal(renderer.disposed, false);
  const renderCount = site.renders.length;
  const resizeCount = renderer.resizes;
  site.restore(1000);
  site.resize(2000);
  site.move(3000);
  assert.equal(site.renders.length, renderCount);
  assert.equal(renderer.resizes, resizeCount);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.pendingTimers, 0);
  site.page(10000, 'pageshow', { persisted: true });
  assert.equal(site.renderer, renderer);
  assert.equal(site.renderers.length, 1);
  phase(site.last.time, 12.75);
  site.frame(10500);
  phase(site.last.time, 13.25);
});

await test('busy GPU frames do not enter adaptive-resolution timing samples', () => {
  const site = browser();
  site.renderer.busy = true;
  site.frame(100);
  site.frame(200);
  assert.equal(site.samples.length, 0);
  assert.equal(site.renders.length, 1);
  site.renderer.busy = false;
  site.frame(300);
  assert.deepEqual(site.samples, [300]);
  phase(site.last.time, 12.3);
});

await test('a busy reduced-motion resize retries one draw without starting the scene clock', () => {
  const site = browser({ reduced: true });
  site.renderer.busy = true;
  site.resize(100);
  site.resize(105);
  assert.equal(site.pendingDrawTasks, 1, 'resize notifications coalesce into one retry');
  site.retry(137);
  assert.equal(site.pendingDrawTasks, 1, 'a still-busy GPU keeps only one retry');
  assert.equal(site.renders.length, 1);
  assert.equal(site.pendingFrames, 0);
  site.renderer.busy = false;
  site.retry(169);
  assert.equal(site.pendingDrawTasks, 0);
  assert.equal(site.renders.length, 2);
  assert.equal(site.pendingFrames, 0);
  phase(site.last.time, 12);
});

await test('offscreen, hidden and pagehide stops cancel busy-GPU draw retries', () => {
  const stops = [
    site => site.visible(110, false),
    site => site.hidden(110, true),
    site => site.page(110, 'pagehide', { persisted: false }),
    site => site.page(110, 'pagehide', { persisted: true }),
  ];
  for (const stop of stops) {
    const site = browser({ reduced: true });
    site.renderer.busy = true;
    site.resize(100);
    assert.equal(site.pendingDrawTasks, 1);
    const queued = site.queuedDrawTasks();
    stop(site);
    assert.equal(site.pendingDrawTasks, 0);
    site.renderer.busy = false;
    for (const callback of queued) callback();
    assert.equal(site.renders.length, 1, 'an already queued retry must remain stopped');
    assert.equal(site.pendingDrawTasks, 0);
    assert.equal(site.pendingFrames, 0);
  }
});
