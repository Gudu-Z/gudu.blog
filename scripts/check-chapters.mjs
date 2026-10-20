import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/chapters.js', import.meta.url), 'utf8');

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
      for (const callback of [...(listeners.get(event.type) || [])]) callback(event);
      return !event.defaultPrevented;
    },
  };
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: name => values.has(name),
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    toggle(name, force = !values.has(name)) {
      if (force) values.add(name);
      else values.delete(name);
      return force;
    },
  };
}

// Only browser surfaces used by the chapter controller are modeled. The real
// controller executes unmodified; assertions inspect scrolls, URLs and events.
function browser({ reduced = false, url = 'https://gudu.blog/', loading = false, hidden = false, viewportWidth = 1200, roundScroll = false, initialPanelWidth = null } = {}) {
  let now = 0;
  let sequence = 0;
  let scrollY = 0;
  let location = new URL(url);
  const frames = new Map();
  const timers = new Map();
  const scrolls = [];
  const innerScrolls = [];
  const chapterEvents = [];
  const historyEntries = [];
  const resizeObservers = [];
  let layoutReads = 0;
  const nodes = [];
  const height = 800;
  let document;
  let window;
  let panelWidthOverride = initialPanelWidth;
  const viewWidth = () => window?.innerWidth ?? viewportWidth;
  const panelWidth = () => panelWidthOverride ?? Number((viewWidth() <= 720 ? viewWidth() * 0.88 : Math.min(1200, viewWidth() * 0.82)).toFixed(4));
  const panelGap = () => viewWidth() <= 720 ? 20 : 32;
  const panelStep = () => panelWidth() + panelGap();

  class Element {
    constructor(tag = 'div', options = {}) {
      Object.assign(this, eventTarget());
      this.tagName = tag.toUpperCase();
      this.id = options.id || '';
      this.classList = classList(options.classes || []);
      this.dataset = options.dataset || {};
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.disabled = false;
      this.inert = false;
      this.isContentEditable = false;
      this.textContent = '';
      this.top = options.top || 0;
      this.chapterIndex = options.chapterIndex;
      this.offsetHeight = options.height || 0;
      this.scrollHeight = this.offsetHeight;
      this.clientHeight = this.offsetHeight;
      this.scrollTop = 0;
      this.style = {
        values: new Map(),
        setProperty(name, value) { this.values.set(name, String(value)); },
        getPropertyValue(name) { return this.values.get(name) || ''; },
        removeProperty(name) { this.values.delete(name); },
      };
      nodes.push(this);
    }
    get offsetTop() { return this.top; }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) {
      if (value) this.setAttribute('hidden', '');
      else this.removeAttribute('hidden');
    }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) {
      if (value) this.setAttribute('disabled', '');
      else this.removeAttribute('disabled');
    }
    get offsetLeft() {
      layoutReads++;
      return this.chapterIndex === undefined ? 0 : (viewWidth() - panelWidth()) / 2 + this.chapterIndex * panelStep();
    }
    get offsetWidth() { layoutReads++; return this.chapterIndex === undefined ? viewWidth() : panelWidth(); }
    get href() { return new URL(this.getAttribute('href') || '', location).href; }
    set href(value) { this.setAttribute('href', value); }
    get hash() { return new URL(this.href).hash; }
    getBoundingClientRect() {
      layoutReads++;
      const top = this.chapterIndex === undefined ? this.top - scrollY : Math.max(0, height - scrollY);
      const translation = parseFloat(html.style.getPropertyValue('--chapter-x')) || 0;
      const left = this.chapterIndex === undefined ? 0 : this.offsetLeft + translation;
      return { top, bottom: top + this.offsetHeight, left, right: left + this.offsetWidth, width: this.offsetWidth, height: this.offsetHeight };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some(part => {
        const match = part.trim();
        if (match === '*') return true;
        if (match.startsWith('#')) return this.id === match.slice(1);
        if (match.startsWith('.')) return this.classList.contains(match.slice(1));
        const attribute = match.match(/^(a|button)?\[([a-z-]+)(?:([~^$*|]?=)["']?([^"'\]]*)["']?)?\]$/i);
        if (attribute) {
          if (attribute[1] && this.tagName !== attribute[1].toUpperCase()) return false;
          const [, , name, operator, value] = attribute;
          const actual = name.startsWith('data-')
            ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
            : this.getAttribute(name);
          if (actual === undefined || actual === null) return false;
          if (!operator) return true;
          if (operator === '^=') return String(actual).startsWith(value);
          return String(actual) === value;
        }
        return this.tagName.toLowerCase() === match.toLowerCase();
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) { return nodes.filter(node => node !== this && this.contains(node) && node.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    scrollIntoView() { window.scrollTo({ top: this.top, behavior: 'instant' }); }
    scrollBy(options) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop + options.top, this.scrollHeight - this.clientHeight));
      innerScrolls.push({ id: this.id, top: this.scrollTop, behavior: options.behavior });
    }
  }

  const html = new Element('html', { classes: loading ? ['is-loading'] : [] });
  const body = new Element('body', { classes: ['home-page'] });
  const main = new Element('main');
  const hero = new Element('section', { id: 'home', classes: ['hero'], top: 0, height });
  const runway = new Element('div', { id: 'chapter-scroll', top: height });
  const viewport = new Element('div', { id: 'chapter-viewport', top: height, height });
  const track = new Element('div', { id: 'chapter-track', top: height, height });
  const about = new Element('section', { id: 'about', classes: ['chapter-section'], top: height, height, chapterIndex: 0 });
  const series = new Element('section', { id: 'series', classes: ['chapter-section'], top: height, height, chapterIndex: 1 });
  const journal = new Element('section', { id: 'journal', classes: ['chapter-section'], top: height, height, chapterIndex: 2 });
  const archive = new Element('section', { id: 'archive', classes: ['chapter-section'], top: height, height, chapterIndex: 3 });
  journal.scrollHeight = height * 2;
  const stage = new Element('div', { id: 'hero-stage' });
  const blackHole = new Element('figure', { id: 'black-hole', height: 600 });
  const header = new Element('header', { classes: ['site-header'] });
  const progress = new Element('nav', { id: 'chapter-progress', classes: ['chapter-progress'] });
  const progressTrack = new Element('div', { classes: ['chapter-progress-track'] });
  const progressFill = new Element('span', { id: 'chapter-progress-fill', classes: ['chapter-progress-fill'] });
  const progressMarker = new Element('span', { classes: ['chapter-progress-marker'] });
  const progressLinks = new Element('div', { classes: ['chapter-progress-links'] });
  const progressCurrent = new Element('span', { id: 'chapter-current', dataset: { chapterCurrent: '' } });
  const heroHeading = new Element('div', { classes: ['hero-heading'] });
  const searchForm = new Element('form', { id: 'post-search' });
  const input = new Element('input', { id: 'search-input' });
  const chapters = [hero, about, series, journal, archive];
  const navLinks = chapters.slice(1).map(chapter => {
    const link = new Element('a', { dataset: { chapterLink: '' } });
    link.href = `#${chapter.id}`;
    return link;
  });
  html.append(body);
  body.append(header, main, progress);
  header.append(searchForm);
  searchForm.append(input);
  progressLinks.append(...navLinks);
  main.append(hero, runway);
  runway.append(viewport);
  viewport.append(track);
  track.append(about, series, journal, archive);
  hero.append(stage);
  stage.append(heroHeading, blackHole);
  progress.append(progressTrack, progressLinks, progressCurrent);
  progressTrack.append(progressFill, progressMarker);
  Object.defineProperty(html, 'scrollHeight', { get: () => height + (parseFloat(runway.style.height) || height) });
  html.clientHeight = body.clientHeight = height;

  const media = eventTarget({ matches: reduced });
  document = eventTarget({
    documentElement: html,
    body,
    activeElement: body,
    hidden,
    readyState: 'complete',
    querySelector: selector => html.querySelector(selector),
    querySelectorAll: selector => html.querySelectorAll(selector),
    getElementById: id => nodes.find(node => node.id === id) || null,
  });
  const requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
  const cancelAnimationFrame = id => frames.delete(id);
  const setTimeout = (callback, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; };
  const clearTimeout = id => timers.delete(id);
  const history = {
    scrollRestoration: 'auto',
    pushState(_state, _title, href) { location = new URL(href, location); historyEntries.push(location.href); },
    replaceState(_state, _title, href) { location = new URL(href, location); historyEntries.push(location.href); },
  };
  window = eventTarget({
    innerWidth: viewportWidth,
    innerHeight: height,
    history,
    matchMedia: () => media,
    requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout,
    scrollTo(options, y) {
      const requested = typeof options === 'number' ? y : options.top;
      scrollY = Math.max(0, Math.min(roundScroll ? Math.round(requested) : requested, html.scrollHeight - window.innerHeight));
      html.scrollTop = body.scrollTop = scrollY;
      scrolls.push({ top: scrollY, at: now });
      window.dispatchEvent({ type: 'scroll' });
    },
  });
  Object.defineProperties(window, {
    location: { get: () => location },
    scrollY: { get: () => scrollY },
    pageYOffset: { get: () => scrollY },
  });
  window.addEventListener('site:chapter', event => chapterEvents.push(event.detail));
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const getComputedStyle = node => ({
    scrollPaddingTop: '0px',
    scrollMarginTop: '0px',
    overflowY: node.overflowY || 'visible',
    getPropertyValue: name => node.style.getPropertyValue(name),
  });
  window.getComputedStyle = getComputedStyle;
  runInNewContext(source, {
    window, document, console, URL, Element, HTMLElement: Element, CustomEvent,
    location, history, performance: { now: () => now },
    matchMedia: () => media, getComputedStyle,
    requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    },
    IntersectionObserver: class { observe() {} disconnect() {} },
  }, { timeout: 1000 });

  function dispatch(type, properties = {}) {
    const event = {
      type, target: body, cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...properties,
    };
    document.dispatchEvent(event);
    window.dispatchEvent(event);
    return event;
  }
  function advance(duration, step = 16) {
    const until = now + duration;
    let iterations = 0;
    while (now < until) {
      now = Math.min(until, now + step);
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
      assert.ok(++iterations < 5000, 'animation must finish within the bounded test clock');
    }
  }
  advance(32);
  return {
    html, body, window, document, chapters, about, journal, series, archive, navLinks, searchForm, input, media, header, progress, progressCurrent,
    runway, viewport, track, progressMarker, heroHeading, scrolls, innerScrolls, chapterEvents, historyEntries,
    get top() { return scrollY; },
    get step() { return panelStep(); },
    destination(id) { return id === 'home' ? 0 : height + chapters.find(chapter => chapter.id === id).chapterIndex * panelStep(); },
    get x() { return parseFloat(html.style.getPropertyValue('--chapter-x')); },
    get url() { return location; },
    get pendingFrames() { return frames.size; },
    get pendingTimers() { return timers.size; },
    get layoutReads() { return layoutReads; },
    get observedTargets() { return resizeObservers.reduce((count, observer) => count + observer.targets.size, 0); },
    queuedFrames() { return [...frames.values()]; },
    lateResize() { for (const observer of resizeObservers) observer.callback(); },
    wheel(deltaY = 80, properties = {}) { return dispatch('wheel', { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, ...properties }); },
    key(key, properties = {}) { return dispatch('keydown', { key, code: key === ' ' ? 'Space' : key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...properties }); },
    click(link) { return dispatch('click', { target: link, button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }); },
    event: dispatch,
    advance,
    jump(top) { window.scrollTo({ top, behavior: 'instant' }); advance(32); },
    link(href) { const link = new Element('a'); link.href = href; body.append(link); return link; },
    form(id) { const form = new Element('form', { id }); body.append(form); return form; },
    hash(hash) { location.hash = hash; dispatch('hashchange'); },
    restore(href, restoredTop) {
      const previousHash = location.hash;
      location = new URL(href, location);
      dispatch('popstate');
      window.scrollTo({ top: restoredTop, behavior: 'instant' });
      if (previousHash !== location.hash) dispatch('hashchange');
      advance(32);
    },
    growJournal(extraHeight) {
      journal.scrollHeight += extraHeight;
      for (const observer of resizeObservers) observer.callback();
    },
    resizeWidth(value) { window.innerWidth = value; dispatch('resize'); advance(32); },
    settlePanelWidth(value = null) {
      panelWidthOverride = value;
      for (const observer of resizeObservers) {
        if (observer.targets.has(about)) observer.callback([{ target: about }]);
      }
      advance(32);
    },
  };
}

await test('only the opening wheel snaps to About and its momentum tail cannot skip the introduction', () => {
  const site = browser();
  assert.equal(site.html.classList.contains('has-chapters'), true);
  assert.equal(site.wheel(60).defaultPrevented, true);
  for (let tick = 0; tick < 16; tick++) {
    site.advance(70);
    assert.equal(site.wheel(12).defaultPrevented, true);
  }
  site.advance(1000);
  assert.equal(site.top, 800, 'inertial wheel tails must finish at the first content chapter');
  assert.equal(site.html.classList.contains('is-content'), true);
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.equal(site.header.inert, false);
  assert.equal(site.progress.inert, false);
  assert.equal(site.heroHeading.inert, true);
  assert.equal(site.progressCurrent.textContent, '01');
  assert.equal(site.navLinks[0].getAttribute('aria-current'), 'location');
  assert.ok(site.chapterEvents.some(event => event.progress === 1), 'the scene receives its fully transformed state');
  assert.equal(site.x, 0);
  site.wheel(60);
  site.advance(32);
  assert.ok(site.x < 0 && site.x > -60, 'subsequent input begins a damped horizontal movement');
  site.advance(1000);
  assert.equal(site.top, 860, 'the next wheel travels its own distance instead of jumping a chapter');
  assert.equal(site.x, -60);
});

await test('the layered entrance lasts 900ms, pulses only in the middle, and returns in 680ms', () => {
  const site = browser();
  site.wheel(60);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0);
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0);
  site.advance(450);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0.5);
  assert.ok(site.chapterEvents.at(-1).entranceGlow > 0.95);
  assert.ok(Math.abs(Number(site.html.style.getPropertyValue('--chapter-entrance-glow')) - site.chapterEvents.at(-1).entranceGlow) < 0.00001);
  assert.equal(site.progress.classList.contains('is-chapter-moving'), false);
  assert.equal(site.progressMarker.classList.contains('is-arriving'), false, 'the layered entrance does not also flash the ruler');
  site.advance(449);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true, 'the entrance is still running immediately before its deadline');
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0, 'the pulse has faded before the final pose');
  site.advance(1);
  assert.equal(site.top, site.destination('about'));
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0);

  const returnEvents = site.chapterEvents.length;
  site.wheel(-60);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  site.advance(679);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  site.advance(1);
  assert.equal(site.top, 0);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.ok(site.chapterEvents.slice(returnEvents).every(event => event.entranceGlow === 0), 'returning to the hero never emits an entrance pulse');
  assert.ok(site.chapterEvents.every(event => event.entranceGlow >= 0 && event.entranceGlow <= 1));
  site.advance(32);
  assert.equal(site.pendingFrames, 0);
});

await test('entrance glow continues after scene progress reaches one, while content navigation remains 640ms', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space' });
  site.click(site.link('#archive'));
  site.advance(450);
  assert.equal(site.chapterEvents.at(-1).progress, 1);
  const peak = site.chapterEvents.at(-1).entranceGlow;
  const eventCount = site.chapterEvents.length;
  assert.ok(peak > 0.95);
  site.advance(100);
  assert.ok(site.chapterEvents.length > eventCount, 'glow updates are emitted even when scroll-based scene progress remains one');
  assert.equal(site.chapterEvents.at(-1).progress, 1);
  assert.ok(site.chapterEvents.at(-1).entranceGlow < peak);
  site.advance(350);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(site.document.activeElement, site.archive);
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0);
  assert.equal(site.url.searchParams.get('q'), 'space');

  const contentEvents = site.chapterEvents.length;
  site.click(site.navLinks[1]);
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  site.advance(639);
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), true);
  site.advance(1);
  assert.equal(site.top, site.destination('series'));
  assert.equal(site.document.activeElement, site.series);
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.ok(site.chapterEvents.slice(contentEvents).every(event => event.entranceGlow === 0));

  for (const options of [{ url: 'https://gudu.blog/#archive' }, { reduced: true }]) {
    const immediate = browser(options);
    if (options.reduced) immediate.click(immediate.link('#archive'));
    assert.equal(immediate.top, immediate.destination('archive'));
    assert.equal(immediate.html.classList.contains('is-chapter-entering'), false);
    assert.equal(immediate.html.classList.contains('is-chapter-leaving'), false);
    assert.ok(immediate.chapterEvents.every(event => event.entranceGlow === 0), 'hash restoration and reduced motion do not play the layered effect');
  }
});

await test('hash jumps, reduced motion, resize and page lifecycle clear an active entrance pulse', () => {
  for (const interruption of ['hash', 'reduced', 'resize', 'hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/?q=space' });
    site.click(site.link('#archive'));
    site.advance(400);
    assert.ok(site.chapterEvents.at(-1).entranceGlow > 0.8);
    const stoppedAt = site.top;
    const eventCount = site.chapterEvents.length;
    if (interruption === 'hash') site.hash('#series');
    if (interruption === 'reduced') {
      site.media.matches = true;
      site.media.dispatchEvent({ type: 'change' });
    }
    if (interruption === 'resize') site.resizeWidth(600);
    if (interruption === 'hidden') {
      site.document.hidden = true;
      site.event('visibilitychange');
    }
    if (interruption === 'pagehide') site.event('pagehide');
    assert.equal(site.html.classList.contains('is-chapter-entering'), false, interruption);
    assert.equal(site.html.classList.contains('is-chapter-leaving'), false, interruption);
    assert.equal(site.html.classList.contains('is-chapter-transitioning'), false, interruption);
    assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0, interruption);
    assert.equal(Number(site.html.style.getPropertyValue('--chapter-entrance-glow')), 0, interruption);
    assert.equal(site.chapterEvents.at(-1).entranceGlow, 0, `${interruption} notifies the renderer immediately`);
    const destination = interruption === 'pagehide' ? stoppedAt : site.destination(interruption === 'hash' ? 'series' : 'archive');
    assert.equal(site.top, destination, interruption);
    if (['reduced', 'resize', 'hidden'].includes(interruption)) assert.equal(site.document.activeElement, site.archive);
    site.advance(1200);
    assert.equal(site.top, destination);
    assert.equal(site.pendingFrames, 0);
    assert.ok(site.chapterEvents.slice(eventCount).every(event => event.entranceGlow === 0), `${interruption} does not replay the cleared pulse`);
    assert.equal(site.url.searchParams.get('q'), 'space');
  }
});

await test('reversing or retargeting a hero transition preserves the visible phase without replaying its pulse', () => {
  const visualPhase = site => {
    const phase = Number(site.html.style.getPropertyValue('--chapter-transition-phase'));
    return site.html.classList.contains('is-chapter-leaving') ? 1 - phase : phase;
  };
  const site = browser({ url: 'https://gudu.blog/?q=space' });
  site.click(site.link('#about'));
  site.advance(450);
  assert.ok(site.chapterEvents.at(-1).entranceGlow > 0.95);
  const enteringVisual = visualPhase(site);
  const enteringScroll = site.top;
  const reversalEvents = site.chapterEvents.length;
  site.key('Home');
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  assert.equal(visualPhase(site), enteringVisual, 'the return begins at the same visible layer position');
  assert.equal(site.top, enteringScroll, 'reversing does not jump the camera scroll position');
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0);
  site.advance(180);
  const leavingVisual = visualPhase(site);
  const leavingScroll = site.top;
  assert.ok(leavingVisual > 0 && leavingVisual < enteringVisual);
  site.click(site.link('#about'));
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true);
  assert.ok(Math.abs(visualPhase(site) - leavingVisual) < 0.00011, 're-entry preserves the partially hidden layers');
  assert.equal(site.top, leavingScroll);
  site.advance(690);
  assert.equal(site.top, site.destination('about'));
  assert.equal(site.document.activeElement, site.about);
  assert.equal(site.url.hash, '#about');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.ok(site.chapterEvents.slice(reversalEvents).every(event => event.entranceGlow === 0), 'an interrupted entrance never flashes a new pulse at its midpoint');
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  site.advance(32);
  assert.equal(site.pendingFrames, 0);

  const retargeted = browser();
  retargeted.click(retargeted.link('#archive'));
  retargeted.advance(300);
  assert.equal(retargeted.chapterEvents.at(-1).progress, 1, 'the camera can finish before the visual layers');
  const previousVisual = visualPhase(retargeted);
  const previousScroll = retargeted.top;
  retargeted.click(retargeted.link('#journal'));
  assert.equal(retargeted.html.classList.contains('is-chapter-entering'), true);
  assert.equal(visualPhase(retargeted), previousVisual, 'changing a content target continues unfinished entrance layers');
  assert.equal(retargeted.top, previousScroll);
  assert.equal(retargeted.wheel(120).defaultPrevented, true, 'the unfinished layered entrance still absorbs wheel momentum');
  retargeted.advance(599);
  assert.equal(retargeted.html.classList.contains('is-chapter-entering'), true);
  retargeted.advance(1);
  assert.equal(retargeted.html.classList.contains('is-chapter-entering'), false, 'a same-direction retarget keeps only the remaining entrance duration');
  assert.equal(retargeted.top, retargeted.destination('journal'));
  assert.equal(retargeted.document.activeElement, retargeted.journal);

  const nearDestination = browser();
  nearDestination.click(nearDestination.link('#about'));
  nearDestination.advance(760);
  assert.ok(Math.abs(nearDestination.top - nearDestination.destination('about')) < 1);
  const nearVisual = visualPhase(nearDestination);
  nearDestination.click(nearDestination.link('#about'));
  assert.equal(nearDestination.html.classList.contains('is-chapter-entering'), true, 'a subpixel scroll remainder does not skip unfinished visual layers');
  assert.equal(visualPhase(nearDestination), nearVisual);
  nearDestination.advance(140);
  assert.equal(nearDestination.html.classList.contains('is-chapter-entering'), false);
});

await test('continuous wheel input accumulates distance across panel boundaries without another snap', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  for (let index = 0; index < 15; index++) {
    site.wheel(100);
    site.advance(16);
  }
  site.advance(1000);
  assert.equal(site.top, 2300);
  assert.equal(site.x, -1500);
  assert.equal(site.url.hash, '#series');
  assert.equal(site.progressCurrent.textContent, '02');
  assert.equal(Number(site.html.style.getPropertyValue('--site-progress')), Number((1500 / (site.step * 3)).toFixed(5)));
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.equal(site.heroHeading.inert, true);
  assert.equal(site.header.inert, false);
  assert.equal(site.progress.inert, false);
  assert.equal(site.html.style.getPropertyValue('--chapter-progress'), '1.0000', 'the black hole stays at its content-state position');
  site.wheel(0, { deltaX: -200 });
  site.advance(1000);
  assert.equal(site.x, -1300, 'horizontal trackpad input also moves the horizontal strip');
});

await test('minimal progress readout tracks movement and arrivals, then clears feedback when idle or leaving', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#about' });
  const moving = () => site.progress.classList.contains('is-chapter-moving');
  const arriving = node => node.classList.contains('is-arriving');
  assert.equal(site.document.querySelector('[data-chapter-title]'), null);
  assert.equal(site.document.querySelector('[data-chapter-coordinate]'), null);
  assert.equal(moving(), false);
  assert.equal(arriving(site.progressMarker), false, 'restoring an initial hash does not announce an arrival');
  site.advance(1000);
  assert.equal(site.pendingTimers, 0);

  site.wheel(80);
  site.advance(32);
  assert.equal(moving(), true, 'feedback follows actual horizontal movement');
  assert.equal(arriving(site.progressMarker), false, 'movement within one chapter does not trigger an arrival');
  site.advance(1800);
  assert.equal(moving(), false);
  assert.equal(site.pendingTimers, 0, 'settled movement does not leave a polling timer');

  site.hash('#series');
  assert.equal(site.progressCurrent.textContent, '02');
  assert.equal(site.navLinks[1].getAttribute('aria-current'), 'location');
  assert.equal(arriving(site.navLinks[1]), true);
  assert.equal(arriving(site.progressMarker), true);
  site.advance(200);
  site.hash('#journal');
  assert.equal(arriving(site.navLinks[1]), false, 'a new arrival clears the previous station');
  assert.equal(arriving(site.navLinks[2]), true);
  assert.equal(site.url.searchParams.get('q'), 'space');
  for (let tick = 0; tick < 6; tick++) {
    site.event('scroll');
    site.advance(80);
  }
  assert.equal(moving(), false);
  assert.equal(arriving(site.navLinks[2]), false);
  assert.equal(arriving(site.progressMarker), false, 'stationary scroll updates do not restart the arrival pulse');
  site.advance(1000);
  assert.equal(site.pendingTimers, 0);

  site.hash('#archive');
  assert.equal(moving(), true);
  assert.equal(arriving(site.progressMarker), true);
  assert.ok(site.pendingTimers > 0);
  site.event('pagehide');
  assert.equal(moving(), false);
  assert.equal(arriving(site.progressMarker), false);
  assert.equal(site.navLinks.some(arriving), false);
  assert.equal(site.pendingTimers, 0, 'pagehide cancels feedback timers immediately');
  site.advance(1000);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.pendingTimers, 0);
});

await test('reduced motion suppresses progress feedback and cancels feedback already in progress', () => {
  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#series' });
  reduced.click(reduced.navLinks[2]);
  assert.equal(reduced.top, reduced.destination('journal'));
  assert.equal(reduced.document.activeElement, reduced.journal);
  assert.equal(reduced.progressCurrent.textContent, '03');
  assert.equal(reduced.progress.classList.contains('is-chapter-moving'), false);
  assert.equal(reduced.progressMarker.classList.contains('is-arriving'), false);
  assert.equal(reduced.navLinks.some(link => link.classList.contains('is-arriving')), false);
  assert.equal(reduced.pendingTimers, 0, 'reduced motion never starts feedback timers');

  const animated = browser({ url: 'https://gudu.blog/#about' });
  const distance = animated.step * 0.8;
  animated.wheel(distance);
  animated.advance(160);
  assert.equal(animated.progress.classList.contains('is-chapter-moving'), true);
  assert.equal(animated.progressMarker.classList.contains('is-arriving'), true);
  animated.media.matches = true;
  animated.media.dispatchEvent({ type: 'change' });
  assert.equal(animated.top, animated.destination('about') + distance);
  assert.equal(animated.progress.classList.contains('is-chapter-moving'), false);
  assert.equal(animated.progressMarker.classList.contains('is-arriving'), false);
  assert.equal(animated.navLinks.some(link => link.classList.contains('is-arriving')), false);
  assert.equal(animated.pendingTimers, 0, 'changing preference removes active feedback immediately');
  animated.advance(1000);
  assert.equal(animated.pendingFrames, 0);
  assert.equal(animated.pendingTimers, 0);
});

await test('idle decoration starts one second after content settles and stops immediately for navigation', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  const idle = () => site.progress.classList.contains('is-chapter-idle');
  assert.equal(idle(), false);
  assert.equal(site.pendingTimers, 1, 'initial content owns one pending idle timeout');
  site.advance(967);
  assert.equal(idle(), false);
  site.advance(1);
  assert.equal(idle(), true);
  assert.equal(site.pendingTimers, 0, 'CSS takes over after the single timeout');
  site.advance(10000);
  assert.equal(site.pendingTimers, 0, 'breathing and scan cycles do not use recurring timers');
  assert.equal(site.pendingFrames, 0, 'idle decoration does not keep a JS animation loop alive');

  site.wheel(200);
  assert.equal(idle(), false, 'wheel activity hides decoration before the next frame');
  site.advance(1800);
  assert.equal(idle(), true);
  assert.equal(site.pendingTimers, 0);
  site.click(site.navLinks[1]);
  assert.equal(idle(), false);
  site.advance(640);
  assert.equal(site.top, site.destination('series'));
  assert.equal(site.html.style.getPropertyValue('--chapter-active-index'), '1');
  site.advance(999);
  assert.equal(idle(), false, 'the delay starts after navigation finishes');
  site.advance(1);
  assert.equal(idle(), true);
  assert.equal(site.pendingTimers, 0);
  site.key('Home');
  assert.equal(idle(), false);
  site.advance(2000);
  assert.equal(idle(), false, 'the hero never starts content decoration');
  assert.equal(site.pendingTimers, 0);

  site.wheel(60);
  site.advance(900);
  assert.equal(idle(), false);
  site.advance(999);
  assert.equal(idle(), false);
  site.advance(1);
  assert.equal(idle(), true, 'the layered entrance also waits one second after completion');
  assert.equal(site.pendingTimers, 0);
});

await test('native reading, reading keys and a held touch suspend idle decoration without taking over inputs', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#journal' });
  const idle = () => site.progress.classList.contains('is-chapter-idle');
  site.advance(1000);
  assert.equal(idle(), true);
  const horizontalPosition = site.top;
  site.journal.scrollTop = 200;
  site.document.dispatchEvent({ type: 'scroll', target: site.journal });
  assert.equal(idle(), false, 'captured non-bubbling chapter scroll stops decoration immediately');
  site.advance(800);
  site.journal.scrollTop = 300;
  site.document.dispatchEvent({ type: 'scroll', target: site.journal });
  site.advance(999);
  assert.equal(idle(), false, 'continued native scrolling restarts the quiet period');
  site.advance(1);
  assert.equal(idle(), true);
  assert.equal(site.top, horizontalPosition);
  assert.equal(site.pendingTimers, 0);

  assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, false);
  assert.equal(idle(), false);
  site.advance(1000);
  assert.equal(idle(), true);
  site.key('PageDown', { target: site.journal });
  assert.equal(idle(), false);
  assert.ok(site.journal.scrollTop > 300, 'reading keys still scroll the chapter itself');
  assert.equal(site.top, horizontalPosition);
  site.advance(1000);
  assert.equal(idle(), true);

  site.input.focus();
  assert.equal(site.key('Home', { target: site.input }).defaultPrevented, false);
  assert.equal(idle(), false);
  assert.equal(site.document.activeElement, site.input);
  assert.equal(site.top, horizontalPosition);
  site.advance(1000);
  assert.equal(idle(), true);

  site.journal.scrollTop = 200;
  const finger = clientY => ({ clientX: 100, clientY });
  site.event('touchstart', { target: site.journal, touches: [finger(600)] });
  assert.equal(idle(), false);
  site.advance(1500);
  assert.equal(idle(), false, 'a stationary held touch is still an active interaction');
  assert.equal(site.pendingTimers, 0);
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(550)] }).defaultPrevented, false);
  site.event('touchend', { touches: [] });
  site.advance(999);
  assert.equal(idle(), false);
  site.advance(1);
  assert.equal(idle(), true);
  assert.equal(site.top, horizontalPosition);
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.equal(site.pendingTimers, 0);
  assert.equal(site.pendingFrames, 0);
});

await test('visibility, page lifecycle and reduced motion cancel idle work and restart a fresh quiet period', () => {
  for (const lifecycle of ['hidden', 'pagehide', 'reduced']) {
    const site = browser({ url: 'https://gudu.blog/#series' });
    const idle = () => site.progress.classList.contains('is-chapter-idle');
    site.advance(1000);
    assert.equal(idle(), true);
    if (lifecycle === 'hidden') {
      site.document.hidden = true;
      site.event('visibilitychange');
    } else if (lifecycle === 'pagehide') site.event('pagehide');
    else {
      site.media.matches = true;
      site.media.dispatchEvent({ type: 'change' });
    }
    assert.equal(idle(), false, lifecycle);
    assert.equal(site.pendingTimers, 0, `${lifecycle} removes pending idle work immediately`);
    site.advance(2000);
    assert.equal(idle(), false);
    assert.equal(site.pendingFrames, 0);
    if (lifecycle === 'hidden') {
      site.document.hidden = false;
      site.event('visibilitychange');
    } else if (lifecycle === 'pagehide') site.event('pageshow');
    else {
      site.media.matches = false;
      site.media.dispatchEvent({ type: 'change' });
    }
    assert.equal(site.pendingTimers, 1, `${lifecycle} recovery schedules one new quiet period`);
    site.advance(999);
    assert.equal(idle(), false);
    site.advance(1);
    assert.equal(idle(), true);
    assert.equal(site.pendingTimers, 0);
  }

  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#series' });
  reduced.advance(10000);
  assert.equal(reduced.progress.classList.contains('is-chapter-idle'), false);
  assert.equal(reduced.pendingTimers, 0, 'reduced motion never schedules idle decoration');
  assert.equal(reduced.pendingFrames, 0);
});

await test('long panels read vertically before their edge passes wheel movement to the strip', () => {
  const site = browser({ url: 'https://gudu.blog/#journal' });
  const journalTop = site.destination('journal');
  assert.equal(site.top, journalTop);
  site.journal.scrollTop = 300;
  assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, false);
  site.advance(1000);
  assert.equal(site.top, journalTop);
  assert.equal(site.journal.scrollTop, 300, 'native scrolling is left to the browser');
  site.journal.scrollTop = 800;
  assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, journalTop + 80);
  assert.equal(site.journal.scrollTop, 800);
  assert.equal(site.wheel(-80, { target: site.journal }).defaultPrevented, false, 'scrolling back up reads the existing panel');
  site.journal.scrollTop = 0;
  assert.equal(site.wheel(-80, { target: site.journal }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, journalTop);
});

await test('keyboard input travels continuously, while anchors retain query parameters and focus', () => {
  const site = browser({ url: 'https://gudu.blog/?q=design&category=tech' });
  site.key('PageDown');
  site.advance(1000);
  assert.equal(site.top, 800);
  site.key('ArrowRight');
  site.advance(1000);
  assert.equal(site.top, 900, 'an arrow moves a small distance rather than a whole panel');
  site.key('PageDown');
  site.advance(1000);
  assert.ok(site.top > 900 && site.top < site.destination('series'), 'PageDown travels part of the strip');
  site.click(site.link('#archive'));
  site.advance(1000);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(site.url.hash, '#archive');
  assert.equal(site.url.searchParams.get('q'), 'design');
  assert.equal(site.url.searchParams.get('category'), 'tech');
  assert.equal(site.document.activeElement, site.archive);
  assert.equal(site.key('Home', { target: site.input }).defaultPrevented, false, 'typing controls keep their native keys');
  site.key('Home');
  site.advance(1000);
  assert.equal(site.top, 0);
});

await test('vertical keys scroll long panels and horizontal keys always move across the strip', () => {
  const site = browser({ url: 'https://gudu.blog/#journal' });
  const journalTop = site.destination('journal');
  site.key('PageDown', { target: site.journal });
  assert.ok(site.journal.scrollTop > 0 && site.journal.scrollTop < site.journal.clientHeight);
  const readingTop = site.journal.scrollTop;
  assert.equal(site.top, journalTop);
  site.key('ArrowRight', { target: site.journal });
  site.advance(1000);
  assert.equal(site.top, journalTop + 100);
  assert.equal(site.journal.scrollTop, readingTop);
  site.key('ArrowDown', { target: site.journal });
  assert.equal(site.journal.scrollTop, readingTop + 100);
  site.journal.scrollTop = 800;
  site.key('ArrowDown', { target: site.journal });
  site.advance(1000);
  assert.equal(site.top, journalTop + 200);
});

await test('reduced motion completes both entrance and continuous movement without animation', () => {
  const reduced = browser({ reduced: true });
  reduced.wheel(80);
  assert.equal(reduced.top, 800, 'reduced motion does not wait for animated scrolling');
  assert.equal(reduced.html.classList.contains('is-chapter-transitioning'), false);
  reduced.advance(300);
  reduced.wheel(80);
  assert.equal(reduced.top, 880);
  assert.equal(reduced.x, -80);
  reduced.advance(32);
  assert.equal(reduced.pendingFrames, 0);

  const animated = browser({ url: 'https://gudu.blog/#about' });
  animated.wheel(400);
  animated.advance(32);
  assert.ok(animated.top > 800 && animated.top < 1200);
  animated.media.matches = true;
  animated.media.dispatchEvent({ type: 'change' });
  assert.equal(animated.top, 1200, 'a preference change finishes at the accumulated target');
  animated.advance(32);
  assert.equal(animated.pendingFrames, 0);
});

await test('pagehide cancels entrance, anchor navigation and continuous damping', () => {
  for (const kind of ['entrance', 'anchor', 'continuous']) {
    const animated = browser({ url: kind === 'entrance' ? 'https://gudu.blog/' : 'https://gudu.blog/#about' });
    if (kind === 'anchor') animated.click(animated.link('#archive'));
    else animated.wheel(kind === 'continuous' ? 400 : 80);
    animated.advance(160);
    animated.event('pagehide');
    const stoppedAt = animated.top;
    animated.advance(1400);
    assert.equal(animated.top, stoppedAt, 'a leaving page must not keep scrolling');
    assert.equal(animated.pendingFrames, 0);
    assert.equal(animated.wheel(80).defaultPrevented, false);
  }
});

await test('suspended chapters reject late layout and frame callbacks, then recover their fractional position', () => {
  for (const lifecycle of ['hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/?q=space#series' });
    site.wheel(350);
    site.advance(48);
    const queuedFrames = site.queuedFrames();
    if (lifecycle === 'hidden') {
      site.document.hidden = true;
      site.event('visibilitychange');
    } else site.event('pagehide', { persisted: true });
    const fraction = (site.top - site.destination('about')) / site.step;
    const snapshot = () => [site.top, site.layoutReads, site.scrolls.length, site.chapterEvents.length, site.pendingFrames, site.pendingTimers];
    const suspended = snapshot();
    assert.equal(site.observedTargets, 0, lifecycle);
    site.window.innerWidth = 600;
    site.event('resize');
    site.lateResize();
    site.event('site:revealed');
    site.event('scroll');
    site.event('popstate');
    site.media.dispatchEvent({ type: 'change' });
    for (const callback of queuedFrames) callback(5000);
    assert.equal(site.wheel(80).defaultPrevented, false);
    site.advance(1400);
    assert.deepEqual(snapshot(), suspended, `${lifecycle} leaves no layout, scroll, scene event or new scheduled work`);

    site.document.hidden = false;
    site.event('visibilitychange');
    if (lifecycle === 'pagehide') {
      assert.deepEqual(snapshot(), suspended, 'visibility alone cannot reopen a page after pagehide');
      site.event('pageshow', { persisted: true });
    }
    assert.ok(Math.abs(site.top - (site.destination('about') + fraction * site.step)) < 0.001, lifecycle);
    assert.equal(site.observedTargets, 2, 'resuming reconnects the viewport and panel observers');
    assert.equal(site.url.searchParams.get('q'), 'space');
    site.advance(1400);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.pendingTimers, 0);
  }
});

await test('background initialization and deferred hashes are positioned only after the page resumes', () => {
  const background = browser({ url: 'https://gudu.blog/?q=space#series', hidden: true });
  assert.equal(background.layoutReads, 0, 'background startup does not measure layout');
  assert.equal(background.scrolls.length, 0);
  background.event('pageshow');
  background.event('site:revealed');
  background.lateResize();
  assert.equal(background.layoutReads, 0);
  assert.equal(background.pendingFrames, 0);
  background.document.hidden = false;
  // The head-script loader resumes before the chapter visibility listener.
  background.event('site:revealed');
  background.event('visibilitychange');
  assert.equal(background.top, background.destination('series'));
  assert.equal(background.series.inert, false);
  assert.equal(background.url.searchParams.get('q'), 'space');

  const cached = browser({ url: 'https://gudu.blog/?q=space#series' });
  cached.event('pagehide', { persisted: true });
  const reads = cached.layoutReads;
  const scrollCount = cached.scrolls.length;
  cached.window.innerWidth = 600;
  cached.hash('#journal');
  cached.event('site:revealed');
  assert.equal(cached.layoutReads, reads);
  assert.equal(cached.scrolls.length, scrollCount);
  cached.event('pageshow', { persisted: true });
  assert.equal(cached.top, cached.destination('journal'), 'remeasuring must not replace a deferred hash with the previous chapter');
  assert.equal(cached.url.hash, '#journal');
  assert.equal(cached.url.searchParams.get('q'), 'space');
});

await test('initial and changed hashes open the corresponding chapter without dropping query state', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#journal' });
  assert.equal(site.top, site.destination('journal'));
  assert.equal(site.x, -(site.destination('journal') - site.destination('about')));
  assert.equal(site.html.classList.contains('is-content'), true);
  site.hash('#about');
  assert.equal(site.top, 800);
  assert.equal(site.url.searchParams.get('q'), 'space');
  site.hash('#home');
  assert.equal(site.top, 0);
  assert.equal(site.header.inert, true);
  assert.equal(site.progress.inert, true);
  assert.equal(site.heroHeading.inert, false);
});

await test('loading, open navigation, form inputs and browser zoom keep their own input', () => {
  const site = browser({ loading: true });
  assert.equal(site.wheel(80).defaultPrevented, false);
  site.html.classList.remove('is-loading');
  site.body.dataset.menuOpen = 'true';
  assert.equal(site.wheel(80).defaultPrevented, false);
  assert.equal(site.key('PageDown').defaultPrevented, false);
  delete site.body.dataset.menuOpen;
  assert.equal(site.wheel(80, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(site.wheel(80, { target: site.input }).defaultPrevented, false);
  site.advance(1000);
  assert.equal(site.top, 0);
});

await test('touch snaps only on entry, then follows drag distance, while multi-touch stays native', () => {
  const site = browser();
  const finger = (clientY, clientX = 100) => ({ clientX, clientY });
  site.event('touchstart', { touches: [finger(600)] });
  assert.equal(site.event('touchmove', { touches: [finger(580)] }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, 800);
  assert.equal(site.event('touchmove', { touches: [finger(450)] }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, 800, 'one continuous swipe must not enter a second section');
  site.event('touchend', { touches: [] });
  site.event('touchstart', { touches: [finger(600), finger(610, 150)] });
  assert.equal(site.event('touchmove', { touches: [finger(500), finger(510, 150)] }).defaultPrevented, false);
  site.event('touchend', { touches: [] });
  site.event('touchstart', { touches: [finger(600)] });
  site.event('touchmove', { touches: [finger(550)] });
  site.advance(1000);
  assert.equal(site.top, 850, 'a subsequent touch follows its displacement instead of jumping panels');
  site.event('touchmove', { touches: [finger(500)] });
  site.advance(1000);
  assert.equal(site.top, 900, 'a drag uses displacement from its start without accumulating the same distance twice');
  site.event('touchend', { touches: [] });
  site.event('touchstart', { touches: [finger(600, 400)] });
  site.event('touchmove', { touches: [finger(600, 200)] });
  site.advance(1000);
  assert.equal(site.top, 1100, 'horizontal finger movement also advances the strip');
});

await test('history traversal restores sections and preserves native positions within search results', () => {
  const site = browser({ url: 'https://gudu.blog/?q=first#journal' });
  site.jump(site.destination('journal') + 100);
  site.restore('https://gudu.blog/?q=second#journal', site.destination('journal') + 200);
  assert.equal(site.top, site.destination('journal') + 200, 'same-hash search history must not snap to the panel start');
  assert.equal(site.url.searchParams.get('q'), 'second');
  site.click(site.link('#archive'));
  site.advance(160);
  site.restore('https://gudu.blog/?q=first#about', 800);
  site.advance(1000);
  assert.equal(site.top, 800, 'Back cancels an in-flight jump and shows the restored chapter');
  assert.equal(site.url.hash, '#about');
  assert.equal(site.url.searchParams.get('q'), 'first');
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
});

await test('new articles expand internal reading space without changing horizontal destinations', () => {
  const site = browser({ url: 'https://gudu.blog/#journal' });
  site.journal.scrollTop = 800;
  site.growJournal(800);
  assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, false, 'more posts add reading space below the old bottom');
  site.advance(1000);
  assert.equal(site.top, site.destination('journal'));
  site.click(site.link('#archive'));
  site.advance(1000);
  assert.equal(site.top, site.destination('archive'), 'archive remains three panel steps from the first panel');
  assert.equal(site.runway.style.height, `${800 + 3 * site.step}px`);
});

await test('resizing preserves the fractional horizontal position and recalculates navigation', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  site.jump(800 + site.step * 0.5);
  assert.equal(site.x, -site.step * 0.5);
  site.resizeWidth(600);
  assert.equal(site.top, 800 + site.step * 0.5);
  assert.equal(site.x, -site.step * 0.5);
  assert.equal(site.runway.style.height, `${800 + 3 * site.step}px`);
  site.click(site.link('#archive'));
  site.advance(1000);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(site.x, -site.step * 3);
});

await test('native touch reading stays native until release, and the next edge gesture moves horizontally', () => {
  const site = browser({ url: 'https://gudu.blog/#journal' });
  const finger = clientY => ({ clientX: 100, clientY });
  site.journal.scrollTop = 700;
  site.event('touchstart', { target: site.journal, touches: [finger(600)] });
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(570)] }).defaultPrevented, false);
  site.journal.scrollTop = 800; // The browser consumes the vertical reading part.
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(470)], cancelable: false }).defaultPrevented, false);
  site.event('touchend', { target: site.journal, touches: [] });
  site.event('touchstart', { target: site.journal, touches: [finger(600)] });
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(500)] }).defaultPrevented, true);
  site.advance(1000);
  assert.ok(site.top > site.destination('journal'), 'continued movement at the reading edge reaches the next horizontal panel');
});

await test('PageDown in a tall article never skips more than its visible reading height on wide screens', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth: 2400 });
  site.growJournal(2000);
  site.key('PageDown', { target: site.journal });
  assert.ok(site.journal.scrollTop > 0);
  assert.ok(site.journal.scrollTop <= site.journal.clientHeight, 'reading-page distance is based on height, not screen width');
  assert.equal(site.top, site.destination('journal'));
});

await test('damping reaches its exact endpoint and stops when the browser rounds scrollY to whole pixels', () => {
  const site = browser({ url: 'https://gudu.blog/#about', roundScroll: true });
  site.wheel(37);
  site.advance(1200);
  assert.equal(site.top, 837);
  assert.equal(site.x, -37);
  assert.equal(site.pendingFrames, 0, 'subpixel damping must not keep requesting frames two pixels from its destination');
  site.wheel(133);
  site.advance(32);
  site.wheel(-29);
  site.advance(1200);
  assert.equal(site.top, 941, 'rounded presentation does not discard the queued wheel distance');
  assert.equal(site.pendingFrames, 0);
});

await test('all positions follow measured panel gaps while progress counts only the four content panels', () => {
  const site = browser();
  const ids = ['home', 'about', 'series', 'journal', 'archive'];
  for (const [index, id] of ids.entries()) {
    site.hash(`#${id}`);
    assert.equal(site.top, site.destination(id));
    assert.equal(site.progressCurrent.textContent, String(Math.max(index, 1)).padStart(2, '0'));
    assert.equal(site.html.style.getPropertyValue('--chapter-active-index'), String(Math.max(index - 1, 0)));
    assert.equal(Number(site.html.style.getPropertyValue('--site-progress')), Number((Math.max(index - 1, 0) / 3).toFixed(5)));
  }
  assert.equal(site.url.hash, '#archive');
  assert.equal(site.x, -site.step * 3);
  assert.notEqual(site.step, site.window.innerWidth, 'the fixture exercises partial-width panels');
  site.hash('#series');
  assert.equal(site.progressCurrent.textContent, '02');
  assert.equal(site.navLinks[1].getAttribute('aria-current'), 'location');
});

await test('visible neighbouring panels remain focusable while offscreen panels are inert', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  assert.equal(site.about.inert, false);
  assert.equal(site.series.inert, false, 'the visible topic panel edge must use its actual bounding box');
  assert.equal(site.journal.inert, true);
  assert.equal(site.archive.inert, true);
  site.hash('#series');
  assert.equal(site.about.inert, false);
  assert.equal(site.series.inert, false);
  assert.equal(site.journal.inert, false);
  assert.equal(site.archive.inert, true);
});

await test('an upward wheel from the About edge returns to the hero and absorbs its momentum tail', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#about' });
  assert.equal(site.wheel(-30, { target: site.about }).defaultPrevented, true);
  site.advance(100);
  assert.ok(site.top > 0 && site.top < 800);
  for (let index = 0; index < 14; index++) {
    site.advance(70);
    assert.equal(site.wheel(-12, { target: site.about }).defaultPrevented, true);
  }
  site.advance(1000);
  assert.equal(site.top, 0, 'return motion finishes at the hero instead of stopping partway');
  assert.equal(site.url.hash, '#home');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.equal(site.html.classList.contains('is-content'), false);
  assert.equal(site.header.inert, true);
  assert.equal(site.heroHeading.inert, false);
  assert.equal(site.pendingFrames, 0);
  site.wheel(60);
  site.advance(1000);
  assert.equal(site.top, 800, 'a new downward gesture can enter About again');
});

await test('About reads its own vertical content before an upward wheel or key returns to the hero', () => {
  const wheelSite = browser({ url: 'https://gudu.blog/#about' });
  wheelSite.about.scrollHeight = 1600;
  wheelSite.about.scrollTop = 200;
  assert.equal(wheelSite.wheel(-80, { target: wheelSite.about }).defaultPrevented, false);
  wheelSite.advance(1000);
  assert.equal(wheelSite.top, 800);
  wheelSite.about.scrollTop = 0;
  assert.equal(wheelSite.wheel(-80, { target: wheelSite.about }).defaultPrevented, true);
  wheelSite.advance(1000);
  assert.equal(wheelSite.top, 0);

  const keySite = browser({ url: 'https://gudu.blog/#about' });
  keySite.about.scrollHeight = 1600;
  keySite.about.scrollTop = 200;
  keySite.key('ArrowUp', { target: keySite.about });
  assert.equal(keySite.about.scrollTop, 100);
  assert.equal(keySite.top, 800);
  keySite.about.scrollTop = 0;
  keySite.key('ArrowUp', { target: keySite.about });
  keySite.advance(1000);
  assert.equal(keySite.top, 0);
});

await test('a downward finger drag returns from About once and a fresh gesture can re-enter', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  const finger = clientY => ({ clientX: 100, clientY });
  site.event('touchstart', { target: site.about, touches: [finger(200)] });
  assert.equal(site.event('touchmove', { target: site.about, touches: [finger(260)] }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, 0);
  assert.equal(site.event('touchmove', { target: site.about, touches: [finger(100)] }).defaultPrevented, true);
  site.advance(1000);
  assert.equal(site.top, 0, 'the same finger cannot reverse the completed hero transition');
  site.event('touchend', { touches: [] });
  site.event('touchstart', { touches: [finger(600)] });
  site.event('touchmove', { touches: [finger(550)] });
  site.advance(1000);
  assert.equal(site.top, 800);
});

await test('clicking Home during wheel momentum stays on the hero after the navigation animation ends', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#journal' });
  site.wheel(100);
  site.advance(16);
  site.click(site.link('#home'));
  for (let index = 0; index < 16; index++) {
    site.advance(70);
    assert.equal(site.wheel(12).defaultPrevented, true);
  }
  site.advance(1000);
  assert.equal(site.top, 0, 'the old forward momentum must not re-enter About after returning Home');
  assert.equal(site.url.hash, '#home');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.equal(site.pendingFrames, 0);
});

await test('resizing during a discrete navigation completes its destination instead of stranding a partial hero', () => {
  for (const destination of ['about', 'home', 'series']) {
    const site = browser({ url: destination === 'about' ? 'https://gudu.blog/' : 'https://gudu.blog/#journal' });
    if (destination === 'about') site.wheel(60);
    else site.click(site.link(`#${destination}`));
    site.advance(100);
    assert.equal(site.html.classList.contains('is-chapter-transitioning'), true);
    site.resizeWidth(600);
    site.advance(1000);
    assert.equal(site.top, site.destination(destination), `${destination} resolves against the resized panel geometry`);
    assert.equal(site.url.hash, `#${destination}`);
    assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
    assert.equal(site.pendingFrames, 0);
    if (destination !== 'about') assert.equal(site.document.activeElement.id, destination, 'anchor navigation retains its requested focus');
  }
});

await test('a delayed panel width change preserves a direct Series destination without a window resize', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#series', initialPanelWidth: 704 });
  const temporaryPosition = site.top;
  assert.equal(temporaryPosition, site.destination('series'));
  assert.equal(site.html.style.getPropertyValue('--chapter-count'), '4');
  site.settlePanelWidth();
  assert.equal(site.window.innerWidth, 1200, 'only the first observed panel changes size');
  assert.ok(site.top > temporaryPosition);
  assert.equal(site.top, site.destination('series'));
  assert.equal(site.x, -(site.destination('series') - site.destination('about')));
  assert.equal(site.url.hash, '#series');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.equal(site.about.inert, false);
  assert.equal(site.journal.inert, false);
  assert.equal(site.series.inert, false);
  assert.equal(site.archive.inert, true);
  site.click(site.link('#archive'));
  site.advance(1000);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(site.series.inert, true);
  assert.equal(site.journal.inert, false);
  assert.equal(site.archive.inert, false);
  assert.equal(site.pendingFrames, 0);
});

await test('top search submission reaches the article panel while preserving input focus through navigation changes', () => {
  for (const mode of ['animated', 'reduced', 'resize', 'motion-change']) {
    const site = browser({ url: 'https://gudu.blog/?q=space&category=tech#series', reduced: mode === 'reduced' });
    site.journal.scrollTop = 500;
    site.input.focus();
    assert.equal(site.header.contains(site.input), true);
    assert.equal(site.journal.contains(site.input), false);
    assert.equal(site.event('submit', { target: site.searchForm }).defaultPrevented, true);
    if (mode === 'reduced') {
      assert.equal(site.top, site.destination('journal'), 'reduced motion reaches results immediately');
    } else {
      site.advance(100);
      assert.equal(site.document.activeElement, site.input, 'navigation never steals focus from the visible top search field');
      if (mode === 'resize') site.resizeWidth(600);
      if (mode === 'motion-change') {
        site.media.matches = true;
        site.media.dispatchEvent({ type: 'change' });
      }
    }
    site.advance(1000);
    assert.equal(site.top, site.destination('journal'), `${mode} reaches the article panel`);
    assert.equal(site.document.activeElement, site.input, `${mode} retains focus in the header search input`);
    assert.equal(site.journal.scrollTop, 0, 'search reveals the beginning of the article results');
    assert.equal(site.url.hash, '#journal');
    assert.equal(site.url.searchParams.get('q'), 'space');
    assert.equal(site.url.searchParams.get('category'), 'tech');
    assert.equal(site.pendingFrames, 0);
  }
});

await test('unrelated form submissions keep their native behavior and current chapter', () => {
  const site = browser({ url: 'https://gudu.blog/#series' });
  const form = site.form('unrelated-form');
  site.input.focus();
  assert.equal(site.event('submit', { target: form }).defaultPrevented, false);
  site.advance(1000);
  assert.equal(site.top, site.destination('series'));
  assert.equal(site.url.hash, '#series');
  assert.equal(site.document.activeElement, site.input);
  assert.equal(site.pendingFrames, 0);
});
