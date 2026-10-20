import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/loading.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, callback, options = {}) {
      if (!listeners.has(type)) listeners.set(type, new Map());
      if (!listeners.get(type).has(callback)) listeners.get(type).set(callback, options);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      event.target ??= this;
      for (const [callback, options] of [...(listeners.get(event.type) || [])]) {
        if (!listeners.get(event.type)?.has(callback)) continue;
        if (options.once) listeners.get(event.type).delete(callback);
        callback(event);
      }
      return true;
    },
  };
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: name => values.has(name),
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

// Execute the real head script. Browser timing stays controllable so a callback
// already dequeued before pagehide can also be delivered after cancellation.
function browser({ reduced = false, hidden = false, pendingResources = false } = {}) {
  let now = 0;
  let sequence = 0;
  let removed = false;
  const frames = new Map();
  const timers = new Map();
  const events = [];
  const font = deferred();
  const image = deferred();
  if (!pendingResources) { font.resolve(); image.resolve(); }
  const root = { classList: classList() };
  const loader = eventTarget({ remove() { removed = true; } });
  const blackHole = { classList: classList() };
  const fallback = { decode: () => image.promise };
  const reducedMotion = eventTarget({ matches: reduced });
  const window = eventTarget();
  const document = eventTarget({
    hidden,
    documentElement: root,
    fonts: { load: () => font.promise },
    querySelector(selector) {
      if (selector === '#site-loader') return removed ? null : loader;
      if (selector === '.black-hole') return blackHole;
      if (selector === '.black-hole-fallback') return fallback;
      return null;
    },
  });
  for (const type of ['site:revealing', 'site:revealed']) {
    window.addEventListener(type, () => events.push(type));
  }
  runInNewContext(source, {
    window,
    document,
    performance: { now: () => now },
    matchMedia: () => reducedMotion,
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: 'js/loading.js' });

  return {
    window, document, root, loader, frames, timers, events,
    get removed() { return removed; },
    async flushPromises() {
      // Includes Promise.allSettled's handlers and its final continuation.
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
    resolveResources() { font.resolve(); image.resolve(); },
    frame() {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(now));
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      let count = 0;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        assert.ok(count++ < 100, 'timers must not loop indefinitely');
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
    startIntro() {
      document.dispatchEvent({ type: 'animationstart', animationName: 'loader-arrive', target: { matches: selector => selector === '.loader-symbol' } });
    },
    visibility(value) {
      document.hidden = value;
      document.dispatchEvent({ type: 'visibilitychange' });
    },
    pagehide() { window.dispatchEvent({ type: 'pagehide', persisted: true }); },
    pageshow() { window.dispatchEvent({ type: 'pageshow', persisted: true }); },
    reduce(value = true) {
      reducedMotion.matches = value;
      reducedMotion.dispatchEvent({ type: 'change', matches: value });
    },
    finishFade() { loader.dispatchEvent({ type: 'transitionend', target: loader, propertyName: 'opacity' }); },
  };
}

function assertReleased(page) {
  assert.equal(page.removed, true, 'loader must be removed');
  assert.equal(page.root.classList.contains('is-loading'), false);
  assert.equal(page.root.classList.contains('is-loading-exit'), false);
  assert.equal(page.frames.size, 0, 'release must cancel queued animation frames');
  assert.equal(page.timers.size, 0, 'release must cancel all loader timers');
}

test('visible readiness preserves the intro and fade, then announces completion once', async () => {
  const page = browser();
  page.pageshow();
  assert.deepEqual(page.events, [], 'the initial pageshow must not announce an unfinished loader');
  page.startIntro();
  page.window.SiteLoader.ready();
  page.window.SiteLoader.ready();
  await page.flushPromises();
  assert.equal(page.frames.size, 1);
  page.frame();
  assert.equal(page.frames.size, 1);
  page.frame();
  page.advance(1067);
  assert.deepEqual(page.events, []);
  page.advance(1);
  assert.deepEqual(page.events, ['site:revealing']);
  assert.equal(page.root.classList.contains('is-loading-exit'), true);
  page.finishFade();
  assertReleased(page);
  assert.deepEqual(page.events, ['site:revealing', 'site:revealed']);
  page.advance(5000);
  page.pageshow();
  page.visibility(false);
  page.window.SiteLoader.ready();
  assert.deepEqual(page.events, ['site:revealing', 'site:revealed']);
});

test('deadline and reduced motion still release a visible page without trapping loading', async () => {
  const missingMain = browser();
  missingMain.advance(3999);
  assert.equal(missingMain.removed, false);
  missingMain.advance(1);
  assertReleased(missingMain);
  assert.deepEqual(missingMain.events, ['site:revealed']);

  const reduced = browser({ reduced: true });
  reduced.window.SiteLoader.ready();
  await reduced.flushPromises();
  assertReleased(reduced);
  assert.deepEqual(reduced.events, ['site:revealed']);
  assert.equal(reduced.root.classList.contains('has-site-intro'), false);

  const changed = browser();
  changed.reduce();
  assertReleased(changed);
  assert.deepEqual(changed.events, ['site:revealed']);
});

test('an early loader pagehide listener cannot wake downstream startup while closing', () => {
  const page = browser();
  let downstreamActive = true;
  let starts = 0;
  page.window.addEventListener('site:revealed', () => { if (downstreamActive) starts += 1; });
  // main.js and chapters.js register later than the loader's head script.
  page.window.addEventListener('pagehide', () => { downstreamActive = false; });
  page.pagehide();
  assert.equal(page.document.hidden, false, 'pagehide may precede visibilitychange');
  assertReleased(page);
  assert.deepEqual(page.events, []);
  assert.equal(starts, 0);
  page.visibility(true);
  page.visibility(false);
  page.reduce();
  assert.deepEqual(page.events, [], 'visibility alone must not reactivate a pagehide page');
  downstreamActive = true;
  page.pageshow();
  assert.deepEqual(page.events, ['site:revealed']);
  assert.equal(starts, 1);
  page.pagehide();
  page.pageshow();
  assert.equal(starts, 1, 'BFCache restoration must not repeat completion');
});

test('hidden release ignores late readiness promises and announces only after visibility returns', async () => {
  const page = browser({ pendingResources: true });
  page.window.SiteLoader.ready();
  page.visibility(true);
  assertReleased(page);
  assert.deepEqual(page.events, []);
  page.resolveResources();
  await page.flushPromises();
  assertReleased(page);
  assert.deepEqual(page.events, []);
  page.visibility(false);
  assert.deepEqual(page.events, ['site:revealed']);
  page.visibility(true);
  page.visibility(false);
  page.pageshow();
  assert.deepEqual(page.events, ['site:revealed']);
});

test('pagehide cancels either readiness frame and stale callbacks cannot schedule another', async () => {
  for (const stage of [1, 2]) {
    const page = browser();
    page.window.SiteLoader.ready();
    await page.flushPromises();
    if (stage === 2) page.frame();
    const staleFrame = [...page.frames.values()][0];
    assert.equal(typeof staleFrame, 'function', `readiness frame ${stage} must be pending`);
    page.pagehide();
    assertReleased(page);
    staleFrame(100);
    page.advance(5000);
    await page.flushPromises();
    assertReleased(page);
    assert.deepEqual(page.events, [], `stale readiness frame ${stage} must stay silent`);
  }
});

test('closing during the fade cancels its fallback and late completion stays silent', async () => {
  const page = browser();
  page.startIntro();
  page.window.SiteLoader.ready();
  await page.flushPromises();
  page.frame();
  page.frame();
  page.advance(1100);
  assert.deepEqual(page.events, ['site:revealing']);
  const staleTimers = [...page.timers.values()].map(timer => timer.callback);
  page.pagehide();
  assertReleased(page);
  page.finishFade();
  staleTimers.forEach(callback => callback());
  assertReleased(page);
  assert.deepEqual(page.events, ['site:revealing']);
  page.pageshow();
  page.pageshow();
  assert.deepEqual(page.events, ['site:revealing', 'site:revealed']);
});

test('a BFCache page restored in the background waits for a visible active page', async () => {
  const page = browser({ hidden: true, pendingResources: true });
  page.window.SiteLoader.ready();
  page.pagehide();
  assertReleased(page);
  page.pageshow();
  page.resolveResources();
  await page.flushPromises();
  assertReleased(page);
  assert.deepEqual(page.events, []);
  page.pagehide();
  page.visibility(false);
  assert.deepEqual(page.events, [], 'every pagehide must close the lifecycle gate');
  page.pageshow();
  assert.deepEqual(page.events, ['site:revealed']);
  page.visibility(false);
  page.pageshow();
  assert.deepEqual(page.events, ['site:revealed']);
});
