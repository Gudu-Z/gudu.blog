import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/star-sky.js', import.meta.url), 'utf8');
const notFound = await readFile(new URL('../404.html', import.meta.url), 'utf8');

// The script's arrays come from its own realm; compare their contents.
const plain = value => JSON.parse(JSON.stringify(value));

// Run the real script against a page holding the given canvases.
function page(canvases = []) {
  const listeners = new Map();
  const observers = [];
  const root = { dataset: {} };
  const window = {
    devicePixelRatio: 2,
    addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
    emit(type) { for (const callback of listeners.get(type) || []) callback({ type }); },
  };
  const document = {
    documentElement: root,
    querySelectorAll: selector => (selector === 'canvas[data-star-sky]' ? canvases : []),
  };
  runInNewContext(source, {
    window, document, Math,
    ResizeObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
  });
  return { sky: window.StarSky, window, root, resize: () => observers.forEach(callback => callback()) };
}

// A canvas that records what was painted on it.
function canvas(width, height) {
  const painted = [];
  let fill = '';
  const context = {
    setTransform(...matrix) { this.matrix = matrix; },
    set fillStyle(value) { fill = value; },
    beginPath() {}, fill() {},
    arc(x, y, radius) { painted.push({ x, y, radius, fill }); },
  };
  const element = {
    width: 0, height: 0, box: { width, height },
    getBoundingClientRect() { return this.box; },
    getContext: type => (type === '2d' ? context : null),
    painted, context,
    // Setting a canvas's size clears it, as a browser does.
    set size([w, h]) { this.box = { width: w, height: h }; },
  };
  return new Proxy(element, {
    set(target, key, value) { if (key === 'width' || key === 'height') painted.length = 0; target[key] = value; return true; },
  });
}

test('the sky is seeded, about one star per 2500 square pixels, and reaches a little past each edge', () => {
  const { sky } = page();
  const first = sky.stars(1600, 860), again = sky.stars(1600, 860);
  assert.deepEqual(first, again, 'every visit shows the same sky');
  assert.equal(first.length, Math.round(1600 * 860 / 2500));
  assert.equal(sky.stars(300, 300).length, 120, 'a small page still has a sky');
  assert.equal(sky.stars(2560, 1440).length, 1400, 'a very large window is capped');
  assert.equal(sky.stars(2560, 1360).length, Math.round(2560 * 1360 / 2500), 'up to 2560 by 1370 keeps the full density');
  for (const star of first) {
    assert.ok(star.x >= -96 && star.x <= 1696 && star.y >= -52 && star.y <= 912);
    assert.ok(star.radius >= 0.5 && star.radius <= 1.55);
    assert.ok(star.light > 0 && star.light <= 1);
    assert.ok(star.depth >= 0.04 && star.depth <= 0.44);
  }
  assert.ok(first.some(star => star.x < 0) && first.some(star => star.x > 1600), 'the sky overhangs both sides');
});

test('night, day and ink each have their own tone', () => {
  const { sky } = page();
  assert.deepEqual({ ...sky.tone() }, { color: '193,204,223', gain: 1 });
  assert.deepEqual({ ...sky.tone({ day: true }) }, { color: '62,51,32', gain: 0.8 }, 'day is the night sky\'s negative');
  assert.deepEqual({ ...sky.tone({ ink: true }) }, { color: '225,218,200', gain: 0.55 });
  assert.deepEqual({ ...sky.tone({ day: true, ink: true }) }, { ...sky.tone({ ink: true }) });
});

test('a page canvas marked data-star-sky shows the same sky still, and repaints for its size and theme only', () => {
  const lost = canvas(1440, 810);
  const site = page([lost]);
  const expected = site.sky.stars(1440, 810);
  assert.equal(lost.width, 2880, 'drawn at the display\'s pixel ratio');
  assert.deepEqual(lost.context.matrix, [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(plain(lost.painted.map(star => [star.x, star.y, star.radius])), plain(expected.map(star => [star.x, star.y, star.radius])));
  assert.ok(lost.painted.every(star => star.fill.startsWith('rgba(193,204,223,')));

  site.root.dataset.theme = 'light';
  site.window.emit('site:theme');
  assert.equal(lost.painted.length, expected.length);
  assert.ok(lost.painted.every(star => star.fill.startsWith('rgba(62,51,32,')), 'the day page paints the negative');

  lost.size = [800, 600];
  site.resize();
  assert.deepEqual(plain(lost.painted.map(star => [star.x, star.y])), plain(site.sky.stars(800, 600).map(star => [star.x, star.y])), 'a new size, a sky laid out for it');
});

test('a canvas without a 2D context is left alone', () => {
  const blank = { getContext: () => null, getBoundingClientRect: () => ({ width: 100, height: 100 }) };
  assert.doesNotThrow(() => page([blank]));
});

test('the lost page floats in the star sky', () => {
  assert.match(notFound, /<script src="\/js\/star-sky\.js\?v=[^"]+" defer><\/script>/);
  assert.match(notFound, /<body class="not-found-page">\s*<canvas class="lost-sky" data-star-sky aria-hidden="true"><\/canvas>/);
});
