// Phones read the home page as one vertical page. chapters.js runs the
// horizontal strip on wider screens; this controller takes over below the
// phone breakpoint and hands the page back when the viewport grows past it.
// It announces each change with a site:chapter-mode event, so the strip
// stands down before this page starts and resumes after this page stops.
(() => {
  'use strict';

  const root = document.documentElement;
  const hero = document.querySelector('.hero');
  const stage = document.querySelector('#hero-stage');
  const chapters = [...document.querySelectorAll('.chapter-section')];
  const nav = document.querySelector('.chapter-progress');
  const tape = document.querySelector('.chapter-progress-track');
  const marker = document.querySelector('.chapter-progress-marker');
  if (!hero || !stage || !chapters.length || !nav || !tape || !marker) return;

  const sections = [hero, ...chapters];
  const header = document.querySelector('.site-header');
  const links = [...nav.querySelectorAll('[data-chapter-link]')];
  const heroText = [...stage.querySelectorAll('.hero-heading')];
  const labels = chapters.map((chapter, index) => links[index]?.querySelector('.chapter-station-title')?.textContent.trim() || chapter.id);
  const journalIndex = sections.findIndex(section => section.id === 'journal');
  const query = matchMedia('(max-width: 720px), (max-height: 520px) and (pointer: coarse)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  // The surfaces the strip turns in depth: panels and the loose headings and
  // footnotes outside them. Each reveals as one unit and stays one straight
  // plate, as in the strip. A heading shares the plane of the panel it
  // belongs to, so a whole region tilts as one block.
  const units = chapters.flatMap(chapter => [...chapter.querySelectorAll('.chapter-panel, [data-depth-owner]')]
    .filter(element => element.classList.contains('chapter-panel') || !element.closest('.chapter-panel')));
  const leftoverClasses = ['is-chapter-immediate', 'is-chapter-scanning', 'is-chapter-departing', 'is-chapter-closing', 'is-chapter-calibrating'];
  const plates = units.map(element => ({ element, owner: null, left: 0, top: 0, width: 0, height: 0, transform: '', origin: '' }));
  const platesByElement = new Map(plates.map(plate => [plate.element, plate]));
  for (const plate of plates) {
    const id = plate.element.dataset.depthOwnerCompact || plate.element.dataset.depthOwner;
    const owner = id ? platesByElement.get(document.getElementById(id)) : null;
    plate.owner = owner?.element.classList.contains('chapter-panel') ? owner : plate;
  }
  // Text and images rise into place one block at a time as they scroll into
  // view: a panel taller than the screen would otherwise reveal everything at
  // once, long before its lower part is read. The strip's text layers, plus
  // the About portrait.
  const REVEAL_BLOCKS = [
    '.about-panel-top', '.about-avatar', '.about-socials', '.about-text > p', '.about-dossier', '.about-signature',
    '.connection-heading', '.connection-footnote', '.connection-card-head', '.connection-action',
    '.chapter-panel h2', '.chapter-panel > :is(.eyebrow, h3, p, .text-link)',
    '.series-empty', '.series-reading-link', '.journal-heading-part', '.category-heading',
    '.category-index', '.category-composition', '.category-description', '.category-bottom',
    '.journal-toolbar', '.journal-empty', '.search-empty', '.posts-list > .post-card',
    '.archive-year > h3', '.archive-year li', '.archive-group > h3', '.archive-item', '.site-footer',
  ].join(', ');
  // The tape keeps both ends in view. Its cells are a seventh of the window
  // inside these margins, so with the pointer in the middle neither end
  // leaves it. Screens too short for readable cells keep the tape still.
  const TAPE_INSET = 16;
  const TAPE_MIN_CELL = 56;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const px = value => `${value.toFixed(2)}px`;
  const interactive = target => target?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="slider"]');
  // The small viewport: the page keeps its geometry while a mobile toolbar
  // slides in and out.
  const viewportHeight = () => root.clientHeight || window.innerHeight;

  let active = false;
  let frame = 0;
  let animation = null;
  let entry = 1;
  let maxScroll = 0;
  let tops = [];
  let knots = [];
  let readingLine = 0;
  let headerHeight = 70;
  const view = { center: 0, above: 1, below: 1, perspective: 900 };
  const arc = { radius: 1, flat: 0, limit: 1.2 };
  const ruler = { top: 0, cell: 120, pointer: 0, shift: 0, coordinate: 0 };
  let current = -1;
  let lastProgress = -1;
  let interaction = null;
  let drag = null;
  let suppressClick = false;
  let touch = null;
  let wheelHeld = false;
  let lastWheel = -Infinity;
  let lastScroll = 0;
  let scrollDirection = 1;
  let settleTimer = 0;
  let movingTimer = 0;
  let arrivalTimer = 0;
  let moved = false;
  let reveal = null;
  let rise = null;
  let reset = null;
  const risen = new Set();
  let layout = null;
  const inertStates = new Map();

  function setInert(element, inert) {
    if (!element || inertStates.get(element) === inert) return;
    inertStates.set(element, inert);
    element.inert = inert;
  }

  function setInteraction(kind) {
    if (kind === interaction) return;
    const previous = interaction;
    interaction = kind;
    window.dispatchEvent(new CustomEvent('site:interaction', { detail: { active: kind !== null, kind: kind || previous } }));
  }

  function pageBox(element) {
    let left = 0;
    let top = 0;
    for (let node = element; node; node = node.offsetParent) {
      left += node.offsetLeft;
      top += node.offsetTop;
    }
    return { left, top, width: element.offsetWidth, height: element.offsetHeight };
  }

  // Where each section opens: the Hero at the top, 关于 a little below the
  // toolbar where the Hero hands over, the others with their divider just
  // under the toolbar.
  function landing(index) {
    if (index <= 0) return 0;
    if (index === 1) return entry;
    return clamp(tops[index - 1] - headerHeight - 8, entry, maxScroll);
  }

  function measure() {
    if (!active) return;
    const height = viewportHeight();
    headerHeight = header?.offsetHeight || 70;
    tops = chapters.map(chapter => pageBox(chapter).top);
    const first = units.find(element => chapters[0].contains(element));
    entry = Math.max(1, (first ? pageBox(first).top : tops[0]) - headerHeight - 28);
    maxScroll = Math.max(entry, root.scrollHeight - height);

    // The tape window is fixed. With cells a seventh of its height and the
    // pointer in its middle, both ends of the tape stay in view from the top
    // of the page to the bottom. On screens too short for that, the whole tape
    // fills the window and the pointer travels along it instead.
    const box = nav.getBoundingClientRect();
    const usable = Math.max(1, box.height - 2 * TAPE_INSET);
    ruler.top = box.top;
    // Layout, not the box: the hidden tape is shifted sideways.
    ruler.centerX = nav.offsetLeft + nav.offsetWidth / 2;
    ruler.moving = usable / 7 >= TAPE_MIN_CELL;
    ruler.cell = ruler.moving ? Math.min(150, usable / 7) : usable / chapters.length;
    ruler.pointer = TAPE_INSET + usable / 2;
    ruler.lowest = TAPE_INSET;
    ruler.highest = Math.max(TAPE_INSET, TAPE_INSET + usable - chapters.length * ruler.cell);
    nav.style.setProperty('--tape-cell', px(ruler.cell));
    // The pointer's line is the reading line: the chapter crossing it is read.
    readingLine = box.top + ruler.pointer;

    // The ruler coordinate: 0 is 关于 and the last station is 归档. A stem
    // passes the pointer exactly when the reading line crosses into the next
    // chapter, and each chapter's middle is its whole number. The ends stretch
    // so the first reading position after the Hero is 0 and the bottom is last.
    const lines = [entry + readingLine, ...tops.slice(1), maxScroll + readingLine];
    knots = lines.map((line, index) => [line, index === 0 ? 0 : index === lines.length - 1 ? chapters.length - 1 : index - 0.5]);
    for (let index = 1; index < knots.length; index++) knots[index][0] = Math.max(knots[index][0], knots[index - 1][0] + 1);

    // The strip's arc on its side: a flat band through the middle of the
    // reading area, curving towards the reader near the top and bottom.
    const area = height - headerHeight;
    view.center = headerHeight + area / 2;
    // The arc runs to just past the screen edges, under the toolbar too;
    // beyond one more screen the plates stop moving.
    view.above = view.center + 24;
    view.below = height - view.center + 24;
    view.park = height;
    // Perspective converges on the reading column, so panels growing near the
    // screen edges widen into its margins rather than towards the tape.
    const column = pageBox(chapters[0]);
    view.columnX = column.left + column.width / 2;
    view.perspective = Math.max(700, area * 1.1);
    arc.radius = area * 0.72;
    arc.flat = area * 0.1;
    for (const plate of plates) Object.assign(plate, pageBox(plate.element));
    watchBlocks();

    // The fallback illustration shrinks into the scene's center, as in the strip.
    const figure = document.querySelector('#black-hole')?.getBoundingClientRect();
    const scene = stage.getBoundingClientRect();
    if (figure?.width) {
      root.style.setProperty('--fallback-shift-x', px(scene.left + scene.width / 2 - figure.left - figure.width / 2));
      root.style.setProperty('--fallback-shift-y', px(scene.top + scene.height / 2 - figure.top - figure.height / 2));
    }
  }

  // Blocks join the rise once and leave it when they leave the page, as
  // search results replace their cards. A match inside another rises with it.
  function watchBlocks() {
    if (!rise) return;
    const blocks = [...document.querySelectorAll(REVEAL_BLOCKS)].filter(element => element.closest('.chapter-section'));
    const matched = new Set(blocks);
    for (const element of blocks) {
      if (risen.has(element)) continue;
      let nested = false;
      for (let node = element.parentElement; node && !nested; node = node.parentElement) nested = matched.has(node);
      if (nested) continue;
      risen.add(element);
      element.classList.add('is-vertical-reveal');
      rise.observe(element);
      reset.observe(element);
    }
    for (const element of [...risen]) {
      if (element.isConnected) continue;
      rise.unobserve(element);
      reset.unobserve(element);
      risen.delete(element);
    }
  }

  function coordinateAt(y) {
    const line = y + readingLine;
    if (!knots.length || line <= knots[0][0]) return 0;
    for (let index = 1; index < knots.length; index++) {
      const [from, start] = knots[index - 1];
      const [to, stop] = knots[index];
      if (line <= to) return start + (stop - start) * (line - from) / (to - from);
    }
    return chapters.length - 1;
  }

  function scrollFor(coordinate) {
    const target = clamp(coordinate, 0, chapters.length - 1);
    for (let index = 1; index < knots.length; index++) {
      const [from, start] = knots[index - 1];
      const [to, stop] = knots[index];
      if (target <= stop) return clamp(from + (to - from) * (target - start) / (stop - start) - readingLine, 0, maxScroll);
    }
    return maxScroll;
  }

  // Taps and releases within a tenth of a cell of a chapter's middle settle
  // there, as on the horizontal ruler.
  function settleCoordinate(coordinate) {
    const clamped = clamp(coordinate, 0, chapters.length - 1);
    const station = Math.round(clamped);
    return Math.abs(clamped - station) <= 0.1 ? station : clamped;
  }

  // The strip's arc with its depth eased a quarter: the column is narrow, and
  // a full-depth edge would grow into the margins and the tape. Distance along
  // the arc equals distance down the page, so the page rolls onto it unstretched.
  function arcPoint(y) {
    const distance = Math.max(0, Math.abs(y) - arc.flat);
    const angle = Math.min(arc.limit, distance / arc.radius);
    const extension = Math.max(0, distance - arc.radius * arc.limit);
    return {
      y: Math.sign(y) * (Math.min(arc.flat, Math.abs(y)) + arc.radius * Math.sin(angle) + extension * Math.cos(arc.limit)),
      z: arc.radius * (1 - Math.cos(angle)) * 0.75,
    };
  }

  // A region's plane, like the strip's cards: its panel is one flat face
  // spanning the arc points of its top and bottom. A panel reaching past the
  // screen uses only its part on screen, and comes forward less the more of
  // the screen it fills. Off screen it waits at the edge it will enter from,
  // still projected from where it is, so its heading on screen stays true;
  // more than a screen away it stops moving, so nothing is rewritten.
  function planeOf(owner, y) {
    let start = owner.top - y - view.center;
    const end = start + owner.height;
    const side = start >= view.below ? 1 : end <= -view.above ? -1 : 0;
    let top;
    let bottom;
    let pivot;
    let depthScale = 1;
    if (side) {
      const edge = side > 0 ? view.below : -view.above;
      top = side > 0 ? edge : edge - 1;
      bottom = top + 1;
      pivot = side > 0 ? 0 : owner.height;
      if (side > 0 && start > edge + view.park) start = edge + view.park;
      if (side < 0 && end < edge - view.park) start = edge - view.park - owner.height;
    } else {
      top = Math.max(start, -view.above);
      bottom = Math.max(top + 1, Math.min(end, view.below));
      pivot = (top + bottom) / 2 - start;
      depthScale = 1 - (bottom - top) / (view.above + view.below);
    }
    const a = arcPoint(top);
    const b = arcPoint(bottom);
    return {
      x: owner.left + owner.width / 2,
      y: owner.top + pivot,
      cameraX: view.columnX - (owner.left + owner.width / 2),
      cameraY: -(start + pivot),
      shift: (a.y + b.y) / 2 - (top + bottom) / 2,
      depth: (a.z + b.z) / 2 * depthScale,
      pitch: Math.atan2(b.z - a.z, b.y - a.y) * 180 / Math.PI,
      span: Math.hypot(b.y - a.y, b.z - a.z) / (bottom - top),
    };
  }

  function placePlates(y) {
    const planes = new Map();
    for (const plate of plates) {
      let plane = planes.get(plate.owner);
      if (!plane) planes.set(plate.owner, plane = planeOf(plate.owner, y));
      const transform = `translate3d(${plane.cameraX.toFixed(2)}px, ${plane.cameraY.toFixed(2)}px, 0) perspective(${view.perspective.toFixed(1)}px) `
        + `translate3d(${(-plane.cameraX).toFixed(2)}px, ${(plane.shift - plane.cameraY).toFixed(2)}px, ${plane.depth.toFixed(2)}px) `
        + `rotateX(${plane.pitch.toFixed(3)}deg) scaleY(${plane.span.toFixed(5)})`;
      // Every plate of a region turns about the same point of its panel.
      const origin = `${(plane.x - plate.left).toFixed(2)}px ${(plane.y - plate.top).toFixed(2)}px`;
      if (transform !== plate.transform) plate.element.style.transform = plate.transform = transform;
      if (origin !== plate.origin) plate.element.style.transformOrigin = plate.origin = origin;
    }
  }

  // The tape's station cells follow the same arc, tilting and tightening
  // towards the tape's ends like a drum, and meet on it as one bent scale.
  // They come forward six tenths as far as the panels, so the tape bows out
  // with the panels beside it and its ends still stay on screen.
  const tapeCells = links.map(element => ({ element, transform: '' }));
  function placeTape() {
    tapeCells.forEach((cell, index) => {
      const start = ruler.top + ruler.shift + index * ruler.cell - view.center;
      const a = arcPoint(start);
      const b = arcPoint(start + ruler.cell);
      const [az, bz] = [a.z * 0.6, b.z * 0.6];
      const pitch = Math.atan2(bz - az, b.y - a.y) * 180 / Math.PI;
      const span = Math.hypot(b.y - a.y, bz - az) / ruler.cell;
      const shift = (a.y + b.y) / 2 - (start + ruler.cell / 2);
      const cameraX = view.columnX - ruler.centerX;
      const cameraY = -(start + ruler.cell / 2);
      const transform = `translate3d(${cameraX.toFixed(2)}px, ${cameraY.toFixed(2)}px, 0) perspective(${view.perspective.toFixed(1)}px) `
        + `translate3d(${(-cameraX).toFixed(2)}px, ${(shift - cameraY).toFixed(2)}px, ${((az + bz) / 2).toFixed(2)}px) rotateX(${pitch.toFixed(3)}deg) scaleY(${span.toFixed(5)})`;
      if (transform !== cell.transform) cell.element.style.transform = cell.transform = transform;
    });
  }

  function clearTape() {
    for (const cell of tapeCells) {
      if (cell.transform) cell.element.style.removeProperty('transform');
      cell.transform = '';
    }
  }

  function clearPlates() {
    for (const plate of plates) {
      if (plate.transform) plate.element.style.removeProperty('transform');
      if (plate.origin) plate.element.style.removeProperty('transform-origin');
      plate.transform = plate.origin = '';
    }
  }

  function writeHash(index, mode = 'replace') {
    const id = sections[index]?.id;
    if (!id || window.location.hash === `#${id}`) return;
    const url = new URL(window.location.href);
    url.hash = id;
    try { window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url); } catch { /* Sandboxed embeds can refuse history. */ }
  }

  function clearArrival() {
    clearTimeout(arrivalTimer);
    arrivalTimer = 0;
    for (const link of links) link.classList.remove('is-arriving', 'is-departing');
    marker.classList.remove('is-arriving');
  }

  // The crossed stem hands the light over, as on the horizontal ruler: the new
  // stretch of axis grows out of it and the old one retracts into it.
  function markArrival(index, previous) {
    clearArrival();
    if (index < 1 || previous < 1 || motion.matches) return;
    nav.classList.toggle('is-moving-back', index < previous);
    links[index - 1]?.classList.add('is-arriving');
    links[previous - 1]?.classList.add('is-departing');
    marker.classList.add('is-arriving');
    arrivalTimer = setTimeout(clearArrival, 400);
  }

  function update() {
    frame = 0;
    if (!active) return;
    const y = window.scrollY;
    const progress = clamp(y / entry, 0, 1);
    const content = progress > 0.55;
    root.style.setProperty('--chapter-progress', progress.toFixed(4));
    root.classList.toggle('is-content', content);
    setInert(header, !content);
    setInert(nav, !content);
    for (const element of heroText) setInert(element, progress > 0.12);
    if (progress !== lastProgress) {
      lastProgress = progress;
      window.dispatchEvent(new CustomEvent('site:chapter', { detail: { progress, entranceGlow: 0 } }));
    }

    // The pointer stays on the reading line and the tape slides under it, so
    // the station at the pointer is the chapter being read.
    const coordinate = coordinateAt(y);
    const markerY = (coordinate + 0.5) * ruler.cell;
    ruler.coordinate = coordinate;
    // The pointer holds the middle; only a short screen moves it instead.
    ruler.shift = clamp(ruler.pointer - markerY, ruler.lowest, ruler.highest);
    nav.style.setProperty('--tape-shift', px(ruler.shift));
    nav.style.setProperty('--chapter-position', coordinate.toFixed(4));
    nav.style.setProperty('--site-progress', (coordinate / Math.max(1, chapters.length - 1)).toFixed(4));
    tape.style.setProperty('--chapter-marker-y', px(markerY));
    const index = content ? 1 + Math.round(coordinate) : 0;
    nav.style.setProperty('--chapter-active-index', String(Math.max(0, index - 1)));
    if (index !== current) {
      const previous = current;
      current = index;
      links.forEach((link, station) => station === index - 1
        ? link.setAttribute('aria-current', 'location') : link.removeAttribute('aria-current'));
      if (previous >= 0) {
        markArrival(index, previous);
        // Navigation writes its own entry; reading along only renames this one.
        if (!animation) writeHash(index);
      }
    }
    const percent = coordinate / Math.max(1, chapters.length - 1) * 100;
    marker.setAttribute('aria-valuenow', percent.toFixed(1));
    marker.setAttribute('aria-valuetext', `${labels[Math.round(coordinate)]}，${Math.round(percent)}%`);

    if (motion.matches) { clearPlates(); clearTape(); return; }
    placePlates(y);
    placeTape();
  }

  const queue = () => { if (active && !frame) frame = requestAnimationFrame(update); };

  function jump(top) {
    window.scrollTo({ top, behavior: 'instant' });
    cancelAnimationFrame(frame);
    update();
  }

  function stopAnimation() {
    if (!animation) return;
    cancelAnimationFrame(animation.frame);
    animation = null;
  }

  // Navigation runs its own easing: the Hero hand-over keeps the strip's
  // timing, and every move starts and ends at rest.
  function animateTo(destination, { kind = 'content', then = null } = {}) {
    stopAnimation();
    const from = window.scrollY;
    const to = clamp(destination, 0, maxScroll);
    if (motion.matches || Math.abs(to - from) < 1) {
      jump(to);
      setInteraction(null);
      then?.();
      return;
    }
    const duration = kind === 'hero' ? (to > from ? 900 : 680) : clamp(360 + Math.abs(to - from) * 0.12, 420, 760);
    const run = { from, to, kind, started: performance.now(), frame: 0 };
    animation = run;
    setInteraction(kind);
    const step = now => {
      if (animation !== run) return;
      const t = clamp((now - run.started) / duration, 0, 1);
      const eased = kind === 'hero' ? 1 - (1 - t) ** 4 : t * t * (3 - 2 * t);
      jump(t === 1 ? to : from + (to - from) * eased);
      if (t < 1) { run.frame = requestAnimationFrame(step); return; }
      animation = null;
      setInteraction(null);
      then?.();
    };
    run.frame = requestAnimationFrame(step);
  }

  function focusSection(index) {
    const target = sections[index];
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  function navigate(index, { history = 'push', focus = true } = {}) {
    if (index < 0 || index >= sections.length) return;
    if (history) writeHash(index, history);
    const kind = index === 0 || window.scrollY < entry - 2 ? 'hero' : 'content';
    animateTo(landing(index), { kind, then: focus ? () => focusSection(index) : null });
  }

  function restoreHash({ smooth = false } = {}) {
    const index = sections.findIndex(section => `#${section.id}` === window.location.hash);
    if (index < 0) return false;
    if (smooth) animateTo(landing(index), { kind: index === 0 || window.scrollY < entry - 2 ? 'hero' : 'content' });
    else jump(landing(index));
    return true;
  }

  // Between the Hero and 关于 the page never rests: a scroll that stops in
  // between finishes the hand-over in the direction it was going.
  function settle() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (!active || animation || drag || touch) return;
    if (interaction === 'content') setInteraction(null);
    const y = window.scrollY;
    if (y > 1 && y < entry - 2) animateTo(scrollDirection < 0 ? 0 : entry, { kind: 'hero' });
  }

  function onScroll() {
    if (!active) return;
    const y = window.scrollY;
    if (Math.abs(y - lastScroll) > 0.5) scrollDirection = Math.sign(y - lastScroll);
    lastScroll = y;
    moved = true;
    queue();
    nav.classList.add('is-chapter-moving');
    clearTimeout(movingTimer);
    movingTimer = setTimeout(() => nav.classList.remove('is-chapter-moving'), 140);
    // Native reading scroll counts as content movement for the background scene.
    if (!animation && y >= entry - 2) setInteraction('content');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 160);
  }

  // The tape is one control. Dragging anywhere on it moves the page: the tape
  // follows the finger, one cell per chapter. A tap on the axis brings that
  // spot to the pointer; a tap on a name opens that chapter. Capture starts
  // only with a drag, so a plain tap still reaches the name's link.
  function axisHit(event) {
    const box = tape.getBoundingClientRect();
    return Math.abs(event.clientX - (box.left + box.width / 2)) <= 10;
  }

  nav.addEventListener('pointerdown', event => {
    if (!active || event.isPrimary === false || event.button > 0 || !root.classList.contains('is-content')) return;
    stopAnimation();
    const link = event.target.closest('a');
    drag = { id: event.pointerId, y: event.clientY, coordinate: ruler.coordinate, shift: ruler.shift, moved: false, link: link && !axisHit(event) ? link : null };
  });
  // One scroll per frame keeps the page, the tape and the pointer in step,
  // however often the screen reports the finger.
  let dragFrame = 0;
  const applyDrag = () => {
    dragFrame = 0;
    if (drag?.target !== undefined) jump(scrollFor(drag.target));
  };
  nav.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = drag.y - event.clientY;
    if (!drag.moved) {
      if (Math.abs(distance) < 6) return;
      drag.moved = true;
      nav.setPointerCapture?.(event.pointerId);
      nav.classList.add('is-scrubbing');
      setInteraction('content');
    }
    event.preventDefault();
    // The moving tape follows the finger; a still tape works like a scrollbar.
    drag.target = ruler.moving ? drag.coordinate + distance / ruler.cell : (event.clientY - ruler.top - ruler.shift) / ruler.cell - 0.5;
    if (!dragFrame) dragFrame = requestAnimationFrame(applyDrag);
  });
  // A finger on the tape must not also pan the page underneath (iOS can,
  // despite touch-action), or the two scrolls fight.
  nav.addEventListener('touchmove', event => { if (active && event.cancelable) event.preventDefault(); }, { passive: false });
  function release(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (dragFrame) { cancelAnimationFrame(dragFrame); applyDrag(); }
    const { moved: dragged, link, y, shift } = drag;
    drag = null;
    nav.classList.remove('is-scrubbing');
    if (nav.hasPointerCapture?.(event.pointerId)) nav.releasePointerCapture(event.pointerId);
    if (dragged || !link) {
      // A drag or an axis tap must not also open the link under it.
      suppressClick = true;
      setTimeout(() => { suppressClick = false; });
    }
    if (event.type !== 'pointerup') { setInteraction(null); return; }
    if (dragged) {
      const settled = settleCoordinate(ruler.coordinate);
      if (settled !== ruler.coordinate) animateTo(scrollFor(settled));
      else setInteraction(null);
      return;
    }
    if (!link) animateTo(scrollFor(settleCoordinate((y - ruler.top - shift) / ruler.cell - 0.5)));
  }
  nav.addEventListener('pointerup', release);
  nav.addEventListener('pointercancel', release);
  nav.addEventListener('click', event => {
    if (!active || !suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // The tape cursor is a slider. Down the page is forward, as on a scrollbar:
  // arrows move a twentieth of a chapter, Page keys a chapter.
  marker.addEventListener('keydown', event => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space') { event.preventDefault(); return; }
    const deltas = { ArrowDown: 0.05, ArrowRight: 0.05, ArrowUp: -0.05, ArrowLeft: -0.05, PageDown: 1, PageUp: -1 };
    let coordinate = null;
    if (event.code === 'Home') coordinate = 0;
    else if (event.code === 'End') coordinate = chapters.length - 1;
    else if (event.code in deltas) coordinate = ruler.coordinate + deltas[event.code];
    if (coordinate === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopAnimation();
    jump(scrollFor(event.code.startsWith('Page') ? Math.round(coordinate) : coordinate));
  });

  // The Hero and 关于 stay two steps, as in the strip: the first swipe, wheel
  // or key from the Hero lands on 关于, and going back from 关于's first
  // position returns to the Hero. Everything below is native scrolling.
  function heroStep(forward, y = window.scrollY) {
    if (y < entry - 2) return forward || y > 1;
    return Math.abs(y - entry) <= 2 && !forward;
  }

  window.addEventListener('touchstart', event => {
    if (!active) return;
    clearTimeout(settleTimer);
    if (animation && animation.kind !== 'hero') stopAnimation();
    touch = event.touches.length === 1 && !event.target.closest?.('.chapter-progress') && !interactive(event.target)
      ? { y: event.touches[0].clientY, scroll: window.scrollY, decided: false } : null;
  }, { passive: true });
  window.addEventListener('touchmove', event => {
    if (!active || !touch || event.touches.length !== 1) return;
    if (animation?.kind === 'hero') { if (event.cancelable) event.preventDefault(); return; }
    if (touch.decided) return;
    const dy = touch.y - event.touches[0].clientY;
    const inHero = touch.scroll < entry - 2;
    // Within the Hero the page takes no native scroll at all.
    if (inHero && event.cancelable) event.preventDefault();
    if (Math.abs(dy) < 4) return;
    touch.decided = true;
    if (!heroStep(dy > 0, touch.scroll)) return;
    if (event.cancelable) event.preventDefault();
    animateTo(dy > 0 ? entry : 0, { kind: 'hero' });
  }, { passive: false });
  const endTouch = event => {
    if (!active) return;
    if (!event.touches?.length) touch = null;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 160);
  };
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });

  window.addEventListener('wheel', event => {
    if (!active || event.ctrlKey || event.metaKey || drag) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
    if (!delta) return;
    const now = performance.now();
    const sameGesture = now - lastWheel < 220;
    lastWheel = now;
    // A hand-over takes the whole gesture, including its inertial tail.
    if (animation?.kind === 'hero' || (wheelHeld && sameGesture)) { event.preventDefault(); wheelHeld = true; return; }
    wheelHeld = false;
    if (heroStep(delta > 0)) {
      event.preventDefault();
      wheelHeld = true;
      animateTo(delta > 0 ? entry : 0, { kind: 'hero' });
      return;
    }
    stopAnimation();
  }, { passive: false });

  document.addEventListener('keydown', event => {
    if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || interactive(event.target)) return;
    const forward = ['ArrowDown', 'PageDown'].includes(event.code) || (event.code === 'Space' && !event.shiftKey);
    const backward = ['ArrowUp', 'PageUp'].includes(event.code) || (event.code === 'Space' && event.shiftKey);
    if (!forward && !backward) return;
    if (event.code === 'Space' && event.target?.closest?.('a')) return;
    if (animation?.kind === 'hero') { event.preventDefault(); return; }
    if (!heroStep(forward)) { stopAnimation(); return; }
    event.preventDefault();
    if (event.repeat) return;
    animateTo(forward ? entry : 0, { kind: 'hero', then: () => focusSection(forward ? 1 : 0) });
  });

  // Section links (the tape's names, the About cards, the brand) ease to
  // their section and add a history entry, like the strip.
  document.addEventListener('click', event => {
    if (!active || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || url.search !== window.location.search) return;
    const index = sections.findIndex(section => `#${section.id}` === url.hash);
    if (index < 0) return;
    event.preventDefault();
    navigate(index);
  });

  // A category link already wrote #journal; a search shows its results there.
  window.addEventListener('site:category', event => {
    if (!active || journalIndex < 0) return;
    event.preventDefault();
    navigate(journalIndex, { history: null });
  });
  document.addEventListener('submit', event => {
    if (!active || event.target.id !== 'post-search' || journalIndex < 0) return;
    event.preventDefault();
    navigate(journalIndex, { history: 'replace', focus: false });
  });

  window.addEventListener('hashchange', () => { if (active) restoreHash({ smooth: true }); });
  window.addEventListener('resize', () => { if (active) { measure(); queue(); } }, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scrollend', () => { if (active && !touch) settle(); });
  // Fonts, images and search results change the page under the loader; a
  // reader who has not moved yet still lands on the linked chapter.
  window.addEventListener('site:revealed', () => {
    if (!active) return;
    measure();
    if (!moved && window.location.hash) restoreHash();
    else queue();
  });
  window.addEventListener('pageshow', () => { if (active) { measure(); queue(); } });

  function activate() {
    if (active) return;
    // The strip stands down first and clears what it wrote.
    window.dispatchEvent(new CustomEvent('site:chapter-mode', { detail: { vertical: true } }));
    active = true;
    current = -1;
    lastProgress = -1;
    moved = false;
    root.classList.add('has-chapters', 'has-vertical-chapters');
    marker.setAttribute('aria-orientation', 'vertical');
    for (const element of units) {
      element.classList.remove(...leftoverClasses);
      element.classList.add('chapter-reveal-unit', 'has-chapter-reveal');
      // Text layers rise in place; the strip slides them in from the side.
      element.style.setProperty('--chapter-reveal-direction', '0');
    }
    // Each block reveals once, as it rises into view.
    reveal = new IntersectionObserver(entries => {
      for (const item of entries) {
        if (!item.isIntersecting) continue;
        item.target.classList.add('is-chapter-revealed');
        reveal?.unobserve(item.target);
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    for (const element of units) reveal.observe(element);
    // Blocks rise as they come into view, several at once in reading order;
    // once wholly off screen they reset, unseen, and rise again next time.
    rise = new IntersectionObserver(entries => {
      entries.filter(item => item.isIntersecting && !item.target.classList.contains('is-vertical-shown'))
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        .forEach((item, order) => {
          item.target.style.setProperty('--vertical-reveal-delay', `${Math.min(order, 6) * 70}ms`);
          item.target.classList.add('is-vertical-shown');
        });
    }, { rootMargin: '0px 0px -8% 0px' });
    reset = new IntersectionObserver(entries => {
      for (const item of entries) if (!item.isIntersecting) item.target.classList.remove('is-vertical-shown');
    });
    layout = new ResizeObserver(() => { if (active) { measure(); queue(); } });
    layout.observe(document.body);
    measure();
    lastScroll = window.scrollY;
    if (!(window.location.hash && restoreHash())) update();
  }

  function deactivate() {
    if (!active) return;
    // Name the chapter being read in the URL: the strip reopens on it.
    writeHash(Math.max(0, current));
    active = false;
    stopAnimation();
    cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of [settleTimer, movingTimer]) clearTimeout(timer);
    clearArrival();
    drag = null;
    touch = null;
    reveal?.disconnect();
    rise?.disconnect();
    reset?.disconnect();
    layout?.disconnect();
    reveal = rise = reset = layout = null;
    for (const element of risen) {
      element.classList.remove('is-vertical-reveal', 'is-vertical-shown');
      element.style.removeProperty('--vertical-reveal-delay');
    }
    risen.clear();
    setInteraction(null);
    clearPlates();
    clearTape();
    for (const element of units) element.style.removeProperty('--chapter-reveal-direction');
    for (const name of ['--tape-cell', '--tape-shift', '--chapter-position', '--site-progress', '--chapter-active-index']) nav.style.removeProperty(name);
    tape.style.removeProperty('--chapter-marker-y');
    for (const [element, inert] of inertStates) if (inert) element.inert = false;
    inertStates.clear();
    nav.classList.remove('is-scrubbing', 'is-chapter-moving', 'is-moving-back');
    marker.setAttribute('aria-orientation', 'horizontal');
    root.classList.remove('has-vertical-chapters');
    window.dispatchEvent(new CustomEvent('site:chapter-mode', { detail: { vertical: false } }));
  }

  query.addEventListener('change', () => (query.matches ? activate() : deactivate()));
  // Reduced motion keeps every panel flat.
  motion.addEventListener('change', () => { if (active) { stopAnimation(); measure(); queue(); } });
  if (query.matches) activate();
})();
