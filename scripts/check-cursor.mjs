import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/cursor.js', import.meta.url), 'utf8');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of [...(listeners.get(event.type) || [])]) callback.call(this, event);
    },
  };
}

// The controller asks a few questions with closest(), matches() and
// querySelector(); each fixture element declares the ones it answers.
const roles = {
  '.header-search': 'search', '.site-header': 'header', '.chapter-progress': 'progress', '.chapter-progress-rail': 'axis',
  '.chapter-progress-marker': 'marker', '[data-chapter-link]': 'station', '.chapter-station-title': 'title',
};
const role = selector => roles[selector] || (selector.includes('textarea') ? 'editable'
  : selector.includes('a[href]') ? 'clickable' : assert.fail(`unmodeled selector: ${selector}`));

function browser({ fine = true, reduced = false } = {}) {
  let now = 0;
  let sequence = 0;
  let layoutReads = 0;
  let hitTests = 0;
  const frames = new Map();
  const timers = new Map();

  class Element {
    constructor({ roles = [], rect = null } = {}) {
      Object.assign(this, eventTarget());
      this.nodeType = 1;
      this.roles = new Set(roles);
      this.rect = rect;
      this.parentElement = null;
      this.children = [];
      this.isConnected = true;
      this.className = '';
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; },
        contains: name => classes.has(name),
      };
      const styles = new Map();
      this.style = { setProperty: (name, value) => styles.set(name, value), getPropertyValue: name => styles.get(name) || '' };
      this.attributes = new Map();
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    append(...children) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    }
    matches(selector) { return this.roles.has(role(selector)); }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelector(selector) { return this.children.find(child => child.matches(selector)) || null; }
    getBoundingClientRect() {
      layoutReads++;
      const { left = 0, top = 0, width = 0, height = 0 } = this.rect || {};
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
  }

  const html = new Element();
  const body = new Element();
  let pointTarget = null;
  const document = eventTarget({
    documentElement: html,
    body,
    hidden: false,
    createElement: () => new Element(),
    elementFromPoint: () => { hitTests++; return pointTarget; },
  });
  const window = eventTarget();
  const finePointer = eventTarget({ matches: fine });
  const motion = eventTarget({ matches: reduced });
  runInNewContext(source, {
    document,
    performance: { now: () => now },
    matchMedia: query => query === '(hover: hover) and (pointer: fine)' ? finePointer
      : query === '(prefers-reduced-motion: reduce)' ? motion
        : assert.fail(`unmodeled media query: ${query}`),
    requestAnimationFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (...args) => window.addEventListener(...args),
  }, { timeout: 1000 });

  const layer = body.children[0];
  const [topLeft, topRight, bottomLeft, bottomRight, dot] = layer.children;
  const plain = new Element();
  const card = new Element({ roles: ['clickable'], rect: { left: 100, top: 200, width: 160, height: 40 } });
  const inside = new Element();
  card.append(inside);
  const station = new Element({ roles: ['clickable', 'station'], rect: { left: 380, top: 680, width: 320, height: 86 } });
  const title = new Element({ roles: ['title'], rect: { left: 400, top: 700, width: 32, height: 23 } });
  station.append(title);
  const progress = new Element({ roles: ['progress'] });
  const track = new Element({ rect: { left: 79, top: 844, width: 1282, height: 1 } });
  const axis = new Element({ roles: ['axis'] });
  const marker = new Element({ roles: ['clickable', 'marker'], rect: { left: 238, top: 840, width: 2, height: 10 } });
  const handle = new Element();
  progress.append(track, station);
  track.append(axis, marker);
  marker.append(handle);
  const header = new Element({ roles: ['header'] });
  const search = new Element({ roles: ['search'], rect: { left: 975, top: 13, width: 300, height: 44 } });
  const searchButton = new Element({ roles: ['clickable'] });
  const searchInput = new Element({ roles: ['editable'] });
  header.append(search);
  search.append(searchInput, searchButton);
  const field = new Element({ roles: ['editable'], rect: { left: 40, top: 500, width: 200, height: 30 } });

  const fire = (type, properties = {}) => window.dispatchEvent({ type, ...properties });
  const point = element => {
    const match = element.style.getPropertyValue('transform').match(/^translate3d\((-?\d+)px, (-?\d+)px, 0\)$/);
    assert.ok(match, `unexpected transform: ${element.style.getPropertyValue('transform')}`);
    return match.slice(1).map(Number);
  };
  return {
    html, layer, dot, plain, card, inside, station, progress, track, axis, marker, handle, search, searchButton, searchInput, field, finePointer, document,
    fire,
    move(target, clientX, clientY, properties = {}) { fire('pointermove', { pointerType: 'mouse', target, clientX, clientY, buttons: 0, ...properties }); },
    advance(duration) {
      const until = now + duration;
      while (now < until) {
        now = Math.min(until, now + 16);
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) { timers.delete(id); timer.callback(); }
        }
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(now);
      }
    },
    corners: () => [topLeft, topRight, bottomLeft, bottomRight].map(point),
    point,
    arm: () => layer.style.getPropertyValue('--site-cursor-arm'),
    has: name => layer.classList.contains(name),
    set pointTarget(element) { pointTarget = element; },
    get layoutReads() { return layoutReads; },
    get hitTests() { return hitTests; },
    get pendingFrames() { return frames.size; },
  };
}

await test('the system cursor stays until the first mouse move, then a frame appears around the pointer', () => {
  const site = browser();
  assert.equal(site.layer.attributes.get('aria-hidden'), 'true');
  assert.equal(site.html.classList.contains('has-site-cursor'), false);
  assert.equal(site.has('is-visible'), false);
  site.move(site.plain, 300, 400);
  assert.equal(site.html.classList.contains('has-site-cursor'), true);
  assert.equal(site.has('is-visible'), true);
  site.advance(16);
  assert.deepEqual(site.corners(), [[291, 391], [309, 391], [291, 409], [309, 409]], 'the first frame appears in place');
  assert.deepEqual(site.point(site.dot), [299, 399]);
  assert.equal(site.arm(), '5px');
});

await test('the frame trails the point and stops requesting frames once settled, while reduced motion snaps', () => {
  const site = browser();
  site.move(site.plain, 300, 400);
  site.advance(16);
  site.move(site.plain, 340, 400);
  site.advance(16);
  const [[left]] = site.corners();
  assert.ok(left > 291 && left < 331, 'one frame later the frame is still on its way');
  assert.deepEqual(site.point(site.dot), [339, 399], 'the point itself never lags');
  site.advance(400);
  assert.deepEqual(site.corners()[0], [331, 391]);
  assert.equal(site.pendingFrames, 0, 'a settled frame requests no more animation frames');

  const reduced = browser({ reduced: true });
  reduced.move(reduced.plain, 300, 400);
  reduced.advance(16);
  reduced.move(reduced.plain, 340, 400);
  reduced.advance(16);
  assert.deepEqual(reduced.corners()[0], [331, 391]);
  assert.equal(reduced.pendingFrames, 0);
});

await test('links and cards lock the frame onto their edges with an orange point, then release it', () => {
  const site = browser();
  site.move(site.inside, 150, 210);
  assert.equal(site.has('is-locked'), true, 'a child of a link locks onto the link itself');
  site.advance(600);
  assert.deepEqual(site.corners(), [[95, 195], [265, 195], [95, 245], [265, 245]], 'the frame sits 5px outside the target');
  assert.equal(site.arm(), '7px', 'arms scale with the shorter side of the target');
  site.move(site.plain, 600, 600);
  site.advance(600);
  assert.equal(site.has('is-locked'), false);
  assert.deepEqual(site.corners()[0], [591, 591]);
  assert.equal(site.arm(), '5px');
});

await test('a ruler station frames its whole segment of the ruler', () => {
  const site = browser();
  site.move(site.station, 600, 760);
  site.advance(600);
  assert.deepEqual(site.corners(), [[375, 675], [705, 675], [375, 771], [705, 771]], 'the frame holds the cell from its stem to the next one');
  assert.equal(site.arm(), '12px');
  assert.equal(site.has('is-locked'), true);
});

await test('the header search is framed as one control, and its field keeps the frame around the text cursor', () => {
  const site = browser();
  site.move(site.searchButton, 1250, 35);
  site.advance(600);
  assert.equal(site.has('is-locked'), true, 'the icon locks with the orange point');
  assert.deepEqual(site.corners(), [[970, 8], [1280, 8], [970, 62], [1280, 62]], 'the frame holds the whole search box, not just its icon');
  site.search.rect = { left: 1225, top: 13, width: 50, height: 44 };
  site.move(site.searchButton, 1250, 36);
  site.advance(600);
  assert.deepEqual(site.corners()[0], [1220, 8], 'the frame follows the box while it opens and closes');
  site.search.rect = { left: 975, top: 13, width: 300, height: 44 };
  site.advance(600);
  assert.deepEqual(site.corners()[0], [1220, 8], 'after the refresh window a still mouse reads no more layout');
  site.document.dispatchEvent({ type: 'transitionend', target: site.search });
  site.advance(1000);
  assert.deepEqual(site.corners()[0], [970, 8], 'the end of the opening transition is read once more');
  site.move(site.searchInput, 1100, 35);
  site.advance(600);
  assert.deepEqual([site.has('is-field'), site.has('is-locked'), site.has('is-visible')], [true, false, true], 'the field shows the text cursor inside the same frame');
  assert.deepEqual(site.corners()[0], [970, 8]);
  site.move(site.field, 100, 515);
  site.advance(1000);
  assert.equal(site.has('is-field'), true);
  assert.deepEqual(site.corners()[0], [35, 495], 'any other text field is framed by itself');
  site.move(site.plain, 600, 300);
  assert.equal(site.has('is-field'), false);
});

await test('the ruler axis turns the frame into a caliper on its landing hairline, and the ruler cursor is held without lag', () => {
  const site = browser();
  site.track.style.setProperty('--chapter-hover-x', '641px');
  site.move(site.axis, 716, 846);
  site.advance(16);
  assert.equal(site.has('is-axis'), true);
  assert.deepEqual(site.corners(), [[715, 835], [725, 835], [715, 855], [725, 855]], 'a 10px caliper sits on the hairline, which may be settled away from the mouse');
  assert.equal(site.arm(), '4px');
  site.track.style.setProperty('--chapter-hover-x', '700px');
  site.move(site.axis, 779, 846);
  site.advance(16);
  assert.deepEqual(site.corners()[0], [774, 835], 'the caliper follows the hairline in the same frame');
  site.move(site.plain, 500, 600);
  site.track.style.setProperty('--chapter-hover-x', '');
  site.move(site.axis, 500, 846);
  site.advance(16);
  assert.deepEqual(site.corners()[0], [495, 835], 'entering without a preview, the caliper marks the mouse on the axis');

  site.move(site.handle, 239, 842);
  site.advance(16);
  assert.deepEqual([site.has('is-grip'), site.has('is-axis')], [true, false]);
  assert.deepEqual(site.corners(), [[230, 832], [249, 832], [230, 854], [249, 854]], 'the frame clears the triangle above the 2px stem');
  site.marker.rect = { left: 300, top: 840, width: 2, height: 10 };
  site.move(site.marker, 301, 842);
  site.advance(16);
  assert.deepEqual(site.corners()[0], [292, 832], 'a dragged cursor is held in the same frame without easing');

  // During a drag chapters.js moves the cursor in its own frames, after the pointer event.
  site.progress.classList.add('is-scrubbing');
  site.move(site.marker, 361, 842);
  site.advance(1000);
  site.marker.rect = { left: 360, top: 840, width: 2, height: 10 };
  site.advance(16);
  assert.deepEqual(site.corners()[0], [352, 832], 'a held grip keeps following the dragged cursor');
  site.progress.classList.remove('is-scrubbing');
  site.advance(1000);
  site.marker.rect = { left: 420, top: 840, width: 2, height: 10 };
  site.advance(16);
  assert.deepEqual(site.corners()[0], [352, 832], 'after the drag the grip stops reading layout');
});

await test('pressing and dragging the ruler never makes the frame flicker between states', () => {
  const site = browser();
  const state = () => ['is-axis', 'is-grip', 'is-locked'].filter(site.has).join() || 'point';
  site.track.style.setProperty('--chapter-hover-x', '641px');
  site.move(site.axis, 716, 846);
  site.advance(16);
  site.fire('pointerdown', { pointerType: 'mouse', button: 0 });
  site.track.style.setProperty('--chapter-hover-x', '');
  const seen = new Set();
  for (let tick = 0; tick < 8; tick++) {
    // While pressed, the captured pointer reports the distant ruler cursor as its target.
    site.move(site.handle, 717 + tick % 2, 846);
    site.fire('scroll');
    site.advance(16);
    seen.add(state());
  }
  assert.deepEqual([...seen], ['is-axis'], 'a click on the axis neither jumps to the ruler cursor nor drops to the point');
  assert.deepEqual(site.corners()[0], [715, 838], 'the pressed caliper keeps the landing point its press started on');

  site.progress.classList.add('is-scrubbing');
  for (let tick = 0; tick < 8; tick++) {
    site.marker.rect = { left: 760 + tick * 10, top: 840, width: 2, height: 10 };
    site.move(site.handle, 761 + tick * 10, 846);
    site.fire('scroll');
    site.advance(16);
    seen.add(state());
  }
  assert.deepEqual([...seen], ['is-axis', 'is-grip'], 'dragging switches to the grip once and keeps it through the scrolling it causes');
  assert.deepEqual(site.corners()[0], [825, 835], 'the pressed grip sits on the dragged cursor');
  site.progress.classList.remove('is-scrubbing');
  site.fire('pointerup', { pointerType: 'mouse', button: 0 });
  site.pointTarget = site.handle;
  site.advance(200);
  assert.equal(state(), 'is-grip', 'after release the cursor under the mouse keeps its grip');

  const click = browser();
  click.track.style.setProperty('--chapter-hover-x', '641px');
  click.move(click.axis, 716, 846);
  click.advance(16);
  click.fire('pointerdown', { pointerType: 'mouse', button: 0 });
  click.track.style.setProperty('--chapter-hover-x', '');
  click.fire('pointerup', { pointerType: 'mouse', button: 0 });
  for (let tick = 0; tick < 20; tick++) {
    click.fire('scroll');
    click.advance(16);
  }
  assert.equal(click.has('is-axis'), true, 'the click keeps its caliper while it eases the strip');
  assert.deepEqual(click.corners()[0], [715, 835], 'and the caliper waits on the landing point instead of jumping to the mouse');
});

await test('the fixed ruler keeps its station framed while the strip scrolls, but a ruler cursor that scrolls away is released', () => {
  const site = browser();
  site.move(site.station, 600, 760);
  site.advance(600);
  site.fire('scroll');
  site.advance(16);
  assert.equal(site.has('is-locked'), true);
  site.move(site.handle, 239, 842);
  site.advance(16);
  assert.equal(site.has('is-grip'), true);
  site.fire('scroll');
  site.advance(16);
  assert.equal(site.has('is-grip'), false);
});

await test('pressing contracts the frame by 3px and releasing restores it', () => {
  const site = browser();
  site.move(site.plain, 300, 400);
  site.advance(16);
  site.fire('pointerdown', { pointerType: 'mouse', button: 0 });
  assert.equal(site.has('is-pressed'), true);
  site.advance(400);
  assert.deepEqual(site.corners()[0], [294, 394]);
  site.fire('pointerup', { pointerType: 'mouse', button: 0 });
  assert.equal(site.has('is-pressed'), false);
  site.advance(400);
  assert.deepEqual(site.corners()[0], [291, 391]);
  site.fire('pointerdown', { pointerType: 'mouse', button: 2 });
  assert.equal(site.has('is-pressed'), false, 'only the primary button presses the frame');
  site.move(site.inside, 150, 210);
  site.fire('pointerdown', { pointerType: 'mouse', button: 0 });
  site.advance(600);
  assert.deepEqual(site.corners()[0], [98, 198], 'a locked frame also tightens around its target');
  site.fire('pointercancel');
  assert.equal(site.has('is-pressed'), false);
});

await test('a locked frame follows its moving target briefly after movement, then reads no more layout', () => {
  const site = browser();
  site.move(site.inside, 150, 210);
  site.advance(1000);
  const reads = site.layoutReads;
  site.advance(2000);
  assert.equal(site.layoutReads, reads, 'a still mouse on a still target reads no layout');
  assert.equal(site.pendingFrames, 0, 'and requests no frames');
  site.move(site.inside, 151, 210);
  site.card.rect = { left: 104, top: 202, width: 160, height: 40 };
  site.advance(400);
  assert.deepEqual(site.corners()[0], [99, 197], 'the frame follows the parallax that a mouse move starts');
  site.advance(600);
  const settled = site.layoutReads;
  site.card.rect = { left: 140, top: 202, width: 160, height: 40 };
  site.advance(600);
  assert.equal(site.layoutReads, settled, 'refreshing ends with the settling window');
});

await test('scrolling releases the lock without reading layout, then hit-tests once the page rests', () => {
  const site = browser();
  site.move(site.inside, 150, 210);
  site.advance(1000);
  const reads = site.layoutReads;
  site.pointTarget = site.plain;
  for (let tick = 0; tick < 10; tick++) {
    site.fire('scroll');
    site.advance(16);
  }
  assert.equal(site.has('is-locked'), false, 'moving content releases the lock');
  assert.equal(site.layoutReads, reads, 'no layout reads while the page moves');
  assert.equal(site.hitTests, 0, 'no hit tests while the page moves');
  site.pointTarget = site.inside;
  site.advance(200);
  assert.equal(site.hitTests, 1, 'one hit test once the page has rested');
  assert.equal(site.has('is-locked'), true, 'a card that arrived under the mouse locks the frame');
  site.advance(600);
  assert.deepEqual(site.corners()[0], [95, 195]);

  site.move(site.searchInput, 1100, 35);
  site.fire('scroll');
  site.advance(16);
  assert.equal(site.has('is-field'), true, 'the fixed header search keeps its lock while the page scrolls');
});

await test('leaving the window, blurring or hiding the page hides the frame, which returns in place', () => {
  const site = browser();
  site.move(site.plain, 300, 400);
  site.advance(16);
  site.document.dispatchEvent({ type: 'pointerout', relatedTarget: site.card });
  assert.equal(site.has('is-visible'), true, 'moving between elements keeps the frame');
  site.document.dispatchEvent({ type: 'pointerout', relatedTarget: null });
  assert.equal(site.has('is-visible'), false);
  assert.equal(site.pendingFrames, 0);
  site.move(site.plain, 800, 500);
  site.advance(16);
  assert.deepEqual(site.corners()[0], [791, 491], 'returning does not slide in from the old spot');
  site.fire('blur');
  assert.equal(site.has('is-visible'), false);
  site.move(site.plain, 800, 500);
  site.document.hidden = true;
  site.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(site.has('is-visible'), false);
  assert.equal(site.html.classList.contains('has-site-cursor'), true, 'a hidden frame keeps the system cursor hidden for the mouse');
});

await test('touch, pen and coarse pointers keep or restore the system cursor', () => {
  const coarse = browser({ fine: false });
  coarse.move(coarse.plain, 300, 400);
  assert.deepEqual([coarse.html.classList.contains('has-site-cursor'), coarse.has('is-visible')], [false, false]);

  const site = browser();
  site.move(site.plain, 300, 400);
  assert.equal(site.html.classList.contains('has-site-cursor'), true);
  site.move(site.plain, 300, 400, { pointerType: 'pen' });
  assert.deepEqual([site.html.classList.contains('has-site-cursor'), site.has('is-visible')], [false, false], 'a pen gets the system cursor back');
  site.move(site.plain, 300, 400);
  assert.equal(site.html.classList.contains('has-site-cursor'), true, 'the mouse brings the frame back');
  site.finePointer.matches = false;
  site.finePointer.dispatchEvent({ type: 'change' });
  assert.deepEqual([site.html.classList.contains('has-site-cursor'), site.has('is-visible')], [false, false]);
});
