(() => {
  'use strict';

  // The home page replaces the mouse pointer with a focus frame: four corner
  // ticks around a point that open onto the link, button, card or ruler segment under it.
  // Text fields, the ruler axis and the ruler cursor draw their own pointer
  // (text cursor, landing hairline, triangle), so there the frame only holds them.
  // Touch, pen and coarse pointers keep the system cursor.
  const root = document.documentElement;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const editable = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, [contenteditable="true"]';
  const clickable = 'a[href], button:not(:disabled), [role="slider"], [role="button"], summary, label[for]';
  // Panels keep moving briefly after the mouse (HUD parallax, hover transitions),
  // so a locked frame re-reads its target for this long after the last movement.
  const settleTime = 400;
  const scrollRest = 120;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const layer = document.createElement('div');
  layer.className = 'site-cursor';
  layer.setAttribute('aria-hidden', 'true');
  const [topLeft, topRight, bottomLeft, bottomRight, dot] = ['tl', 'tr', 'bl', 'br', 'dot'].map(name => {
    const part = document.createElement('i');
    part.className = `site-cursor-${name}`;
    layer.append(part);
    return part;
  });
  document.body.append(layer);

  const styleValues = new WeakMap();
  let visible = false;
  let x = 0;
  let y = 0;
  let kind = 'point';
  let target = null;
  let box = null;
  let hoverX = NaN;
  let pressed = false;
  let frame = null;
  let lastMove = 0;
  let scrollTimer = 0;
  let animation = 0;
  let lastFrame = 0;

  function setStyle(element, name, value) {
    let values = styleValues.get(element);
    if (!values) { values = new Map(); styleValues.set(element, values); }
    if (values.get(name) === value) return;
    values.set(name, value);
    element.style.setProperty(name, value);
  }

  function place(element, left, top) {
    setStyle(element, 'transform', `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`);
  }

  function classify(element) {
    const node = element?.nodeType === 1 ? element : element?.parentElement || null;
    if (!node) return ['point', null];
    // The header search is one control: its icon, field and clear button share
    // one frame, which also follows the field while it opens.
    const search = node.closest('.header-search');
    if (search) return [node.closest(editable) ? 'field' : 'target', search];
    const field = node.closest(editable);
    if (field) return ['field', field];
    // The track carries the axis line and the landing point of the rail preview.
    const rail = node.closest('.chapter-progress-rail');
    if (rail) return ['axis', rail.parentElement];
    const link = node.closest(clickable);
    if (!link) return ['point', null];
    if (link.matches('.chapter-progress-marker')) return ['grip', link];
    // A ruler station link fills its whole cell, so the frame holds that segment.
    return ['target', link];
  }

  function scrubbing(node) {
    return Boolean(node?.closest('.chapter-progress')?.classList.contains('is-scrubbing'));
  }

  function measure() {
    const rect = target?.isConnected ? target.getBoundingClientRect() : null;
    box = rect && (rect.width || rect.height) ? rect : null;
    if (kind !== 'axis' || !target) return;
    // chapters.js writes the settled landing point of a click and clears it from a
    // press until the next move, while its click eases there; the caliper waits on it.
    const landing = parseFloat(target.style.getPropertyValue('--chapter-hover-x'));
    if (Number.isFinite(landing)) hoverX = landing;
  }

  function setKind(nextKind, nextTarget) {
    const changed = nextKind !== kind;
    kind = nextKind;
    if (nextTarget !== target || changed) {
      target = nextTarget;
      box = null;
      hoverX = NaN;
      if (target) measure();
    }
    if (!changed) return;
    layer.classList.toggle('is-locked', kind === 'target');
    layer.classList.toggle('is-field', kind === 'field');
    layer.classList.toggle('is-axis', kind === 'axis');
    layer.classList.toggle('is-grip', kind === 'grip');
  }

  function goal() {
    const inset = pressed ? 3 : 0;
    if (box && kind === 'axis') {
      // A narrow caliper around the ruler's own landing hairline (13px tall).
      const center = Number.isFinite(hoverX) ? box.left + hoverX : x;
      const axis = box.top + box.height / 2;
      return { l: center - 5, t: axis - 10 + inset, r: center + 5, b: axis + 10 - inset, arm: 4 };
    }
    if (box && kind === 'grip') {
      // The ruler cursor's triangle overhangs its 2px stem by 4.5px and rises 4.5px above it.
      return { l: box.left - 8.5 + inset, t: box.top - 8.5 + inset, r: box.right + 8.5 - inset, b: box.bottom + 4 - inset, arm: 5 };
    }
    if (box && (kind === 'target' || kind === 'field')) {
      const pad = 5 - inset;
      return { l: box.left - pad, t: box.top - pad, r: box.right + pad, b: box.bottom + pad, arm: clamp(Math.min(box.width, box.height) * 0.18, 6, 12) };
    }
    const half = 9 - inset;
    return { l: x - half, t: y - half, r: x + half, b: y + half, arm: 5 };
  }

  function schedule() {
    if (!animation && visible) animation = requestAnimationFrame(draw);
  }

  function draw(now) {
    animation = 0;
    if (!visible) return;
    const elapsed = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    // chapters.js moves a dragged ruler cursor in its own frames after the pointer
    // event, so a held grip keeps reading it until the drag ends.
    const dragging = kind === 'grip' && scrubbing(target);
    const refreshing = kind !== 'point' && (dragging || now - lastMove < settleTime);
    if (refreshing) measure();
    const next = goal();
    // The frame trails the point slightly and opens onto targets a little slower;
    // on the ruler it sticks to the hairline and the dragged cursor without lag.
    const snap = motion.matches || !frame || kind === 'axis' || kind === 'grip';
    const ease = snap ? 1 : 1 - Math.exp(-elapsed / (kind === 'point' ? 50 : 80));
    frame ||= { ...next };
    let moving = false;
    for (const side of ['l', 't', 'r', 'b']) {
      const value = frame[side] + (next[side] - frame[side]) * ease;
      const settled = Math.abs(next[side] - value) < 0.05;
      frame[side] = settled ? next[side] : value;
      moving ||= !settled;
    }
    place(topLeft, frame.l, frame.t);
    place(topRight, frame.r, frame.t);
    place(bottomLeft, frame.l, frame.b);
    place(bottomRight, frame.r, frame.b);
    place(dot, x - 1, y - 1);
    setStyle(layer, '--site-cursor-arm', `${Math.round(next.arm)}px`);
    if (moving || refreshing) schedule();
    else lastFrame = 0;
  }

  function show() {
    if (visible) return;
    visible = true;
    // A frame returning to the window appears in place instead of sliding in.
    frame = null;
    lastFrame = 0;
    root.classList.add('has-site-cursor');
    layer.classList.add('is-visible');
  }

  function hide() {
    if (!visible) return;
    visible = false;
    cancelAnimationFrame(animation);
    animation = 0;
    clearTimeout(scrollTimer);
    scrollTimer = 0;
    layer.classList.remove('is-visible');
  }

  function restoreSystemCursor() {
    hide();
    root.classList.remove('has-site-cursor');
  }

  addEventListener('pointermove', event => {
    // A pen or finger on a hybrid device gets the system cursor back until the mouse returns.
    if (event.pointerType !== 'mouse' || !finePointer.matches) { restoreSystemCursor(); return; }
    x = event.clientX;
    y = event.clientY;
    lastMove = performance.now();
    // A press keeps what it started on. A captured ruler press reports the ruler
    // cursor as its target before any drag begins, which would jump the frame to
    // it; the frame takes the cursor only once the ruler is actually dragged.
    if (!pressed) setKind(...classify(event.target));
    else if (kind !== 'grip' && scrubbing(event.target)) setKind('grip', event.target.closest('.chapter-progress-marker'));
    show();
    schedule();
  }, { passive: true });

  addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    pressed = true;
    layer.classList.add('is-pressed');
    schedule();
  }, { passive: true });

  for (const type of ['pointerup', 'pointercancel']) {
    addEventListener(type, () => {
      if (!pressed) return;
      pressed = false;
      layer.classList.remove('is-pressed');
      schedule();
    }, { passive: true });
  }

  // The strip and long chapters move under a still mouse. Release the lock while
  // they move and hit-test once they rest, instead of forcing layout every frame.
  addEventListener('scroll', () => {
    if (!visible) return;
    // The header and the ruler stay fixed and keep their lock. Only the ruler
    // cursor travels with the strip, so its grip holds just while it is dragged;
    // dragging and click easing scroll the page continuously.
    const fixed = Boolean(target?.closest('.site-header') || target?.closest('.chapter-progress'));
    if (kind !== 'point' && (!fixed || (kind === 'grip' && !scrubbing(target)))) setKind('point', null);
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      // A held press keeps its target; the first move after release reclassifies.
      if (!visible || pressed) return;
      setKind(...classify(document.elementFromPoint(x, y)));
      lastMove = performance.now();
      schedule();
    }, scrollRest);
    schedule();
  }, { capture: true, passive: true });

  // A target can keep moving after the mouse stops (the search box opening, slow
  // frames): when its own transition or an ancestor's ends, read it once more.
  document.addEventListener('transitionend', event => {
    if (!visible || !target || !(event.target === target || event.target.contains?.(target))) return;
    lastMove = performance.now();
    schedule();
  }, true);

  document.addEventListener('pointerout', event => { if (!event.relatedTarget) hide(); });
  addEventListener('blur', hide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  finePointer.addEventListener('change', () => { if (!finePointer.matches) restoreSystemCursor(); });
})();
