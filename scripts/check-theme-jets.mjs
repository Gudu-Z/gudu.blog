import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/theme-jets.js', import.meta.url), 'utf8');
const degree = Math.PI / 180;
// The hero's scene camera, as js/black-hole.js reports it, on a 1000x800 page.
const heroCamera = (roll = 0) => ({ x: 400, y: 300, roll, inclination: 81 * degree, azimuth: 0, distance: 31.78443, focal: 4.05, scale: 450 });

// Promise-shaped signals that call back synchronously, so a test drives a
// switch step by step without awaiting. The switch only ever chains
// then/catch on a transition's promises.
function signal() {
  const waiting = [];
  let outcome = null;
  const settle = (state, value) => {
    if (outcome) return;
    outcome = { state, value };
    for (const run of waiting.splice(0)) run();
  };
  const promise = {
    then(fulfilled, rejected) {
      const next = signal();
      const run = () => {
        const handler = outcome.state === 'fulfilled' ? fulfilled : rejected;
        if (!handler) return outcome.state === 'fulfilled' ? next.resolve(outcome.value) : next.reject(outcome.value);
        try { next.resolve(handler(outcome.value)); } catch (error) { next.reject(error); }
      };
      if (outcome) run();
      else waiting.push(run);
      return next.promise;
    },
    catch(rejected) { return promise.then(undefined, rejected); },
  };
  return { promise, resolve: value => settle('fulfilled', value), reject: error => settle('rejected', error) };
}

// A page with a synthetic clock, display frames, a 2D canvas that records
// its strokes and fills, and view transitions whose restyle pause ends only
// when a test resolves it.
function loadJets({ theme = 'dark', reduced = false, transitions = true, camera = heroCamera(), drawsWithTheme = true } = {}) {
  let now = 0;
  let switcher = null;
  let drawn = 0;
  const frames = [];
  const sets = [];
  const classes = new Set();
  const animations = [];
  const started = [];
  const listeners = new Set();
  const strokes = [];
  const fills = [];
  const body = { children: [], append(element) { this.children.push(element); } };
  class Path2D {
    constructor() { this.segments = 0; this.arcs = []; }
    moveTo() {}
    lineTo() { this.segments++; }
    closePath() {}
    rect() {}
    arc(x, y, radius) { this.arcs.push({ x, y, radius }); }
  }
  // Gradients keep their axis and the opacity at each stop; fills keep the
  // clips they were drawn under.
  let clips = [];
  const saved = [];
  const context = {
    setTransform() {}, clearRect() { strokes.length = 0; fills.length = 0; },
    stroke(path) { strokes.push({ style: this.strokeStyle, segments: path.segments }); },
    createLinearGradient: (...axis) => ({
      axis, stops: [],
      addColorStop(offset, color) { this.stops.push([offset, Number(/([\d.]+)\)$/.exec(color)[1])]); },
    }),
    save() { saved.push(clips); clips = [...clips]; },
    restore() { clips = saved.pop(); },
    clip(path, rule) { clips.push({ arcs: path.arcs, rule }); },
    fill(path) { fills.push({ style: this.fillStyle, segments: path.segments, clips }); },
  };
  const element = tag => ({
    tag, className: '', attributes: {}, children: [], width: 0, height: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    remove() { body.children = body.children.filter(child => child !== this); },
    getContext: () => (tag === 'canvas' ? context : null),
  });
  const root = {
    dataset: { theme },
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)) },
    animate(keyframes, options) {
      const animation = {
        // Only the first and latest clips are kept, so the test allocates little.
        options, frames: keyframes, paused: false, cancelled: false, first: null, last: null,
        effect: { setKeyframes: next => { animation.frames = next; animation.first ??= next[0].clipPath; animation.last = next[0].clipPath; } },
        pause() { this.paused = true; },
        cancel() { this.cancelled = true; },
      };
      animations.push(animation);
      return animation;
    },
  };
  const document = { documentElement: root, body, createElement: element };
  if (transitions) {
    document.startViewTransition = update => {
      const ready = signal(), finished = signal();
      const transition = {
        ready: ready.promise, finished: finished.promise, skipped: false,
        skipTransition() { this.skipped = true; finished.resolve(); },
        show() { ready.resolve(); },
        abort() { ready.reject(new Error('skipped')); finished.resolve(); },
      };
      started.push(transition);
      // The browser captures the old page, then runs the update.
      update();
      return transition;
    };
  }
  const window = {
    location: { search: '' }, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    SiteBlackHole: camera && { jetCamera: () => camera, drawn: () => drawn },
    SiteTheme: {
      get current() { return root.dataset.theme; },
      set(next) { sets.push(next); root.dataset.theme = next; },
      useSwitcher(value) { switcher = value; },
    },
    addEventListener(type) { listeners.add(type); },
    removeEventListener(type) { listeners.delete(type); },
  };
  runInNewContext(source, {
    window, document, URLSearchParams, Path2D,
    matchMedia: () => ({ matches: reduced }),
    performance: { now: () => now },
    requestAnimationFrame: callback => frames.push(callback),
    cancelAnimationFrame() {},
  });
  const overlay = () => body.children.find(child => child.className === 'theme-jets');
  return {
    switcher, sets, classes, animations, started, listeners, strokes, fills, overlay,
    button: { getBoundingClientRect: () => ({ left: 900, top: 20, width: 40, height: 40 }) },
    run(milliseconds) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(end, now + 16);
        // The black hole draws a frame in the current theme every display frame.
        if (drawsWithTheme) drawn++;
        for (const callback of frames.splice(0)) callback(now);
      }
    },
    finish() {
      for (let i = 0; i < 100 && (overlay() || frames.length); i++) this.run(64);
    },
  };
}

const points = clip => clip.match(/-?[\d.]+px -?[\d.]+px/g)?.map(point => point.split(' ').map(Number.parseFloat)) ?? [];
const area = shape => Math.abs(shape.reduce((sum, [x, y], i) => {
  const [nx, ny] = shape[(i + 1) % shape.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;
// The column's two ends: the outline's farthest points from the hole, either way along it.
function ends(shape, [x, y]) {
  const far = shape.reduce((best, point) => (Math.hypot(point[0] - x, point[1] - y) > Math.hypot(best[0] - x, best[1] - y) ? point : best));
  const other = shape.reduce((best, point) => {
    const away = (point[0] - x) * (far[0] - x) + (point[1] - y) * (far[1] - y);
    const bestAway = (best[0] - x) * (far[0] - x) + (best[1] - y) * (far[1] - y);
    return away < bestAway ? point : best;
  });
  return far[1] < other[1] ? [far, other] : [other, far];
}

await test('a switch to day restyles at once, then a column of the day page shoots out of the hole and swells over the screen', () => {
  const site = loadJets();
  site.switcher.request('light', site.button);
  assert.equal(site.started.length, 1, 'the one view transition starts at the click');
  assert.equal(site.switcher.target, 'light');
  assert.deepEqual(site.sets, ['light']);
  assert.ok(site.classes.has('is-theme-jets') && site.classes.has('is-theme-jets-opening'));
  assert.ok(['wheel', 'touchmove', 'keydown'].every(type => site.listeners.has(type)), 'the page holds still during the switch');
  assert.equal(site.overlay().attributes['aria-hidden'], 'true');
  site.run(200);
  assert.equal(site.animations.length, 0, 'nothing moves before the restyled page is ready');
  site.started[0].show();
  const [clip] = site.animations;
  assert.equal(clip.options.pseudoElement, '::view-transition-new(root)', 'the new day page fills the column');
  assert.ok(clip.paused);
  assert.ok(area(points(clip.first)) < 50, 'the column starts inside the hole');
  site.run(400);
  const shot = points(clip.last);
  const xs = shot.map(point => point[0]), ys = shot.map(point => point[1]);
  assert.ok(Math.min(...ys) < -60 && Math.max(...ys) > 860, 'after its shot the column runs off both edges');
  assert.ok(Math.max(...xs) - Math.min(...xs) < 160, 'and is still thin');
  assert.ok(site.strokes.length > 0 && site.strokes.every(stroke => stroke.segments > 0), 'fine lines draw its rims');
  assert.ok(site.strokes.reduce((sum, stroke) => sum + stroke.segments, 0) <= 128, 'only its two end rims, without strands');
  site.finish();
  assert.equal(clip.last, 'none', 'the column swallowed the screen before the live page took over');
  assert.ok(site.started[0].skipped);
  assert.equal(site.overlay(), undefined);
  assert.equal(site.classes.size, 0);
  assert.equal(site.listeners.size, 0);
  assert.deepEqual(site.sets, ['light'], 'one theme change');
  assert.equal(site.switcher.target, null);
});

await test('the column is shaded as a lit cylinder, never over the black shadow, and leaves the day page as it is', () => {
  const site = loadJets();
  site.switcher.request('light', site.button);
  site.started[0].show();
  site.run(400);
  assert.equal(site.fills.length, 2, 'a shade and a highlight cover the column');
  const [dark, light] = site.fills.map(fill => fill.style);
  const opacity = (gradient, offset) => gradient.stops.find(([stop]) => Math.abs(stop - offset) < 1e-9)[1];
  assert.ok(opacity(dark, 0) > 0.2 && opacity(dark, 1) > 0.2, 'the wall darkens towards both edges');
  assert.ok(opacity(dark, 0.5) < 0.01, 'and keeps the page as it is along the middle');
  const peak = light.stops.reduce((best, stop) => (stop[1] > best[1] ? stop : best));
  assert.ok(Math.abs(peak[0] - 0.33) < 0.03 && peak[1] > 0.5, 'a highlight runs a third of the way across');
  const [x0, y0, x1, y1] = dark.axis;
  assert.ok(Math.abs(y1 - y0) < Math.abs(x1 - x0) * 0.05, 'the shading runs across the upright column');
  for (const fill of site.fills) {
    const hole = fill.clips.find(clip => clip.rule === 'evenodd')?.arcs[0];
    assert.ok(hole, 'the black shadow is left out of the shading');
    assert.deepEqual([hole.x, hole.y], [400, 300]);
    assert.ok(Math.abs(hole.radius - 2.6 / 31.78443 * 4.05 * 450) < 3, `the cut-out follows the shadow's rim: ${hole.radius}`);
  }
  site.run(500);
  assert.equal(site.fills.length, 0, 'the shading has faded before the column fills the screen');
  site.finish();
  const page = loadJets({ camera: null });
  page.switcher.request('light', page.button);
  page.started[0].show();
  page.run(400);
  assert.ok(page.fills.length === 2 && page.fills.every(fill => fill.clips.length === 0), 'without a black hole nothing is left out');
  page.finish();
});

// A clip is set on the root for a transition pseudo-element, so it outlives
// its transition unless cancelled: a switch back to night left its empty
// final clip on the old page image, and the next switch to day then showed
// only the column on a blank page.
await test('each switch takes its clip away with it, so the next switch keeps the page around its column', () => {
  const site = loadJets({ theme: 'light' });
  site.switcher.request('dark', site.button);
  site.started[0].show();
  site.finish();
  site.switcher.request('light', site.button);
  site.started[1].show();
  site.run(200);
  const [back, forth] = site.animations;
  assert.ok(back.cancelled, 'the switch back took its clip of the old page away');
  assert.equal(site.animations.filter(animation => !animation.cancelled
    && animation.options.pseudoElement === '::view-transition-old(root)').length, 0, 'nothing clips the night page around the column');
  assert.equal(forth.options.pseudoElement, '::view-transition-new(root)');
  site.finish();
  assert.ok(site.animations.every(animation => animation.cancelled));
});

await test('switching back clips the old day image to a column that shrinks into the hole', () => {
  const site = loadJets({ theme: 'light' });
  site.switcher.request('dark', site.button);
  assert.equal(site.started.length, 1);
  assert.ok(site.classes.has('is-theme-jets-closing'));
  site.started[0].show();
  const [clip] = site.animations;
  assert.equal(clip.options.pseudoElement, '::view-transition-old(root)', 'the old day page fills the column');
  assert.equal(clip.first, 'none', 'at first the day page still covers the screen');
  site.finish();
  assert.ok(area(points(clip.last)) < 50, 'the column ends inside the hole');
  assert.ok(site.started[0].skipped);
  assert.deepEqual(site.sets, ['dark']);
});

await test('a toggle midway turns the column back, and the first theme returns once its image covers the screen', () => {
  const site = loadJets();
  site.switcher.request('light', site.button);
  site.started[0].show();
  site.run(300);
  site.switcher.request('dark', site.button);
  assert.equal(site.switcher.target, 'dark');
  site.run(200);
  assert.deepEqual(site.sets, ['light'], 'the page keeps its restyle while the column retreats');
  site.finish();
  assert.equal(site.started.length, 1, 'no second transition');
  assert.deepEqual(site.sets, ['light', 'dark']);
  assert.ok(site.started[0].skipped);
  assert.equal(site.overlay(), undefined);
});

await test('the live page waits for the black hole to draw in the restored theme', () => {
  const site = loadJets({ drawsWithTheme: false });
  site.switcher.request('light', site.button);
  site.started[0].show();
  site.run(100);
  site.switcher.request('dark', site.button);
  site.run(140);
  assert.deepEqual(site.sets, ['light', 'dark']);
  assert.equal(site.started[0].skipped, false, 'no frame in the restored theme yet');
  site.run(300);
  assert.ok(site.started[0].skipped, 'but it never waits for long');
});

await test('a toggle while the switch completes waits, then switches again', () => {
  const site = loadJets({ drawsWithTheme: false });
  site.switcher.request('light', site.button);
  site.started[0].show();
  site.run(80);
  site.switcher.request('dark', site.button);
  site.run(120);
  // Restoring night: the switch is ending, so this request queues.
  site.switcher.request('light', site.button);
  assert.equal(site.switcher.target, 'light');
  site.run(400);
  assert.equal(site.started.length, 2);
  site.started[1].show();
  site.finish();
  assert.deepEqual(site.sets, ['light', 'dark', 'light']);
});

await test('a transition the browser skips still lands on the requested theme', () => {
  const site = loadJets();
  site.switcher.request('light', site.button);
  site.started[0].abort();
  assert.deepEqual(site.sets, ['light']);
  assert.equal(site.overlay(), undefined);
  assert.equal(site.listeners.size, 0);
  assert.equal(site.classes.size, 0);
});

await test('reduced motion crossfades; without view transitions the theme changes at once', () => {
  const calm = loadJets({ reduced: true });
  calm.switcher.request('light', calm.button);
  assert.equal(calm.started.length, 1);
  assert.equal(calm.overlay(), undefined);
  assert.ok(calm.classes.has('is-theme-fade'));
  calm.started[0].skipTransition();
  assert.equal(calm.classes.size, 0);
  assert.deepEqual(calm.sets, ['light']);

  const legacy = loadJets({ transitions: false });
  legacy.switcher.request('light', legacy.button);
  assert.deepEqual(legacy.sets, ['light']);
  assert.equal(legacy.overlay(), undefined);
});

await test('the column leaves the hole along the spin axis, rolled with the disk, or the toggle where there is none', () => {
  for (const [roll, label] of [[0, 'level'], [18 * degree, 'rolled like the hero']]) {
    const site = loadJets({ camera: heroCamera(roll) });
    site.switcher.request('light', site.button);
    site.started[0].show();
    site.run(400);
    const [top, bottom] = ends(points(site.animations[0].last), [400, 300]);
    const lean = Math.atan2(top[0] - bottom[0], bottom[1] - top[1]);
    assert.ok(Math.abs(lean + roll) < 2 * degree, `${label}: the column's top leans left by the roll, got ${(lean / degree).toFixed(2)}°`);
    site.finish();
  }
  const page = loadJets({ camera: null });
  page.switcher.request('light', page.button);
  page.started[0].show();
  page.run(120);
  const shape = points(page.animations[0].last);
  const [cx, cy] = shape.reduce(([sx, sy], [x, y]) => [sx + x / shape.length, sy + y / shape.length], [0, 0]);
  assert.ok(Math.hypot(cx - 920, cy - 40) < 140, 'the column starts at the toggle');
  page.run(300);
  const [top, bottom] = ends(points(page.animations[0].last), [920, 40]);
  assert.ok(top[0] > bottom[0], 'from the top right corner it leans so as to cross the page');
  page.finish();
});
