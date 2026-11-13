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
function browser({ reduced = false, loading = false, deferInk = false, deferReady = false, unavailable = false,
  clockBox = null } = {}) {
  let now = 0;
  let sequence = 0;
  let renderCost = 0;
  let renderer;
  let intersection;
  let resize;
  let nextStyle = 'minimal';
  let preparation;
  const frames = new Map();
  const timers = new Map();
  const attempts = [];
  const renders = [];
  const renderers = [];
  const samples = [];
  const polls = [];
  const work = { canvasClears: 0, canvasResizes: 0, starDraws: 0, starStreaks: 0, layerWrites: 0 };
  const media = {
    '(prefers-reduced-motion: reduce)': eventTarget({ matches: reduced }),
    '(pointer: fine)': eventTarget({ matches: true }),
  };
  const hero = eventTarget({
    dataset: {}, classList: classes(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  });
  const canvas = eventTarget({ parentElement: { classList: classes() } });
  const starColors = [];
  // The sky as last painted: each point's place, size and color.
  let sky = [];
  const context = {
    setTransform() {}, clearRect() { work.canvasClears++; sky = []; }, beginPath() {},
    arc(x, y, radius) { sky.push({ x, y, radius, color: starColors.at(-1) }); },
    fill() { work.starDraws++; },
    moveTo() {}, lineTo() {}, stroke() { work.starStreaks++; },
    set fillStyle(value) { starColors.push(value); },
  };
  let starWidth = 0, starHeight = 0;
  const stars = {
    getContext: () => context,
    get width() { return starWidth; },
    set width(value) { starWidth = value; work.canvasResizes++; },
    get height() { return starHeight; },
    set height(value) { starHeight = value; work.canvasResizes++; },
  };
  const clockParts = [{ textContent: '' }, { textContent: '' }];
  const clock = {
    querySelector: name => clockParts[name === '[data-clock-date]' ? 0 : 1],
    setAttribute() {},
    // Laid out inside the hero, which is the stage on this page.
    ...(clockBox && { offsetLeft: clockBox.left, offsetTop: clockBox.top, offsetWidth: clockBox.width,
      offsetHeight: clockBox.height, offsetParent: hero }),
  };
  const layers = ['1', '2'].map(depth => ({
    dataset: { depth }, style: { values: {}, setProperty(name, value) { work.layerWrites++; this.values[name] = value; } },
  }));
  const sphere = { hidden: false };
  const nodes = { '.hero': hero, '#starfield': stars, '#black-hole-canvas': canvas, '#local-time': clock, '.black-hole-switch': sphere };
  const document = eventTarget({
    hidden: false,
    documentElement: { dataset: {}, classList: classes(loading ? ['is-loading', 'has-site-intro'] : []) },
    querySelector: name => nodes[name], querySelectorAll: () => layers,
  });
  const window = eventTarget({
    SiteLoader: { ready({ scene }) { preparation = scene; } },
    BlackHoleTheme: { apply: style => style || nextStyle, resolve: () => nextStyle },
    BlackHole: class {
      constructor(_canvas, options) {
        renderer = this;
        renderers.push(this);
        this.style = options.style;
        this.ready = !deferReady && !unavailable;
        this.lost = false;
        this.disposed = false;
        this.busy = false;
        this.frameInterval = 1000 / 30;
        this.quality = 1;
        this.initialization = unavailable ? Promise.resolve(false) : new Promise(() => {});
        this.timingResets = 0;
        this.resizes = 0;
        canvas.addEventListener('webglcontextlost', () => { this.ready = false; this.lost = true; });
      }
      resize() { this.resizes++; }
      resetTiming() { this.timingResets++; }
      pollGpu() { polls.push(now); return !this.busy; }
      getFrameInterval(cameraMoving) { return cameraMoving ? this.cameraInterval ?? this.frameInterval : this.frameInterval; }
      sampleFrame(timestamp) { samples.push(timestamp); }
      dispose(options) { this.disposeOptions = options; this.disposed = true; this.ready = false; }
      setStyle(style) { this.style = style; this.ready = !(deferInk && style === 'ink'); }
      setIntro(amount) { this.intro = amount; }
      introView(amount) { return { x: -674, y: -326, zoom: 1.8 ** amount }; }
      render(time, x, y, chapter = 0, entranceGlow = 0) {
        attempts.push({ time, x, y, chapter, entranceGlow, at: now });
        if (!this.ready || this.lost || this.disposed || this.busy) return false;
        renders.push({ time, x, y, chapter, entranceGlow, intro: this.intro ?? 0, at: now });
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
    attempts, renders, layers, renderers, samples, polls, work, starColors, sphere, root: document.documentElement,
    hero,
    get scene() { return window.SiteBlackHole; },
    // Keyed by size and color, which no two points share, so one star can be
    // followed from one painting to the next.
    get sky() { return new Map(sky.map(star => [`${star.radius} ${star.color}`, star])); },
    get preparation() { return preparation; },
    get renderer() { return renderer; },
    get pendingFrames() { return frames.size; },
    get pendingTimers() { return timers.size; },
    get pendingDrawTasks() { return [...timers.values()].filter(timer => timer.callback.name === 'retryDraw').length; },
    get pendingPreparationTasks() { return [...timers.values()].filter(timer => timer.callback.name === 'checkFirstFrame').length; },
    get rendererDelay() { return [...timers.values()].find(timer => timer.callback.name === 'initializeRenderer')?.delay; },
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
    warmup(time) { at(time); setupRenderer(); },
    checkPreparation(time) {
      at(time);
      for (const [id, timer] of [...timers]) {
        if (timer.callback.name !== 'checkFirstFrame') continue;
        timers.delete(id);
        timer.callback();
      }
    },
    interaction(time, active, kind = 'content') { at(time); window.emit('site:interaction', { detail: { active, kind } }); },
    finishIntro(time) { at(time); hero.emit('animationend', { animationName: 'title-period-enter' }); setupRenderer(); },
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

await test('the default cadence renders every second 60 Hz frame despite timestamp rounding', () => {
  const site = browser();
  for (let index = 1; index <= 60; index++) site.frame(index * 16.666);
  assert.equal(site.renders.length, 31, 'initial draw plus 30 animated frames');
  phase(site.last.time, 12.99996);
});

await test('settled live animation does not repaint the sky or rewrite parallax layers', () => {
  const site = browser();
  // A 640 by 480 stage holds 123 stars; a few lie in the margin beyond it.
  assert.ok(site.sky.size > 100 && site.sky.size <= 123, 'the live scene shows the hero\'s sky');
  const before = { ...site.work };
  const rest = site.sky;
  for (let index = 1; index <= 60; index++) site.frame(index * 16.666);
  assert.equal(site.renders.length, 31, 'the black hole keeps its animation cadence');
  assert.deepEqual(site.work, before, 'unchanged 2D and DOM layers do no per-frame work');
  site.resize(1100);
  assert.deepEqual(site.work, before, 'a heading-only resize must not reset the full-screen 2D buffer');
  site.move(1200);
  for (let index = 1; index <= 90; index++) site.frame(1200 + index * 16.666);
  assert.ok(site.work.layerWrites > before.layerWrites, 'pointer parallax still updates when the camera moves');
  assert.ok(site.work.canvasClears > before.canvasClears, 'the sky follows the pointer');
  assert.equal(site.work.starStreaks, 0, 'only the entrance camera draws traces');
  // The pointer rests at (0.9375, -0.875): the scene pans with it by a few
  // pixels, far stars with the scene and near stars the other way.
  const shifts = [...site.sky].filter(([key]) => rest.has(key)).map(([key, star]) => [star.x - rest.get(key).x, star.y - rest.get(key).y]);
  assert.ok(shifts.length > 100);
  assert.ok(shifts.every(([x, y]) => x > -5.9 && x < 5.5 && y > -3.7 && y < 4.1));
  assert.ok(shifts.some(([x, y]) => x > 4 && y < -2.5) && shifts.some(([x, y]) => x < -2 && y > 1.5));
});

await test('one sky serves the live scene, its fallback and ink, repainted only when it changes', () => {
  const site = browser();
  const live = { ...site.work };
  const rest = site.sky;
  site.lose(100);
  assert.deepEqual(site.work, live, 'context loss keeps the sky already painted');
  site.resize(200);
  site.restore(300);
  assert.deepEqual(site.work, live, 'and so does recovery');
  assert.match(site.starColors.at(-1), /^rgba\(193,204,223,/);
  site.theme(400, 'ink');
  assert.ok(site.work.starDraws > live.starDraws, 'ink repaints the same stars in its own tone');
  assert.match(site.starColors.at(-1), /^rgba\(225,218,200,/);
  assert.equal(site.sky.size, rest.size);
  const ink = { ...site.work };
  site.frame(450);
  assert.deepEqual(site.work, ink, 'stationary ink stars are not repainted every scene frame');
});

await test('a day/night switch repaints the sky as its negative, then stops', () => {
  const site = browser();
  assert.match(site.starColors.at(-1), /^rgba\(193,204,223,/);
  const night = site.work.starDraws;
  const places = [...site.sky.values()].map(star => [star.x, star.y, star.radius]);
  site.root.dataset.theme = 'light';
  site.page(200, 'site:theme', { detail: { theme: 'light' } });
  // A running scene repaints its sky on the next display frame.
  site.frame(216);
  assert.ok(site.work.starDraws > night, 'the night stars repaint');
  assert.match(site.starColors.at(-1), /^rgba\(62,51,32,/, 'each day star is its night color inverted');
  assert.deepEqual([...site.sky.values()].map(star => [star.x, star.y, star.radius]), places, 'every star keeps its place and size');
  const day = { ...site.work };
  site.resize(300);
  assert.deepEqual(site.work, day, 'unchanged day stars keep their pixels');
});

await test('the sky dims around the clock, and nowhere else', () => {
  const plain = browser();
  const site = browser({ clockBox: { left: 60, top: 200, width: 240, height: 40 } });
  const light = star => Number(star.color.match(/,([\d.e-]+)\)$/)[1]);
  const open = [...plain.sky.values()], dimmed = [...site.sky.values()];
  assert.equal(dimmed.length, open.length, 'no star is removed');
  let inside = 0, outside = 0;
  for (const [index, star] of dimmed.entries()) {
    const same = open[index];
    assert.deepEqual([star.x, star.y, star.radius], [same.x, same.y, same.radius]);
    // The line itself plus the room its own parallax needs: 8px and 6px.
    const within = star.x >= 52 && star.x <= 308 && star.y >= 194 && star.y <= 246;
    const far = star.x < 36 || star.x > 324 || star.y < 178 || star.y > 262;
    if (within) { inside++; assert.ok(Math.abs(light(star) - 0.15 * light(same)) < 1e-9, 'a star among the digits keeps 15% of its light'); }
    else if (far) { outside++; assert.equal(star.color, same.color); }
    else assert.ok(light(star) <= light(same) && light(star) >= 0.15 * light(same) - 1e-9, 'the edge fades over 16px');
  }
  assert.ok(inside >= 2 && outside > 90, `${inside} stars lie inside the clock's line`);
});

await test('quality-driven cadence changes reduce draws without changing orbital phase', () => {
  const site = browser();
  for (let index = 1; index <= 72; index++) {
    if (index === 25) site.renderer.frameInterval = 1000 / 15;
    if (index === 49) site.renderer.frameInterval = 1000 / 20;
    site.frame(index * 1000 / 60);
  }
  assert.equal(site.renders.length, 27, '12 frames at 30 fps, 6 at 15 fps, 8 at 20 fps, plus initial draw');
  for (const render of site.renders) phase(render.time, 12 + render.at / 1000);
  phase(site.last.time, 13.2);
  assert.equal(site.pendingFrames, 1, 'the animation loop remains active at every cadence');
});

await test('a busy GPU defers a due frame until the first free display tick without wasting a cadence slot', () => {
  const site = browser();
  site.renderer.frameInterval = 1000 / 15;
  site.renderer.busy = true;
  const attempts = site.attempts.length;
  site.frame(1000 / 15);
  assert.equal(site.attempts.length, attempts, 'busy polling never submits another frame');
  assert.equal(site.pendingDrawTasks, 0);
  site.renderer.busy = false;
  site.retry(100);
  assert.equal(site.attempts.length, attempts, 'no timer bypass');
  site.frame(100);
  assert.equal(site.attempts.length, attempts + 1, 'the overdue frame uses the latest available display tick');
  phase(site.last.time, 12.1);
  site.frame(116);
  assert.equal(site.attempts.length, attempts + 1, 'one late frame does not start a catch-up burst');
  site.frame(2000 / 15);
  assert.equal(site.attempts.length, attempts + 2);
  phase(site.last.time, 12 + 2 / 15);
});

await test('fractional display rates preserve the requested idle cadence instead of slowing it down', () => {
  for (const hz of [60, 75, 120, 144]) {
    const site = browser();
    for (let index = 1; index <= hz * 2; index++) site.frame(index * 1000 / hz);
    assert.equal(site.renders.length, 61, `expected 30 fps on a ${hz} Hz display`);
    phase(site.last.time, 14);
  }
});

await test('camera motion uses the interactive cadence, responds promptly and returns to idle without changing orbital speed', () => {
  for (const hz of [60, 75, 120, 144]) {
    const site = browser();
    site.renderer.cameraInterval = 1000 / 60;
    site.move(0, 576, 120); // target x = 0.8
    for (let index = 1; index <= hz * 2; index++) site.frame(index * 1000 / hz);
    const response = site.renders.find(render => render.x >= 0.72);
    assert(response && response.at <= 280, `slow pointer response at ${hz} Hz`);
    const early = site.renders.filter(render => render.at > 0 && render.at <= 500);
    assert(early.length >= 29 && early.length <= 30, `expected 60 fps within one display tick at ${hz} Hz`);
    const idle = site.renders.filter(render => render.at > 1000);
    assert.equal(idle.length, 30, 'settled camera returns to the 30 fps budget');
    for (const render of site.renders) phase(render.time, 12 + render.at / 1000);
    assert.equal(site.pendingFrames, 1, 'input must not create another animation loop');
  }
});

await test('parallax layers keep easing during busy GPU frames and a recovered frame uses the current camera', () => {
  const site = browser();
  site.renderer.cameraInterval = 1000 / 60;
  site.renderer.busy = true;
  const attempts = site.attempts.length;
  site.move(0, 576, 120);
  site.frame(1000 / 60);
  const first = Number.parseFloat(site.layers[0].style.values['--pointer-x']);
  site.frame(2000 / 60);
  assert(Number.parseFloat(site.layers[0].style.values['--pointer-x']) < first);
  assert.equal(site.attempts.length, attempts, 'busy GPU work stays bounded');
  assert.equal(site.pendingDrawTasks, 0);
  site.renderer.busy = false;
  site.frame(50);
  assert.equal(site.attempts.length, attempts + 1);
  assert(site.last.x > 0.25, 'the recovered render should use current eased input');
  phase(site.last.time, 12.05);
});

await test('GPU completion is polled at display cadence while slow draws and pauses remain bounded', () => {
  const site = browser();
  site.renderer.frameInterval = 1000 / 15;
  for (let index = 1; index <= 60; index++) site.frame(index * 1000 / 60);
  assert.equal(site.polls.length, 60);
  assert.equal(site.renders.length, 16, 'polling does not submit extra frames');
  const resets = site.renderer.timingResets;
  site.visible(1100, false);
  assert.equal(site.renderer.timingResets, resets + 1, 'pausing invalidates stale GPU timing observations');
  site.frame(2000);
  assert.equal(site.polls.length, 60, 'an offscreen scene does not poll the GPU');
  assert.equal(site.renders.length, 16);
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

await test('GPU preparation stays behind the loader and the scene responds as soon as revealing starts', async () => {
  const site = browser({ loading: true });
  site.move(1000);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.rendererDelay, 1100, 'logo strokes finish before cold GPU setup begins');
  site.warmup(1100);
  phase(site.last.time, 12);
  assert.equal(site.pendingFrames, 0, 'preparation submits only the first still frame');
  site.checkPreparation(1200);
  assert.equal(await site.preparation, true);
  site.page(1250, 'site:revealing');
  site.move(1300);
  site.frame(1750);
  phase(site.last.time, 12.5);
  assert.ok(site.last.x > 0, 'camera input works before the title entrance finishes');
});

await test('loading waits for first GPU completion, and repeated reveal events do not recreate the renderer', async () => {
  const site = browser({ loading: true });
  site.warmup(1100);
  site.renderer.busy = true;
  let prepared = false;
  site.preparation.then(() => { prepared = true; });
  site.checkPreparation(1200);
  await Promise.resolve();
  assert.equal(prepared, false, 'submission alone does not release the loader');
  assert.equal(site.pendingPreparationTasks, 1);
  assert.equal(site.renders.length, 1, 'waiting never queues extra scene frames');
  site.renderer.busy = false;
  site.checkPreparation(1250);
  assert.equal(await site.preparation, true);
  assert.equal(site.pendingPreparationTasks, 0);
  const firstRenderer = site.renderer;
  site.page(1300, 'site:revealing');
  site.page(1720, 'site:revealed');
  site.finishIntro(2200);
  site.frame(2300);
  assert.equal(site.renderer, firstRenderer);
  phase(site.last.time, 13);
});

await test('failed, timed-out and closed startup waits resolve to fallback without late GPU work', async () => {
  const failed = browser({ loading: true, unavailable: true });
  failed.warmup(1100);
  assert.equal(await failed.preparation, false);
  assert.equal(failed.renders.length, 0);
  const delayed = browser({ loading: true, deferReady: true });
  delayed.warmup(1100);
  delayed.page(3450, 'site:revealing');
  assert.equal(await delayed.preparation, false);
  delayed.restore(5000);
  delayed.frame(5100);
  assert.ok(delayed.renders.length > 0, 'late readiness can upgrade the fallback');
  const closed = browser({ loading: true });
  closed.warmup(1100);
  const callbacks = closed.queuedTimers();
  closed.page(1150, 'pagehide', { persisted: false });
  assert.equal(await closed.preparation, false);
  const polls = closed.polls.length;
  callbacks.forEach(callback => callback());
  assert.equal(closed.polls.length, polls);
  assert.equal(closed.pendingTimers, 0);
});

await test('constrained GPUs yield the content drag to the UI and resume without an orbital jump', () => {
  const site = browser();
  site.page(0, 'site:chapter', { detail: { progress: 1 } });
  site.frame(500);
  site.renderer.quality = 0.85;
  site.interaction(600, true);
  const renders = site.renders.length;
  assert.equal(site.pendingFrames, 0, 'holding the background also stops its CPU animation loop');
  site.frame(1600);
  site.resize(1700);
  assert.equal(site.renders.length, renders);
  site.interaction(2000, false);
  site.frame(2100);
  phase(site.last.time, 12.7);
  site.interaction(2200, true, 'hero');
  site.frame(2300);
  phase(site.last.time, 12.9);
  assert.equal(site.pendingFrames, 1, 'hero camera transitions continue to animate');
});

await test('healthy GPUs keep animating during scrolling, while sustained busy frames yield until input ends', () => {
  const site = browser();
  site.page(0, 'site:chapter', { detail: { progress: 1 } });
  site.interaction(100, true);
  site.frame(150);
  assert.equal(site.pendingFrames, 1);
  site.renderer.busy = true;
  site.frame(200);
  site.frame(250);
  site.frame(300);
  assert.equal(site.pendingFrames, 0, 'a long pending frame is enough to protect UI before adaptation catches up');
  site.renderer.busy = false;
  site.interaction(500, false);
  site.frame(550);
  phase(site.last.time, 12.35);
});

await test('the hero camera never freezes during a gesture before reaching the content boundary', () => {
  const site = browser();
  site.renderer.quality = 0.85;
  site.interaction(100, true);
  site.page(200, 'site:chapter', { detail: { progress: 0.5 } });
  site.frame(300);
  assert.equal(site.last.chapter, 0.5);
  assert.equal(site.pendingFrames, 1);
  // A rapid reversal switches the motion kind before the chapter position.
  site.page(400, 'site:chapter', { detail: { progress: 1 } });
  site.frame(450);
  assert.equal(site.pendingFrames, 0);
  site.interaction(500, true, 'hero');
  site.page(550, 'site:chapter', { detail: { progress: 0.8 } });
  site.frame(600);
  assert.equal(site.last.chapter, 0.8);
  assert.equal(site.pendingFrames, 1);
});

await test('context loss during first-frame preparation releases the fallback without waiting for timeout', async () => {
  const site = browser({ loading: true });
  site.warmup(1100);
  site.renderer.busy = true;
  site.checkPreparation(1150);
  assert.equal(site.pendingPreparationTasks, 1);
  site.lose(1200);
  assert.equal(await site.preparation, false);
  assert.equal(site.pendingPreparationTasks, 0);
  site.page(1250, 'site:revealing');
  site.renderer.busy = false;
  site.restore(1300);
  site.frame(1400);
  assert.equal(site.pendingFrames, 1);
  assert.ok(site.renders.length > 1, 'the recovered context can still upgrade the fallback');
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

await test('pagehide avoids GPU teardown and rejects late initialization, input and timer callbacks', () => {
  const site = browser({ deferReady: true });
  const oldRenderer = site.renderer;
  const queuedTimers = site.queuedTimers();
  site.page(500, 'pagehide', { persisted: false });
  assert.equal(oldRenderer.disposed, true);
  assert.equal(oldRenderer.disposeOptions?.releaseGpu, false, 'closing the document must leave GPU retirement to the browser');
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
  assert.equal(renderer.disposeOptions, undefined, 'BFCache keeps the existing GPU resources for restoration');
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

await test('resuming animation cancels static retries, including an already queued callback', () => {
  const site = browser({ reduced: true });
  site.renderer.frameInterval = 1000 / 15;
  site.renderer.busy = true;
  site.resize(100);
  const queued = site.queuedDrawTasks();
  assert.equal(queued.length, 1);
  site.motion(120, false);
  assert.equal(site.pendingDrawTasks, 0);
  const attempts = site.attempts.length;
  site.renderer.busy = false;
  for (const callback of queued) callback();
  assert.equal(site.attempts.length, attempts, 'an obsolete static retry cannot enter the animation schedule');
  site.frame(200);
  phase(site.last.time, 12.08);
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

await test('chapter entrance light follows its event and clears without altering orbital time or camera', () => {
  const site = browser();
  const control = browser();
  for (const [time, progress, glow] of [[100, 0.4, 0.75], [200, 1, 0], [300, 0.6, 1], [400, 0.6, undefined]]) {
    site.page(time, 'site:chapter', { detail: { progress, entranceGlow: glow } });
    control.page(time, 'site:chapter', { detail: { progress } });
    site.frame(time + 20);
    control.frame(time + 20);
    assert.equal(site.last.entranceGlow, glow ?? 0);
    assert.equal(site.last.chapter, progress);
    assert.deepEqual([site.last.time, site.last.x, site.last.y],
      [control.last.time, control.last.x, control.last.y],
      'the light accent must not change orbital phase or pointer camera motion');
  }
});

await test('a busy entrance frame cannot replay its pulse after the cleanup event', () => {
  const site = browser();
  site.renderer.busy = true;
  site.page(100, 'site:chapter', { detail: { progress: 0.4, entranceGlow: 1 } });
  site.frame(120);
  assert.equal(site.attempts.length, 1, 'busy frames wait without submitting a stale entrance pulse');
  assert.equal(site.renders.length, 1);
  site.page(200, 'site:chapter', { detail: { progress: 1, entranceGlow: 0 } });
  site.frame(220);
  assert.equal(site.attempts.length, 1);
  assert.equal(site.pendingDrawTasks, 0, 'the pulse must not bypass the animation frame budget');
  site.renderer.busy = false;
  site.frame(260);
  assert.equal(site.last.entranceGlow, 0);
  assert.equal(site.last.chapter, 1);
  phase(site.last.time, 12.26);
});

await test('reduced motion applies chapter destinations without animating the entrance light or clock', () => {
  const site = browser({ reduced: true });
  site.page(100, 'site:chapter', { detail: { progress: 0.5, entranceGlow: 1 } });
  assert.equal(site.last.chapter, 0.5);
  assert.equal(site.last.entranceGlow, 0);
  assert.equal(site.pendingFrames, 0);
  phase(site.last.time, 12);
  site.page(1000, 'site:chapter', { detail: { progress: 1, entranceGlow: 0 } });
  assert.equal(site.last.chapter, 1);
  assert.equal(site.last.entranceGlow, 0);
  phase(site.last.time, 12);
});

await test('hidden, offscreen and cached pages discard entrance pulses until the scene is visible again', () => {
  const lifecycles = [
    [site => site.hidden(150, true), site => site.hidden(200, false)],
    [site => site.visible(150, false), site => site.visible(200, true)],
    [site => site.page(150, 'pagehide', { persisted: true }), site => site.page(200, 'pageshow', { persisted: true })],
  ];
  for (const [suspend, resume] of lifecycles) {
    const site = browser();
    site.page(100, 'site:chapter', { detail: { progress: 0.4, entranceGlow: 1 } });
    site.frame(120);
    assert.equal(site.last.entranceGlow, 1);
    suspend(site);
    const attempts = site.attempts.length;
    site.page(160, 'site:chapter', { detail: { progress: 0.8, entranceGlow: 0.7 } });
    assert.equal(site.attempts.length, attempts, 'late entrance events must not render an inactive scene');
    assert.equal(site.pendingFrames, 0);
    resume(site);
    site.frame(240);
    assert.equal(site.last.chapter, 0.8);
    assert.equal(site.last.entranceGlow, 0, 'resuming must not flash a stale entrance accent');
  }
});

await test('the black sphere switches day and night on the hero only', () => {
  const site = browser();
  assert.equal(site.sphere.hidden, false, 'the hero offers its black sphere as the switch');
  site.page(0, 'site:chapter', { detail: { progress: 0.2 } });
  assert.equal(site.sphere.hidden, true, 'the chapters move the hole away and use the header toggle');
  site.page(10, 'site:chapter', { detail: { progress: 1 } });
  assert.equal(site.sphere.hidden, true);
  site.page(20, 'site:chapter', { detail: { progress: 0 } });
  assert.equal(site.sphere.hidden, false, 'back on the hero the sphere switches again');
});

await test('the entrance camera frames its opening sky from the first frame and moves at the interactive cadence', async () => {
  const site = browser({ loading: true });
  const rest = site.sky;
  site.scene.intro(1);
  assert.equal(site.renders.length, 0, 'no renderer exists before the logo has drawn');
  assert.equal(site.rendererDelay, 1100, 'asking for the opening sky does not hurry GPU setup');
  assert.deepEqual([...site.sky], [...rest], 'without the camera the sky stays as it is');
  site.warmup(1100);
  assert.equal(site.last.intro, 1, 'the first frame behind the loader is the opening sky');
  assert.ok([...site.sky].some(([key, star]) => rest.has(key) && star.x > rest.get(key).x + 20),
    'and the stars behind the loader are already magnified with it');
  assert.equal(site.renders.length, 1);
  site.checkPreparation(1200);
  assert.equal(await site.preparation, true);
  assert.equal(site.scene.live(), true);
  assert.deepEqual(site.scene.introView(1), { x: -674, y: -326, zoom: 1.8 });
  site.page(1250, 'site:revealing');
  site.renderer.cameraInterval = 1000 / 60;
  const idleFrom = site.renders.length;
  for (let index = 1; index <= 30; index++) site.frame(1250 + index * 1000 / 60);
  assert.ok(site.renders.length - idleFrom <= 16, 'a resting entrance camera keeps the idle budget');
  site.scene.intro(0.6, true);
  const movingFrom = site.renders.length;
  for (let index = 31; index <= 60; index++) site.frame(1250 + index * 1000 / 60);
  assert.ok(site.renders.length - movingFrom >= 29, 'the pull-back draws every display frame');
  assert.equal(site.last.intro, 0.6);
  site.scene.intro(4, true);
  site.frame(2300);
  assert.equal(site.last.intro, 1, 'the amount is clamped');
  assert.equal(site.pendingFrames, 1, 'the entrance adds no animation loop of its own');
  site.page(2400, 'site:intro-complete');
  assert.equal(site.root.classList.contains('has-site-intro'), false);
  assert.equal(site.hero.classList.contains('intro-complete'), true);
  site.frame(2500);
  assert.equal(site.last.intro, 0, 'however the entrance ends, the camera is home');
  phase(site.last.time, 12 + (2500 - 1250) / 1000);
});

await test('the entrance magnifies the hero\'s own sky and ends with every star where the page keeps it', () => {
  const site = browser();
  const rest = site.sky;
  site.scene.intro(1);
  site.frame(20);
  // Each star moves straight away from the camera's fixed point (-674, -326)
  // by its depth's share of the 1.8 magnification.
  let followed = 0;
  for (const [key, star] of site.sky) {
    const from = rest.get(key);
    if (!from) continue;
    followed++;
    const scale = (star.x + 674) / (from.x + 674);
    assert.ok(Math.abs((star.y + 326) / (from.y + 326) - scale) < 1e-9, 'along the line from that point');
    assert.ok(scale > 1.03 && scale < 1.36, `between the farthest and nearest depths, got ${scale}`);
  }
  assert.ok(followed > 60, 'the opening sky is the same stars');
  assert.equal(site.work.starStreaks, 0, 'a resting camera draws points');
  site.scene.intro(0.6, true);
  site.frame(40);
  assert.ok(site.work.starStreaks > 0, 'the moving camera leaves one frame\'s trace');
  const traces = site.work.starStreaks;
  site.scene.intro(0.2, true);
  site.frame(60);
  site.page(70, 'site:intro-complete');
  site.frame(80);
  assert.deepEqual([...site.sky], [...rest], 'the entrance ends on the sky the page keeps: no star is lost or moved');
  const settled = { ...site.work };
  assert.ok(settled.starStreaks > traces);
  for (let index = 1; index <= 30; index++) site.frame(80 + index * 16.666);
  assert.deepEqual(site.work, settled, 'and the settled sky is not repainted');
});

await test('every other way the entrance ends also returns its camera, and a still scene redraws at once', () => {
  const hidden = browser();
  hidden.scene.intro(0.7, true);
  hidden.frame(100);
  assert.equal(hidden.last.intro, 0.7);
  hidden.hidden(200, true);
  hidden.hidden(900, false);
  hidden.frame(1000);
  assert.equal(hidden.last.intro, 0, 'a hidden page ends its entrance');
  const finished = browser();
  finished.scene.intro(0.4, true);
  finished.finishIntro(50);
  finished.frame(100);
  assert.equal(finished.last.intro, 0, 'the short entrance ends with the title period');

  const still = browser({ reduced: true });
  const before = still.renders.length;
  still.scene.intro(0.5);
  assert.equal(still.renders.length, before + 1, 'a paused scene cannot keep a stale camera');
  assert.equal(still.last.intro, 0.5);
  still.scene.intro(0.5);
  assert.equal(still.renders.length, before + 1, 'an unchanged amount draws nothing');
  still.scene.intro(0);
  assert.equal(still.last.intro, 0);
  assert.equal(still.pendingFrames, 0, 'reduced motion still starts no animation');
});
