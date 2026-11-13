import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/intro.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of [...(listeners.get(event.type) || [])]) callback(event);
      return true;
    },
    listening: type => listeners.get(type)?.size || 0,
    listenerCount: () => [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0),
  });
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: name => values.has(name),
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    list: () => [...values],
  };
}

function style() {
  const properties = new Map();
  return {
    clipPath: '', transform: '', opacity: '',
    setProperty(name, value) { properties.set(name, value); },
    removeProperty(name) { properties.delete(name); },
    getPropertyValue: name => properties.get(name) ?? '',
    properties,
  };
}

// Execute the real entrance script against a controlled page: a hero with its
// two-part title and clock, the scene's camera hooks, and a manual clock.
function browser({ search = '', hash = '', seen = false, storageBlocked = false, reduced = false, loading = true,
  live = true, text = '个人博客', navigation = 'navigate',
  timing = time => ({ measured: true, quality: 1, frameInterval: 1000 / 60,
    gpuTimes: Array(Math.floor(time / 32) % 8).fill(8), gpuPending: null }) } = {}) {
  let now = 0;
  let sequence = 0;
  const frames = new Map();
  const timers = new Map();
  const events = [];
  const storage = new Map(seen ? [['gudu-intro', 'seen']] : []);
  const created = [];
  const root = { classList: classList(loading ? ['is-loading', 'has-site-intro'] : []), dataset: {}, style: style() };

  const period = { style: style() };
  const second = { style: style(), childNodes: [], getBoundingClientRect: () => ({ left: 100, top: 300, width: 560, height: 120 }) };
  const place = node => second.childNodes.indexOf(node);
  const titleText = {
    nodeType: 3, nodeValue: text,
    replaceWith(...nodes) { second.childNodes.splice(place(titleText), 1, ...nodes); },
  };
  second.childNodes.push(titleText, period);
  const glyph = () => {
    const node = {
      nodeType: 1, textContent: '', style: style(),
      // Each character is 60px wide, laid out in document order.
      getBoundingClientRect: () => ({ left: 100 + place(node) * 60, right: 160 + place(node) * 60 }),
      before(other) { second.childNodes.splice(place(node), 0, other); },
      remove() { second.childNodes.splice(place(node), 1); },
    };
    return node;
  };
  const clockParts = [{ textContent: '' }, { textContent: '' }];
  const clock = { querySelector: selector => clockParts[selector === '[data-clock-date]' ? 0 : 1] };
  const grid = { getBoundingClientRect: () => ({ left: 67, top: 48, right: 1533, bottom: 812 }) };
  const heroNodes = { '.space-grid': grid, '.title-second-content': second, '.title-period': period, '#local-time': clock };
  const hero = { querySelector: selector => heroNodes[selector] ?? null };
  const frameLayer = { clientHeight: 860, style: style() };
  const scene = {
    calls: [],
    states: [], performanceReads: [],
    intro(amount, moving = false) {
      this.calls.push([amount, moving]);
      this.states.push({ at: now, amount, full: root.classList.contains('is-intro'), short: root.classList.contains('has-site-intro') });
    },
    introView: (amount = 1) => (live ? { x: -674, y: -326, zoom: 1.8 ** amount } : null),
    introPerformance() { this.performanceReads.push(now); return typeof timing === 'function' ? timing(now) : timing; },
    live: () => live,
  };
  const pageNodes = { '.hero': hero, '.intro-frame': frameLayer };
  const document = eventTarget({
    hidden: false,
    documentElement: root,
    querySelector: selector => pageNodes[selector] ?? null,
    // The entrance only ever makes the title's character spans.
    createElement(name) { created.push(name); return glyph(); },
  });
  const media = eventTarget({ matches: reduced });
  const window = eventTarget({
    location: { search, hash }, scrollY: 0, innerHeight: 860,
    SiteBlackHole: scene,
    sessionStorage: {
      getItem(key) { if (storageBlocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('blocked'); storage.set(key, value); },
    },
  });
  window.addEventListener('site:intro-complete', () => {
    events.push('site:intro-complete');
    // The real main.js removes the short fade when this event arrives.
    root.classList.remove('has-site-intro');
  });
  // The wall clock the title's time locks onto.
  class FixedDate extends Date { constructor() { super(2026, 10, 12, 14, 31, 38); } }
  const warnings = [];
  runInNewContext(source, {
    window, document, URLSearchParams, Date: FixedDate,
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    Event: class { constructor(type) { this.type = type; } },
    // How this page was reached; an older browser has no such record.
    performance: navigation === null ? { now: () => now }
      : { now: () => now, getEntriesByType: type => (type === 'navigation' ? [{ type: navigation }] : []) },
    matchMedia: () => media,
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: 'js/intro.js' });

  const visible = () => second.childNodes.filter(node => node !== period && node.nodeType === 1 && node.style.opacity !== '0').length;
  return {
    window, document, root, scene, second, period, titleText, clockParts, frameLayer, created,
    events, storage, warnings, media, frames, timers,
    get now() { return now; },
    amount: () => scene.calls.at(-1)?.[0],
    moving: () => scene.calls.at(-1)?.[1],
    typed: () => (second.childNodes.includes(titleText) ? null : visible()),
    // The loader's animated exit: the class first, then the announcement.
    reveal() {
      root.classList.add('is-loading-exit');
      window.dispatchEvent({ type: 'site:revealing' });
    },
    release() {
      root.classList.remove('is-loading', 'is-loading-exit');
      window.dispatchEvent({ type: 'site:revealed' });
    },
    // Display frames every 16ms; `frames: false` models a stalled frame loop.
    advance(milliseconds, { frames: animate = true } = {}) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(end, now + 16);
        for (const [id, timer] of [...timers]) {
          if (timer.at > now || !timers.has(id)) continue;
          timers.delete(id);
          timer.callback();
        }
        if (!animate) continue;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(now);
      }
    },
    input(type) { window.dispatchEvent({ type }); },
    chapter(progress) { window.dispatchEvent({ type: 'site:chapter', detail: { progress } }); },
    hide() { document.hidden = true; document.dispatchEvent({ type: 'visibilitychange' }); },
    reduce() { media.matches = true; media.dispatchEvent({ type: 'change' }); },
    setLive(value) { live = value; },
  };
}

function assertNoWork(page) {
  assert.equal(page.window.listenerCount(), 1, 'only the page\'s own completion observer remains');
  assert.equal(page.document.listenerCount(), 0, 'the visibility listener is removed');
  assert.equal(page.media.listenerCount(), 0, 'the motion preference listener is removed');
  assert.equal(page.frames.size, 0, 'no frame stays queued');
  assert.equal(page.timers.size, 0, 'no timer stays queued');
}

function assertSettled(page, completions = 1) {
  assert.equal(page.amount(), 0, 'the camera is back on the hero composition');
  assert.equal(page.moving(), false);
  assert.equal(page.root.classList.contains('is-intro'), false);
  assert.equal(page.root.style.getPropertyValue('--intro-slow'), '');
  assert.deepEqual(page.second.childNodes, [page.titleText, page.period], 'the title keeps its own text node');
  assert.equal(page.second.style.clipPath, '');
  assert.equal(page.period.style.transform, '');
  assert.deepEqual(page.clockParts.map(part => part.textContent), ['2026.11.12', '14:31:38']);
  assert.ok(page.created.every(name => name === 'span'), 'the sky is the page\'s own: the entrance adds no layer');
  assert.equal(page.frameLayer.style.properties.size, 0);
  assertNoWork(page);
  assert.deepEqual(page.events, Array(completions).fill('site:intro-complete'));
}

function assertShort(page) {
  assertSettled(page, 0);
  assert.equal(page.root.classList.contains('has-site-intro'), true, 'the existing CSS fade carries the settled hero');
  assert.equal(page.storage.has('gudu-intro'), false, 'a slow device has not seen the full entrance');
  assert.ok(page.scene.calls.every(([amount, moving]) => (amount === 1 || amount === 0) && !moving),
    'the camera never starts its pull-back');
  assert.deepEqual(page.scene.states.at(-1), { at: page.scene.states.at(-1).at, amount: 0, full: false, short: true },
    'the camera returns only after the short fade has taken over');
}

test('a fast scene opens on the sky, pulls back, types the title and reports its end once', () => {
  const page = browser();
  assert.deepEqual(page.scene.calls, [[1, false]], 'the first frame behind the loader already frames the opening sky');
  page.reveal();
  assert.equal(page.root.classList.contains('is-intro'), true);
  assert.equal(page.storage.has('gudu-intro'), false, 'the sky hold has not committed to the full entrance');
  assert.deepEqual([...page.frameLayer.style.properties], [['--page-left', '67px'], ['--page-top', '48px'],
    ['--page-right', '1533px'], ['--page-bottom', '812px']], 'the corner marks open out to the hero frame');
  assert.equal(page.typed(), 0, 'every character waits for the cursor');
  assert.equal(page.second.style.clipPath, '', 'the line stays hidden until its cursor appears');
  page.advance(120);
  page.release();

  page.advance(320);
  assert.equal(page.amount(), 1, 'stars alone: the camera has not moved yet');
  assert.equal(page.moving(), false);
  const amounts = [], counts = [];
  let moved = false;
  for (let time = 440; time < 1880; time += 16) {
    page.advance(16);
    amounts.push(page.amount());
    counts.push(page.typed());
    if (page.moving()) moved = true;
    if (page.now > 1750) assert.equal(page.moving(), false, 'a settled camera returns to the idle cadence');
  }
  assert.ok(moved, 'the pull-back draws at the interactive cadence');
  assert.equal(page.storage.get('gudu-intro'), 'seen');
  assert.ok(page.scene.performanceReads.every(time => time <= 472), 'cost checks stop before the first moving frame');
  assert.ok(amounts.every((amount, index) => index === 0 || amount <= amounts[index - 1]), 'the camera only pulls back');
  assert.ok(amounts[0] > 0.9 && amounts.at(-1) === 0);
  assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]), 'typing never retreats');
  assert.deepEqual([...new Set(counts)], [0, 1, 2, 3, 4], 'each character appears in turn');
  assert.equal(page.second.style.clipPath, 'none');
  assert.equal(page.period.style.transform, 'translate3d(0px, 0, 0)', 'the cursor ends after the last character');
  assert.deepEqual(page.events, []);
  page.advance(40);
  assertSettled(page);
  page.advance(5000);
  page.reveal();
  page.input('wheel');
  assertSettled(page);
});

test('the cursor steps one character at a time and the clock locks onto the real time', () => {
  const page = browser();
  page.reveal();
  page.advance(1170);
  assert.equal(page.second.style.clipPath, '');
  page.advance(30);
  assert.equal(page.second.style.clipPath, 'none', 'the cursor appears at the start of the line');
  assert.equal(page.typed(), 0);
  assert.equal(page.period.style.transform, 'translate3d(-240px, 0, 0)');
  page.advance(106);
  assert.equal(page.typed(), 1);
  assert.equal(page.period.style.transform, 'translate3d(-180px, 0, 0)');
  // While rolling, the digits keep the clock's own punctuation and length.
  const rolling = page.clockParts.map(part => part.textContent);
  assert.match(rolling[0], /^\d{4}\.\d{2}\.\d{2}$/);
  assert.match(rolling[1], /^\d{2}:\d{2}:\d{2}$/);
  page.advance(1806 - page.now);
  assert.deepEqual(page.clockParts.map(part => part.textContent), ['2026.11.12', '14:31:38']);
  page.advance(200);
  assertSettled(page);
});

test('the entrance plays once per session and again on a reload, and ?intro overrides both', () => {
  const seen = browser({ seen: true });
  assert.deepEqual(seen.scene.calls, [], 'a return visit never frames the opening sky');
  seen.reveal();
  seen.advance(2500);
  assert.equal(seen.root.classList.contains('is-intro'), false);
  assert.deepEqual(seen.events, []);

  // Reloading is asking for the page afresh; coming back to it is not.
  const reloaded = browser({ seen: true, navigation: 'reload' });
  assert.deepEqual(reloaded.scene.calls, [[1, false]], 'a reload opens on the sky again');
  reloaded.reveal();
  assert.equal(reloaded.root.classList.contains('is-intro'), true);
  reloaded.advance(2000);
  assertSettled(reloaded);
  for (const navigation of ['back_forward', 'navigate', 'prerender', null]) {
    assert.deepEqual(browser({ seen: true, navigation }).scene.calls, [], `${navigation}: still the short entrance`);
  }
  assert.deepEqual(browser({ navigation: null }).scene.calls, [[1, false]], 'a first visit needs no navigation record');
  assert.deepEqual(browser({ seen: true, navigation: 'reload', search: '?intro=short' }).scene.calls, [],
    '?intro=short still forces the short entrance');
  assert.deepEqual(browser({ seen: true, navigation: 'reload', reduced: true }).scene.calls, [],
    'reduced motion still shows the page directly');

  const replay = browser({ seen: true, search: '?intro=full' });
  assert.deepEqual(replay.scene.calls, [[1, false]]);
  const short = browser({ search: '?intro=short' });
  assert.deepEqual(short.scene.calls, []);
  const blocked = browser({ storageBlocked: true });
  blocked.reveal();
  assert.equal(blocked.root.classList.contains('is-intro'), true, 'a blocked store still plays');
  blocked.advance(2000);
  assertSettled(blocked);
});

test('?intro=slow stretches the same entrance to a fifth of its speed', () => {
  const page = browser({ search: '?intro=slow' });
  page.reveal();
  assert.equal(page.root.style.getPropertyValue('--intro-slow'), '5');
  page.advance(2200);
  assert.equal(page.amount(), 1, 'five times the stars-only hold');
  page.advance(7200);
  assert.deepEqual(page.events, []);
  assert.equal(page.typed(), 4);
  page.advance(200);
  assertSettled(page);
});

test('any input, a chapter, a scroll, a theme switch or a hidden page lands on the settled hero at once', () => {
  const exits = {
    wheel: page => page.input('wheel'),
    touch: page => page.input('touchstart'),
    key: page => page.input('keydown'),
    pointer: page => page.input('pointerdown'),
    chapter: page => page.chapter(0.2),
    scroll: page => { page.window.scrollY = 40; page.input('scroll'); },
    theme: page => page.input('site:theme'),
    hidden: page => page.hide(),
    pagehide: page => page.input('pagehide'),
    reduced: page => page.reduce(),
    resizeWithoutScene: page => { page.setLive(false); page.input('resize'); },
  };
  for (const [name, leave] of Object.entries(exits)) {
    for (const at of [200, 900, 1400]) {
      const page = browser();
      page.reveal();
      page.advance(at);
      leave(page);
      assertSettled(page);
      page.advance(4000);
      assertSettled(page);
      assert.deepEqual(page.warnings, [], name);
    }
  }
});

test('a page that cannot open on the sky keeps the short entrance and its camera at home', () => {
  const cases = {
    noScene: page => page.setLive(false),
    chapter: page => page.chapter(0.5),
    scrolled: page => { page.window.scrollY = 300; },
    hidden: page => { page.document.hidden = true; },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const page = browser();
    arrange(page);
    page.reveal();
    assert.equal(page.amount(), 0, name);
    assert.equal(page.root.classList.contains('is-intro'), false, name);
    assert.equal(page.storage.has('gudu-intro'), false, `${name}: an entrance that never played is not counted`);
    page.advance(3000);
    assert.deepEqual(page.events, [], `${name}: the short entrance ends itself`);
    assert.deepEqual(page.second.childNodes, [page.titleText, page.period]);
  }
  // A refresh restores the last scroll offset. The chapters treat a pixel of
  // it as still being the hero, and so does the entrance: it plays, and that
  // residue does not end it part-way either.
  const restored = browser();
  restored.window.scrollY = 1;
  restored.chapter(0.0012);
  restored.reveal();
  assert.equal(restored.root.classList.contains('is-intro'), true, 'a stray restored pixel does not cancel the entrance');
  restored.advance(600);
  restored.chapter(0.0012);
  restored.input('scroll');
  assert.equal(restored.root.classList.contains('is-intro'), true);
  assert.deepEqual(restored.events, []);
  restored.chapter(0.03);
  assertSettled(restored);
  // A link straight to a chapter leaves the hero as soon as it is revealed;
  // the hero's own anchor still opens on the sky.
  const linked = browser({ hash: '#about' });
  linked.reveal();
  assert.equal(linked.amount(), 0);
  assert.equal(linked.root.classList.contains('is-intro'), false);
  const home = browser({ hash: '#home' });
  home.reveal();
  assert.equal(home.root.classList.contains('is-intro'), true);
});

test('a loader released without its animated exit never starts the entrance', () => {
  for (const leave of ['release', 'reduce', 'hide', 'pagehide']) {
    const page = browser();
    if (leave === 'release') page.release();
    else if (leave === 'reduce') page.reduce();
    else if (leave === 'hide') page.hide();
    else page.input('pagehide');
    assert.equal(page.amount(), 0, `${leave}: the camera returns before anything is shown`);
    page.reveal();
    page.advance(3000);
    assert.equal(page.root.classList.contains('is-intro'), false, leave);
    assert.deepEqual(page.events, [], leave);
  }
  // Reduced motion, a finished loader or a page without the scene: no part.
  for (const options of [{ reduced: true }, { loading: false }]) {
    const page = browser(options);
    assert.deepEqual(page.scene.calls, []);
    page.reveal();
    assert.equal(page.root.classList.contains('is-intro'), false);
  }
});

test('a stalled frame loop or a failing frame cannot hold the page on its entrance', () => {
  const stalled = browser();
  stalled.reveal();
  stalled.advance(3390, { frames: false });
  assert.deepEqual(stalled.events, [], 'the watchdog allows the full entrance and a margin');
  stalled.advance(20, { frames: false });
  stalled.frames.clear();
  assertSettled(stalled);

  // Even when returning the camera is itself the failing call, the page's
  // own content settles and the end is still reported once.
  const failing = browser();
  failing.reveal();
  failing.advance(1300);
  failing.scene.intro = () => { throw new Error('camera failed'); };
  failing.advance(16);
  assert.equal(failing.root.classList.contains('is-intro'), false);
  assert.deepEqual(failing.second.childNodes, [failing.titleText, failing.period]);
  assert.equal(failing.second.style.clipPath, '');
  assert.deepEqual(failing.events, ['site:intro-complete']);
  assert.equal(failing.warnings.length, 2, 'the failed frame and the failed camera reset are both reported');
  failing.advance(5000);
  assert.deepEqual(failing.events, ['site:intro-complete']);
  assert.equal(failing.frames.size + failing.timers.size, 0);
});

test('a resize re-measures the frame and the cursor without losing its place', () => {
  const page = browser();
  page.reveal();
  page.advance(1420);
  const typed = page.typed();
  assert.ok(typed >= 2);
  const before = page.period.style.transform;
  page.frameLayer.style.properties.clear();
  page.input('resize');
  assert.equal(page.frameLayer.style.properties.size, 4, 'the corner marks follow the new frame');
  assert.equal(page.typed(), typed);
  assert.equal(page.period.style.transform, before);
  page.advance(600);
  assertSettled(page);
});

test('sustained GPU cost selects the short fade before the camera can move', () => {
  const slow = { measured: true, quality: 1, frameInterval: 1000 / 60, gpuTimes: [110, 120, 115], gpuPending: null };
  for (const availableAt of [0, 240, 448, 460]) {
    const page = browser({ timing: time => time >= availableAt ? slow : { ...slow, gpuTimes: [] } });
    page.reveal();
    page.advance(460);
    assertShort(page);
    assert.ok(page.scene.states.at(-1).at <= 460, 'the decision fits inside the stars-only hold');
    const reads = page.scene.performanceReads.length;
    page.release();
    page.advance(6000);
    page.input('resize');
    page.reveal();
    assert.equal(page.scene.performanceReads.length, reads, 'no performance probe survives the fallback');
    assertShort(page);
  }
});

test('the bar uses the quality floor, rejects isolated spikes and respects adaptive cadence', () => {
  const cases = [
    { quality: 1, gpuTimes: [40, 45, 50], short: false },
    { quality: 0.6, gpuTimes: [40, 45, 50], short: true },
    { quality: 0.75, gpuTimes: [54, 55, 56], short: true },
    { quality: 0.6, gpuTimes: Array(3).fill(1000 / 30), short: false },
    { quality: 0.6, gpuTimes: Array(3).fill(1000 / 30 + 0.01), short: true },
    { quality: 1, gpuTimes: [1000, 8, 9], short: false },
    { quality: 1, gpuTimes: [8, 9, 1000], short: false },
    { quality: 1, gpuTimes: [1000, 8, 9, 110, 120, 115], short: true },
    { quality: 0.6, gpuTimes: [], frameInterval: 50, short: true },
    { quality: 0.7, gpuTimes: [], measured: false, frameInterval: 1000 / 15, short: true },
  ];
  for (const { short, ...timing } of cases) {
    const page = browser({ timing: { measured: true, frameInterval: 1000 / 60, gpuPending: null, ...timing } });
    page.reveal();
    page.advance(480);
    if (short) assertShort(page);
    else {
      assert.equal(page.moving(), true, JSON.stringify(timing));
      page.advance(1500);
      assertSettled(page);
    }
  }
});

test('sparse or unfinished GPU work cannot slip past the decision deadline', () => {
  const cases = [
    { gpuTimes: [], gpuPending: null },
    { gpuTimes: [], gpuPending: 400 },
    { gpuTimes: [8], gpuPending: null },
    { gpuTimes: [8, 8], gpuPending: 0 },
    { gpuTimes: [130, 140], gpuPending: 120 },
  ];
  for (const timing of cases) {
    const page = browser({ timing: { measured: true, quality: 1, frameInterval: 1000 / 60, ...timing } });
    page.reveal();
    page.advance(460);
    assertShort(page);
  }
  const pending = browser({ timing: time => ({ measured: true, quality: 1, frameInterval: 1000 / 60,
    gpuTimes: time >= 280 ? [130, 140] : [], gpuPending: time >= 400 ? 120 : 0 }) });
  pending.reveal();
  pending.advance(400);
  assertShort(pending);
  assert.equal(pending.now, 400, 'two completed slow frames and the next busy fence prove overload early');

  const delayed = browser({ timing: { measured: true, quality: 1, frameInterval: 1000 / 60, gpuTimes: [], gpuPending: null } });
  delayed.reveal();
  delayed.advance(700, { frames: false });
  assert.equal(delayed.amount(), 1);
  delayed.advance(16);
  assertShort(delayed);
});

test('draining the adaptive timing window does not lose measured fast frames', () => {
  const page = browser({ timing: time => ({ measured: true, quality: 1, frameInterval: 1000 / 60,
    gpuTimes: time >= 96 && time < 440 ? [8, 9, 8] : [], gpuPending: null }) });
  page.reveal();
  page.advance(480);
  assert.equal(page.moving(), true, 'the renderer may clear its eight-frame batch just before the deadline');
  page.advance(1500);
  assertSettled(page);
});

test('older and unmeasured scenes retain their entrance without inventing GPU timings', () => {
  for (const timing of [null, { measured: false, quality: 1, frameInterval: 1000 / 30, gpuTimes: [], gpuPending: null }]) {
    const page = browser({ timing });
    page.reveal();
    page.advance(480);
    assert.equal(page.moving(), true);
    page.advance(1500);
    assertSettled(page);
  }
  const cached = browser();
  delete cached.scene.introPerformance;
  cached.reveal();
  cached.advance(2000);
  assertSettled(cached);
});

test('GPU pressure after the first moving frame cannot jump the camera home', () => {
  const page = browser();
  page.reveal();
  page.advance(480);
  assert.equal(page.moving(), true);
  const amount = page.amount();
  page.scene.introPerformance = () => { throw new Error('timing must no longer be read'); };
  page.advance(120);
  assert.ok(page.amount() < amount && page.amount() > 0);
  page.advance(1400);
  assertSettled(page);
  assert.deepEqual(page.warnings, []);
});

test('?intro=full and ?intro=slow force a slow GPU through the full entrance, while short stays short', () => {
  const timing = { measured: true, quality: 0.6, frameInterval: 1000 / 15, gpuTimes: [100, 110, 120], gpuPending: 90 };
  for (const [search, multiplier] of [['?intro=full', 1], ['?intro=slow', 5]]) {
    const page = browser({ search, timing });
    page.reveal();
    page.advance(480 * multiplier);
    assert.equal(page.moving(), true, search);
    assert.equal(page.storage.get('gudu-intro'), 'seen');
    assert.deepEqual(page.scene.performanceReads, [], 'the testing overrides bypass the gate entirely');
    page.advance(1500 * multiplier);
    assertSettled(page);
  }
  const page = browser({ search: '?intro=short', timing });
  page.reveal();
  page.advance(2000);
  assert.deepEqual(page.scene.calls, []);
  assert.deepEqual(page.scene.performanceReads, []);
  assert.equal(page.storage.has('gudu-intro'), false);
  assertNoWork(page);
});

test('a slow first visit can retry the full entrance when the next load is faster', () => {
  const first = browser({ timing: { measured: true, quality: 0.6, frameInterval: 50, gpuTimes: [], gpuPending: null } });
  first.reveal();
  assertShort(first);
  const next = browser({ seen: first.storage.has('gudu-intro'), navigation: 'reload' });
  next.reveal();
  next.advance(480);
  assert.equal(next.moving(), true);
  next.advance(1500);
  assertSettled(next);
});

test('a timing or layout error releases every entrance resource', () => {
  for (const at of [0, 200]) {
    const page = browser();
    if (at) { page.reveal(); page.advance(at); }
    page.scene.introPerformance = () => { throw new Error('timing unavailable'); };
    if (at) page.advance(16); else page.reveal();
    assertSettled(page, at ? 1 : 0);
    assert.equal(page.warnings.length, 1);
    assert.equal(page.storage.has('gudu-intro'), false);
  }
  for (const at of [0, 200]) {
    const page = browser();
    if (at) { page.reveal(); page.advance(at); }
    page.scene.introView = () => { throw new Error('layout unavailable'); };
    if (at) page.input('resize'); else page.reveal();
    assertSettled(page);
    assert.equal(page.warnings.length, 1);
  }
});
