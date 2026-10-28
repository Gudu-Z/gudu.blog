import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/categories.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  };
}

function browser({ reduced = false, observer = true, content = true, missing = false } = {}) {
  class Element {
    constructor(className = '', data = {}) {
      Object.assign(this, eventTarget());
      this.className = className;
      this.dataset = data;
      this.children = [];
      this.style = {};
      this.hidden = false;
      this.hovered = false;
      this.focusVisible = false;
    }
    append(...elements) { this.children.push(...elements); }
    replaceChildren(...elements) { this.children = elements; }
    matches(selector) {
      if (selector === ':hover') return this.hovered;
      if (selector === ':focus-visible') return this.focusVisible;
      const match = selector.match(/^\.([\w-]+)(?:\[data-category-link="([^"]+)"\])?$/);
      return Boolean(match && this.className.split(' ').includes(match[1]) && (!match[2] || this.dataset.categoryLink === match[2]));
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const root = new Element('category-surface');
  const words = new Element('category-column', { categoryLink: 'collected' });
  const network = new Element('category-column', { categoryLink: 'other' });
  words.href = '?category=collected#journal';
  network.href = '?category=other#journal';
  const wordDepth = new Element('category-art-depth');
  wordDepth.append(new Element('category-word-lines'), new Element('category-word-bracket'));
  words.append(wordDepth);
  const networkDepth = new Element('category-art-depth');
  networkDepth.append(
    ...Array.from({ length: 5 }, () => new Element('category-node')),
    ...Array.from({ length: 4 }, () => new Element('category-node-line')),
    new Element('category-node-ring'), new Element('category-art-dot'),
  );
  network.append(networkDepth);
  root.append(words, network);
  const classes = new Set(['has-chapters', ...(content ? ['is-content'] : [])]);
  const viewport = new Element('chapter-viewport');
  const document = eventTarget({
    hidden: false,
    documentElement: { classList: { contains: name => classes.has(name) } },
    querySelector: selector => ({ '#category-surface': missing ? null : root, '#chapter-viewport': viewport })[selector] || null,
    createElement: () => new Element(),
  });
  const window = eventTarget();
  const motion = eventTarget({ matches: reduced });
  const frames = new Map();
  const observers = [];
  let sequence = 0;
  let now = 0;
  let requested = 0;
  class Observer {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      observers.push(this);
    }
    observe(element) { this.observed.add(element); }
    disconnect() { this.observed.clear(); }
  }
  runInNewContext(source, {
    document, window,
    matchMedia: () => motion,
    performance: { now: () => now },
    requestAnimationFrame(callback) { requested++; frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); },
    queueMicrotask: callback => callback(),
    ...(observer ? { IntersectionObserver: Observer } : {}),
  });

  return {
    root, words, network, document, window, motion, observers, frames,
    get requested() { return requested; },
    tick(ms) {
      now += ms;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
    },
    intersect(element, visible) {
      observers[0].callback([{ target: element, isIntersecting: visible, intersectionRatio: visible ? .75 : 0 }]);
    },
    show() { if (observer) this.intersect(words, true); if (observer) this.intersect(network, true); },
    enter(element, pointerType = 'mouse') {
      element.hovered = pointerType !== 'touch';
      element.dispatchEvent({ type: 'pointerenter', pointerType });
    },
    leave(element) { element.hovered = false; element.dispatchEvent({ type: 'pointerleave' }); },
    focus(element, visible = true) { element.focusVisible = visible; element.dispatchEvent({ type: visible ? 'focus' : 'blur' }); },
    hidden(value) { document.hidden = value; document.dispatchEvent({ type: 'visibilitychange' }); },
    reduced(value) { motion.matches = value; motion.dispatchEvent({ type: 'change' }); },
    chapter(progress) { window.dispatchEvent({ type: 'site:chapter', detail: { progress } }); },
    wordsState() {
      return {
        scanY: Number(words.querySelector('.category-word-scanner').style.transform.match(/,([\d.e+-]+)px,/)[1]),
        scanOpacity: Number(words.querySelector('.category-word-scanner').style.opacity),
        decoded: words.querySelectorAll('.category-word-decoded').map(node => Number(node.style.opacity)),
        transform: wordDepth.style.transform,
      };
    },
  };
}

function checkConnections(network) {
  const nodes = network.querySelectorAll('.category-node').map(node => ({
    x: parseFloat(node.style.left) + parseFloat(node.style.width) / 2,
    y: parseFloat(node.style.top) + parseFloat(node.style.height) / 2,
  }));
  const connections = [[0, 2], [2, 1], [2, 3], [2, 4]];
  network.querySelectorAll('.category-node-line').forEach((edge, index) => {
    const [from, to] = connections[index];
    const x = parseFloat(edge.style.left);
    const y = parseFloat(edge.style.top);
    const length = parseFloat(edge.style.width);
    const angle = parseFloat(edge.style.transform.slice(7)) * Math.PI / 180;
    assert.ok(Math.hypot(x - nodes[from].x, y - nodes[from].y) < .001);
    assert.ok(Math.hypot(x + Math.cos(angle) * length - nodes[to].x, y + Math.sin(angle) * length - nodes[to].y) < .001);
  });
}

test('initial diagrams are still, reuse the existing depth wrapper, and leave category links alone', () => {
  const b = browser();
  assert.equal(b.root.querySelectorAll('.category-art-depth').length, 2);
  assert.equal(b.words.querySelectorAll('.category-word-row').length, 6);
  assert.equal(b.words.href, '?category=collected#journal');
  assert.equal(b.words.listeners.has('click'), false);
  assert.equal(b.requested, 0);
  b.show();
  assert.equal(b.requested, 0);
  assert.deepEqual(b.wordsState().decoded, [0, 0, 0, 0, 0, 0]);
});

test('scan completes in 1.8 seconds and does not keep an idle frame loop', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.tick(450);
  const partial = b.wordsState();
  assert.ok(partial.scanY > -12 && partial.scanY < 80);
  assert.ok(partial.scanOpacity > 0);
  b.tick(1350);
  assert.deepEqual(b.wordsState().decoded, [1, 1, 1, 1, 1, 1]);
  assert.equal(b.wordsState().scanOpacity, 0);
  assert.equal(b.frames.size, 0);
  const count = b.requested;
  b.tick(10000);
  assert.equal(b.requested, count);
});

test('pointer reversals continue from the current scan without resetting its position', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.tick(400);
  const entering = b.wordsState();
  b.leave(b.words);
  assert.deepEqual(b.wordsState(), entering);
  b.tick(200);
  assert.ok(b.wordsState().scanY < entering.scanY);
  const returning = b.wordsState();
  b.enter(b.words);
  assert.deepEqual(b.wordsState(), returning);
  b.tick(1800);
  assert.equal(b.wordsState().scanY, 80);
  b.leave(b.words);
  b.tick(1800);
  assert.equal(b.wordsState().scanY, -12);
  assert.equal(b.frames.size, 0);
});

test('node links remain attached through spatial motion and mid-flight reversal', () => {
  const b = browser();
  b.show();
  checkConnections(b.network);
  b.enter(b.network);
  for (const step of [200, 350, 400]) { b.tick(step); checkConnections(b.network); }
  b.leave(b.network);
  for (const step of [300, 700, 800]) { b.tick(step); checkConnections(b.network); }
  assert.equal(b.frames.size, 0);
});

test('each column pauses when clipped without stopping a visible sibling', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.enter(b.network);
  assert.equal(b.frames.size, 1);
  b.tick(300);
  b.intersect(b.words, false);
  assert.equal(b.wordsState().scanY, -12);
  assert.equal(b.frames.size, 1);
  b.intersect(b.network, false);
  assert.equal(b.frames.size, 0);
  b.focus(b.words);
  assert.equal(b.frames.size, 0);
});

test('hidden tabs and the Hero suspend diagrams even before an observer update', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.tick(300);
  b.hidden(true);
  assert.equal(b.frames.size, 0);
  assert.equal(b.wordsState().scanY, -12);
  b.hidden(false);
  assert.equal(b.frames.size, 1);
  b.tick(300);
  b.chapter(.3);
  assert.equal(b.frames.size, 0);
  assert.equal(b.wordsState().scanY, -12);
  b.chapter(1);
  assert.equal(b.frames.size, 1);
});

test('pagehide disconnects observation; a restored page waits for fresh visibility', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.tick(300);
  b.window.dispatchEvent({ type: 'pagehide' });
  assert.equal(b.frames.size, 0);
  assert.equal(b.observers[0].observed.size, 0);
  b.window.dispatchEvent({ type: 'pageshow' });
  assert.equal(b.observers[0].observed.size, 2);
  assert.equal(b.frames.size, 0);
  b.intersect(b.words, true);
  assert.equal(b.frames.size, 1);
  b.tick(1800);
  assert.equal(b.frames.size, 0);
});

test('reduced motion preserves static hover and keyboard feedback without frames', () => {
  const b = browser({ reduced: true });
  b.show();
  b.enter(b.words);
  assert.equal(b.wordsState().scanY, 80);
  assert.equal(b.wordsState().scanOpacity, 0);
  b.leave(b.words);
  assert.equal(b.wordsState().scanY, -12);
  b.focus(b.words);
  assert.equal(b.wordsState().scanY, 80);
  b.focus(b.words, false);
  assert.equal(b.wordsState().scanY, -12);
  assert.equal(b.requested, 0);
});

test('changing reduced motion during a pass settles the active state', () => {
  const b = browser();
  b.show();
  b.enter(b.words);
  b.tick(300);
  b.reduced(true);
  assert.equal(b.wordsState().scanY, 80);
  assert.equal(b.frames.size, 0);
  b.hidden(true);
  assert.equal(b.wordsState().scanY, -12);
});

test('touch entry does not latch a hover loop and missing observer remains usable', () => {
  const b = browser({ observer: false });
  b.enter(b.words, 'touch');
  assert.equal(b.requested, 0);
  b.focus(b.words);
  b.tick(1800);
  assert.equal(b.wordsState().scanY, 80);
  assert.equal(b.frames.size, 0);
});

test('pages without the category surface add no observers or animation work', () => {
  const b = browser({ missing: true });
  assert.equal(b.observers.length, 0);
  assert.equal(b.requested, 0);
  assert.equal(b.window.listeners.size, 0);
});
