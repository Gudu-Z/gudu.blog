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
      event.currentTarget = this;
      for (const callback of [...(listeners.get(event.type) || [])]) callback.call(this, event);
      return !event.defaultPrevented;
    },
  };
}

function classList(initial = [], onWrite = () => {}) {
  const values = new Set(initial);
  return {
    contains: name => values.has(name),
    add: (...names) => { onWrite('add', names); names.forEach(name => values.add(name)); },
    remove: (...names) => { onWrite('remove', names); names.forEach(name => values.delete(name)); },
    toggle(name, force = !values.has(name)) {
      onWrite(force ? 'add' : 'remove', [name]);
      if (force) values.add(name);
      else values.delete(name);
      return force;
    },
  };
}

// Only browser surfaces used by the chapter controller are modeled. The real
// controller executes unmodified; assertions inspect scrolls, URLs and events.
function browser({ reduced = false, finePointer = true, url = 'https://gudu.blog/', loading = false, hidden = false, viewportWidth = 1200, viewportHeight = 800, roundScroll = false, initialPanelWidth = null, multiPanels = false } = {}) {
  let now = 0;
  let sequence = 0;
  let scrollY = 0;
  let location = new URL(url);
  const frames = new Map();
  const timers = new Map();
  const scrolls = [];
  const innerScrolls = [];
  const chapterEvents = [];
  const interactionEvents = [];
  const pointerCaptures = new Map();
  const historyEntries = [];
  const resizeObservers = [];
  let layoutReads = 0;
  let requestedFrames = 0;
  const domWrites = [];
  const nodes = [];
  const height = viewportHeight;
  let document;
  let window;
  let panelWidthOverride = initialPanelWidth;
  const viewWidth = () => window?.innerWidth ?? viewportWidth;
  const panelWidth = () => panelWidthOverride ?? Number((viewWidth() <= 720 ? viewWidth() * 0.88 : Math.min(1200, viewWidth() * 0.82)).toFixed(4));
  const panelGap = () => viewWidth() <= 720 ? 20 : 32;
  const panelStep = () => panelWidth() + panelGap();
  const rulerWidth = () => viewWidth() * (viewWidth() <= 720 ? 0.92 : 0.89);

  class Element {
    constructor(tag = 'div', options = {}) {
      Object.assign(this, eventTarget());
      this.tagName = tag.toUpperCase();
      this.id = options.id || '';
      this.classList = classList(options.classes || [], (operation, names) => domWrites.push({ target: this, kind: 'class', operation, names }));
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
      this.geometry = options.geometry || null;
      this.layoutParent = options.offsetParent || null;
      this.chapterIndex = options.chapterIndex;
      this.offsetHeight = options.height || 0;
      this.scrollHeight = options.height || 0;
      this.clientHeight = options.height || 0;
      this.scrollTop = 0;
      const target = this;
      this.style = {
        values: new Map(),
        setProperty(name, value) { domWrites.push({ target, kind: 'style', name }); this.values.set(name, String(value)); },
        getPropertyValue(name) { return this.values.get(name) || ''; },
        removeProperty(name) { this.values.delete(name); },
      };
      nodes.push(this);
    }
    get offsetTop() { layoutReads++; return this.geometry ? this.geometry().top : this.top; }
    get offsetHeight() { layoutReads++; return this.geometry ? this.geometry().height : this._height; }
    set offsetHeight(value) { this._height = value; }
    get offsetParent() { return this.layoutParent || this.parentElement; }
    get inert() { return this._inert; }
    set inert(value) { domWrites.push({ target: this, kind: 'inert', value }); this._inert = value; }
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
      if (this.geometry) return this.geometry().left;
      return this.chapterIndex === undefined ? 0 : (viewWidth() - panelWidth()) / 2 + this.chapterIndex * panelStep();
    }
    get offsetWidth() {
      layoutReads++;
      if (this.classList.contains('chapter-progress-track')) return rulerWidth();
      if (this.geometry) return this.geometry().width;
      return this.chapterIndex === undefined ? viewWidth() : panelWidth();
    }
    get href() { return new URL(this.getAttribute('href') || '', location).href; }
    set href(value) { this.setAttribute('href', value); }
    get hash() { return new URL(this.href).hash; }
    getBoundingClientRect() {
      layoutReads++;
      const ruler = this.classList.contains('chapter-progress-track');
      const displacement = ruler ? layerOffset(progress) : [0, 0];
      const top = (this.chapterIndex === undefined ? this.top - scrollY : Math.max(0, height - scrollY)) + displacement[1];
      const translation = Number(track.style.getPropertyValue('transform').match(/translate3d\(([-\d.]+)px/)?.[1]) || 0;
      const left = ruler ? (viewWidth() - rulerWidth()) / 2 + displacement[0]
        : this.chapterIndex === undefined ? 0 : this.offsetLeft + translation;
      return { top, bottom: top + this.offsetHeight, left, right: left + this.offsetWidth, width: this.offsetWidth, height: this.offsetHeight };
    }
    setPointerCapture(id) { pointerCaptures.set(id, this); }
    releasePointerCapture(id) { if (pointerCaptures.get(id) === this) pointerCaptures.delete(id); }
    hasPointerCapture(id) { return pointerCaptures.get(id) === this; }
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
  const progressRail = new Element('span', { classes: ['chapter-progress-rail'] });
  progressRail.setAttribute('aria-hidden', 'true');
  const progressFill = new Element('span', { id: 'chapter-progress-fill', classes: ['chapter-progress-fill'] });
  const progressMarker = new Element('span', { classes: ['chapter-progress-marker'] });
  for (const [name, value] of Object.entries({ role: 'slider', tabindex: '0', 'aria-controls': 'chapter-track', 'aria-valuemin': '0', 'aria-valuemax': '100' })) {
    progressMarker.setAttribute(name, value);
  }
  const progressHitbox = new Element('span');
  progressHitbox.setAttribute('aria-hidden', 'true');
  progressMarker.append(progressHitbox);
  const progressLinks = new Element('div', { classes: ['chapter-progress-links'] });
  const progressCurrent = new Element('span', { id: 'chapter-current', dataset: { chapterCurrent: '' } });
  const heroHeading = new Element('div', { classes: ['hero-heading'] });
  const searchForm = new Element('form', { id: 'post-search' });
  const input = new Element('input', { id: 'search-input' });
  const chapters = [hero, about, series, journal, archive];
  const panels = chapters.slice(1).map(chapter => {
    const panel = new Element('div', {
      id: `${chapter.id}-panel`, classes: ['chapter-panel'], offsetParent: chapter,
      geometry: () => ({ left: 0, top: 100, width: panelWidth(), height: chapter === journal ? journal.scrollHeight - 100 : 600 }),
    });
    chapter.append(panel);
    return panel;
  });
  const journalPanels = { main: panels[2] };
  if (multiPanels) {
    journal.paddingBottom = 122;
    const column = new Element('div', {
      geometry: () => ({ left: panelWidth() * 0.04, top: 100, width: panelWidth() * 0.92, height: 1200 }),
      offsetParent: journal,
    });
    journal.children = journal.children.filter(child => child !== journalPanels.main);
    journal.append(column);
    journalPanels.main.geometry = () => ({ left: 0, top: 0, width: panelWidth() * 0.58, height: 480 });
    journalPanels.main.layoutParent = column;
    const sidebar = new Element('aside', {
      id: 'journal-sidebar', classes: ['chapter-panel'], offsetParent: column,
      geometry: () => ({ left: panelWidth() * 0.64, top: 0, width: panelWidth() * 0.28, height: 340 }),
    });
    const stacked = new Element('div', {
      id: 'journal-stacked', classes: ['chapter-panel'], offsetParent: column,
      geometry: () => ({ left: 0, top: 740, width: panelWidth() * 0.92, height: 360 }),
    });
    const headingLayout = new Element('div', {
      classes: ['section-heading'], offsetParent: journal,
      geometry: () => ({ left: 0, top: 60, width: panelWidth(), height: viewWidth() <= 720 ? 96 : 48 }),
    });
    const heading = new Element('div', {
      classes: ['journal-heading-part'], dataset: { depthOwner: journalPanels.main.id }, offsetParent: headingLayout,
      geometry: () => ({ left: panelWidth() * 0.04, top: 0, width: panelWidth() * 0.58, height: 48 }),
    });
    const intro = new Element('p', {
      classes: ['section-intro', 'journal-heading-part'],
      dataset: { depthOwner: sidebar.id, depthOwnerCompact: journalPanels.main.id }, offsetParent: headingLayout,
      geometry: () => ({ left: panelWidth() * (viewWidth() <= 720 ? 0.04 : 0.68), top: viewWidth() <= 720 ? 64 : 20,
        width: panelWidth() * (viewWidth() <= 720 ? 0.58 : 0.28), height: 28 }),
    });
    const nestedHeading = new Element('header', {
      classes: ['journal-heading-part'], dataset: { depthOwner: sidebar.id }, offsetParent: journalPanels.main,
      geometry: () => ({ left: 0, top: 0, width: panelWidth() * 0.58, height: 40 }),
    });
    column.append(journalPanels.main, sidebar, stacked);
    journalPanels.main.append(nestedHeading);
    headingLayout.append(heading, intro);
    journal.append(headingLayout);
    Object.assign(journalPanels, { sidebar, stacked, headingLayout, heading, intro, nestedHeading });
  }
  const chapterTitles = ['关于', '分类', '最新文章', '归档'];
  const chapterSubtitles = ['ABOUT ME', 'CATEGORIES', 'LATEST ARTICLES', 'ARCHIVE'];
  const navLinks = chapters.slice(1).map((chapter, index) => {
    const link = new Element('a', { dataset: { chapterLink: '' } });
    link.href = `#${chapter.id}`;
    const number = new Element('span', { classes: ['chapter-station-index'] });
    const title = new Element('strong', { classes: ['chapter-station-title'] });
    const subtitle = new Element('small', { classes: ['chapter-station-subtitle'] });
    number.textContent = String(index + 1).padStart(2, '0');
    title.textContent = chapterTitles[index];
    subtitle.textContent = chapterSubtitles[index];
    link.append(number, title, subtitle);
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
  progressTrack.append(progressRail, progressFill, progressMarker);
  Object.defineProperty(html, 'scrollHeight', { get: () => height + (parseFloat(runway.style.height) || height) });
  html.clientHeight = body.clientHeight = height;

  const media = eventTarget({ matches: reduced });
  const pointerMedia = eventTarget({ matches: finePointer });
  const matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? media
    : query === '(hover: hover) and (pointer: fine)' ? pointerMedia
      : assert.fail(`unmodeled media query: ${query}`);
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
  const requestAnimationFrame = callback => { requestedFrames++; const id = ++sequence; frames.set(id, callback); return id; };
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
    matchMedia,
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
  window.addEventListener('site:interaction', event => interactionEvents.push({
    active: event.detail.active, kind: event.detail.kind, top: scrollY,
    transform: track.style.getPropertyValue('transform'), scrollCount: scrolls.length,
  }));
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const getComputedStyle = node => ({
    scrollPaddingTop: '0px',
    scrollMarginTop: '0px',
    paddingBottom: `${node.paddingBottom || 0}px`,
    clipPath: node === viewport && multiPanels ? 'inset(88px 0px 122px 0px)' : 'none',
    overflowY: node.overflowY || 'visible',
    getPropertyValue: name => node.style.getPropertyValue(name),
  });
  window.getComputedStyle = getComputedStyle;
  runInNewContext(source, {
    window, document, console, URL, Element, HTMLElement: Element, CustomEvent,
    location, history, performance: { now: () => now },
    matchMedia, getComputedStyle,
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
      stopPropagation() { this.propagationStopped = true; },
      ...properties,
    };
    if (['pointermove', 'pointerup', 'pointercancel'].includes(type) && pointerCaptures.has(event.pointerId)) {
      event.target = pointerCaptures.get(event.pointerId);
    }
    for (let node = event.target instanceof Element ? event.target : null; node && !event.propagationStopped; node = node.parentElement) {
      node.dispatchEvent(event);
    }
    if (!event.propagationStopped) document.dispatchEvent(event);
    if (!event.propagationStopped) window.dispatchEvent(event);
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
    html, body, window, document, chapters, panels, journalPanels, about, journal, series, archive, navLinks, searchForm, input, media, pointerMedia, header, progress, progressCurrent,
    runway, viewport, track, progressTrack, progressRail, progressMarker, progressHitbox, heroHeading, scrolls, innerScrolls, chapterEvents, interactionEvents, historyEntries, domWrites,
    get top() { return scrollY; },
    get step() { return panelStep(); },
    destination(id) { return id === 'home' ? 0 : height + chapters.find(chapter => chapter.id === id).chapterIndex * panelStep(); },
    get x() { return Number(track.style.getPropertyValue('transform').match(/translate3d\(([-\d.]+)px/)?.[1]) || 0; },
    get markerX() { return parseFloat(progressMarker.style.getPropertyValue('--chapter-marker-x')); },
    get rulerWidth() { return rulerWidth(); },
    get rulerLeft() { return (viewWidth() - rulerWidth()) / 2; },
    get url() { return location; },
    get pendingFrames() { return frames.size; },
    get pendingTimers() { return timers.size; },
    get layoutReads() { return layoutReads; },
    get requestedFrames() { return requestedFrames; },
    get observedTargets() { return resizeObservers.reduce((count, observer) => count + observer.targets.size, 0); },
    isObserved(target) { return resizeObservers.some(observer => observer.targets.has(target)); },
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
  assert.equal(site.header.inert, true, 'the hidden header cannot receive keyboard focus on the hero');
  site.wheel(60);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0);
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0);
  assert.equal(site.header.inert, true);
  site.advance(200);
  assert.equal(site.html.classList.contains('is-content'), true, 'the camera reaches content before the header layers finish');
  assert.equal(site.header.inert, true, 'transparent header controls stay outside keyboard navigation after the content threshold');
  site.advance(250);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0.5);
  assert.equal(site.header.inert, true, 'the partly assembled header remains inaccessible');
  assert.ok(site.chapterEvents.at(-1).entranceGlow > 0.95);
  assert.ok(Math.abs(Number(site.html.style.getPropertyValue('--chapter-entrance-glow')) - site.chapterEvents.at(-1).entranceGlow) < 0.00001);
  assert.equal(site.progress.classList.contains('is-chapter-moving'), false);
  assert.equal(site.progressMarker.classList.contains('is-arriving'), false, 'the layered entrance does not also flash the ruler');
  site.advance(449);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true, 'the entrance is still running immediately before its deadline');
  assert.equal(site.header.inert, true, 'the header waits for the complete layered entrance');
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0, 'the pulse has faded before the final pose');
  site.advance(1);
  assert.equal(site.top, site.destination('about'));
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.equal(Number(site.html.style.getPropertyValue('--chapter-transition-phase')), 0);
  assert.equal(site.header.inert, false, 'finishing the entrance restores the header controls');

  const returnEvents = site.chapterEvents.length;
  site.wheel(-60);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  assert.equal(site.header.inert, true, 'returning to the hero immediately removes the header from keyboard navigation');
  site.advance(80);
  assert.equal(site.html.classList.contains('is-content'), true, 'the header gate also applies before the returning camera leaves content');
  assert.equal(site.header.inert, true);
  site.advance(599);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  assert.equal(site.header.inert, true);
  site.advance(1);
  assert.equal(site.top, 0);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.equal(site.header.inert, true, 'the returned hero keeps the hidden header inaccessible');
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
    assert.equal(entranceShift(immediate), 0, 'instant navigation has no side-entry displacement');
    assert.equal(immediate.viewport.inert, false);
    assert.equal(immediate.header.inert, false, 'direct hash and reduced-motion content have immediately usable header controls');
    assert.ok(immediate.chapterEvents.every(event => event.entranceGlow === 0), 'hash restoration and reduced motion do not play the layered effect');
  }
});

await test('hash jumps, reduced motion, resize and page lifecycle clear an active entrance pulse', () => {
  for (const interruption of ['hash', 'reduced', 'resize', 'hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/?q=space' });
    site.click(site.link('#archive'));
    site.advance(400);
    assert.ok(site.chapterEvents.at(-1).entranceGlow > 0.8);
    assert.equal(site.header.inert, true, `${interruption} starts while header interaction is suspended`);
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
    assert.equal(entranceShift(site), 0, `${interruption} clears the side-entry displacement`);
    if (['hash', 'reduced', 'resize'].includes(interruption)) {
      assert.equal(site.viewport.inert, false, `${interruption} restores content interaction`);
      assert.equal(site.header.inert, false, `${interruption} restores header interaction without waiting for an abandoned animation`);
    }
    assert.equal(site.chapterEvents.at(-1).entranceGlow, 0, `${interruption} notifies the renderer immediately`);
    if (['reduced', 'hidden', 'pagehide'].includes(interruption)) {
      for (const panel of site.panels) assertFlatDepth(panel, `${interruption} also clears the interrupted hero plane transform`);
    }
    const destination = interruption === 'pagehide' ? stoppedAt : site.destination(interruption === 'hash' ? 'series' : 'archive');
    assert.equal(site.top, destination, interruption);
    if (['reduced', 'resize', 'hidden'].includes(interruption)) assert.equal(site.document.activeElement, site.archive);
    site.advance(1200);
    assert.equal(site.top, destination);
    assert.equal(site.pendingFrames, 0);
    assert.ok(site.chapterEvents.slice(eventCount).every(event => event.entranceGlow === 0), `${interruption} does not replay the cleared pulse`);
    assert.equal(site.url.searchParams.get('q'), 'space');
    if (interruption === 'hidden') {
      site.document.hidden = false;
      site.event('visibilitychange');
    }
    if (interruption === 'pagehide') site.event('pageshow');
    site.advance(32);
    assert.equal(site.header.inert, false, `${interruption} leaves the resumed content header usable`);
    assert.equal(site.html.classList.contains('is-chapter-entering'), false);
    assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
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
  const enteringDepth = [depthState(site.about), depthState(site.series)];
  const enteringShift = entranceShift(site);
  const reversalEvents = site.chapterEvents.length;
  site.key('Home');
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), true);
  assert.equal(visualPhase(site), enteringVisual, 'the return begins at the same visible layer position');
  assert.equal(site.top, enteringScroll, 'reversing does not jump the camera scroll position');
  assert.deepEqual([depthState(site.about), depthState(site.series)], enteringDepth, 'reversing preserves each complete rigid-plane pose');
  assert.equal(entranceShift(site), enteringShift, 'reversing preserves the actual side-entry position');
  assert.equal(site.viewport.inert, true, 'reversing cannot activate panels in transit');
  assert.equal(site.header.inert, true, 'reversing cannot activate partly assembled header controls');
  assert.equal(site.chapterEvents.at(-1).entranceGlow, 0);
  site.advance(180);
  const leavingVisual = visualPhase(site);
  const leavingScroll = site.top;
  const leavingDepth = [depthState(site.about), depthState(site.series)];
  const leavingShift = entranceShift(site);
  assert.ok(leavingVisual > 0 && leavingVisual < enteringVisual);
  site.click(site.link('#about'));
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.equal(site.html.classList.contains('is-chapter-entering'), true);
  assert.ok(Math.abs(visualPhase(site) - leavingVisual) < 0.00011, 're-entry preserves the partially hidden layers');
  assert.equal(site.top, leavingScroll);
  assert.deepEqual([depthState(site.about), depthState(site.series)], leavingDepth, 're-entry resumes the exact partially returned panel pose');
  assert.equal(entranceShift(site), leavingShift, 're-entry also preserves its side-entry displacement');
  assert.equal(site.header.inert, true, 're-entry does not release the header between directions');
  site.advance(690);
  assert.equal(site.top, site.destination('about'));
  assert.equal(site.document.activeElement, site.about);
  assert.equal(site.url.hash, '#about');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.ok(site.chapterEvents.slice(reversalEvents).every(event => event.entranceGlow === 0), 'an interrupted entrance never flashes a new pulse at its midpoint');
  assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  assert.equal(site.header.inert, false, 'the resumed entrance restores header interaction when finished');
  site.advance(32);
  assert.equal(site.pendingFrames, 0);

  const retargeted = browser();
  retargeted.click(retargeted.link('#archive'));
  retargeted.advance(300);
  assert.equal(retargeted.chapterEvents.at(-1).progress, 1, 'the camera can finish before the visual layers');
  const previousVisual = visualPhase(retargeted);
  const previousScroll = retargeted.top;
  const previousDepth = retargeted.panels.map(depthState);
  const previousShift = entranceShift(retargeted);
  retargeted.click(retargeted.link('#journal'));
  assert.equal(retargeted.html.classList.contains('is-chapter-entering'), true);
  assert.equal(visualPhase(retargeted), previousVisual, 'changing a content target continues unfinished entrance layers');
  assert.equal(retargeted.top, previousScroll);
  assert.deepEqual(retargeted.panels.map(depthState), previousDepth, 'retargeting unfinished entrance layers preserves each current panel pose');
  assert.equal(entranceShift(retargeted), previousShift, 'retargeting does not restart the side slide');
  assert.equal(retargeted.header.inert, true, 'retargeting content during Hero travel keeps the header suspended');
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
  assert.ok(Math.abs(site.markerX - (1500 / site.step + 0.5) * site.rulerWidth / 4) < 0.001, 'the marker follows continuous movement inside its own track');
  assert.equal(site.url.hash, '#series');
  assert.equal(site.progressCurrent.textContent, '02');
  assert.equal(Number(site.progress.style.getPropertyValue('--site-progress')), Number((1500 / (site.step * 3)).toFixed(5)));
  assert.equal(site.html.classList.contains('is-chapter-transitioning'), false);
  assert.equal(site.heroHeading.inert, true);
  assert.equal(site.header.inert, false);
  assert.equal(site.progress.inert, false);
  assert.equal(site.html.style.getPropertyValue('--chapter-progress'), '1.0000', 'the black hole stays at its content-state position');
  site.wheel(0, { deltaX: -200 });
  site.advance(1000);
  assert.equal(site.x, -1300, 'horizontal trackpad input also moves the horizontal strip');
});

await test('continuous scrolling updates only changing local styles and uses one animation chain', t => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  site.jump(site.destination('about') + site.step / 2);
  site.advance(1200);
  const start = site.top;
  const startX = site.x;
  const before = { writes: site.domWrites.length, frames: site.requestedFrames, scrolls: site.scrolls.length, reads: site.layoutReads };
  site.wheel(120);
  site.advance(1600);
  const writes = site.domWrites.slice(before.writes);
  const metrics = {
    rootStyles: writes.filter(write => write.target === site.html && write.kind === 'style').length,
    rootClasses: writes.filter(write => write.target === site.html && write.kind === 'class').length,
    inertWrites: writes.filter(write => write.kind === 'inert').length,
    layoutReads: site.layoutReads - before.reads,
    frames: site.requestedFrames - before.frames,
    scrolls: site.scrolls.length - before.scrolls,
  };
  t.diagnostic(`120px content scroll: ${JSON.stringify(metrics)}`);
  assert.deepEqual([metrics.rootStyles, metrics.rootClasses, metrics.inertWrites, metrics.layoutReads], [0, 0, 0, 0], JSON.stringify(metrics));
  assert.ok(metrics.frames <= metrics.scrolls + 1, `scroll events must not add a second update loop: ${JSON.stringify(metrics)}`);
  assert.equal(site.x, startX - 120);
  assert.equal(site.top, start + 120);
  const settled = [site.domWrites.length, site.requestedFrames];
  site.event('scroll');
  site.advance(32);
  assert.deepEqual([site.domWrites.length, site.requestedFrames], settled, 'a delayed scroll event for the already rendered position does no work');
});

function revealUnit(node) {
  return node.classList.contains('chapter-section') ? node.querySelector('.chapter-panel') : node;
}

function revealState(node) {
  const chapter = revealUnit(node);
  return {
    initialized: chapter.classList.contains('chapter-reveal-unit'),
    open: chapter.classList.contains('is-chapter-revealed'),
    departing: chapter.classList.contains('is-chapter-departing'),
    closing: chapter.classList.contains('is-chapter-closing'),
    immediate: chapter.classList.contains('is-chapter-immediate'),
    scanning: chapter.classList.contains('is-chapter-scanning'),
    direction: chapter.style.getPropertyValue('--chapter-reveal-direction'),
  };
}

function isCalibrating(node) {
  return revealUnit(node).classList.contains('is-chapter-calibrating');
}

function calibrationCount(site, node) {
  return site.domWrites.filter(write => write.target === revealUnit(node) && write.operation === 'add'
    && write.names?.includes('is-chapter-calibrating')).length;
}

function depthState(node) {
  const unit = revealUnit(node);
  // CSS treats signed zero identically; keep missing/invalid values as NaN.
  const value = name => 0 + parseFloat(unit.style.getPropertyValue(name));
  return {
    yaw: value('--chapter-depth-yaw'),
    z: value('--chapter-depth-z'),
    shift: value('--chapter-depth-x'),
    span: value('--chapter-depth-span'),
    left: value('--chapter-light-left'),
    right: value('--chapter-light-right'),
  };
}

function depthGeometry(node) {
  const { left, right, ...geometry } = depthState(node);
  return geometry;
}

function viewAngles(site) {
  return ['yaw', 'pitch'].map(axis => parseFloat(site.track.style.getPropertyValue(`--chapter-view-${axis}`)) || 0);
}

function parallaxX(node) {
  return 0 + parseFloat(revealUnit(node).style.getPropertyValue('--chapter-parallax-x'));
}

function layerOffset(node) {
  const value = node.style.getPropertyValue('translate');
  if (!value) return [0, 0];
  const match = value.startsWith('calc(')
    ? value.match(/^calc\(var\(--chapter-entrance-x, 0px\) \+ ([-\d.]+)px\) ([-\d.]+)px$/)
    : value.match(/^([-\d.]+)px ([-\d.]+)px$/);
  assert.ok(match, `unexpected interface translation: ${value}`);
  return match.slice(1).map(Number);
}

function interfaceOffsets(site) {
  return [site.track, site.header, site.progress].map(layerOffset);
}

function movePointer(site, target, properties = {}) {
  return site.event('pointermove', { target, pointerType: 'mouse', pointerId: 9, isPrimary: true,
    buttons: 0, clientX: site.window.innerWidth, clientY: site.window.innerHeight, ...properties });
}

function entranceShift(site) {
  return parseFloat(site.track.style.getPropertyValue('--chapter-entrance-x'));
}

function cameraOffset(node) {
  const unit = revealUnit(node);
  return {
    x: 0 + parseFloat(unit.style.getPropertyValue('--chapter-camera-x')),
    y: 0 + parseFloat(unit.style.getPropertyValue('--chapter-camera-y')),
  };
}

function assertFlatDepth(node, message) {
  assert.deepEqual(depthState(node), { yaw: 0, z: 0, shift: 0, span: 1, left: 0, right: 0 }, message);
  assert.deepEqual(cameraOffset(node), { x: 0, y: 0 }, message);
}

function panelLayout(node) {
  const section = node.closest('.chapter-section');
  let left = section.offsetLeft;
  let top = 0;
  for (let ancestor = node; ancestor !== section; ancestor = ancestor.offsetParent) {
    left += ancestor.offsetLeft;
    top += ancestor.offsetTop;
  }
  return { left, top, width: node.offsetWidth, height: node.offsetHeight, section };
}

function projectedPoint(site, node, layout, x, y) {
  const pose = depthState(node);
  const camera = cameraOffset(node);
  const unit = revealUnit(node);
  const value = name => parseFloat(unit.style.getPropertyValue(name));
  const perspective = value('--chapter-perspective');
  const originX = value('--chapter-depth-origin-x');
  const originY = value('--chapter-depth-origin-y');
  const angle = pose.yaw * Math.PI / 180;
  const localX = (x - originX) * pose.span;
  const localY = y - originY;
  const [viewYaw, viewPitch] = viewAngles(site).map(degrees => degrees * Math.PI / 180);
  const sceneX = Math.cos(angle) * localX + pose.shift - camera.x;
  const sceneY = localY - camera.y;
  const sceneZ = pose.z - Math.sin(angle) * localX;
  // CSS applies the shared view Ry, then Rx, after the card's own chord pose.
  const turnedX = Math.cos(viewYaw) * sceneX + Math.sin(viewYaw) * sceneZ;
  const turnedZ = -Math.sin(viewYaw) * sceneX + Math.cos(viewYaw) * sceneZ;
  const turnedY = Math.cos(viewPitch) * sceneY - Math.sin(viewPitch) * turnedZ;
  const depth = Math.sin(viewPitch) * sceneY + Math.cos(viewPitch) * turnedZ;
  const scale = perspective / (perspective - depth);
  const [pointerX, pointerY] = layerOffset(site.track);
  // Evaluate the CSS camera projection at each actual rotated corner. This
  // also allows labels to be compared with points outside their owner's box.
  return {
    x: layout.left + site.x + pointerX + originX + camera.x + turnedX * scale,
    y: layout.top - layout.section.scrollTop + pointerY + originY + camera.y + turnedY * scale,
    depth, scale,
  };
}

function projectedPanel(site, node, layout) {
  const points = [[0, 0], [layout.width, 0], [layout.width, layout.height], [0, layout.height]]
    .map(([x, y]) => projectedPoint(site, node, layout, x, y));
  return { left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)), points };
}

function assertOnOwnerPlane(site, copy, owner) {
  const layout = panelLayout(copy);
  const ownerLayout = panelLayout(owner);
  for (const key of ['yaw', 'z', 'shift', 'span']) {
    assert.equal(depthState(copy)[key], depthState(owner)[key], `${key} belongs to this text's own surface`);
  }
  assert.deepEqual(cameraOffset(copy), cameraOffset(owner), 'text and owner use the same viewport camera');
  for (const [x, y] of [[0, 0], [layout.width, 0], [layout.width, layout.height], [0, layout.height]]) {
    const actual = projectedPoint(site, copy, layout, x, y);
    const expected = projectedPoint(site, owner, ownerLayout, x + layout.left - ownerLayout.left, y + layout.top - ownerLayout.top);
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 0.003, 'each text corner lies on the correct extended owner plane');
  }
}

function revealThresholds(site, chapter) {
  const visibleWidth = Math.min(revealUnit(chapter).offsetWidth, site.window.innerWidth);
  const enter = Math.min(80, visibleWidth * 0.1);
  const exit = Math.min(24, visibleWidth * 0.03);
  const departure = Math.min(320, visibleWidth * 0.35);
  return { enter, exit, departure, between: (enter + exit) / 2 };
}

function moveToVisiblePixels(site, chapter, visibleWidth, side = 'right') {
  const unit = revealUnit(chapter);
  const section = unit.closest('.chapter-section');
  let localLeft = 0;
  for (let ancestor = unit; ancestor && ancestor !== section; ancestor = ancestor.offsetParent) localLeft += ancestor.offsetLeft;
  const width = unit.offsetWidth;
  const left = side === 'right' ? site.window.innerWidth - visibleWidth : visibleWidth - width;
  const target = site.destination('about') + section.offsetLeft + localLeft - left;
  // Small native scroll steps exercise threshold transitions rather than the
  // explicit fast-drag fallback. The controller still runs unmodified.
  while (Math.abs(target - site.top) > site.step / 12) {
    const previous = site.top;
    site.jump(site.top + Math.sign(target - site.top) * site.step / 12);
    assert.notEqual(site.top, previous, 'the requested panel visibility must be reachable within the fixture scroll range');
  }
  site.jump(target);
}

await test('internal parallax rests at each chapter stop and moves every card together with bounded reversible travel', () => {
  for (const viewportWidth of [1200, 600]) {
    const limit = viewportWidth <= 720 ? 5 : 12;
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { main, sidebar, stacked, heading, nestedHeading } = site.journalPanels;
    const cards = [main, sidebar, stacked];
    for (const id of ['series', 'journal', 'archive']) {
      site.hash(`#${id}`);
      const chapterCards = site[id].querySelectorAll('.chapter-panel');
      assert.ok(chapterCards.length > 0);
      assert.ok(chapterCards.every(card => parallaxX(card) === 0), `${id}: its authored reading position has no internal offset`);
    }
    const sample = offset => {
      site.jump(site.destination('journal') + site.step * offset);
      const values = cards.map(parallaxX);
      assert.ok(values.every(value => Number.isFinite(value) && Math.abs(value) <= limit));
      assert.deepEqual(values, Array(cards.length).fill(values[0]), 'asymmetric main, sidebar and stacked cards share their chapter reading stop');
      return values[0];
    };
    const before = sample(-0.5);
    assert.ok(before < 0 && before > -limit, 'approaching content has an opposite internal offset to its track motion');
    assert.equal(sample(0), 0);
    const after = sample(0.5);
    assert.equal(after, -before, 'equal distances either side of the stop produce opposite internal offsets');
    assert.equal(sample(-0.5), before, 'reversal restores exactly the same internal pose');
    assert.equal(sample(-1), -limit);
    assert.equal(sample(1), limit);
    for (const node of [site.html, site.track, site.about, revealUnit(site.about), heading, nestedHeading]) {
      assert.equal(node.style.getPropertyValue('--chapter-parallax-x'), '', 'About, outside headings and ancestors do not receive an internal parallax variable');
    }
  }
});

await test('internal parallax shares the existing scroll frame and stays still during native vertical reading', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  site.jump(site.destination('journal') - site.step * 0.3);
  site.advance(1200);
  const { main, sidebar, stacked } = site.journalPanels;
  const allowed = new Set([revealUnit(site.series), main, sidebar, stacked, revealUnit(site.archive)]);
  const before = { reads: site.layoutReads, frames: site.requestedFrames, scrolls: site.scrolls.length, writes: site.domWrites.length };
  site.wheel(120);
  site.advance(1000);
  const writes = site.domWrites.slice(before.writes).filter(write => write.name === '--chapter-parallax-x');
  assert.ok(writes.length > 0, 'continuous horizontal travel updates internal layers');
  assert.ok(writes.every(write => allowed.has(write.target)), 'writes stay local to the three eligible chapter surfaces');
  assert.equal(site.layoutReads, before.reads, 'internal motion uses the existing measured layout');
  assert.ok(site.requestedFrames - before.frames <= site.scrolls.length - before.scrolls + 1, 'parallax does not start a second animation chain');
  assert.equal(site.pendingFrames, 0);
  const pose = [main, sidebar, stacked].map(parallaxX);
  const horizontal = site.top;
  const count = site.domWrites.filter(write => write.name === '--chapter-parallax-x').length;
  const nativeReads = site.layoutReads;
  site.journal.scrollTop = 120;
  site.event('scroll', { target: site.journal });
  site.advance(32);
  assert.equal(site.journal.scrollTop, 120);
  assert.equal(site.top, horizontal, 'native reading keeps its horizontal station');
  assert.deepEqual([main, sidebar, stacked].map(parallaxX), pose, 'reading vertically cannot drift the internal horizontal layers');
  assert.equal(site.layoutReads, nativeReads);
  site.event('popstate');
  site.advance(32);
  assert.equal(site.domWrites.filter(write => write.name === '--chapter-parallax-x').length, count, 'vertical and stationary updates do not rewrite unchanged internal offsets');
});

await test('internal parallax clears on motion limits or suspension and resumes correctly across viewport sizes', () => {
  for (const interruption of ['reduced', 'blocked', 'hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
    site.jump(site.destination('journal') - site.step * 0.4);
    site.advance(1200);
    const cards = [revealUnit(site.series), site.journalPanels.main, site.journalPanels.sidebar, site.journalPanels.stacked, revealUnit(site.archive)];
    const original = cards.map(parallaxX);
    assert.ok(original.some(value => Math.abs(value) > 1));
    if (interruption === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'blocked') { site.html.classList.add('is-loading'); site.event('popstate'); site.advance(32); }
    if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pagehide');
    assert.deepEqual(cards.map(parallaxX), Array(cards.length).fill(0), `${interruption} clears every internal offset`);
    const settled = { frames: site.requestedFrames, reads: site.layoutReads };
    site.advance(1200);
    assert.equal(site.requestedFrames, settled.frames, `${interruption} leaves no independent parallax loop`);
    assert.equal(site.layoutReads, settled.reads);
    if (interruption === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'blocked') { site.html.classList.remove('is-loading'); site.event('popstate'); site.advance(32); }
    if (interruption === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pageshow');
    assert.deepEqual(cards.map(parallaxX), original, `${interruption} resumes at the original reading coordinate`);
  }
  const responsive = browser({ url: 'https://gudu.blog/#journal' });
  responsive.jump(responsive.destination('journal') + responsive.step * 0.5);
  const desktop = parallaxX(responsive.journal);
  responsive.resizeWidth(600);
  assert.ok(Math.abs(parallaxX(responsive.journal) - desktop * 5 / 12) < 0.001, 'compact screens retain the same travel phase at a gentler amplitude');
  responsive.resizeWidth(1200);
  assert.equal(parallaxX(responsive.journal), desktop, 'restoring viewport size restores the original fractional pose');
  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#journal' });
  assert.ok([reduced.series, reduced.journal, reduced.archive].every(chapter => parallaxX(chapter) === 0), 'a reduced-motion deep link starts without offset even on neighboring panels');
});

await test('Hero travel gives internal layers the same coordinate as ordinary scrolling without a docking jump', () => {
  const hero = browser({ multiPanels: true });
  const cards = [revealUnit(hero.series), hero.journalPanels.main, hero.journalPanels.sidebar, hero.journalPanels.stacked, revealUnit(hero.archive)];
  assert.deepEqual(cards.map(parallaxX), Array(cards.length).fill(0), 'the hero starts with internal layers neutral');
  hero.click(hero.link('#journal'));
  hero.advance(600);
  assert.equal(hero.html.classList.contains('is-chapter-entering'), true);
  const shifted = parallaxX(hero.journal);
  assert.ok(shifted < 0 && shifted > -12, 'the destination is still assembling toward its reading stop');
  const reference = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  reference.jump(reference.destination('about') - hero.x - entranceShift(hero));
  assert.ok(Math.abs(parallaxX(reference.journal) - shifted) <= 0.001, 'Hero side displacement participates in the ordinary internal-motion coordinate');
  const reversing = cards.map(parallaxX);
  hero.key('Home');
  assert.deepEqual(cards.map(parallaxX), reversing, 'reversal preserves all current internal layers');
  hero.advance(80);
  const returning = cards.map(parallaxX);
  hero.click(hero.link('#journal'));
  assert.deepEqual(cards.map(parallaxX), returning, 're-entry resumes the same internal offset');
  const before = { reads: hero.layoutReads, frames: hero.requestedFrames, scrolls: hero.scrolls.length };
  hero.advance(1000);
  assert.equal(parallaxX(hero.journal), 0, 'finishing Hero entry reaches the authored reading position');
  assert.equal(hero.html.classList.contains('is-chapter-entering'), false);
  assert.equal(hero.layoutReads, before.reads);
  assert.ok(hero.requestedFrames - before.frames <= hero.scrolls.length - before.scrolls + 1);
  hero.event('popstate');
  hero.advance(32);
  assert.equal(parallaxX(hero.journal), 0, 'the next ordinary update does not change the docking endpoint');
  hero.click(hero.link('#home'));
  hero.advance(1000);
  assert.deepEqual(cards.map(parallaxX), Array(cards.length).fill(0), 'return completion clears all internal offsets');
  assert.equal(hero.pendingFrames, 0);
});

await test('panel reveal thresholds have hysteresis and leave CSS to finish the sequence after scrolling stops', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  const chapter = site.journal;
  const thresholds = revealThresholds(site, chapter);
  assert.equal(site.chapters.slice(1).every(chapter => revealState(chapter).initialized), true);
  assert.equal(revealState(site.about).open, true);
  assert.equal(revealState(site.about).immediate, true, 'the initial hash is already settled');
  assert.equal(revealState(site.about).scanning, false);
  assert.equal(revealState(site.series).open, false, 'a small adjacent preview waits for its threshold');
  moveToVisiblePixels(site, chapter, thresholds.enter - 1);
  assert.equal(revealState(chapter).open, false);
  moveToVisiblePixels(site, chapter, thresholds.enter + 1);
  assert.deepEqual(revealState(chapter), { initialized: true, open: true, departing: false, closing: false, immediate: false, scanning: true, direction: '1' });
  const writes = site.domWrites.length;
  const frames = site.requestedFrames;
  site.advance(1600);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.requestedFrames, frames, 'CSS reveal completion does not schedule JavaScript frames');
  assert.equal(site.pendingTimers, 0, 'no reveal completion timer survives the existing navigation feedback');
  assert.equal(site.domWrites.slice(writes).filter(write => write.target === revealUnit(chapter)).length, 0, 'stopping scroll does not rewrite or complete the panel animation from JavaScript');
  const scanWrites = () => site.domWrites.filter(write => write.target === revealUnit(chapter) && write.names?.includes('is-chapter-scanning'));
  const scanCount = scanWrites().length;
  moveToVisiblePixels(site, chapter, thresholds.exit + 1);
  assert.equal(revealState(chapter).open, true, 'an opened panel stays open inside the hysteresis band');
  moveToVisiblePixels(site, chapter, thresholds.exit - 1);
  assert.equal(revealState(chapter).closing, true);
  assert.equal(revealState(chapter).direction, '1', 'returning toward the right closes toward the right');
  moveToVisiblePixels(site, chapter, thresholds.between);
  assert.equal(revealState(chapter).closing, true, 'a closing panel waits for the opening threshold');
  moveToVisiblePixels(site, chapter, thresholds.enter + 1);
  assert.equal(revealState(chapter).open, true);
  assert.equal(revealState(chapter).scanning, true);
  assert.equal(scanWrites().length, scanCount, 'reversing a close keeps the original one-shot scan class without removing or readding it');
});

await test('whole-interface mouse parallax coalesces samples and moves only three parent layers before coming to rest', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  const assertForeground = () => {
    const [content, top, bottom] = interfaceOffsets(site);
    assert.deepEqual(top, bottom, 'both HUD layers occupy the same foreground plane');
    for (const axis of [0, 1]) {
      assert.equal(Math.sign(top[axis]), Math.sign(content[axis]), 'foreground and content follow the same mouse direction');
      assert.ok(Math.abs(top[axis]) > Math.abs(content[axis]), 'foreground parallax stays stronger than content on both axes');
    }
  };
  site.advance(1600);
  const { main, nestedHeading, heading, intro } = site.journalPanels;
  const snapshot = () => ({ top: site.top, x: site.x, marker: site.markerX, url: site.url.href,
    depth: depthGeometry(main), camera: cameraOffset(main), scrollOffset: parallaxX(main),
    heading: depthGeometry(heading), intro: depthGeometry(intro), scrolls: site.scrolls.length,
    events: site.interactionEvents.length });
  const before = snapshot();
  const reads = site.layoutReads;
  const frames = site.requestedFrames;
  const writes = site.domWrites.length;
  for (let index = 0; index < 30; index++) {
    assert.equal(movePointer(site, index % 2 ? main : nestedHeading).defaultPrevented, false);
  }
  assert.equal(site.pendingFrames, 1);
  assert.equal(site.requestedFrames - frames, 1, 'a burst shares one update frame');
  assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]]);
  site.advance(16);
  const first = layerOffset(site.track);
  assert.ok(first[0] > 0 && first[0] < 6 && first[1] > 0 && first[1] < 3.75);
  assertForeground();
  site.advance(1000);
  assert.deepEqual(interfaceOffsets(site), [[6, 3.75], [8, 5], [8, 5]]);
  assert.deepEqual(viewAngles(site), [-1.5, 0.8]);
  assertForeground();
  assert.deepEqual(snapshot(), before, 'parent translation does not change rail geometry, panel projection or internal scroll offsets');
  assert.equal(site.layoutReads, reads);
  assert.equal(site.pendingFrames, 0);
  assert.ok(site.domWrites.slice(writes).every(write => write.kind === 'style' && (
    ([site.track, site.header, site.progress].includes(write.target) && write.name === 'translate')
    || (write.target === site.track && ['--chapter-view-yaw', '--chapter-view-pitch'].includes(write.name))
    || (write.target.classList.contains('chapter-panel') && ['--chapter-light-left', '--chapter-light-right'].includes(write.name))
  )), 'mouse frames only update parent translation, shared view angles and local material opacity');
  for (const hud of [site.header, site.progress]) {
    assert.equal(hud.style.getPropertyValue('--chapter-view-yaw'), '');
    assert.equal(hud.style.getPropertyValue('--chapter-view-pitch'), '', 'foreground HUDs remain unrotated');
  }
  for (const node of [...site.panels, heading, intro, nestedHeading, site.html]) {
    assert.equal(node.style.getPropertyValue('--chapter-pointer-x'), '');
    assert.equal(node.style.getPropertyValue('translate'), '', 'all content follows its parent with no independent mouse offset');
  }
  const settled = { frames: site.requestedFrames, writes: site.domWrites.length };
  site.advance(1800);
  assert.deepEqual({ frames: site.requestedFrames, writes: site.domWrites.length }, settled);
  for (const target of [site.body, site.header, site.progress, heading]) {
    site.event('pointerout', { target: main, relatedTarget: target });
    movePointer(site, target);
    site.advance(32);
    assert.deepEqual(interfaceOffsets(site), [[6, 3.75], [8, 5], [8, 5]], 'blank space, HUDs and loose text share one continuous mouse field');
  }
  movePointer(site, site.body, { clientX: -100, clientY: -100 });
  site.advance(1100);
  assert.deepEqual(interfaceOffsets(site), [[-6, -3.75], [-8, -5], [-8, -5]]);
  assert.deepEqual(viewAngles(site), [1.5, -0.8]);
  assertForeground();
  site.event('pointerout', { target: site.body, relatedTarget: null });
  assert.equal(layerOffset(site.track)[0], -6, 'actually leaving the window starts a soft return');
  site.advance(32);
  assert.ok(layerOffset(site.track)[0] > -6 && layerOffset(site.track)[0] < 0);
  assertForeground();
  site.advance(1000);
  assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(viewAngles(site), [0, 0]);
  for (const node of [site.track, site.header, site.progress]) assert.equal(node.style.getPropertyValue('translate'), '', 'rest clears inline translation, restoring CSS entrance ownership');
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.layoutReads, reads);
});

await test('shared mouse observation preserves owner planes and panel gaps while a fixed light responds continuously to orientation', () => {
  for (const viewportWidth of [1200, 2551]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { main, sidebar, heading, intro } = site.journalPanels;
    const mainLayout = panelLayout(main);
    const sidebarLayout = panelLayout(sidebar);
    for (const offset of [-0.1, 0, 0.1]) {
      site.jump(site.destination('journal') + offset * site.step);
      const geometry = [main, sidebar, heading, intro].map(depthGeometry);
      let firstProjection;
      for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0, 0]]) {
        const reads = site.layoutReads;
        movePointer(site, site.body, { clientX: x * viewportWidth, clientY: y * site.window.innerHeight });
        site.advance(1000);
        assert.equal(site.layoutReads, reads, 'view orientation and illumination never read live layout');
        assert.equal(site.pendingFrames, 0);
        const [yaw, pitch] = viewAngles(site);
        assert.ok(Math.abs(yaw) <= 1.5 && Math.abs(pitch) <= 0.8, 'observation stays within the subtle yaw and pitch limits');
        assert.deepEqual([main, sidebar, heading, intro].map(depthGeometry), geometry, 'mouse observation does not alter the scroll-authored chord geometry');
        assertOnOwnerPlane(site, heading, main);
        assertOnOwnerPlane(site, intro, sidebar);
        const mainRect = projectedPanel(site, main, mainLayout);
        const sideRect = projectedPanel(site, sidebar, sidebarLayout);
        assert.ok(sideRect.left > mainRect.right, 'a shared observation angle retains the horizontal gap and card order');
        for (const point of [...mainRect.points, ...sideRect.points]) {
          assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && point.scale > 0, 'both observed surfaces stay in front of the camera');
        }
        for (const card of [main, sidebar]) {
          const { left, right } = depthState(card);
          assert.ok(left >= 0 && left <= 1 && right >= 0 && right <= 1);
        }
        for (const copy of [heading, intro]) {
          assert.equal(copy.style.getPropertyValue('--chapter-light-left'), '');
          assert.equal(copy.style.getPropertyValue('--chapter-light-right'), '', 'material shading remains on black surfaces only');
        }
        if (x === 0 && y === 0) {
          const projection = [mainRect, sideRect, depthState(main), depthState(sidebar)];
          if (firstProjection) assert.deepEqual(projection, firstProjection, 'reversing the mouse restores the same observed planes and shading');
          else firstProjection = projection;
        }
      }
    }
  }
  const light = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  const card = light.journalPanels.main;
  const layout = panelLayout(card);
  light.jump(light.destination('about') + layout.left + layout.width / 2 - light.window.innerWidth / 2);
  assert.equal(depthState(card).yaw, 0);
  const sample = fraction => {
    const reads = light.layoutReads;
    movePointer(light, light.body, { clientX: fraction * light.window.innerWidth, clientY: light.window.innerHeight / 2 });
    light.advance(1000);
    assert.equal(light.layoutReads, reads);
    const { left, right } = depthState(card);
    return [left, right];
  };
  const facing = sample(1);
  const opposing = sample(0);
  assert.ok(facing[0] > opposing[0] && facing[1] < opposing[1], 'at equal pitch a surface turned toward the upper-left source gains reflection and loses shadow');
  for (const edge of [[-0.01, 0, 0.01], [1.01, 1, 0.99]]) {
    const [outside, boundary, inside] = edge.map(sample);
    assert.deepEqual(outside, boundary, 'clamping at a mouse boundary cannot jump the light');
    assert.ok(boundary.every((value, index) => Math.abs(value - inside[index]) <= 0.003), 'the first step inside the boundary changes reflection and shadow gently');
  }
  light.media.matches = true;
  light.media.dispatchEvent({ type: 'change' });
  assert.deepEqual(viewAngles(light), [0, 0]);
  assertFlatDepth(card, 'reduced motion clears observation, perspective and material together');
  assert.equal(light.pendingFrames, 0);
});

await test('ordinary presses and search editing freeze the entire interface without moving hit targets', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  movePointer(site, site.header);
  site.advance(1000);
  const frozen = interfaceOffsets(site);
  const frozenAngles = viewAngles(site);
  const reads = site.layoutReads;
  site.event('pointerdown', { target: site.header, pointerType: 'mouse', button: 0, isPrimary: true });
  movePointer(site, site.body, { clientX: 0, clientY: 0, buttons: 1 });
  site.advance(500);
  assert.deepEqual(interfaceOffsets(site), frozen);
  assert.deepEqual(viewAngles(site), frozenAngles);
  assert.equal(site.pendingFrames, 0);
  site.input.focus();
  site.event('focusin', { target: site.input });
  site.event('pointerup', { target: site.input, pointerType: 'mouse', isPrimary: true });
  site.input.value = 'space';
  for (const target of [site.body, site.header]) movePointer(site, target, { clientX: 0, clientY: 0 });
  site.event('pointerout', { target: site.header, relatedTarget: null });
  site.advance(500);
  assert.deepEqual(interfaceOffsets(site), frozen, 'editing keeps search controls still, even if the mouse leaves');
  assert.deepEqual(viewAngles(site), frozenAngles, 'search editing freezes the shared observation angle too');
  assert.equal(site.document.activeElement, site.input);
  assert.equal(site.input.value, 'space');
  assert.equal(site.pendingFrames, 0);
  site.document.activeElement = site.body;
  site.event('focusout', { target: site.input });
  site.advance(1000);
  assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(viewAngles(site), [0, 0]);
  movePointer(site, site.body);
  site.advance(1000);
  assert.deepEqual(interfaceOffsets(site), frozen, 'fresh input resumes after editing ends');
  site.event('pointerdown', { target: site.header, pointerType: 'mouse', button: 0 });
  site.event('pointerout', { target: site.header, relatedTarget: null });
  // An ordinary press released outside the browser may have no pointerup.
  movePointer(site, site.body, { clientX: 0, clientY: 0, buttons: 0 });
  site.advance(1000);
  assert.deepEqual(interfaceOffsets(site), [[-6, -3.75], [-8, -5], [-8, -5]], 'a released mouse sample recovers from a missed pointerup');
  assert.equal(site.layoutReads, reads);
});

await test('translated ruler presses and drags preserve exact coordinates while its layer stays frozen', () => {
  for (const operation of ['click', 'drag', 'remeasured-click']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    movePointer(site, site.body, { clientX: site.window.innerWidth * 0.7021, clientY: 500 });
    site.advance(1000);
    const frozen = interfaceOffsets(site);
    const frozenAngles = viewAngles(site);
    const navX = frozen[2][0];
    assert.notEqual(navX, 0);
    if (operation === 'remeasured-click') {
      site.input.focus();
      site.event('focusin', { target: site.input });
      site.event('site:revealed'); // measure while editing preserves the actual shifted ruler.
      assert.deepEqual(interfaceOffsets(site), frozen);
    }
    const reads = site.layoutReads;
    const before = site.top;
    const initialMarker = site.rulerLeft + navX + site.markerX;
    const destination = 1.413;
    const pressedX = operation === 'drag' ? initialMarker + 9
      : site.rulerLeft + navX + (destination + 0.5) / 4 * site.rulerWidth;
    markerPointer(site, 'pointerdown', pressedX, { target: operation === 'drag' ? site.progressHitbox : site.progressRail });
    assert.deepEqual(interfaceOffsets(site), frozen, 'stop and focus cannot reset a pressed ruler');
    assert.deepEqual(viewAngles(site), frozenAngles);
    assert.equal(site.top, before, 'pressing cannot jump the document before a drag or release');
    movePointer(site, site.header, { clientX: 0, clientY: 0, buttons: 1 });
    site.advance(200);
    assert.deepEqual(interfaceOffsets(site), frozen);
    if (operation === 'drag') {
      const end = pressedX + site.rulerWidth * 0.31;
      markerPointer(site, 'pointermove', end);
      site.advance(32);
      assert.deepEqual(interfaceOffsets(site), frozen, 'drag updates keep all interface layers at the grabbed pose');
      assert.deepEqual(viewAngles(site), frozenAngles, 'the shared camera cannot move while the ruler is grabbed');
      assert.ok(Math.abs(site.rulerLeft + navX + site.markerX - (end - 9)) < 0.001, 'the visual marker preserves the initial grabbed point');
      markerPointer(site, 'pointerup', end);
      assert.ok(Math.abs(site.top - (site.destination('about') + site.step * 1.24)) < 0.00001);
    } else {
      markerPointer(site, 'pointerup', pressedX);
      site.advance(700);
      assert.ok(Math.abs(site.top - (site.destination('about') + site.step * destination)) < 0.00001, 'rail click uses its translated visual origin, including after measurement');
    }
    assert.equal(site.progressMarker.hasPointerCapture(7), false);
    assert.equal(site.layoutReads, reads, 'mapping and dragging use cached ruler bounds');
    site.advance(1100);
    assert.equal(site.pendingFrames, 0);
    movePointer(site, site.body, { clientX: 0, clientY: 0 });
    site.advance(1000);
    assert.deepEqual(interfaceOffsets(site), [[-6, -3.75], [-8, -5], [-8, -5]], 'normal mouse movement resumes after release');
  }
});

await test('interrupted translated ruler drags clear the frozen pose and cannot leave a queued scrub behind', () => {
  for (const action of ['capture-lost', 'escape', 'reduced', 'coarse']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    movePointer(site, site.body);
    site.advance(1000);
    const start = site.rulerLeft + layerOffset(site.progress)[0] + site.markerX;
    markerPointer(site, 'pointerdown', start);
    markerPointer(site, 'pointermove', start + site.rulerWidth / 16);
    site.advance(32);
    const stoppedAt = site.top;
    markerPointer(site, 'pointermove', start + site.rulerWidth / 8);
    assert.equal(site.pendingFrames, 1);
    if (action === 'capture-lost') {
      site.progressMarker.releasePointerCapture(7);
      site.event('lostpointercapture', { target: site.progressMarker, pointerId: 7 });
    }
    if (action === 'escape') assert.equal(site.key('Escape', { target: site.progressMarker }).defaultPrevented, true);
    if (action === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (action === 'coarse') { site.pointerMedia.matches = false; site.pointerMedia.dispatchEvent({ type: 'change' }); }
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]], action);
    assert.deepEqual(viewAngles(site), [0, 0], action);
    assert.equal(site.progressMarker.hasPointerCapture(7), false);
    assert.equal(site.progress.classList.contains('is-scrubbing'), false);
    assert.equal(site.pendingFrames, 0, 'the pending drag sample is discarded');
    markerPointer(site, 'pointermove', 10000);
    site.advance(1000);
    assert.equal(site.top, stoppedAt, action);
    if (action === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
    if (action === 'coarse') { site.pointerMedia.matches = true; site.pointerMedia.dispatchEvent({ type: 'change' }); }
    movePointer(site, site.body);
    site.advance(1000);
    assert.deepEqual(interfaceOffsets(site), [[6, 3.75], [8, 5], [8, 5]], 'fresh mouse movement resumes after interruption');
    assert.equal(site.pendingFrames, 0);
  }
});

await test('whole-interface mouse parallax excludes unsupported devices and unavailable scenes', () => {
  for (const properties of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { buttons: 1 }, { isPrimary: false }]) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    movePointer(site, site.body);
    site.advance(48);
    assert.ok(layerOffset(site.track)[0] > 0);
    movePointer(site, site.body, properties);
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]]);
    assert.equal(site.pendingFrames, 0, JSON.stringify(properties));
  }
  for (const state of ['coarse', 'narrow', 'reduced', 'loading', 'menu', 'home']) {
    const site = browser({ url: 'https://gudu.blog/#' + (state === 'home' ? 'home' : 'about'),
      finePointer: state !== 'coarse', reduced: state === 'reduced', viewportWidth: state === 'narrow' ? 720 : 1200 });
    if (state === 'loading') site.html.classList.add('is-loading');
    if (state === 'menu') site.body.dataset.menuOpen = 'true';
    const before = { frames: site.requestedFrames, reads: site.layoutReads };
    movePointer(site, site.body);
    site.advance(1000);
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]], state);
    assert.deepEqual(viewAngles(site), [0, 0], state);
    assert.equal(site.requestedFrames, before.frames, state);
    assert.equal(site.layoutReads, before.reads);
  }
});

await test('scroll input clears whole-interface offsets without losing pending updates or Hero composition', () => {
  for (const action of ['external', 'wheel', 'keyboard', 'native']) {
    const site = browser({ url: 'https://gudu.blog/#' + (action === 'native' ? 'journal' : 'series') });
    const panel = site.panels[action === 'native' ? 2 : 1];
    movePointer(site, site.body);
    site.advance(48);
    const start = site.top;
    const reads = site.layoutReads;
    if (action === 'external') {
      site.window.scrollTo({ top: start + 123, behavior: 'instant' });
      assert.equal(site.pendingFrames, 1);
      site.event('focusin', { target: panel });
      assert.equal(site.pendingFrames, 1, 'mouse reset must retain a queued navigation update');
    }
    if (action === 'wheel') assert.equal(site.wheel(120, { target: panel }).defaultPrevented, true);
    if (action === 'keyboard') assert.equal(site.key('ArrowRight', { target: panel }).defaultPrevented, true);
    if (action === 'native') {
      assert.equal(site.wheel(100, { target: panel }).defaultPrevented, false);
      site.journal.scrollTop = 100;
      site.event('scroll', { target: site.journal });
    }
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]]);
    site.advance(1200);
    assert.equal(site.top, start + ({ external: 123, wheel: 120, keyboard: 100, native: 0 })[action]);
    assert.equal(site.x, -(site.top - site.destination('about')));
    assert.equal(site.journal.scrollTop, action === 'native' ? 100 : 0);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.layoutReads, reads);
    if (action !== 'native') assert.notEqual(parallaxX(panel), 0, 'independent scroll parallax continues');
  }
  const hero = browser({ url: 'https://gudu.blog/#about' });
  movePointer(hero, hero.body);
  hero.advance(1000);
  assert.match(hero.track.style.getPropertyValue('translate'), /^calc\(var\(--chapter-entrance-x, 0px\) \+ 6\.000px\)/, 'the moved parent composes with Hero displacement');
  hero.click(hero.link('#home'));
  assert.equal(hero.track.style.getPropertyValue('translate'), '', 'returning Hero clears inline translate so CSS controls entrance');
  assert.deepEqual(viewAngles(hero), [0, 0], 'Hero travel clears the pointer observation angle');
  hero.advance(680);
  assert.equal(hero.top, 0);
  hero.wheel(100);
  hero.advance(450);
  movePointer(hero, hero.body);
  assert.ok(entranceShift(hero) > 0, 'the ordinary Hero side entrance still runs');
  assert.equal(hero.track.style.getPropertyValue('translate'), '');
  hero.advance(450);
  assert.equal(hero.top, hero.destination('about'));
  movePointer(hero, hero.body);
  hero.advance(1000);
  assert.deepEqual(interfaceOffsets(hero), [[6, 3.75], [8, 5], [8, 5]]);
});

await test('whole-interface offsets clear even when frozen across device, layout and page lifecycle changes', () => {
  for (const action of ['cancel', 'blur', 'resize', 'hidden', 'pagehide', 'reduced', 'coarse', 'touch']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    movePointer(site, site.body);
    site.advance(48);
    site.event('pointerdown', { target: site.input, pointerType: 'mouse', button: 0 });
    site.input.focus();
    site.event('focusin', { target: site.input });
    assert.ok(layerOffset(site.track)[0] > 0);
    if (action === 'cancel') site.event('pointercancel', { pointerId: 9 });
    if (action === 'blur') site.event('blur');
    if (action === 'resize') site.resizeWidth(720);
    if (action === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (action === 'pagehide') site.event('pagehide');
    if (action === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (action === 'coarse') { site.pointerMedia.matches = false; site.pointerMedia.dispatchEvent({ type: 'change' }); }
    if (action === 'touch') site.event('pointerdown', { target: site.body, pointerType: 'touch', button: 0 });
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]], action);
    assert.deepEqual(viewAngles(site), [0, 0], action);
    for (const node of [site.track, site.header, site.progress]) assert.equal(node.style.getPropertyValue('translate'), '', action);
    assert.equal(site.pendingFrames, 0);
    const reads = site.layoutReads;
    const frames = site.requestedFrames;
    site.advance(1100);
    assert.equal(site.requestedFrames, frames);
    assert.equal(site.layoutReads, reads);
    if (action === 'resize') site.resizeWidth(1200);
    if (action === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); }
    if (action === 'pagehide') site.event('pageshow');
    if (action === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
    if (action === 'coarse') { site.pointerMedia.matches = true; site.pointerMedia.dispatchEvent({ type: 'change' }); }
    site.document.activeElement = site.body;
    site.advance(1100);
    assert.deepEqual(interfaceOffsets(site), [[0, 0], [0, 0], [0, 0]], 'resume does not replay an obsolete mouse position');
    assert.deepEqual(viewAngles(site), [0, 0], 'resume also clears the former observation angle');
    movePointer(site, site.body);
    site.advance(1000);
    assert.deepEqual(interfaceOffsets(site), [[6, 3.75], [8, 5], [8, 5]], action);
  }
});

await test('both exit edges withdraw early, hold through rest and jitter, and restore after a deliberate reversal', () => {
  for (const side of ['left', 'right']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    const chapter = side === 'left' ? site.series : site.journal;
    const thresholds = revealThresholds(site, chapter);
    moveToVisiblePixels(site, chapter, thresholds.enter + 1);
    assert.equal(revealState(chapter).departing, false, `${side}: a newly arriving sliver does not withdraw`);
    moveToVisiblePixels(site, chapter, thresholds.departure + 30, side);
    assert.equal(revealState(chapter).departing, false, `${side}: withdrawal waits for its edge threshold`);
    moveToVisiblePixels(site, chapter, thresholds.departure - 1, side);
    assert.deepEqual(revealState(chapter), {
      initialized: true, open: true, departing: true, closing: false,
      immediate: false, scanning: true, direction: side === 'left' ? '-1' : '1',
    });
    assert.equal(revealUnit(chapter).inert, false, `${side}: the partially withdrawn panel remains readable and interactive`);
    const scanWrites = () => site.domWrites.filter(write => write.target === revealUnit(chapter) && write.names?.includes('is-chapter-scanning')).length;
    const scanCount = scanWrites();
    const sectionWrites = () => site.domWrites.filter(write => write.target === revealUnit(chapter)).length;
    const writes = sectionWrites();
    const reads = site.layoutReads;
    site.event('popstate'); // Request another controller update at the same position.
    site.advance(32);
    assert.equal(revealState(chapter).departing, true, `${side}: a stationary update preserves the exit pose`);
    assert.equal(sectionWrites(), writes, `${side}: a stationary update does not rewrite reveal styles`);
    const frames = site.requestedFrames;
    site.advance(1600);
    assert.equal(sectionWrites(), writes);
    assert.equal(site.requestedFrames, frames, `${side}: CSS completion has no controller animation loop`);
    assert.deepEqual([site.pendingFrames, site.pendingTimers, site.layoutReads - reads], [0, 0, 0]);

    for (const remaining of [thresholds.departure, thresholds.departure - 1, thresholds.departure - 2]) {
      moveToVisiblePixels(site, chapter, remaining, side);
      assert.equal(revealState(chapter).departing, true, `${side}: one-pixel reversals retain the partial exit`);
    }
    const minimum = thresholds.departure - 70;
    moveToVisiblePixels(site, chapter, minimum, side);
    moveToVisiblePixels(site, chapter, minimum + 23, side);
    assert.equal(revealState(chapter).departing, true, `${side}: reversal is accumulated from the deepest exit`);
    moveToVisiblePixels(site, chapter, minimum + 25, side);
    assert.equal(revealState(chapter).departing, false, `${side}: a deliberate reversal restores the full panel`);
    assert.equal(revealState(chapter).open, true);
    assert.equal(scanWrites(), scanCount, `${side}: restoring a partial exit never replays the scanner`);

    moveToVisiblePixels(site, chapter, thresholds.exit + 1, side);
    assert.equal(revealState(chapter).departing, true, `${side}: the last readable slice keeps the partial pose`);
    assert.equal(revealUnit(chapter).inert, false);
    moveToVisiblePixels(site, chapter, thresholds.exit - 1, side);
    assert.equal(revealState(chapter).departing, false);
    assert.equal(revealState(chapter).closing, true);
    assert.equal(revealUnit(chapter).inert, true, `${side}: only the final closing slice loses interaction`);
    moveToVisiblePixels(site, chapter, 0.5, side);
    assert.equal(revealState(chapter).scanning, false, `${side}: fully leaving rearms the scanner`);
    moveToVisiblePixels(site, chapter, thresholds.enter + 1, side);
    assert.equal(revealState(chapter).departing, false);
    assert.equal(revealState(chapter).scanning, true, `${side}: a later visit gets its own scan`);
  }
});

await test('fully leaving the viewport rearms the scan and returning from the left uses the opposite reveal direction', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  const thresholds = revealThresholds(site, site.series);
  const scanAdds = () => site.domWrites.filter(write => write.target === revealUnit(site.series) && write.operation === 'add' && write.names?.includes('is-chapter-scanning')).length;
  moveToVisiblePixels(site, site.series, thresholds.enter + 1);
  assert.equal(scanAdds(), 1);
  moveToVisiblePixels(site, site.series, thresholds.exit - 1, 'left');
  assert.equal(revealState(site.series).closing, true);
  assert.equal(revealState(site.series).direction, '-1');
  moveToVisiblePixels(site, site.series, 0.5, 'left');
  assert.equal(revealState(site.series).open, false);
  assert.equal(revealState(site.series).scanning, false, 'leaving the screen clears the previous scan');
  moveToVisiblePixels(site, site.series, thresholds.enter - 1, 'left');
  assert.equal(revealState(site.series).open, false);
  moveToVisiblePixels(site, site.series, thresholds.enter + 1, 'left');
  assert.deepEqual(revealState(site.series), { initialized: true, open: true, departing: false, closing: false, immediate: false, scanning: true, direction: '-1' });
  assert.equal(scanAdds(), 2, 'a new visit gets exactly one new scan');
});

await test('fast cursor travel settles the visible destination without queuing skipped chapter reveals', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  moveToVisiblePixels(site, site.series, revealThresholds(site, site.series).enter + 1);
  assert.equal(revealState(site.series).scanning, true);
  moveToVisiblePixels(site, site.series, revealThresholds(site, site.series).departure - 1, 'left');
  assert.equal(revealState(site.series).departing, true);
  const grabbedX = site.rulerLeft + site.markerX;
  const currentPosition = (site.top - site.destination('about')) / site.step;
  const delta = (2 - currentPosition) * site.rulerWidth / 4;
  markerPointer(site, 'pointerdown', grabbedX);
  markerPointer(site, 'pointermove', grabbedX + delta);
  site.advance(16);
  markerPointer(site, 'pointerup', grabbedX + delta);
  assert.ok(Math.abs(site.top - site.destination('journal')) < 1e-6);
  for (const chapter of site.chapters.slice(1)) {
    assert.equal(revealState(chapter).immediate, true, `${chapter.id} does not trail behind a fast drag`);
    assert.equal(revealState(chapter).scanning, false, `${chapter.id} has no queued scanner`);
    assert.equal(revealState(chapter).departing, false, `${chapter.id} has no unfinished partial exit`);
  }
  assert.equal(revealState(site.journal).open, true, 'the destination is immediately readable');
  const frames = site.requestedFrames;
  site.advance(1600);
  assert.equal(site.requestedFrames, frames);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.pendingTimers, 0);
  moveToVisiblePixels(site, site.journal, revealThresholds(site, site.journal).exit - 1);
  assert.equal(revealState(site.journal).closing, true);
  assert.equal(revealState(site.journal).immediate, false, 'the next real state change resumes transitions');
  for (const settle of ['fast', 'resize']) {
    const partial = browser({ url: 'https://gudu.blog/#about' });
    const thresholds = revealThresholds(partial, partial.series);
    moveToVisiblePixels(partial, partial.series, thresholds.enter + 1);
    const scanAdds = () => partial.domWrites.filter(write => write.target === revealUnit(partial.series) && write.operation === 'add' && write.names?.includes('is-chapter-scanning')).length;
    assert.equal(scanAdds(), 1);
    if (settle === 'fast') {
      const target = partial.destination('about') + partial.series.offsetLeft + partial.series.offsetWidth - thresholds.between;
      partial.jump(target); // One large move leaves a visible slice below the opening threshold.
    } else partial.resizeWidth(600); // The same fractional position now leaves a smaller right preview.
    assert.equal(revealState(partial.series).immediate, true, settle);
    assert.equal(revealState(partial.series).open, false, settle);
    assert.equal(revealState(partial.series).scanning, false, settle);
    moveToVisiblePixels(partial, partial.series, revealThresholds(partial, partial.series).enter + 1, settle === 'fast' ? 'left' : 'right');
    assert.equal(revealState(partial.series).open, true, settle);
    assert.equal(revealState(partial.series).scanning, false, 'a partial preview has not left the screen and cannot rearm its scan');
    assert.equal(scanAdds(), 1, `${settle} preserves the already-seen state until the chapter fully leaves`);
  }
});

await test('hash, resize, motion preferences and page lifecycle settle panel states and clear unfinished scans', () => {
  const assertSettled = (site, preservingHiddenPose = false) => {
    for (const chapter of site.chapters.slice(1)) {
      assert.equal(revealState(chapter).immediate, true);
      assert.equal(revealState(chapter).scanning, false);
      if (!preservingHiddenPose) assert.equal(revealState(chapter).departing, false);
    }
  };
  const cases = ['hash', 'resize', 'reduced', 'hidden', 'pagehide', 'hero']
    .flatMap(action => ['open', 'departing'].map(phase => ({ action, phase })));
  for (const { action, phase } of cases) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    moveToVisiblePixels(site, site.series, revealThresholds(site, site.series).enter + 1);
    assert.equal(revealState(site.series).scanning, true);
    if (phase === 'departing') {
      moveToVisiblePixels(site, site.series, revealThresholds(site, site.series).departure - 1, 'left');
      assert.equal(revealState(site.series).departing, true, action);
    }
    if (action === 'hash') site.hash('#journal');
    if (action === 'resize') site.resizeWidth(2400);
    if (action === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (action === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (action === 'pagehide') site.event('pagehide');
    if (action === 'hero') site.hash('#home');
    // Hidden pages freeze their current pose without layout work; resume must
    // settle it before making the page visible again.
    assertSettled(site, action === 'hidden' || action === 'pagehide');
    if (action === 'hash') assert.equal(revealState(site.journal).open, true);
    if (action === 'resize') assert.equal(revealState(site.series).open, true, 'resizing settles using the newly measured visible width');
    if (action === 'reduced') {
      assert.equal(site.chapters.slice(1).every(chapter => revealState(chapter).open), true);
      site.media.matches = false;
      site.media.dispatchEvent({ type: 'change' });
      assertSettled(site);
      assert.equal(revealState(site.archive).open, false, 'restoring motion immediately returns distant panels to preview state');
    }
    if (action === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); assertSettled(site); }
    if (action === 'pagehide') { site.event('pageshow'); assertSettled(site); }
    if (action === 'hero') {
      assert.equal(site.chapters.slice(1).some(chapter => revealState(chapter).open), false);
      site.wheel(120);
      assert.equal(revealState(site.about).open, true, 'hero content is prepared before the first scroll frame');
      assert.equal(revealState(site.about).scanning, false, 'hero owns its entrance without a second scanner');
      site.advance(120);
      assert.equal(revealState(site.about).open, true, 'passing the viewport visibility threshold cannot change the content target');
      site.advance(880);
      assertSettled(site);
      assert.equal(revealState(site.about).open, true, 'the hero entrance settles the first readable chapter');
    }
    site.advance(1600);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.pendingTimers, 0);
  }
});

await test('main and sidebar cards reveal, withdraw and rearm independently using nested layout offsets', () => {
  const site = browser({ url: 'https://gudu.blog/#about', multiPanels: true });
  const { main, sidebar, stacked, heading, nestedHeading } = site.journalPanels;
  const mainEdges = revealThresholds(site, main);
  const sidebarEdges = revealThresholds(site, sidebar);
  const scans = unit => site.domWrites.filter(write => write.target === unit && write.operation === 'add' && write.names?.includes('is-chapter-scanning')).length;
  assert.equal(site.journal.classList.contains('has-chapter-reveal'), false, 'sections no longer own inherited reveal state');
  assert.equal(revealState(nestedHeading).initialized, false, 'a heading inside a black panel belongs to that panel animation');
  for (const unit of [main, sidebar, stacked, heading]) assert.equal(site.isObserved(unit), true, `${unit.id || 'loose heading'} is observed for geometry changes`);

  moveToVisiblePixels(site, main, mainEdges.enter + 1);
  assert.deepEqual([revealState(main).open, main.inert, revealState(sidebar).open, sidebar.inert], [true, false, false, true]);
  assert.equal(site.journal.inert, false, 'an invisible sidebar cannot deactivate its visible sibling');
  assert.deepEqual([scans(main), scans(sidebar), scans(stacked)], [1, 0, 0]);
  moveToVisiblePixels(site, sidebar, sidebarEdges.enter + 1);
  assert.deepEqual([revealState(main).open, revealState(sidebar).open, sidebar.inert], [true, true, false]);
  assert.deepEqual([scans(main), scans(sidebar), scans(stacked)], [1, 1, 0]);

  moveToVisiblePixels(site, main, mainEdges.departure - 1, 'left');
  assert.equal(revealState(main).departing, true);
  assert.equal(revealState(sidebar).departing, false, 'the fully visible sidebar does not follow the main card exit');
  const reads = site.layoutReads;
  site.jump(site.top + 1);
  assert.equal(site.layoutReads, reads, 'moving several cards uses cached geometry only');
  assert.equal(revealState(main).departing, true);
  moveToVisiblePixels(site, main, mainEdges.exit + 1, 'left');
  moveToVisiblePixels(site, main, Math.max(mainEdges.enter, mainEdges.exit + 25) + 1, 'left');
  assert.equal(revealState(main).departing, false);
  assert.equal(revealState(sidebar).open, true);
  assert.deepEqual([scans(main), scans(sidebar)], [1, 1], 'reversing one card cannot restart either scanner');

  moveToVisiblePixels(site, sidebar, 0.5);
  assert.deepEqual([revealState(main).open, revealState(sidebar).open, sidebar.inert], [true, false, true]);
  moveToVisiblePixels(site, sidebar, sidebarEdges.enter + 1);
  assert.deepEqual([scans(main), scans(sidebar)], [1, 2], 'only the card that fully left gets a second scan');
  assert.equal(stacked.inert, true, 'horizontal visibility cannot reveal a card below the internal viewport');

  site.resizeWidth(600);
  assert.equal(revealState(sidebar).scanning, false, 'resize settles independent cards without replaying a scan');
  const resizedEdges = revealThresholds(site, sidebar);
  assert.ok(resizedEdges.enter < sidebarEdges.enter, 'the narrower sidebar has a separately measured opening threshold');
  moveToVisiblePixels(site, sidebar, 0.5);
  moveToVisiblePixels(site, sidebar, resizedEdges.enter - 1);
  assert.equal(revealState(sidebar).open, false);
  moveToVisiblePixels(site, sidebar, resizedEdges.enter + 1);
  assert.equal(revealState(sidebar).open, true, 'resized offsets and width control the new threshold');
  assert.equal(sidebar.inert, false);
  assert.equal(stacked.inert, true);
});

await test('each panel comes forward at the edges and returns to its reading plane reversibly without extra layout or frames', () => {
  const edgeStates = [];
  for (const viewportWidth of [1200, 600]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { main, sidebar, heading } = site.journalPanels;
    assert.ok(Number.isFinite(depthState(main).yaw), 'the main reading card has a valid shared-arc pose');
    assert.ok(Math.abs(depthState(sidebar).yaw) > 0, 'the neighboring sidebar has its own off-center yaw');
    assert.ok(depthState(sidebar).z > 0, 'the neighboring sidebar comes forward independently');
    assert.equal(depthState(heading).yaw, depthState(main).yaw, 'the outside heading shares the main reading plane');
    assert.equal(heading.style.getPropertyValue('--chapter-light-left'), '', 'loose text has no panel material');
    assert.equal(site.journal.style.getPropertyValue('--chapter-depth-yaw'), '', 'the whole chapter is not transformed as one surface');
    assert.match(main.style.getPropertyValue('--chapter-depth-yaw'), /deg$/);
    assert.match(main.style.getPropertyValue('--chapter-depth-z'), /px$/);
    assert.match(main.style.getPropertyValue('--chapter-depth-x'), /px$/);
    assert.equal(main.style.getPropertyValue('--chapter-depth-drift'), '', 'the rigid plane has no separate interior drift');
    let worldCenter = site.journal.offsetLeft + main.offsetWidth / 2;
    for (let node = main; node !== site.journal; node = node.offsetParent) worldCenter += node.offsetLeft;
    const entry = site.destination('about');
    const atCenter = screenX => {
      const reads = site.layoutReads;
      const frames = site.requestedFrames;
      site.jump(entry + worldCenter - screenX);
      assert.equal(site.layoutReads, reads, 'positioning a panel reads no live geometry');
      assert.ok(site.requestedFrames - frames <= 1, 'a native position update needs only the existing controller frame');
      return depthState(main);
    };
    site.advance(1300);
    const right = atCenter(viewportWidth * 0.9);
    assert.ok(right.yaw < 0 && right.left > 0, 'the right-hand panel turns toward the fixed upper-left light');
    assert.ok(right.shift < 0, 'the right chord bends toward the shared arc center');
    const innerRight = atCenter(viewportWidth * 0.75);
    assert.ok(Math.abs(right.yaw) > Math.abs(innerRight.yaw) && Math.abs(innerRight.yaw) > 0, 'yaw approaches zero continuously on the way to the center');
    assert.ok(right.z > innerRight.z && innerRight.z > 0, 'the forward edge depth recedes toward the central reading plane');
    assert.ok(Math.abs(right.shift) > Math.abs(innerRight.shift) && innerRight.shift < 0, 'the arc displacement approaches zero on the way to the reading plane');
    for (const offset of [25, 0, -25]) {
      atCenter(viewportWidth / 2 + offset);
      assert.ok(Math.abs(depthState(main).yaw) < 3 && depthState(main).z < viewportWidth * 0.03, 'small central movements retain a gentle reading pose');
    }
    const left = atCenter(viewportWidth * 0.1);
    assert.ok(left.yaw > 0 && left.right > 0, 'the left-hand panel turns away from the light and develops a soft dark side');
    assert.ok(left.shift > 0 && Math.abs(left.shift + right.shift) < 0.001, 'the chord displacement mirrors continuously across the center');
    assert.ok(left.yaw * right.yaw < 0, 'the two sides tilt in opposite directions');
    assert.ok(Math.abs(left.yaw + right.yaw) < 0.001);
    assert.ok(Math.abs(left.z - right.z) < 0.001);
    assert.ok(right.left > left.left && right.right < left.right, 'one fixed light source illuminates facing surfaces more than opposing surfaces');
    for (const light of [left.left, left.right, right.left, right.right]) assert.ok(light >= 0 && light <= 1);
    assert.ok(right.left + right.right > 0, 'the off-center surface has a localized side light');
    assert.deepEqual(atCenter(viewportWidth * 0.9), right, 'returning to a coordinate restores the exact pose without easing history');
    edgeStates.push(right);
    const frames = site.requestedFrames;
    const writes = site.domWrites.length;
    site.advance(1600);
    assert.equal(site.requestedFrames, frames, 'depth has no animation loop after movement stops');
    assert.equal(site.domWrites.slice(writes).filter(write => write.target === main && write.name?.startsWith('--chapter-depth')).length, 0);
    assert.deepEqual([site.pendingFrames, site.pendingTimers], [0, 0]);
  }
  assert.ok(Math.abs(edgeStates[1].yaw) < Math.abs(edgeStates[0].yaw), 'mobile uses a gentler tilt');
  assert.ok(Math.abs(edgeStates[1].z) < Math.abs(edgeStates[0].z), 'mobile uses a shallower depth');
  assert.ok(Math.abs(edgeStates[1].shift) < Math.abs(edgeStates[0].shift), 'mobile uses a gentler arc displacement');
});

await test('outer panels keep changing their pose until the edge instead of plateauing while still visible', () => {
  for (const viewportWidth of [600, 1200, 3840]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth,
      initialPanelWidth: viewportWidth > 1200 ? viewportWidth * 0.78 : null });
    const { main, heading } = site.journalPanels;
    const layout = panelLayout(main);
    const center = layout.left + layout.width / 2;
    const offsetSpan = (viewportWidth + layout.width) / 2;
    const atOffset = offset => {
      const reads = site.layoutReads;
      const frames = site.requestedFrames;
      site.jump(site.destination('about') + center - (viewportWidth / 2 + offset * offsetSpan));
      assert.equal(site.layoutReads, reads);
      assert.ok(site.requestedFrames - frames <= 1);
      const { yaw, z, shift, span } = depthState(main);
      const text = depthState(heading);
      assert.deepEqual({ yaw: text.yaw, z: text.z, shift: text.shift, span: text.span }, { yaw, z, shift, span }, 'the outside heading follows the full owner curve');
      return { yaw, z, shift, span, ...cameraOffset(main) };
    };
    for (const direction of [1, -1]) {
      const poses = [0.7, 0.8, 0.9].map(offset => atOffset(direction * offset));
      assert.ok(Math.sign(poses[0].yaw) === -direction);
      for (let index = 1; index < poses.length; index++) {
        assert.ok(Math.abs(poses[index].yaw) > Math.abs(poses[index - 1].yaw), 'tilt keeps evolving across the outer visible range');
        assert.ok(poses[index].z > poses[index - 1].z, 'depth keeps approaching without the old outer plateau');
      }
      assert.deepEqual(atOffset(direction * 0.8), poses[1], 'reversal retraces the same outer pose');
      assert.deepEqual(atOffset(direction * 0.7), poses[0]);
    }
    atOffset(0);
    assert.equal(depthState(main).yaw, 0, 'the centered chord faces the reader');
    assert.equal(depthState(main).shift, 0, 'the centered chord has no sideways offset');
  }
});

await test('visible edge panels turn substantially and grow in both dimensions with no corner receding behind the reading plane', () => {
  for (const viewportWidth of [390, 600, 1200, 2551, 3840, 7680]) {
    for (const widthFraction of [0.35, 0.78]) {
      const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth,
        initialPanelWidth: viewportWidth * 0.82 });
      const main = site.panels[2];
      main.geometry = () => ({ left: 0, top: 100, width: viewportWidth * widthFraction, height: 600 });
      site.resizeWidth(viewportWidth);
      const layout = panelLayout(main);
      const center = layout.left + layout.width / 2;
      const atCenter = fraction => {
        const reads = site.layoutReads;
        const frames = site.requestedFrames;
        site.jump(site.destination('about') + center - viewportWidth * fraction);
        assert.equal(site.layoutReads, reads);
        assert.ok(site.requestedFrames - frames <= 1);
        const projected = projectedPanel(site, main, layout);
        for (const point of projected.points) {
          assert.ok(point.depth >= -0.01, 'every corner stays on or in front of the reading plane');
          assert.ok(Number.isFinite(point.scale) && point.scale >= 0.99999, 'no corner shrinks away from the viewer or crosses the camera');
        }
        return projected;
      };
      const reading = atCenter(0.5);
      for (const fraction of [0, 1]) {
        const edge = atCenter(fraction);
        assert.ok(edge.right > 0 && edge.left < viewportWidth, 'the tested turn is visible instead of already offscreen');
        assert.ok(Math.abs(depthState(main).yaw) >= 20, `the visible ${viewportWidth}px edge turns clearly`);
        assert.ok(edge.right - edge.left > (reading.right - reading.left) * 1.05, 'forward motion outweighs the width lost to rotation');
        assert.ok(edge.bottom - edge.top > (reading.bottom - reading.top) * 1.05, 'the same edge is visibly taller as it approaches');
      }
      for (const fraction of [0.1, 0.25, 0.75, 0.9]) atCenter(fraction);
    }
  }
});

await test('a visible wide panel keeps turning and growing smoothly when its outer edge crosses the former arc limit', () => {
  for (const viewportWidth of [390, 1200, 3840]) {
    const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth,
      initialPanelWidth: viewportWidth * 0.82 });
    const main = site.panels[2];
    main.geometry = () => ({ left: 0, top: 100, width: viewportWidth * 0.78, height: 600 });
    site.resizeWidth(viewportWidth);
    const layout = panelLayout(main);
    const worldCenter = layout.left + layout.width / 2;
    const compact = viewportWidth <= 720;
    const radius = viewportWidth * (compact ? 0.9 : 0.65);
    const flatWidth = viewportWidth * (compact ? 0.12 : 0.1);
    const oldLimitCenter = flatWidth + radius * 1.15 - layout.width / 2;
    const step = viewportWidth * 0.004;
    for (const direction of [1, -1]) {
      const samples = [-2, -1, 1, 2].map(offset => {
        const reads = site.layoutReads;
        const distance = oldLimitCenter + offset * step;
        site.jump(site.destination('about') + worldCenter - (viewportWidth / 2 + direction * distance));
        assert.equal(site.layoutReads, reads);
        const projected = projectedPanel(site, main, layout);
        assert.ok(projected.right > 0 && projected.left < viewportWidth, 'the inner portion is still visible across the former cutoff');
        return { turn: Math.abs(depthState(main).yaw), height: projected.bottom - projected.top };
      });
      for (const property of ['turn', 'height']) {
        const before = samples[1][property] - samples[0][property];
        const after = samples[3][property] - samples[2][property];
        assert.ok(before > 0 && after > 0, `${property} continues increasing instead of freezing at the former cutoff`);
        assert.ok(after / before > 0.9 && after / before < 1.1, `${property} keeps a continuous visible speed at ${viewportWidth}px`);
      }
    }
  }
});

await test('a surface wholly inside the flat arc center keeps its original reading geometry', () => {
  for (const viewportWidth of [390, 1200]) {
    const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth });
    const main = site.panels[2];
    main.geometry = () => ({ left: 0, top: 100, width: viewportWidth * 0.12, height: 600 });
    site.resizeWidth(viewportWidth);
    const layout = panelLayout(main);
    const center = layout.left + layout.width / 2;
    for (const fraction of [0.475, 0.5, 0.525]) {
      site.jump(site.destination('about') + center - viewportWidth * fraction);
      assert.deepEqual(depthGeometry(main), { yaw: 0, z: 0, shift: 0, span: 1 });
      const projected = projectedPanel(site, main, layout);
      assert.ok(Math.abs(projected.left - (layout.left + site.x)) < 0.001);
      assert.ok(Math.abs(projected.top - layout.top) < 0.001);
      assert.ok(Math.abs(projected.right - projected.left - layout.width) < 0.001);
      assert.ok(Math.abs(projected.bottom - projected.top - layout.height) < 0.001);
    }
  }
});

await test('only logical content overflow clips a chapter and enables its native reading viewport', () => {
  const site = browser({ url: 'https://gudu.blog/#about', multiPanels: true });
  const scrollable = chapter => chapter.classList.contains('is-chapter-scrollable');
  assert.equal(scrollable(site.about), false, 'fitting panels can extend their perspective past the chapter edges');
  assert.equal(scrollable(site.journal), true, 'lower stacked content retains its native reading viewport');

  site.about.scrollHeight = site.window.innerHeight + 300;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(scrollable(site.about), false, 'projection-inflated scrollHeight alone cannot clip a fitting chapter');
  site.about.paddingBottom = 104;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(scrollable(site.about), true, 'real bottom padding participates in the reading-height limit');
  site.about.paddingBottom = 0;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(scrollable(site.about), false, 'removing logical overflow restores the open projection');

  site.journal.clientHeight = 1600;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(scrollable(site.journal), false, 'a taller reading viewport can fit the same content');
  site.journal.clientHeight = site.window.innerHeight;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(scrollable(site.journal), true, 'resizing back preserves access to genuinely overflowing content');
  const reads = site.layoutReads;
  const writes = site.domWrites.length;
  site.wheel(120);
  site.advance(1600);
  assert.equal(site.layoutReads, reads, 'overflow classification does not add layout reads to scrolling');
  assert.equal(site.domWrites.slice(writes).filter(write => write.names?.includes('is-chapter-scrollable')).length, 0, 'perspective motion cannot repeatedly change clipping mode');
});

await test('projection-only overflow cannot swallow wheel, keyboard or touch movement over a fitting panel', () => {
  for (const viewportWidth of [600, 1200]) {
    for (const input of ['wheel', 'keyboard', 'touch']) {
      const site = browser({ url: 'https://gudu.blog/#series', viewportWidth });
      site.series.scrollHeight = site.window.innerHeight + 300;
      site.resizeWidth(viewportWidth);
      assert.equal(site.series.classList.contains('is-chapter-scrollable'), false);
      const target = site.panels[1];
      const originalTop = site.top;
      if (input === 'wheel') assert.equal(site.wheel(60, { target }).defaultPrevented, true);
      if (input === 'keyboard') assert.equal(site.key('ArrowDown', { target }).defaultPrevented, true);
      if (input === 'touch') {
        const finger = clientY => ({ clientX: 100, clientY });
        site.event('touchstart', { target, touches: [finger(600)] });
        assert.equal(site.event('touchmove', { target, touches: [finger(540)] }).defaultPrevented, true);
        site.event('touchend', { target, touches: [] });
      }
      site.advance(1000);
      assert.ok(site.top > originalTop, `${input} continues moving through the horizontal strip at ${viewportWidth}px`);
      assert.equal(site.series.scrollTop, 0, 'a fitting panel does not create an artificial vertical reading position');
      assert.equal(site.innerScrolls.length, 0);
    }
  }
});

await test('outside headings share their owner plane through reversible perspective without projecting nested copy twice', () => {
  const edgeStates = [];
  for (const viewportWidth of [1200, 600]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { main, heading, nestedHeading } = site.journalPanels;
    const layout = panelLayout(heading);
    const ownerLayout = panelLayout(main);
    const worldCenter = ownerLayout.left + ownerLayout.width / 2;
    const pose = () => {
      const { yaw, z, shift, span } = depthState(heading);
      return { yaw, z, shift, span, ...cameraOffset(heading) };
    };
    const atCenter = screenX => {
      const reads = site.layoutReads;
      const frames = site.requestedFrames;
      site.jump(site.destination('about') + worldCenter - screenX);
      assert.equal(site.layoutReads, reads, 'loose text uses the same cached layout as panels');
      assert.ok(site.requestedFrames - frames <= 1, 'loose text adds no animation chain');
      const { yaw, z, shift, span } = depthState(main);
      assert.deepEqual(pose(), { yaw, z, shift, span, ...cameraOffset(main) }, 'the label uses its owner pose and viewport camera');
      for (const [x, y] of [[0, 0], [layout.width, layout.height]]) {
        const actual = projectedPoint(site, heading, layout, x, y);
        const owner = projectedPoint(site, main, ownerLayout, x + layout.left - ownerLayout.left, y + layout.top - ownerLayout.top);
        assert.ok(Math.hypot(actual.x - owner.x, actual.y - owner.y) < 0.003, 'outside label corners remain on the exact owner plane');
      }
      return pose();
    };
    site.advance(1300);
    const right = atCenter(viewportWidth * 0.9);
    assert.ok(right.yaw < 0 && right.z > 0 && right.x < 0, 'incoming text tilts and approaches around the viewport camera');
    const inner = atCenter(viewportWidth * 0.75);
    assert.ok(Math.abs(inner.yaw) < Math.abs(right.yaw) && inner.z < right.z && inner.z > 0);
    const centered = atCenter(viewportWidth / 2);
    assert.equal(centered.yaw, 0, 'centered reading copy faces the reader on its owner chord');
    assert.equal(centered.shift, 0);
    const left = atCenter(viewportWidth * 0.1);
    assert.ok(left.yaw > 0 && left.z > 0 && left.x > 0, 'outgoing text follows the opposite perspective');
    assert.ok(Math.abs(left.yaw + right.yaw) < 0.001 && Math.abs(left.z - right.z) < 0.001);
    assert.ok(Math.abs(left.x + right.x) < 0.001, 'the viewport camera mirrors around the owner pivot');
    assert.deepEqual(atCenter(viewportWidth * 0.9), right, 'the text pose depends on its position, not scroll history');
    assert.equal(heading.style.getPropertyValue('--chapter-light-left'), '');
    assert.equal(heading.style.getPropertyValue('--chapter-light-right'), '');
    assert.equal(isCalibrating(heading), false, 'outside text never receives the panel material pulse');
    assert.equal(revealState(nestedHeading).initialized, false, 'copy inside a panel inherits that panel instead of becoming another surface');
    assert.equal(nestedHeading.style.getPropertyValue('--chapter-depth-yaw'), '');
    assert.equal(site.journal.style.getPropertyValue('--chapter-depth-yaw'), '', 'perspective remains independent per surface');
    const frames = site.requestedFrames;
    const writes = site.domWrites.length;
    site.advance(1600);
    assert.equal(site.requestedFrames, frames, 'settled text does not keep rendering');
    assert.equal(site.domWrites.slice(writes).filter(write => write.target === heading && write.name?.startsWith('--chapter-depth')).length, 0);
    edgeStates.push(right);
  }
  assert.ok(Math.abs(edgeStates[1].yaw) < Math.abs(edgeStates[0].yaw) && edgeStates[1].z < edgeStates[0].z, 'mobile text follows the gentler mobile perspective');
});

await test('journal title and intro follow separate surfaces without projecting or revealing their layout wrapper', () => {
  for (const viewportWidth of [1200, 721, 720, 600]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { main, sidebar, heading, intro, headingLayout, nestedHeading } = site.journalPanels;
    assert.equal(site.isObserved(heading), true);
    assert.equal(site.isObserved(intro), true, 'both text boxes can invalidate their own cached layout');
    for (const offset of [-0.3, 0, 0.3, -0.3]) {
      const reads = site.layoutReads;
      const frames = site.requestedFrames;
      site.jump(site.destination('journal') + site.step * offset);
      assert.equal(site.layoutReads, reads, 'independent text planes add no scroll-time geometry reads');
      assert.ok(site.requestedFrames - frames <= 1);
      assertOnOwnerPlane(site, heading, main);
      assertOnOwnerPlane(site, intro, viewportWidth <= 720 ? main : sidebar);
      if (viewportWidth > 720) {
        assert.notEqual(depthState(intro).yaw, depthState(heading).yaw, 'the right intro cannot inherit the wide main panel tilt');
      }
      for (const copy of [heading, intro]) {
        assert.equal(copy.style.getPropertyValue('--chapter-parallax-x'), '', 'outer text receives no interior drift');
        assert.equal(copy.style.getPropertyValue('--chapter-light-left'), '', 'outer text receives no panel material');
      }
    }
    for (const node of [headingLayout, nestedHeading]) {
      assert.equal(revealState(node).initialized, false, 'layout wrappers and text already inside a panel do not become surfaces');
      assert.equal(node.style.getPropertyValue('--chapter-depth-yaw'), '');
      assert.equal(node.style.getPropertyValue('--chapter-camera-x'), '');
      assert.equal(node.style.getPropertyValue('--chapter-parallax-x'), '');
      assert.equal(node.inert, false, 'the layout wrapper cannot suppress its independently visible children');
    }
  }
  const travel = browser({ url: 'https://gudu.blog/#about', multiPanels: true });
  const { heading, intro } = travel.journalPanels;
  moveToVisiblePixels(travel, heading, revealThresholds(travel, heading).enter + 1);
  assert.equal(revealState(heading).open, true);
  assert.equal(revealState(intro).open, false, 'the right intro waits until its own text box enters');
  moveToVisiblePixels(travel, intro, revealThresholds(travel, intro).enter + 1);
  assert.equal(revealState(intro).open, true);
  moveToVisiblePixels(travel, heading, revealThresholds(travel, heading).departure - 1, 'left');
  assert.equal(revealState(heading).departing, true);
  assert.equal(revealState(intro).departing, false, 'the right intro does not withdraw with the departing left title');
});

await test('the journal intro switches its owner at the stacking breakpoint and restores the desktop plane on resize', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth: 721 });
  site.jump(site.destination('journal') - site.step * 0.2);
  const { main, sidebar, heading, intro } = site.journalPanels;
  const pose = () => ({ ...depthState(intro), ...cameraOffset(intro),
    originX: intro.style.getPropertyValue('--chapter-depth-origin-x'),
    originY: intro.style.getPropertyValue('--chapter-depth-origin-y') });
  const original = pose();
  for (const width of [720, 390, 721]) {
    site.resizeWidth(width);
    assertOnOwnerPlane(site, heading, main);
    assertOnOwnerPlane(site, intro, width <= 720 ? main : sidebar);
    assert.ok(Math.abs((site.top - site.destination('journal')) / site.step + 0.2) < 0.00001, 'changing ownership preserves the horizontal reading coordinate');
    const frozen = pose();
    const reads = site.layoutReads;
    const frames = site.requestedFrames;
    site.journal.scrollTop = 12;
    site.event('scroll', { target: site.journal });
    site.advance(32);
    assert.equal(site.layoutReads, reads, 'native reading reuses the newly selected owner bounds');
    assert.ok(site.requestedFrames - frames <= 1);
    assert.equal(cameraOffset(intro).y, frozen.y + 12);
    assertOnOwnerPlane(site, intro, width <= 720 ? main : sidebar);
    site.journal.scrollTop = 0;
    site.event('scroll', { target: site.journal });
    site.advance(32);
    assert.deepEqual(pose(), frozen, 'native reading reversal preserves the selected plane');
  }
  assert.deepEqual(pose(), original, 'crossing back above 720px restores the exact original desktop pose and pivot');
});

await test('outside text perspective resets on reduced motion and page suspension and resumes without a stale pose', () => {
  for (const [viewportWidth, interruption] of [1200, 600].flatMap(width => ['reduced', 'hidden', 'pagehide'].map(action => [width, action]))) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth });
    const { heading, intro, headingLayout } = site.journalPanels;
    site.jump(site.destination('journal') - site.window.innerWidth * 0.4);
    const pose = () => [heading, intro].map(copy => {
      const { yaw, z, shift, span } = depthState(copy);
      return { yaw, z, shift, span, ...cameraOffset(copy) };
    });
    const original = pose();
    assert.ok(original.every(copy => copy.yaw < 0 && copy.z > 0), `${interruption} begins with both text parts on their angled planes`);
    if (interruption === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pagehide');
    assert.deepEqual(pose(), Array(2).fill({ yaw: 0, z: 0, shift: 0, span: 1, x: 0, y: 0 }), `${interruption} clears both independent text planes and cameras`);
    const frames = site.requestedFrames;
    const reads = site.layoutReads;
    site.advance(1600);
    assert.equal(site.requestedFrames, frames);
    assert.equal(site.layoutReads, reads);
    if (interruption === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pageshow');
    assert.deepEqual(pose(), original, `${interruption} resumes the text at its cached screen position`);
    assert.equal(headingLayout.style.getPropertyValue('--chapter-depth-yaw'), '', 'resuming never turns the layout wrapper into a second projection');
  }
});

await test('visible outside text keeps its owner plane current when the owner is vertically clipped', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  const { main, heading } = site.journalPanels;
  const width = main.offsetWidth;
  main.geometry = () => ({ left: 0, top: site.window.innerHeight * 2, width, height: 480 });
  site.resizeWidth(site.window.innerWidth);
  const ownerLayout = panelLayout(main);
  const textLayout = panelLayout(heading);
  const worldCenter = ownerLayout.left + ownerLayout.width / 2;
  const align = () => {
    const textPoint = projectedPoint(site, heading, textLayout, 0, 0);
    const ownerPoint = projectedPoint(site, main, ownerLayout, textLayout.left - ownerLayout.left, textLayout.top - ownerLayout.top);
    assert.ok(Math.hypot(textPoint.x - ownerPoint.x, textPoint.y - ownerPoint.y) < 0.003);
  };
  site.jump(site.destination('about') + worldCenter - site.window.innerWidth * 0.9);
  assert.equal(main.inert, true, 'the owner remains below the internal viewport');
  assert.equal(heading.inert, false, 'its separate heading is visible and readable');
  assert.ok(depthState(heading).yaw < 0);
  align();
  const originalCamera = cameraOffset(heading);
  const reads = site.layoutReads;
  site.journal.scrollTop = 20;
  site.event('scroll', { target: site.journal });
  site.advance(32);
  assert.equal(site.layoutReads, reads);
  assert.equal(cameraOffset(heading).y, originalCamera.y + 20, 'a clipped owner does not freeze its visible label camera');
  align();
  site.jump(site.destination('about') + worldCenter - site.window.innerWidth * 0.1);
  assert.ok(depthState(heading).yaw > 0, 'the owner-linked heading also updates across the horizontal center');
  assert.equal(main.inert, true);
  align();
});

await test('the shared arc preserves horizontal gaps without reading new geometry', () => {
  for (const viewportWidth of [600, 1200, 3840]) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth,
      initialPanelWidth: viewportWidth > 1200 ? viewportWidth * 0.78 : null });
    const { main, sidebar } = site.journalPanels;
    const mainLayout = panelLayout(main);
    const sideLayout = panelLayout(sidebar);
    const worldCenter = mainLayout.left + mainLayout.width / 2;
    for (const position of [-0.05, 0.1, 0.3, 0.5, 0.65]) {
      const reads = site.layoutReads;
      site.jump(site.destination('about') + worldCenter - viewportWidth * position);
      assert.equal(site.layoutReads, reads, 'perspective separation uses only the cached panel bounds');
      const mainRect = projectedPanel(site, main, mainLayout);
      const sideRect = projectedPanel(site, sidebar, sideLayout);
      assert.ok(sideRect.left - mainRect.right > 0, `horizontal cards retain a projected gap at ${viewportWidth}px / ${position}`);
      if (position === 0.5) {
        assert.equal(depthState(main).yaw, 0, 'the centered panel faces the reader');
        const growth = (mainRect.right - mainRect.left) / mainLayout.width;
        assert.ok(growth >= 1 && growth < 1.08, 'the reading pose retains a restrained size');
      }
      else if (depthState(main).z > 0) assert.equal(Math.sign(cameraOffset(main).x), Math.sign(0.5 - position), 'the camera stays at the shared view center');
      assert.equal(main.style.getPropertyValue('--chapter-depth-y'), '');
      assert.equal(parseFloat(main.style.getPropertyValue('--chapter-perspective')), Math.max(700, viewportWidth * 1.1));
    }
    const expected = cameraOffset(main);
    site.jump(site.destination('about') + worldCenter - viewportWidth * 0.3);
    site.jump(site.destination('about') + worldCenter - viewportWidth * 0.65);
    assert.deepEqual(cameraOffset(main), expected, 'reversing to the same screen position restores the same camera');
  }
});

await test('wide and tall stacked panels keep their projected gap through horizontal and native vertical travel', () => {
  for (const viewportWidth of [390, 3840]) {
    const compact = viewportWidth < 720;
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true, viewportWidth,
      viewportHeight: compact ? 844 : 2160,
      initialPanelWidth: compact ? null : viewportWidth * 0.78 });
    const { main, sidebar } = site.journalPanels;
    const cardWidth = compact ? 300 : 1200;
    const cardHeight = compact ? 220 : 1100;
    main.geometry = () => ({ left: 0, top: 0, width: cardWidth, height: cardHeight });
    sidebar.geometry = () => ({ left: 0, top: cardHeight + 16, width: cardWidth, height: cardHeight });
    site.resizeWidth(viewportWidth);
    const mainLayout = panelLayout(main);
    const sideLayout = panelLayout(sidebar);
    for (const side of ['right', 'left']) {
      moveToVisiblePixels(site, main, cardWidth * 0.05, side);
      const before = depthState(main);
      assert.ok(before.z > viewportWidth * 0.1, 'edge panels move substantially toward the viewer');
      assert.ok(Math.abs(before.yaw) >= 20 && Math.abs(before.yaw) < 66, 'wide panels visibly turn as one rigid face');
      let upper = projectedPanel(site, main, mainLayout);
      let lower = projectedPanel(site, sidebar, sideLayout);
      const assertGaps = () => {
        // Compare the same sides of the sloped edges. Axis-aligned bounding
        // boxes overlap on a tilted plane even when its polygons are separate.
        for (const [bottom, top] of [[3, 0], [2, 1]]) {
          assert.ok(Math.abs(upper.points[bottom].x - lower.points[top].x) < 0.003);
          const gap = lower.points[top].y - upper.points[bottom].y;
          assert.ok(gap >= 15.9, `stacked cards preserve a positive gap (${gap})`);
          assert.ok(Math.abs(gap - 16 * upper.points[bottom].scale) < 0.003, 'the gap grows only by the same perspective as its neighboring edge');
        }
      };
      assertGaps();
      const originalCamera = cameraOffset(main);
      const reads = site.layoutReads;
      site.journal.scrollTop = 40;
      site.event('scroll', { target: site.journal });
      site.advance(32);
      assert.equal(site.layoutReads, reads, 'vertical clearance updates from cached bounds and native scrollTop');
      assert.deepEqual(depthState(main), before, 'vertical reading does not alter the approved yaw or forward depth');
      assert.equal(cameraOffset(main).x, originalCamera.x);
      assert.equal(cameraOffset(main).y, originalCamera.y + 40, 'vertical reading retains the fixed viewport camera');
      upper = projectedPanel(site, main, mainLayout);
      lower = projectedPanel(site, sidebar, sideLayout);
      assertGaps();
      site.journal.scrollTop = 0;
      site.event('scroll', { target: site.journal });
      site.advance(32);
      assert.deepEqual(cameraOffset(main), originalCamera, 'reversing native reading restores the exact camera');
    }
    site.media.matches = true;
    site.media.dispatchEvent({ type: 'change' });
    assertFlatDepth(main, 'reduced motion clears perspective and the camera transform');
    assertFlatDepth(sidebar, 'reduced motion also clears the independently positioned stacked card');
  }
});

await test('motion preferences and suspension settle depth while hero phases join and leave the content pose continuously', () => {
  for (const interruption of ['reduced', 'blocked', 'hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
    const sidebar = site.journalPanels.sidebar;
    const original = depthState(sidebar);
    assert.ok(Math.abs(original.yaw) > 0, interruption);
    if (interruption === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'blocked') { site.html.classList.add('is-loading'); site.event('popstate'); site.advance(32); }
    if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pagehide');
    for (const panel of [...site.panels, sidebar, site.journalPanels.stacked]) assertFlatDepth(panel, `${interruption} settles every panel`);
    const frames = site.requestedFrames;
    const reads = site.layoutReads;
    site.advance(1600);
    assert.equal(site.requestedFrames, frames, `${interruption} cannot leave a depth animation running`);
    assert.equal(site.layoutReads, reads);
    if (interruption === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
    if (interruption === 'blocked') { site.html.classList.remove('is-loading'); site.event('popstate'); site.advance(32); }
    if (interruption === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pageshow');
    assert.deepEqual(depthState(sidebar), original, `${interruption} resumes the cached horizontal position without a stale pose`);
  }
  const hero = browser();
  assert.equal(entranceShift(hero), 0);
  for (const panel of hero.panels) assertFlatDepth(panel, 'the hero starts without panel depth');
  hero.wheel(120);
  const initialShift = entranceShift(hero);
  assert.ok(initialShift > hero.window.innerWidth, 'the assembled content starts beyond the side of the viewport');
  assert.equal(hero.viewport.inert, true, 'the entire moving viewport is inaccessible during the hero transition');
  assert.equal(revealState(hero.about).open, true, 'the main panel is assembled before its side-entry displacement becomes visible');
  const initialDepth = depthState(hero.about);
  assert.ok(initialDepth.z > 0 && initialDepth.yaw < 0 && initialDepth.shift < 0, 'the incoming panel starts near the viewer on the side of the arc');
  const geometryReads = hero.layoutReads;
  const animationFrames = hero.requestedFrames;
  const animationScrolls = hero.scrolls.length;
  hero.advance(450);
  const middleShift = entranceShift(hero);
  assert.ok(middleShift > 0 && middleShift < initialShift, 'the assembled content moves progressively into the viewport');
  assert.equal(hero.viewport.inert, true);
  const middleDepth = depthState(hero.about);
  assert.ok(middleDepth.z > 0 && middleDepth.z < initialDepth.z, 'the middle of the entrance is still in depth while receding toward the reading plane');
  assert.ok(middleDepth.yaw < -20, 'the visible side entrance turns clearly instead of remaining nearly frontal');
  assert.ok(middleDepth.shift < 0 && Math.abs(middleDepth.shift) < Math.abs(initialDepth.shift));
  const reference = browser({ url: 'https://gudu.blog/#journal' });
  reference.jump(reference.destination('journal') - middleShift);
  const screenMatchedDepth = depthState(reference.journal);
  for (const key of Object.keys(middleDepth)) {
    assert.ok(Math.abs(middleDepth[key] - screenMatchedDepth[key]) <= 0.011, `${key} follows the actual shifted screen position instead of a separate hero depth mix`);
  }
  hero.advance(350);
  assert.equal(hero.html.classList.contains('is-chapter-entering'), true);
  assert.equal(entranceShift(hero), 0, 'the slide joins the ordinary track before the final transition frame');
  assert.equal(hero.viewport.inert, true, 'an already aligned viewport still waits for the transition to finish');
  const reading = browser({ url: 'https://gudu.blog/#about' });
  assert.deepEqual(depthState(hero.about), depthState(reading.about), 'the main panel reaches its ordinary reading plane before the final hero frame');
  const joinedDepth = [depthState(hero.about), depthState(hero.series)];
  assert.ok(Math.abs(joinedDepth[1].yaw) > 0, 'the neighboring panel already has its ordinary off-center pose');
  hero.advance(100);
  assert.equal(hero.html.classList.contains('is-chapter-entering'), false);
  assert.equal(hero.viewport.inert, false, 'finishing the transition restores content interaction');
  assert.equal(entranceShift(hero), 0);
  assert.deepEqual([depthState(hero.about), depthState(hero.series)], joinedDepth, 'removing the hero transition cannot jump either panel at the endpoint');
  assert.equal(hero.layoutReads, geometryReads, 'hero depth uses existing cached geometry throughout the timeline');
  assert.ok(hero.requestedFrames - animationFrames <= hero.scrolls.length - animationScrolls + 1, 'depth adds no animation chain to the existing hero movement');
  hero.click(hero.link('#home'));
  assert.equal(entranceShift(hero), 0, 'the return starts at the ordinary track position');
  assert.equal(hero.viewport.inert, true);
  assert.deepEqual([depthState(hero.about), depthState(hero.series)], joinedDepth, 'returning begins at the same content pose');
  hero.advance(340);
  assert.equal(entranceShift(hero), middleShift, 'the same visual phase follows the same side-entry path in reverse');
  assert.deepEqual(depthState(hero.about), middleDepth, 'the same visual phase follows the same rigid-plane path in reverse');
  hero.advance(1000);
  assert.equal(entranceShift(hero), 0, 'return completion clears displacement after hiding the content');
  assert.equal(hero.viewport.inert, true, 'hidden content stays inaccessible on the hero');
  for (const panel of hero.panels) assertFlatDepth(panel);
  assert.equal(hero.pendingFrames, 0);
  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#journal', multiPanels: true });
  assertFlatDepth(reduced.journalPanels.sidebar, 'an initial hash with reduced motion is flat from the first render');
});

await test('native vertical reading reveals lower cards against the clipped viewport without moving their siblings or reading layout', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', multiPanels: true });
  const { main, sidebar, stacked, heading } = site.journalPanels;
  const readTo = top => {
    let steps = 0;
    while (site.journal.scrollTop !== top) {
      assert.ok(++steps < 100, 'the requested native reading position remains reachable');
      site.journal.scrollTop += Math.sign(top - site.journal.scrollTop) * Math.min(24, Math.abs(top - site.journal.scrollTop));
      site.event('scroll', { target: site.journal });
      site.advance(32);
    }
  };
  assert.deepEqual([revealState(main).open, revealState(sidebar).open, revealState(stacked).open], [true, true, false]);
  assert.equal(stacked.inert, true);
  assert.equal(revealState(heading).initialized, true, 'loose headings are independent reveal units');
  const horizontalDepth = [depthState(main), depthState(sidebar)];
  const reads = site.layoutReads;
  const horizontalPosition = site.top;
  // The lower panel starts at 100 + 740px in the nested wrapper. Its first
  // 36px must cross the 678px clipped bottom, not the 800px window boundary.
  readTo(197);
  assert.equal(revealState(stacked).open, false);
  readTo(199);
  assert.deepEqual([revealState(stacked).open, revealState(stacked).scanning, stacked.inert], [true, true, false]);
  assert.equal(revealState(main).departing, false);
  assert.equal(revealState(sidebar).departing, false);
  assert.equal(heading.inert, true, 'the loose heading above the clip becomes inert independently');
  readTo(325);
  assert.equal(revealState(main).departing, true, 'the main card begins exiting above the clipped viewport');
  assert.equal(revealState(stacked).departing, false, 'the incoming lower card keeps its own open state');
  assert.deepEqual([depthState(main), depthState(sidebar)], horizontalDepth, 'native vertical reading cannot alter either card horizontal depth');
  site.event('scroll', { target: site.journal });
  site.advance(32);
  assert.equal(revealState(main).departing, true, 'full horizontal visibility cannot reset a stationary vertical exit');
  readTo(324);
  assert.equal(revealState(main).departing, true, 'a vertical one-pixel reversal retains the exit pose');
  readTo(300);
  assert.equal(revealState(main).departing, false);
  assert.equal(revealState(stacked).scanning, true, 'restoring the upper panel leaves the lower scanner untouched');
  readTo(493);
  assert.equal(main.inert, true, 'the fully clipped upper card cannot expose links');
  assert.equal(sidebar.inert, true);
  assert.equal(stacked.inert, false, 'the visible lower card remains usable after both upper cards exit');
  assert.equal(site.journal.inert, false);
  assert.equal(site.top, horizontalPosition, 'native reading leaves the horizontal strip in place');
  assert.equal(site.layoutReads, reads, 'every native reading update uses cached target bounds and clip limits');
  const frames = site.requestedFrames;
  site.advance(1600);
  assert.equal(site.requestedFrames, frames);
  assert.deepEqual([site.pendingFrames, site.pendingTimers], [0, 0]);

  site.viewport.clientHeight = 700;
  site.event('resize');
  site.advance(32);
  readTo(270);
  assert.equal(revealState(stacked).open, false, 'the shorter stable viewport closes a lower card behind its bottom clip');
  readTo(299);
  assert.equal(revealState(stacked).open, true, 'the new 578px clipped bottom is used even while window.innerHeight stays 800');
  site.media.matches = true;
  site.media.dispatchEvent({ type: 'change' });
  assert.equal(revealState(stacked).scanning, false);
  assert.equal(revealState(main).departing, false);
});

await test('interaction events bracket real motion before its first step and after its final position', () => {
  for (const kind of ['hero', 'content']) {
    const site = browser({ url: kind === 'hero' ? 'https://gudu.blog/' : 'https://gudu.blog/#about' });
    assert.equal(site.interactionEvents.length, 0, 'initial hash positioning is not an animated interaction');
    const start = site.top;
    const scrollCount = site.scrolls.length;
    site.wheel(120);
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, kind]]);
    assert.equal(site.interactionEvents[0].top, start);
    assert.equal(site.interactionEvents[0].scrollCount, scrollCount, 'main is notified before the first controlled scroll');
    site.advance(80);
    assert.ok(site.top > start);
    site.wheel(80);
    site.advance(80);
    assert.equal(site.interactionEvents.length, 1, 'frames and repeated wheel inputs do not repeat active notifications');
    site.advance(1600);
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, kind], [false, kind]]);
    const end = site.interactionEvents.at(-1);
    assert.equal(end.top, kind === 'hero' ? site.destination('about') : site.destination('about') + 200);
    assert.equal(end.scrollCount, site.scrolls.length, 'the last scroll is committed before notifying main that drawing may resume');
    assert.equal(end.transform, site.track.style.getPropertyValue('transform'));
  }
  const navigation = browser({ url: 'https://gudu.blog/#about' });
  const beforeNavigation = navigation.scrolls.length;
  navigation.click(navigation.link('#archive'));
  assert.equal(navigation.interactionEvents[0].scrollCount, beforeNavigation, 'anchor activity is announced before its first scroll too');
  navigation.advance(80);
  navigation.resizeWidth(600);
  assert.deepEqual(navigation.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content']], 'resizing a continuing anchor animation keeps its activity uninterrupted');
  navigation.advance(1000);
  assert.deepEqual(navigation.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
  assert.equal(navigation.interactionEvents.at(-1).top, navigation.destination('archive'));
  assert.equal(navigation.interactionEvents.at(-1).scrollCount, navigation.scrolls.length);
});

await test('horizontal touches crossing the hero keep its camera active without changing drag behavior', () => {
  for (const distance of [300, 1000]) {
    const site = browser();
    const finger = x => ({ clientX: x, clientY: 600 });
    site.event('touchstart', { touches: [finger(1100)] });
    const beforeDrag = site.scrolls.length;
    assert.equal(site.event('touchmove', { touches: [finger(1100 - distance)] }).defaultPrevented, true);
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'hero']]);
    assert.equal(site.interactionEvents[0].scrollCount, beforeDrag, 'hero classification precedes the first drag step');
    assert.equal(site.html.classList.contains('is-chapter-entering'), false, 'a horizontal drag retains continuous movement instead of acquiring an entrance snap');
    site.advance(80);
    assert.ok(site.top > 0 && site.top < site.destination('about'), 'the initial path changes the hero camera even when its destination is content');
    site.advance(1200);
    assert.equal(site.top, distance, 'horizontal drag distance remains unchanged');
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'hero'], [false, 'hero']]);
    assert.equal(site.interactionEvents.at(-1).top, distance);
    site.event('touchend', { touches: [] });
    if (distance > site.destination('about')) {
      site.event('touchstart', { touches: [finger(400)] });
      site.event('touchmove', { touches: [finger(300)] });
      assert.equal(site.interactionEvents.at(-1).kind, 'content', 'a subsequent path entirely inside content may yield the background');
      site.advance(1200);
      assert.deepEqual(site.interactionEvents.slice(-2).map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
    }
  }
});

await test('retargeting and quick reversals switch interaction kind without a false inactive pulse', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  site.wheel(500);
  site.advance(80);
  site.click(site.link('#archive'));
  site.advance(80);
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content']]);
  site.click(site.link('#home'));
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [true, 'hero']]);
  site.advance(80);
  site.click(site.link('#series'));
  assert.equal(site.interactionEvents.length, 2, 'reversing a layered hero transition keeps one active hero interaction');
  site.advance(1200);
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [true, 'hero'], [false, 'hero']]);
  assert.equal(site.interactionEvents.at(-1).top, site.destination('series'));
});

await test('interruptions release interaction state after settling, without later reactivation', () => {
  for (const kind of ['hero', 'content']) {
    for (const interruption of ['hash', 'resize', 'hidden', 'pagehide', 'reduced']) {
      const site = browser({ url: kind === 'hero' ? 'https://gudu.blog/' : 'https://gudu.blog/#about' });
      site.wheel(300);
      site.advance(80);
      const staleFrames = site.queuedFrames();
      if (interruption === 'hash') site.hash('#journal');
      if (interruption === 'resize') site.resizeWidth(600);
      if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
      if (interruption === 'pagehide') site.event('pagehide');
      if (interruption === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
      assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, kind], [false, kind]], `${kind}: ${interruption}`);
      assert.equal(site.interactionEvents.at(-1).top, site.top, `${interruption} reports its settled position`);
      if (['hidden', 'pagehide'].includes(interruption)) for (const callback of staleFrames) callback(5000);
      site.advance(1600);
      assert.equal(site.interactionEvents.length, 2, 'canceled work never reopens the interaction');
      assert.equal(site.pendingFrames, 0);
    }
  }
});

await test('instant positioning, clamped movement and native reading do not claim controller activity', () => {
  const edge = browser({ url: 'https://gudu.blog/#archive' });
  edge.wheel(100);
  edge.advance(32);
  assert.equal(edge.interactionEvents.length, 0);
  assert.equal(edge.pendingFrames, 0, 'the end of the rail does not start an empty animation');
  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#about' });
  reduced.wheel(100);
  reduced.click(reduced.link('#archive'));
  assert.equal(reduced.interactionEvents.length, 0);
  const reading = browser({ url: 'https://gudu.blog/#journal' });
  assert.equal(reading.wheel(100, { target: reading.journal }).defaultPrevented, false);
  reading.event('scroll', { target: reading.journal });
  reading.event('touchstart', { target: reading.journal, touches: [{ clientX: 100, clientY: 400 }] });
  assert.equal(reading.interactionEvents.length, 0, 'native reading and a stationary touch are not horizontal animation');
  reading.event('touchend', { touches: [] });
  reading.wheel(100);
  reading.advance(64);
  reading.wheel(100, { target: reading.journal });
  assert.deepEqual(reading.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']], 'handing movement back to native reading releases the background');
});

function markerPointer(site, type, clientX, properties = {}) {
  return site.event(type, {
    target: site.progressMarker, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY: 700,
    ...properties,
  });
}

await test('the progress cursor drags continuously from its grabbed point, coalesces frames and flushes release without snapping', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#series' });
  const start = site.top;
  const markerStart = site.markerX;
  const grabbedX = site.rulerLeft + markerStart + 8;
  const stationWidth = site.rulerWidth / 4;
  assert.equal(markerPointer(site, 'pointerdown', grabbedX, { target: site.progressHitbox }).defaultPrevented, true);
  assert.equal(site.progressMarker.hasPointerCapture(7), true);
  assert.equal(site.top, start, 'grabbing off-center does not move the page');
  assert.equal(site.interactionEvents.length, 0, 'a stationary grip does not claim scene activity');
  const reads = site.layoutReads;
  const frames = site.requestedFrames;
  const scrolls = site.scrolls.length;
  markerPointer(site, 'pointermove', grabbedX + stationWidth * 0.15);
  markerPointer(site, 'pointermove', grabbedX + stationWidth * 0.37);
  assert.equal(site.top, start, 'pointer events wait for the shared animation frame');
  assert.equal(site.pendingFrames, 1, 'several pointer moves create one frame');
  site.advance(16);
  assert.ok(Math.abs(site.top - (start + site.step * 0.37)) < 1e-6);
  assert.ok(Math.abs(site.markerX - markerStart - stationWidth * 0.37) < 0.001);
  assert.equal(site.scrolls.length, scrolls + 1);
  assert.equal(site.requestedFrames, frames + 1);
  assert.equal(site.layoutReads, reads, 'drag updates use cached geometry');
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content']]);
  assert.equal(site.interactionEvents[0].scrollCount, scrolls, 'scene activity starts before committing the first dragged position');
  markerPointer(site, 'pointermove', grabbedX + stationWidth * 0.42);
  markerPointer(site, 'pointerup', grabbedX + stationWidth * 0.463);
  const destination = start + site.step * 0.463;
  assert.ok(Math.abs(site.top - destination) < 1e-6, 'release uses its final pointer position without waiting for another frame');
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.progressMarker.hasPointerCapture(7), false);
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
  assert.equal(site.interactionEvents.at(-1).top, site.top);
  assert.ok(Math.abs(Number(site.progressMarker.getAttribute('aria-valuenow')) - 100 * 1.463 / 3) < 0.51);
  assert.equal(site.url.search, '?q=space');
  site.advance(1400);
  assert.ok(Math.abs(site.top - destination) < 1e-6, 'a fractional chapter remains exactly where the cursor was released');
  assert.equal(site.layoutReads, reads);
});

await test('cursor drag endpoints are the first and last content panels and never expose the hero', () => {
  const site = browser({ url: 'https://gudu.blog/#series' });
  const startX = site.rulerLeft + site.markerX;
  markerPointer(site, 'pointerdown', startX);
  markerPointer(site, 'pointermove', -10000);
  site.advance(16);
  assert.equal(site.top, site.destination('about'));
  assert.equal(Number(site.progressMarker.getAttribute('aria-valuenow')), 0);
  assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
  assert.ok(Math.abs(site.markerX - site.rulerWidth / 8) < 0.001);
  markerPointer(site, 'pointermove', 10000);
  site.advance(16);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(Number(site.progressMarker.getAttribute('aria-valuenow')), 100);
  assert.ok(Math.abs(site.markerX - site.rulerWidth * 7 / 8) < 0.001);
  markerPointer(site, 'pointerup', 10000);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.interactionEvents.every(event => event.kind === 'content'), true);
});

await test('canceling or suspending a cursor drag releases capture and drops queued movement', () => {
  for (const interruption of ['pointercancel', 'lostpointercapture', 'blur', 'Escape', 'hidden', 'pagehide', 'resize']) {
    const site = browser({ url: 'https://gudu.blog/#series' });
    const startX = site.rulerLeft + site.markerX;
    markerPointer(site, 'pointerdown', startX);
    markerPointer(site, 'pointermove', startX + site.rulerWidth * 0.1);
    site.advance(16);
    const fraction = (site.top - site.destination('about')) / site.step;
    markerPointer(site, 'pointermove', startX + site.rulerWidth * 0.2);
    const queued = site.queuedFrames();
    if (interruption === 'pointercancel') markerPointer(site, 'pointercancel', startX);
    if (interruption === 'lostpointercapture') {
      site.progressMarker.releasePointerCapture(7);
      markerPointer(site, 'lostpointercapture', startX);
    }
    if (interruption === 'blur') site.event('blur');
    if (interruption === 'Escape') site.key('Escape', { target: site.progressMarker });
    if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pagehide');
    if (interruption === 'resize') site.resizeWidth(600);
    assert.equal(site.progressMarker.hasPointerCapture(7), false, `${interruption} releases pointer capture`);
    assert.equal(site.pendingFrames, 0, `${interruption} cancels queued drag frames`);
    assert.ok(Math.abs(site.top - (site.destination('about') + fraction * site.step)) < 1e-6, `${interruption} retains the last committed fractional position`);
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']], interruption);
    const stopped = site.top;
    for (const callback of queued) callback(5000);
    markerPointer(site, 'pointermove', 10000);
    markerPointer(site, 'pointerup', 10000);
    site.advance(1400);
    assert.equal(site.top, stopped, `${interruption} ignores late frames and pointer events`);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.pendingTimers, 0);
    if (interruption === 'pointercancel') {
      const restartedX = site.rulerLeft + site.markerX;
      markerPointer(site, 'pointerdown', restartedX);
      markerPointer(site, 'pointermove', restartedX + site.rulerWidth / 16);
      for (const callback of queued) callback(5000);
      assert.equal(site.top, stopped, 'a canceled callback cannot flush a newer drag early');
      assert.equal(site.pendingFrames, 1, 'the newer drag keeps its own scheduled frame');
      site.advance(16);
      assert.ok(Math.abs(site.top - (stopped + site.step / 4)) < 1e-6);
      markerPointer(site, 'pointerup', restartedX + site.rulerWidth / 16);
    }
  }
});

await test('a touch cursor drag owns its pointer without starting page gestures or accepting a second pointer', () => {
  const site = browser({ url: 'https://gudu.blog/#about', viewportWidth: 600 });
  const startX = site.rulerLeft + site.markerX;
  const start = site.top;
  assert.equal(markerPointer(site, 'pointerdown', startX, { button: 2 }).defaultPrevented, false);
  assert.equal(markerPointer(site, 'pointerdown', startX, { isPrimary: false, pointerId: 8 }).defaultPrevented, false);
  assert.equal(site.progressMarker.hasPointerCapture(8), false);
  markerPointer(site, 'pointerdown', startX, { pointerType: 'touch' });
  site.event('touchstart', { target: site.progressMarker, touches: [{ clientX: startX, clientY: 700 }] });
  site.event('touchmove', { target: site.progressMarker, touches: [{ clientX: startX, clientY: 500 }] });
  markerPointer(site, 'pointermove', 10000, { pointerId: 8, isPrimary: false, pointerType: 'touch' });
  assert.equal(site.pendingFrames, 0, 'native touch compatibility events and another finger cannot move the rail');
  assert.equal(site.top, start);
  markerPointer(site, 'pointermove', startX + site.rulerWidth / 8, { pointerType: 'touch' });
  site.wheel(200);
  site.advance(16);
  assert.ok(Math.abs(site.top - (start + site.step / 2)) < 1e-6, 'wheel input cannot alter the held cursor destination');
  markerPointer(site, 'pointerup', startX + site.rulerWidth / 8, { pointerType: 'touch' });
  site.event('touchend', { target: site.progressMarker, touches: [] });
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.progressMarker.hasPointerCapture(7), false);
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
});

await test('the slider keyboard moves by fine steps or whole chapters and keeps Home inside content', () => {
  for (const reduced of [false, true]) {
    const site = browser({ reduced, url: 'https://gudu.blog/?q=space#series' });
    const marker = site.progressMarker;
    marker.focus();
    const key = code => site.key(code, { target: marker });
    assert.equal(key('ArrowRight').defaultPrevented, true);
    assert.ok(Math.abs(site.top - (site.destination('series') + site.step / 20)) < 1e-6);
    key('PageUp');
    assert.ok(Math.abs(site.top - (site.destination('journal') + site.step / 20)) < 1e-6);
    key('PageDown');
    key('ArrowLeft');
    assert.ok(Math.abs(site.top - site.destination('series')) < 1e-6);
    key('End');
    assert.equal(site.top, site.destination('archive'));
    key('Home');
    assert.equal(site.top, site.destination('about'));
    key('ArrowLeft');
    assert.equal(site.top, site.destination('about'), 'the slider cannot cross back to the hero');
    assert.equal(site.document.activeElement, marker);
    assert.equal(site.url.search, '?q=space');
    assert.equal(site.pendingFrames, 0, 'keyboard slider values apply directly in either motion preference');
    assert.equal(site.html.classList.contains('is-chapter-entering'), false);
  }
});

await test('pressing the horizontal axis seeks between chapters and can continue dragging without a release jump', () => {
  const site = browser({ url: 'https://gudu.blog/?q=space#about' });
  const point = position => site.rulerLeft + (position + 0.5) * site.rulerWidth / 4;
  const top = position => site.destination('about') + site.step * position;
  const reads = site.layoutReads;
  const scrolls = site.scrolls.length;
  assert.equal(markerPointer(site, 'pointerdown', point(1.413), { target: site.progressRail }).defaultPrevented, true);
  assert.equal(site.top, site.destination('about'), 'the initial press waits to distinguish a click from a drag');
  assert.equal(site.interactionEvents.length, 0);
  assert.equal(site.progressMarker.hasPointerCapture(7), true);
  assert.equal(site.document.activeElement, site.progressMarker);
  markerPointer(site, 'pointermove', point(1.47), { target: site.progressRail });
  site.advance(16);
  assert.ok(Math.abs(site.top - top(1.47)) < 1e-6, 'the axis press becomes a normal captured drag');
  assert.ok(Math.abs(site.markerX + site.rulerLeft - point(1.47)) < 0.001, 'the triangle follows the dragged coordinate directly');
  assert.equal(site.interactionEvents[0].scrollCount, scrolls, 'background interaction starts before the position changes');
  markerPointer(site, 'pointerup', point(1.527), { target: site.progressRail });
  const released = site.top;
  assert.ok(Math.abs(released - top(1.527)) < 1e-6);
  assert.equal(site.progressTrack.style.getPropertyValue('--chapter-marker-x'), site.progressMarker.style.getPropertyValue('--chapter-marker-x'), 'local tick feedback follows the released position');
  const historyCount = site.historyEntries.length;
  assert.equal(site.click(site.progressRail).defaultPrevented, true, 'the release click is consumed by the horizontal axis');
  site.advance(1400);
  assert.equal(site.top, released, 'release does not snap to the nearest chapter center');
  assert.equal(site.historyEntries.length, historyCount, 'release cannot trigger a second chapter navigation');
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.layoutReads, reads, 'axis press and drag use cached ruler geometry');
  assert.equal(site.url.search, '?q=space');
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
});

await test('an axis click ignores small jitter and eases to its exact point without layout reads', () => {
  for (const jitter of [0, 5, -3]) {
    const site = browser({ url: 'https://gudu.blog/?q=space#about' });
    const start = site.top;
    const target = start + site.step * 1.413;
    const clientX = site.rulerLeft + 1.913 * site.rulerWidth / 4;
    const reads = site.layoutReads;
    markerPointer(site, 'pointerdown', clientX, { target: site.progressRail });
    markerPointer(site, 'pointermove', clientX + jitter, { target: site.progressRail });
    site.advance(64);
    assert.equal(site.top, start, 'jitter within five pixels is not a drag');
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.interactionEvents.length, 0);
    markerPointer(site, 'pointerup', clientX + jitter, { target: site.progressRail });
    assert.equal(site.top, start, 'the click starts moving only on subsequent frames');
    assert.equal(site.progressMarker.hasPointerCapture(7), false);
    assert.equal(site.pendingFrames, 1);
    assert.equal(site.click(site.progressRail).defaultPrevented, true);
    site.advance(16);
    assert.ok(site.top > start && site.top < start + (target - start) * 0.03, 'the first frame starts gently instead of jumping a large part of the distance');
    site.advance(80);
    assert.ok(site.top > start && site.top < target, 'a click has a visible intermediate position');
    site.advance(800);
    assert.ok(Math.abs(site.top - target) < 1e-6, 'the press position is retained while release jitter is ignored');
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.layoutReads, reads);
    assert.equal(site.url.search, '?q=space');
    assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
    assert.equal(site.interactionEvents.at(-1).top, site.top);
  }
});

await test('a release beyond the drag threshold commits directly while reduced motion clicks remain immediate', () => {
  const drag = browser({ url: 'https://gudu.blog/#about' });
  const point = position => drag.rulerLeft + (position + 0.5) * drag.rulerWidth / 4;
  markerPointer(drag, 'pointerdown', point(0.7), { target: drag.progressRail });
  markerPointer(drag, 'pointerup', point(1.27), { target: drag.progressRail });
  assert.ok(Math.abs(drag.top - (drag.destination('about') + drag.step * 1.27)) < 1e-6, 'release alone can reveal that the pointer crossed into dragging');
  assert.equal(drag.pendingFrames, 0);
  assert.equal(drag.progressMarker.hasPointerCapture(7), false);
  const reduced = browser({ reduced: true, url: 'https://gudu.blog/#about' });
  const clientX = reduced.rulerLeft + 1.913 * reduced.rulerWidth / 4;
  markerPointer(reduced, 'pointerdown', clientX, { target: reduced.progressRail });
  assert.equal(reduced.top, reduced.destination('about'));
  markerPointer(reduced, 'pointerup', clientX + 3, { target: reduced.progressRail });
  assert.ok(Math.abs(reduced.top - (reduced.destination('about') + reduced.step * 1.413)) < 1e-6);
  assert.equal(reduced.pendingFrames, 0, 'reduced motion skips the click tween');
});

await test('a new axis target, marker grab or wheel takes over a click tween without stale frames', () => {
  for (const takeover of ['axis', 'marker', 'wheel', 'marker-wheel']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    const point = position => site.rulerLeft + (position + 0.5) * site.rulerWidth / 4;
    markerPointer(site, 'pointerdown', point(2.6), { target: site.progressRail });
    markerPointer(site, 'pointerup', point(2.6), { target: site.progressRail });
    site.advance(96);
    const current = site.top;
    const stale = site.queuedFrames();
    assert.equal(stale.length, 1);
    let destination;
    if (takeover === 'axis') {
      markerPointer(site, 'pointerdown', point(0.137), { target: site.progressRail });
      assert.equal(site.top, current, 'retargeting starts from the displayed position');
      markerPointer(site, 'pointerup', point(0.137), { target: site.progressRail });
      destination = site.destination('about') + site.step * 0.137;
    } else if (takeover === 'marker') {
      const grabbedX = site.rulerLeft + site.markerX + 8;
      markerPointer(site, 'pointerdown', grabbedX);
      assert.equal(site.top, current, 'grabbing the moving triangle does not jump to its old destination');
      markerPointer(site, 'pointermove', grabbedX + site.rulerWidth / 16);
      destination = current + site.step / 4;
      for (const callback of stale) callback(5000);
      assert.equal(site.top, current, 'the retired click tween cannot flush the new drag');
      site.advance(16);
      markerPointer(site, 'pointerup', grabbedX + site.rulerWidth / 16);
    } else {
      site.wheel(120, { target: takeover === 'marker-wheel' ? site.progressMarker : site.body });
      destination = current + 120;
    }
    const beforeStale = site.top;
    const frames = site.pendingFrames;
    for (const callback of stale) callback(5000);
    assert.equal(site.top, beforeStale, `${takeover} rejects the retired click callback`);
    assert.equal(site.pendingFrames, frames, `${takeover} retains only its own animation chain`);
    site.advance(1200);
    assert.ok(Math.abs(site.top - destination) < 1e-6, `${takeover} finishes at the new target`);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.interactionEvents.at(-1).active, false);
  }
});

await test('click tweens stop on resize or page exit and finish their target only when hidden', () => {
  for (const interruption of ['resize', 'hidden', 'pagehide']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    const clientX = site.rulerLeft + 3.1 * site.rulerWidth / 4;
    markerPointer(site, 'pointerdown', clientX, { target: site.progressRail });
    markerPointer(site, 'pointerup', clientX, { target: site.progressRail });
    site.advance(96);
    const current = site.top;
    const fraction = (current - site.destination('about')) / site.step;
    const stale = site.queuedFrames();
    if (interruption === 'resize') site.resizeWidth(600);
    if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    if (interruption === 'pagehide') site.event('pagehide');
    const expected = interruption === 'hidden' ? site.destination('about') + site.step * 2.6
      : interruption === 'resize' ? site.destination('about') + site.step * fraction : current;
    assert.ok(Math.abs(site.top - expected) < 1e-6, interruption);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.progressMarker.hasPointerCapture(7), false);
    assert.equal(site.interactionEvents.at(-1).active, false);
    for (const callback of stale) callback(5000);
    site.advance(1400);
    assert.ok(Math.abs(site.top - expected) < 1e-6, `${interruption} cannot revive an old tween`);
    assert.equal(site.pendingFrames, 0);
  }
});

await test('clicking a Chinese or English chapter label centers that chapter and transfers focus', () => {
  for (const selector of ['.chapter-station-title', '.chapter-station-subtitle']) {
    const site = browser({ url: 'https://gudu.blog/?q=space#about' });
    for (const [index, link] of site.navLinks.entries()) {
      site.jump(site.destination('about') + site.step * (index === 3 ? 2.63 : index + 0.37));
      const label = link.querySelector(selector);
      assert.ok(label?.textContent, 'the fixture targets the actual visible text child');
      assert.equal(site.click(label).defaultPrevented, true);
      site.advance(1000);
      const chapter = site.chapters[index + 1];
      assert.equal(site.top, site.destination(chapter.id));
      assert.ok(Math.abs(site.markerX - (index + 0.5) * site.rulerWidth / 4) < 0.001);
      assert.equal(site.document.activeElement, chapter);
      assert.equal(site.url.hash, `#${chapter.id}`);
      assert.equal(site.url.search, '?q=space');
      assert.equal(site.progressMarker.hasPointerCapture(7), false, 'text links do not start axis dragging');
    }
  }
});

await test('the outer half-cells of the horizontal axis clamp to the first and last chapter centers', () => {
  for (const viewportWidth of [360, 1200, 2400]) {
    const site = browser({ url: 'https://gudu.blog/#series', viewportWidth });
    const cases = [[0, 'about', 0], [1 / 8 - 0.01, 'about', 0], [7 / 8 + 0.01, 'archive', 3], [1, 'archive', 3]];
    for (const [fraction, id, position] of cases) {
      const clientX = site.rulerLeft + site.rulerWidth * fraction;
      const before = site.top;
      markerPointer(site, 'pointerdown', clientX, { target: site.progressRail });
      assert.equal(site.top, before, 'pressing an edge does not jump before release');
      markerPointer(site, 'pointerup', clientX);
      assert.equal(site.top, before, 'click release starts smooth movement instead of a jump');
      site.advance(1600);
      assert.ok(Math.abs(site.top - site.destination(id)) < 1e-6);
      assert.ok(Math.abs(site.markerX - (position + 0.5) * site.rulerWidth / 4) < 0.001);
      assert.equal(Number(site.progressMarker.getAttribute('aria-valuenow')), position / 3 * 100);
      assert.equal(site.html.classList.contains('is-chapter-leaving'), false);
      assert.equal(site.pendingFrames, 0);
    }
    for (const [startFraction, center, inside] of [[0, 0, 0.375], [1, 3, 2.625]]) {
      const point = position => site.rulerLeft + (position + 0.5) * site.rulerWidth / 4;
      markerPointer(site, 'pointerdown', site.rulerLeft + startFraction * site.rulerWidth, { target: site.progressRail });
      markerPointer(site, 'pointermove', point(center), { target: site.progressRail });
      site.advance(16);
      assert.ok(Math.abs(site.top - (site.destination('about') + center * site.step)) < 1e-6, 'dragging from an outer half-cell to its first center must not retain a half-cell offset');
      assert.ok(Math.abs(site.markerX + site.rulerLeft - point(center)) < 0.001);
      markerPointer(site, 'pointermove', point(inside), { target: site.progressRail });
      site.advance(16);
      assert.ok(Math.abs(site.top - (site.destination('about') + inside * site.step)) < 1e-6, 'continuing inward keeps the triangle under the actual pointer coordinate');
      assert.ok(Math.abs(site.markerX + site.rulerLeft - point(inside)) < 0.001);
      markerPointer(site, 'pointerup', point(inside), { target: site.progressRail });
      assert.equal(site.pendingFrames, 0);
    }
  }
});

await test('touching the horizontal axis survives compatibility touch events and retains its captured drag', () => {
  const site = browser({ url: 'https://gudu.blog/#about', viewportWidth: 600 });
  const point = position => site.rulerLeft + (position + 0.5) * site.rulerWidth / 4;
  markerPointer(site, 'pointerdown', point(1.62), { target: site.progressRail, pointerType: 'touch' });
  const pressed = site.top;
  assert.equal(pressed, site.destination('about'), 'touch press also waits for click or drag intent');
  site.event('touchstart', { target: site.progressRail, touches: [{ clientX: point(1.62), clientY: 700 }] });
  site.event('touchmove', { target: site.progressRail, touches: [{ clientX: point(1.62), clientY: 500 }] });
  assert.equal(site.progressMarker.hasPointerCapture(7), true, 'touchstart on the axis cannot cancel the pointer drag');
  assert.equal(site.top, pressed);
  assert.equal(site.pendingFrames, 0, 'compatibility touch events cannot start another movement controller');
  markerPointer(site, 'pointermove', point(1.72), { target: site.progressRail, pointerType: 'touch' });
  site.advance(16);
  assert.ok(Math.abs(site.top - (site.destination('about') + site.step * 1.72)) < 1e-6);
  markerPointer(site, 'pointerup', point(1.715), { target: site.progressRail, pointerType: 'touch' });
  site.event('touchend', { target: site.progressRail, touches: [] });
  assert.ok(Math.abs(site.top - (site.destination('about') + site.step * 1.715)) < 1e-6);
  assert.equal(site.progressMarker.hasPointerCapture(7), false);
  assert.equal(site.pendingFrames, 0);
  assert.deepEqual(site.interactionEvents.map(event => [event.active, event.kind]), [[true, 'content'], [false, 'content']]);
});

await test('horizontal axis input cannot interrupt the hero, layered entrance or a blocked page', () => {
  for (const state of ['hero', 'entering', 'leaving', 'loading', 'menu', 'hidden']) {
    const site = browser({ url: ['hero', 'entering'].includes(state) ? 'https://gudu.blog/' : 'https://gudu.blog/#series' });
    if (state === 'entering') { site.wheel(120); site.advance(80); }
    if (state === 'leaving') { site.click(site.link('#home')); site.advance(80); }
    if (state === 'loading') site.html.classList.add('is-loading');
    if (state === 'menu') site.body.dataset.menuOpen = 'true';
    if (state === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
    const before = [site.top, site.scrolls.length, site.pendingFrames, site.interactionEvents.length];
    const clientX = site.rulerLeft + site.rulerWidth * 0.8;
    assert.equal(markerPointer(site, 'pointerdown', clientX, { target: site.progressRail }).defaultPrevented, false, state);
    markerPointer(site, 'pointermove', clientX + 80, { target: site.progressRail });
    markerPointer(site, 'pointerup', clientX + 80, { target: site.progressRail });
    assert.equal(site.progressMarker.hasPointerCapture(7), false, state);
    assert.deepEqual([site.top, site.scrolls.length, site.pendingFrames, site.interactionEvents.length], before, `${state} preserves its existing navigation`);
  }
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
  assert.equal(site.progress.style.getPropertyValue('--chapter-active-index'), '1');
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

await test('Hero panels calibrate only after arrival and share the existing idle timer without layout or frames', () => {
  const site = browser();
  site.wheel(120);
  site.advance(899);
  assert.equal(site.panels.some(isCalibrating), false, 'an assembled side entrance never calibrates while moving');
  site.advance(1);
  assert.equal(site.pendingFrames, 0);
  const reads = site.layoutReads;
  const frames = site.requestedFrames;
  site.advance(119);
  assert.equal(isCalibrating(site.about), false, 'arrival waits for a short quiet period');
  site.advance(1);
  assert.equal(isCalibrating(site.about), true);
  assert.equal(site.panels.slice(1).some(isCalibrating), false, 'distant and partial preview panels do not calibrate');
  assert.equal(calibrationCount(site, site.about), 1);
  assert.equal(site.pendingTimers, 1, 'the same idle timeout now waits for the ruler');
  assert.equal(site.progress.classList.contains('is-chapter-idle'), false);
  site.advance(879);
  assert.equal(site.progress.classList.contains('is-chapter-idle'), false);
  site.advance(1);
  assert.equal(site.progress.classList.contains('is-chapter-idle'), true, 'ruler idle still starts one second after arrival');
  site.advance(5000);
  assert.equal(site.pendingTimers, 0);
  assert.equal(site.pendingFrames, 0);
  assert.equal(site.requestedFrames, frames, 'CSS calibration does not create an animation loop');
  assert.equal(site.layoutReads, reads, 'calibration uses existing visibility state');
  assert.equal(calibrationCount(site, site.about), 1, 'a stationary panel does not repeat its calibration');

  site.click(site.link('#home'));
  assert.equal(site.panels.some(isCalibrating), false, 'returning to Hero cancels the current calibration immediately');
  site.advance(680);
  site.click(site.navLinks[0]);
  site.advance(900);
  site.advance(120);
  assert.equal(calibrationCount(site, site.about), 2, 'a later Hero entrance is a new panel visit');
});

await test('wheel, chapter navigation and rail seeking never calibrate panels before motion actually settles', () => {
  for (const input of ['wheel', 'link', 'rail']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    if (input === 'wheel') site.wheel(site.step);
    if (input === 'link') site.click(site.navLinks[1]);
    if (input === 'rail') {
      const point = site.rulerLeft + site.rulerWidth * 1.5 / 4;
      markerPointer(site, 'pointerdown', point, { target: site.progressRail });
      markerPointer(site, 'pointerup', point, { target: site.progressRail });
    }
    let ticks = 0;
    while (site.pendingFrames) {
      site.advance(16);
      assert.equal(site.panels.some(isCalibrating), false, `${input}: movement cannot trigger a stationary calibration`);
      assert.ok(++ticks < 150, `${input}: the interaction finishes`);
    }
    assert.ok(Math.abs(site.top - site.destination('series')) < 0.01);
    const reads = site.layoutReads;
    const frames = site.requestedFrames;
    site.advance(119);
    assert.equal(isCalibrating(site.series), false, input);
    site.advance(1);
    assert.equal(isCalibrating(site.series), true, `${input}: the destination calibrates after settling`);
    assert.equal(site.layoutReads, reads);
    assert.equal(site.requestedFrames, frames);
  }
});

await test('main, sidebar and vertically stacked panels calibrate independently of their chapter and loose labels', () => {
  const site = browser({ url: 'https://gudu.blog/#about', multiPanels: true });
  const { main, sidebar, stacked, heading, nestedHeading } = site.journalPanels;
  moveToVisiblePixels(site, main, main.offsetWidth * 0.6);
  site.advance(140);
  assert.equal(isCalibrating(main), true);
  assert.equal(isCalibrating(sidebar), false, 'a visible main card does not activate its offscreen neighbor');
  assert.equal(isCalibrating(stacked), false, 'a card below the vertical clipping boundary waits');
  assert.equal(isCalibrating(heading), false);
  assert.equal(isCalibrating(nestedHeading), false);
  assert.equal(site.journal.classList.contains('is-chapter-calibrating'), false, 'calibration belongs to individual surfaces');

  moveToVisiblePixels(site, sidebar, sidebar.offsetWidth * 0.6);
  site.advance(140);
  assert.equal(isCalibrating(sidebar), true);
  assert.equal(calibrationCount(site, main), 1, 'an already visited sibling does not replay');
  assert.equal(calibrationCount(site, sidebar), 1);
  assert.equal(calibrationCount(site, stacked), 0);

  site.journal.scrollTop = 400;
  site.document.dispatchEvent({ type: 'scroll', target: site.journal });
  site.advance(180);
  assert.equal(isCalibrating(stacked), true, 'native vertical reading gives the newly visible card its own calibration');
  assert.equal(isCalibrating(main), false);
  assert.equal(isCalibrating(sidebar), false);
  assert.deepEqual([calibrationCount(site, main), calibrationCount(site, sidebar), calibrationCount(site, stacked)], [1, 1, 1]);
});

await test('small movements and reversals do not replay calibration, while completely leaving rearms only that panel', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  moveToVisiblePixels(site, site.series, revealUnit(site.series).offsetWidth * 0.7);
  site.advance(140);
  assert.equal(calibrationCount(site, site.series), 1);
  assert.equal(revealState(site.series).scanning, false, 'calibration retires the old entrance scanner');
  const scans = () => site.domWrites.filter(write => write.target === revealUnit(site.series) && write.operation === 'add'
    && write.names?.includes('is-chapter-scanning')).length;
  const previousScans = scans();
  const settled = site.top;
  site.jump(settled + 12);
  assert.equal(isCalibrating(site.series), false, 'new activity cancels an active calibration');
  site.advance(200);
  site.jump(settled);
  site.advance(200);
  assert.equal(calibrationCount(site, site.series), 1, 'a short direction reversal keeps the same visit');
  assert.equal(scans(), previousScans, 'canceling calibration does not restart the retired entrance scan');

  moveToVisiblePixels(site, site.series, 0.5, 'left');
  assert.equal(isCalibrating(site.series), false);
  moveToVisiblePixels(site, site.series, revealUnit(site.series).offsetWidth * 0.7, 'left');
  site.advance(140);
  assert.equal(calibrationCount(site, site.series), 2, 'returning after full departure starts one new calibration');
});

await test('held cursor grabs and touches defer pending calibration until release', () => {
  for (const input of ['cursor', 'touch']) {
    const site = browser({ url: 'https://gudu.blog/#about' });
    let release;
    if (input === 'cursor') {
      const start = site.rulerLeft + site.markerX;
      const end = start + site.rulerWidth / 4;
      markerPointer(site, 'pointerdown', start);
      markerPointer(site, 'pointermove', end);
      site.advance(16);
      release = () => markerPointer(site, 'pointerup', end);
    } else {
      moveToVisiblePixels(site, site.series, revealUnit(site.series).offsetWidth * 0.7);
      site.event('touchstart', { target: site.series, touches: [{ clientX: 300, clientY: 400 }] });
      release = () => site.event('touchend', { touches: [] });
    }
    site.advance(1500);
    assert.equal(isCalibrating(site.series), false, `${input}: a stationary held interaction is still active`);
    assert.equal(calibrationCount(site, site.series), 0);
    assert.equal(site.pendingFrames, 0);
    assert.equal(site.pendingTimers, 0, 'no polling timer waits for release');
    release();
    site.advance(119);
    assert.equal(isCalibrating(site.series), false);
    site.advance(1);
    assert.equal(isCalibrating(site.series), true, `${input}: release starts the quiet period`);
  }
});

await test('instant positioning and page lifecycle changes cancel calibration without replaying delayed tails', () => {
  for (const interruption of ['hash', 'resize', 'hidden', 'pagehide', 'reduced']) {
    for (const timing of ['pending', 'active']) {
      const site = browser({ url: 'https://gudu.blog/#about' });
      moveToVisiblePixels(site, site.series, revealUnit(site.series).offsetWidth * 0.7);
      if (timing === 'active') site.advance(140);
      assert.equal(isCalibrating(site.series), timing === 'active');
      if (interruption === 'hash') site.hash('#journal');
      if (interruption === 'resize') site.resizeWidth(600);
      if (interruption === 'hidden') { site.document.hidden = true; site.event('visibilitychange'); }
      if (interruption === 'pagehide') site.event('pagehide');
      if (interruption === 'reduced') { site.media.matches = true; site.media.dispatchEvent({ type: 'change' }); }
      assert.equal(site.panels.some(isCalibrating), false, `${interruption}/${timing}: cancellation is immediate`);
      const counts = site.panels.map(panel => calibrationCount(site, panel));
      if (['hidden', 'pagehide', 'reduced'].includes(interruption)) assert.equal(site.pendingTimers, 0);
      site.advance(1500);
      assert.deepEqual(site.panels.map(panel => calibrationCount(site, panel)), counts, `${interruption}/${timing}: canceled work has no delayed tail`);
      if (interruption === 'hidden') { site.document.hidden = false; site.event('visibilitychange'); }
      if (interruption === 'pagehide') site.event('pageshow');
      if (interruption === 'reduced') { site.media.matches = false; site.media.dispatchEvent({ type: 'change' }); }
      site.advance(1500);
      assert.deepEqual(site.panels.map(panel => calibrationCount(site, panel)), counts, `${interruption}/${timing}: restoration settles already visible surfaces`);
      assert.equal(site.pendingFrames, 0);
      assert.equal(site.pendingTimers, 0);
    }
  }
  for (const reduced of [false, true]) {
    const site = browser({ reduced, url: 'https://gudu.blog/#journal' });
    site.advance(1500);
    assert.equal(site.panels.some(isCalibrating), false, 'an initial hash is a settled view');
    if (reduced) {
      site.click(site.navLinks[1]);
      site.advance(1500);
      assert.equal(site.panels.some(isCalibrating), false, 'reduced motion never plays a calibration');
      assert.equal(site.pendingTimers, 0);
      assert.equal(site.pendingFrames, 0);
    }
  }
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

await test('native long-chapter scrolling stops at real content even when projection inflates the DOM scroll range', () => {
  for (const viewportWidth of [390, 1200]) {
    const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth });
    const logicalGeometry = site.panels[2].geometry();
    site.panels[2].geometry = () => logicalGeometry;
    site.journal.scrollHeight += 700;
    site.resizeWidth(viewportWidth);
    const limit = logicalGeometry.top + logicalGeometry.height - site.journal.clientHeight;
    const horizontal = site.top;
    const reads = site.layoutReads;
    const frames = site.requestedFrames;
    site.journal.scrollTop = limit + 300;
    site.document.dispatchEvent({ type: 'scroll', target: site.journal });
    assert.equal(site.journal.scrollTop, limit, 'native overshoot is removed before the next rendered update');
    site.document.dispatchEvent({ type: 'scroll', target: site.journal });
    site.advance(32);
    assert.equal(site.layoutReads, reads, 'clamping uses cached logical geometry');
    assert.ok(site.requestedFrames - frames <= 1, 'the correcting scroll event shares the existing update frame');
    assert.equal(site.top, horizontal, 'native overshoot cannot move horizontally by itself');
    assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, true, 'a new wheel at the logical bottom leaves the chapter');
    site.advance(1000);
    assert.equal(site.top, horizontal + 80);
    assert.equal(site.journal.scrollTop, limit);
    assert.equal(site.wheel(-80, { target: site.journal }).defaultPrevented, false, 'upward reading still stays inside the long chapter');
    site.journal.scrollTop = -20;
    site.document.dispatchEvent({ type: 'scroll', target: site.journal });
    assert.equal(site.journal.scrollTop, 0, 'the logical start also rejects native overscroll');
  }
});

await test('reading keys target the logical boundary instead of animating into projection-only space', () => {
  for (const reduced of [false, true]) {
    const site = browser({ url: 'https://gudu.blog/#journal', reduced });
    const logicalGeometry = site.panels[2].geometry();
    site.panels[2].geometry = () => logicalGeometry;
    site.journal.scrollHeight += 700;
    site.resizeWidth(site.window.innerWidth);
    const limit = logicalGeometry.top + logicalGeometry.height - site.journal.clientHeight;
    const horizontal = site.top;
    site.journal.scrollTop = limit - 10;
    site.key('PageDown', { target: site.journal });
    assert.equal(site.journal.scrollTop, limit, 'the key target itself ends at the content boundary');
    assert.equal(site.innerScrolls.at(-1).behavior, reduced ? 'instant' : 'smooth');
    assert.equal(site.top, horizontal);
    site.key('ArrowDown', { target: site.journal });
    site.advance(1000);
    assert.equal(site.top, horizontal + 100, 'the following key continues through the horizontal strip');
    assert.equal(site.journal.scrollTop, limit);
  }
});

await test('touch reaching the logical bottom stays native until release before the next gesture moves horizontally', () => {
  const site = browser({ url: 'https://gudu.blog/#journal', viewportWidth: 390 });
  const logicalGeometry = site.panels[2].geometry();
  site.panels[2].geometry = () => logicalGeometry;
  site.journal.scrollHeight += 700;
  site.resizeWidth(site.window.innerWidth);
  const limit = logicalGeometry.top + logicalGeometry.height - site.journal.clientHeight;
  const horizontal = site.top;
  const finger = clientY => ({ clientX: 100, clientY });
  site.journal.scrollTop = limit - 10;
  site.event('touchstart', { target: site.journal, touches: [finger(600)] });
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(570)] }).defaultPrevented, false);
  site.journal.scrollTop = limit + 200;
  site.document.dispatchEvent({ type: 'scroll', target: site.journal });
  assert.equal(site.journal.scrollTop, limit);
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(450)] }).defaultPrevented, false, 'the held native gesture never switches axes at the corrected boundary');
  site.advance(32);
  assert.equal(site.top, horizontal);
  site.event('touchend', { touches: [] });
  site.event('touchstart', { target: site.journal, touches: [finger(600)] });
  assert.equal(site.event('touchmove', { target: site.journal, touches: [finger(540)] }).defaultPrevented, true);
  site.event('touchend', { touches: [] });
  site.advance(1000);
  assert.equal(site.top, horizontal + 60);
  assert.equal(site.journal.scrollTop, limit);
});

await test('logical reading limits remeasure after content and viewport changes and remove stale vertical positions', () => {
  const site = browser({ url: 'https://gudu.blog/#journal' });
  let logicalGeometry = site.panels[2].geometry();
  site.panels[2].geometry = () => logicalGeometry;
  site.journal.scrollHeight += 1000;
  site.resizeWidth(site.window.innerWidth);
  const horizontal = site.top;
  site.journal.scrollTop = 700;
  logicalGeometry = { ...logicalGeometry, height: 700 };
  site.lateResize();
  site.advance(32);
  assert.equal(site.journal.scrollTop, 0, 'shorter results cannot retain an old reading offset');
  assert.equal(site.journal.classList.contains('is-chapter-scrollable'), false);
  logicalGeometry = { ...logicalGeometry, height: 1900 };
  site.lateResize();
  site.advance(32);
  assert.equal(site.journal.classList.contains('is-chapter-scrollable'), true);
  site.journal.scrollTop = 1300;
  site.document.dispatchEvent({ type: 'scroll', target: site.journal });
  assert.equal(site.journal.scrollTop, 1200, 'new content has its own increased logical limit');
  site.journal.clientHeight = 1000;
  site.resizeWidth(site.window.innerWidth);
  assert.equal(site.journal.scrollTop, 1000, 'a taller reading viewport clamps the remaining offset');
  logicalGeometry = { ...logicalGeometry, height: 2300 };
  site.lateResize();
  site.advance(32);
  assert.equal(site.wheel(80, { target: site.journal }).defaultPrevented, false, 'appended content is readable beyond the previous bottom');
  assert.equal(site.top, horizontal, 'logical vertical changes preserve the horizontal destination');
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
    for (const target of [site.viewport, ...site.chapters.slice(1), ...site.panels]) {
      assert.equal(site.isObserved(target), true, `resuming reconnects geometry observation for ${target.id}`);
    }
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
  assert.equal(site.markerX, site.rulerWidth / 4);
  site.resizeWidth(600);
  assert.equal(site.top, 800 + site.step * 0.5);
  assert.equal(site.x, -site.step * 0.5);
  assert.equal(site.markerX, site.rulerWidth / 4, 'resizing remeasures the ruler while preserving its fractional station position');
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
    assert.equal(site.progress.style.getPropertyValue('--chapter-active-index'), String(Math.max(index - 1, 0)));
    assert.equal(Number(site.progress.style.getPropertyValue('--site-progress')), Number((Math.max(index - 1, 0) / 3).toFixed(5)));
    assert.ok(Math.abs(site.markerX - (Math.max(index - 1, 0) + 0.5) * site.rulerWidth / 4) < 0.001, `${id} aligns the marker with its station center`);
  }
  assert.equal(site.url.hash, '#archive');
  assert.equal(site.x, -site.step * 3);
  assert.notEqual(site.step, site.window.innerWidth, 'the fixture exercises partial-width panels');
  site.hash('#series');
  assert.equal(site.progressCurrent.textContent, '02');
  assert.equal(site.navLinks[1].getAttribute('aria-current'), 'location');
});

await test('only revealed panels can receive focus, with geometry still limiting reduced-motion panels', () => {
  const site = browser({ url: 'https://gudu.blog/#about' });
  const chapter = site.journal;
  const thresholds = revealThresholds(site, chapter);
  assert.equal(revealUnit(site.about).inert, false);
  assert.equal(revealUnit(site.series).inert, true, 'an unactivated preview cannot expose invisible links');
  assert.equal(site.series.inert, false, 'the visible section remains a scrollable container while its preview panel is inert');
  assert.equal(revealUnit(site.journal).inert, true);
  assert.equal(revealUnit(site.archive).inert, true);
  moveToVisiblePixels(site, chapter, thresholds.enter - 1);
  assert.equal(revealUnit(chapter).inert, true);
  moveToVisiblePixels(site, chapter, thresholds.enter + 1);
  assert.equal(revealUnit(chapter).inert, false, 'crossing the opening threshold restores interaction');
  moveToVisiblePixels(site, chapter, thresholds.between);
  assert.equal(revealUnit(chapter).inert, false, 'the open hysteresis band retains interaction');
  moveToVisiblePixels(site, chapter, thresholds.exit - 1);
  assert.equal(revealState(chapter).closing, true);
  assert.equal(revealUnit(chapter).inert, true, 'closing panels immediately stop responding to their links');
  moveToVisiblePixels(site, chapter, thresholds.between);
  assert.equal(revealUnit(chapter).inert, true, 'a partial reversal must wait for the opening threshold');
  moveToVisiblePixels(site, chapter, thresholds.enter + 1);
  assert.equal(revealUnit(chapter).inert, false);
  moveToVisiblePixels(site, site.series, 0, 'left');
  assert.equal(revealUnit(site.series).inert, true, 'a fully offscreen panel is inert');
  site.hash('#series');
  assert.equal(revealUnit(site.about).inert, true, 'instant navigation also deactivates the previous chapter preview');
  assert.equal(revealUnit(site.series).inert, false);
  assert.equal(revealUnit(site.journal).inert, true);
  assert.equal(revealUnit(site.archive).inert, true);
  site.media.matches = true;
  site.media.dispatchEvent({ type: 'change' });
  assert.equal(site.chapters.slice(1).every(chapter => revealState(chapter).open), true);
  assert.equal(revealUnit(site.about).inert, false);
  assert.equal(revealUnit(site.series).inert, false);
  assert.equal(revealUnit(site.journal).inert, false);
  assert.equal(revealUnit(site.archive).inert, true, 'reduced motion reveals all panels but never focuses offscreen geometry');
  const hero = browser();
  hero.wheel(120);
  assert.equal(revealState(hero.about).open, true, 'the first chapter is prepared before the hero visibility threshold');
  assert.equal(revealUnit(hero.about).inert, true, 'preparing its visual state does not activate its links early');
  hero.advance(80);
  assert.equal(revealState(hero.about).open, true);
  assert.equal(revealUnit(hero.about).inert, true);
  hero.advance(200);
  assert.equal(revealState(hero.about).open, true);
  assert.equal(revealUnit(hero.about).inert, false, 'the unit becomes ready after the content visibility threshold');
  assert.equal(hero.viewport.inert, true, 'its ancestor still blocks interaction while the assembled panels slide in');
  hero.advance(620);
  assert.equal(hero.viewport.inert, false, 'interaction becomes available when the full hero transition finishes');
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
  const wheelContent = wheelSite.panels[0].geometry();
  wheelSite.panels[0].geometry = () => ({ ...wheelContent, height: 1500 });
  wheelSite.resizeWidth(wheelSite.window.innerWidth);
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
  const keyContent = keySite.panels[0].geometry();
  keySite.panels[0].geometry = () => ({ ...keyContent, height: 1500 });
  keySite.resizeWidth(keySite.window.innerWidth);
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
  assert.equal(revealUnit(site.about).inert, false, 'the initially wider visible slice of the previous panel already exceeds its opening threshold');
  assert.equal(revealUnit(site.journal).inert, false, 'the next panel also opens when its temporary visible slice is wide enough');
  site.settlePanelWidth();
  assert.equal(site.window.innerWidth, 1200, 'only the first observed panel changes size');
  assert.ok(site.top > temporaryPosition);
  assert.equal(site.top, site.destination('series'));
  assert.equal(site.x, -(site.destination('series') - site.destination('about')));
  assert.equal(site.url.hash, '#series');
  assert.equal(site.url.searchParams.get('q'), 'space');
  assert.equal(revealUnit(site.about).inert, true, 'remeasuring leaves the previous narrow preview inactive');
  assert.equal(revealUnit(site.journal).inert, true, 'remeasuring does not activate the next narrow preview');
  assert.equal(revealUnit(site.series).inert, false);
  assert.equal(revealUnit(site.archive).inert, true);
  site.click(site.link('#archive'));
  site.advance(1000);
  assert.equal(site.top, site.destination('archive'));
  assert.equal(revealUnit(site.series).inert, true);
  assert.equal(revealUnit(site.journal).inert, false, 'an already-open panel remains interactive until its visible slice reaches the smaller closing threshold');
  assert.equal(revealUnit(site.archive).inert, false);
  assert.equal(site.pendingFrames, 0);
});

await test('top search submission reaches the article panel while preserving input focus through navigation changes', () => {
  for (const mode of ['animated', 'reduced', 'resize', 'motion-change']) {
    const site = browser({ url: 'https://gudu.blog/?q=space&category=tech#series', reduced: mode === 'reduced' });
    site.journal.scrollTop = 500;
    site.searchForm.classList.add('is-expanded');
    site.input.value = 'space';
    site.input.focus();
    const inputWrites = site.domWrites.length;
    assert.equal(site.header.contains(site.input), true);
    assert.equal(site.journal.contains(site.input), false);
    assert.equal(site.header.inert, false);
    assert.equal(site.event('submit', { target: site.searchForm }).defaultPrevented, true);
    assert.equal(site.header.inert, false, 'ordinary search navigation must not apply the Hero header gate');
    if (mode === 'reduced') {
      assert.equal(site.top, site.destination('journal'), 'reduced motion reaches results immediately');
    } else {
      site.advance(100);
      assert.equal(site.document.activeElement, site.input, 'navigation never steals focus from the visible top search field');
      assert.equal(site.header.inert, false, 'the search field remains interactive while results move into view');
      if (mode === 'resize') site.resizeWidth(600);
      if (mode === 'motion-change') {
        site.media.matches = true;
        site.media.dispatchEvent({ type: 'change' });
      }
    }
    site.advance(1000);
    assert.equal(site.top, site.destination('journal'), `${mode} reaches the article panel`);
    assert.equal(site.document.activeElement, site.input, `${mode} retains focus in the header search input`);
    assert.equal(site.header.inert, false, `${mode} keeps the content header interactive`);
    assert.ok(site.domWrites.slice(inputWrites).filter(write => write.target === site.header && write.kind === 'inert')
      .every(write => write.value === false), `${mode} never transiently makes the focused search field inert`);
    assert.equal(site.searchForm.classList.contains('is-expanded'), true, `${mode} preserves the expanded search form`);
    assert.equal(site.input.value, 'space', `${mode} preserves the entered query`);
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
