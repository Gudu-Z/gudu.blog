(() => {
  'use strict';
  const root = document.documentElement;
  const series = document.querySelector('#series');
  const chapters = window.SiteChapters;
  if (!series || !chapters) return;
  const panel = series.querySelector('.category-panel');
  const grid = panel.querySelector('.category-columns');
  const heading = series.querySelector('.category-heading');
  const title = heading.querySelector('h2');
  const text = title.querySelector('.category-heading-text');
  const period = title.querySelector('.accent');
  const eyebrow = heading.querySelector('.category-heading-label');
  const neighbours = [...document.querySelectorAll('.chapter-section:not(#series)')];
  const cells = [...grid.children].map(column => ({
    column, slug: column.dataset.categorySlug, cover: column.querySelector('.category-cover'),
    display: column.querySelector('.category-display'), scene: column.querySelector('.category-scene'),
    action: column.querySelector('.category-action'), line: column.querySelector('.category-index-line'),
    block: column.querySelector('.catalog-block'), row: column.querySelector('.catalog-row'),
  }));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = () => root.classList.contains('has-vertical-chapters');
  const speed = new URLSearchParams(location.search).get('catalogslow') === '1' ? 5 : 1;
  const move = 'cubic-bezier(.65,0,.35,1)', arrive = 'cubic-bezier(.16,1,.3,1)';
  const px = value => value + 'px';
  const clamp = (n, low, high) => Math.max(low, Math.min(n, high));
  const fromHash = hash => cells.findIndex(cell => hash === '#catalog-' + cell.slug);
  let active = -1, base, board, run, pendingNavigation, scrollFrame, scrollTarget, touch;
  let limit = 0, scrollWidth = 0;
  if (speed !== 1) root.style.setProperty('--catalog-speed', String(speed));

  function measureBase() {
    const css = getComputedStyle(panel);
    const w = parseFloat(css.width), h = parseFloat(css.height);
    const padX = parseFloat(css.paddingLeft), padY = parseFloat(css.paddingTop);
    const bounds = panel.getBoundingClientRect();
    const headingBounds = heading.getBoundingClientRect();
    const [ox, oy] = css.transformOrigin.split(' ').map(parseFloat);
    const pose = new DOMMatrix().translate(ox, oy)
      .multiply(new DOMMatrix(css.transform === 'none' ? undefined : css.transform)).translate(-ox, -oy);
    // The track supplies a translation outside the panel's own projection.
    function point(x, y) {
      const p = pose.transformPoint({ x, y });
      return { x: p.x / p.w, y: p.y / p.w };
    }
    const corners = [point(0, 0), point(w, 0), point(0, h), point(w, h)];
    const left = bounds.left - Math.min(...corners.map(p => p.x));
    const top = bounds.top - Math.min(...corners.map(p => p.y));
    // Intersect the camera ray with the docked board's plane.
    function camera(shift) {
      const x = innerWidth / 2 - shift - left, y = innerHeight / 2 - top;
      const a = pose.m11 - x * pose.m14, b = pose.m21 - x * pose.m24;
      const c = pose.m12 - y * pose.m14, d = pose.m22 - y * pose.m24;
      const e = x * pose.m44 - pose.m41, f = y * pose.m44 - pose.m42;
      return { x: (e * d - b * f) / (a * d - b * c), y: (a * f - e * c) / (a * d - b * c) };
    }
    return {
      w, h, padX, padY, camera, x: (x, y) => left + point(x, y).x,
      slotLeft: cells[0].column.getBoundingClientRect().left, dockRight: bounds.right,
      headingLeft: headingBounds.left, headingScale: headingBounds.width / w,
      p: Math.max(700, 1.1 * innerWidth),
      frameLeft: document.querySelector('.site-brand').getBoundingClientRect().left,
      frameRight: document.querySelector('.header-tools').getBoundingClientRect().right,
      tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat),
      displays: cells.map(c => parseFloat(getComputedStyle(c.display).width)),
      art: cells.map(c => getComputedStyle(c.scene).getPropertyValue('--category-art-size').trim() || '1'),
    };
  }

  function layout(tracks, angle, shift, index = 0, foldShift = shift) {
    const { w, h, padX, padY, camera, p } = base;
    const gain = tracks.reduce((extra, width, i) => extra + width - base.tracks[i], 0);
    const sin = Math.sin(angle * Math.PI / 180), cos = Math.cos(angle * Math.PI / 180);
    // The extra slide translates the already fitted folds in screen pixels.
    const eye = camera(foldShift);
    const a = tracks[0] + padX, b = tracks.at(-1) + padX;
    const leftInset = eye.x * a * sin / p - a * (1 - cos);
    const width = (w + gain + leftInset - eye.x * b * sin / p - b * (1 - cos)) / (1 - b * sin / p);
    const rightInset = width - w - gain - leftInset;
    // A folded edge turns about its divider before the panel projects it onto the screen.
    function edge(x, distance, insetY, bound) {
      const factor = p / (p - Math.abs(distance) * sin);
      const projectedX = eye.x + (x + distance * (cos - 1) - eye.x) * factor;
      return bound(...[insetY, h - insetY].map(y => base.x(projectedX, eye.y + (y - eye.y) * factor) + shift));
    }
    function fold(hinge, turn) {
      const x = eye.x - hinge, y = eye.y - h / 2;
      return `translate(${x}px,${y}px) perspective(${p}px) translate(${-x}px,${-y}px) rotateY(${turn}deg)`;
    }
    const start = leftInset + padX + tracks.slice(0, index).reduce((sum, track) => sum + track, 0);
    const track = tracks[index];
    const columnLeft = edge(start, index === 0 ? -track : 0, padY, Math.min);
    const columnRight = edge(start + track, index === tracks.length - 1 ? track : 0, padY, Math.max);
    const boardRight = edge(width - rightInset - padX, tracks.at(-1), padY, Math.max);
    const headingLeft = Math.max(base.frameLeft, edge(leftInset, -a, 0, Math.min));
    const headingRight = Math.min(base.frameRight, edge(width - rightInset, b, 0, Math.max));
    return { width, shift, foldShift, tracks, angle, leftInset, rightInset, columnLeft, columnRight, boardRight,
      headingShift: headingLeft - base.headingLeft, headingWidth: (headingRight - headingLeft) / base.headingScale,
      folds: [fold(leftInset + a, angle), fold(width - rightInset - b, -angle)],
    };
  }

  function fit(index) {
    if (index < 0) return layout(base.tracks, 0, 0);
    const requested = Math.max(0, parseFloat(getComputedStyle(cells[index].row).width) - base.displays[index]);
    const span = base.frameRight - base.frameLeft, angle = reduce.matches ? 0 : 6;
    function place(gain) {
      const tracks = [...base.tracks];
      tracks[index] += gain;
      let result = layout(tracks, angle, 0, index);
      // Moving the board also changes the camera's position relative to each fold.
      for (let i = 0; i < 8; i++) {
        const shift = Math.min(0, result.shift + base.frameRight - result.columnRight);
        if (Math.abs(shift - result.shift) < .005) break;
        result = layout(tracks, angle, shift, index);
      }
      return result;
    }
    // Probe one frame span at a time so even a very long row stays in front of the camera.
    let lo = 0, hi = Math.min(requested, span);
    let result = place(hi);
    while (result.columnRight - result.columnLeft <= span) {
      if (hi === requested) {
        if (index === 0 || result.boardRight <= base.frameRight + .005) return result;
        const extra = clamp(result.columnLeft - base.slotLeft, 0, result.boardRight - base.dockRight);
        return layout(result.tracks, angle, result.shift - extra, index, result.shift);
      }
      lo = hi;
      hi = Math.min(requested, hi + span);
      result = place(hi);
    }
    while (hi - lo > .005) {
      const gain = (lo + hi) / 2;
      result = place(gain);
      if (result.columnRight - result.columnLeft > span) hi = gain;
      else lo = gain;
    }
    return place(lo);
  }

  function setBoard(b) {
    const style = series.style;
    const values = { 'board-base': px(base.w), 'board-width': px(b.width), 'board-shift': px(b.shift),
      'board-heading-width': px(b.headingWidth), 'board-heading-shift': px(b.headingShift),
      'board-inset-left': px(b.leftInset), 'board-inset-right': px(b.rightInset),
      'board-pad-x': px(base.padX), 'board-pad-y': px(base.padY), 'board-tracks': b.tracks.map(px).join(' ') };
    for (const [name, value] of Object.entries(values)) style.setProperty('--' + name, value);
    let start = b.leftInset + base.padX;
    cells.forEach(({ column }, i) => {
      const s = column.style;
      s.setProperty('--catalog-scene-x', px(base.displays[i] / 2));
      s.setProperty('--catalog-scene-size', base.art[i]);
      s.setProperty('--catalog-light-x', px(-(i === 0 ? b.leftInset : start)));
      if (i === 0 || i === 3) s.setProperty('--catalog-fold', b.folds[i === 0 ? 0 : 1]);
      start += b.tracks[i];
    });
    series.classList.add('has-catalog-board');
    board = b;
  }

  function fitRowHeight(index) {
    if (index < 0) return;
    const { column, row, display } = cells[index];
    column.classList.remove('has-compact-row');
    const deficit = row.offsetHeight - display.clientHeight;
    if (deficit <= 0) return;
    // Borrow the open cell's vertical gutters on short laptops before clipping its cards.
    const gaps = ['composition', 'name', 'description', 'bottom'].map(name =>
      [name, parseFloat(getComputedStyle(column.querySelector('.category-' + name)).marginTop)]);
    gaps.push(['footer-pad', parseFloat(getComputedStyle(column.querySelector('.category-bottom')).paddingTop)]);
    const available = gaps.reduce((sum, [, gap]) => sum + gap, 2 * base.padY);
    const use = Math.min(1, (deficit + 1) / available);
    column.style.setProperty('--catalog-bleed-y', px(-base.padY * use));
    for (const [name, gap] of gaps) column.style.setProperty('--catalog-gap-' + name, px(gap * (1 - use)));
    column.classList.add('has-compact-row');
  }

  function clearBoard() {
    series.classList.remove('has-catalog-board');
    for (const el of [series, ...cells.map(c => c.column)]) {
      el.classList.remove('has-compact-row');
      for (const name of [...el.style]) {
        if (name.startsWith('--board-') || name.startsWith('--catalog-')) el.style.removeProperty(name);
      }
      if (!el.style.length) el.removeAttribute('style');
    }
    board = base = null;
  }

  function scrollState(index) {
    const { block } = cells[index];
    const x = block.scrollLeft;
    block.style.setProperty('--catalog-left-fade', px(x > .5 ? 90 : 0));
    block.style.setProperty('--catalog-right-fade', px(limit - x > .5 ? 90 : 0));
    return limit ? .1 + .8 * clamp(x / limit, 0, 1) : .5;
  }

  function scrollToRow(x) {
    if (run || phone() || active < 0 || !limit) return;
    const block = cells[active].block;
    scrollTarget = clamp(x, 0, limit);
    if (reduce.matches) { block.scrollLeft = scrollTarget; return; }
    if (scrollFrame) return;
    let previous = performance.now(), current = block.scrollLeft;
    function step(now) {
      const gain = 1 - Math.exp(-Math.min(64, now - previous) / (85 * speed));
      current += (scrollTarget - current) * gain;
      if (Math.abs(current - scrollTarget) < .6) current = scrollTarget;
      block.scrollLeft = current;
      previous = now;
      scrollFrame = current === scrollTarget ? 0 : requestAnimationFrame(step);
    }
    scrollFrame = requestAnimationFrame(step);
  }

  function show(index, old = -1) {
    cells.forEach(({ column, cover, block }, i) => {
      column.classList.toggle('is-catalog-open', i === index);
      cover.inert = i === index;
      block.hidden = i !== index && i !== old;
      block.inert = i !== index;
      if (block.hidden) { block.scrollLeft = 0; block.removeAttribute('style'); }
    });
  }

  function cleanFinish() {
    show(active);
    if (active < 0) {
      root.classList.remove('is-catalog');
      clearBoard();
      chapters.releaseCatalog();
    }
    root.classList.remove('is-catalog-transitioning');
    chapters.finishCatalogRuler();
    if (active >= 0 && !phone()) chapters.setCatalogRuler(active, scrollState(active));
  }

  function writeTitle(open) {
    const label = open ? '文章目录' : '分类';
    text.textContent = label;
    title.setAttribute('aria-label', label);
    eyebrow.textContent = open ? 'ARTICLE INDEX' : 'CATEGORIES';
    period.classList.remove('is-cursor-blinking');
    text.style.removeProperty('width');
    period.style.removeProperty('translate');
    if (!text.style.length) text.removeAttribute('style');
    if (!period.style.length) period.removeAttribute('style');
  }

  function titleStops() {
    const css = getComputedStyle(text);
    const pen = document.createElement('canvas').getContext('2d');
    pen.font = css.fontWeight + ' ' + css.fontSize + ' ' + css.fontFamily;
    pen.letterSpacing = css.letterSpacing;
    const widths = new Map([['', 0]]);
    for (const label of ['分类', '文章目录']) {
      for (let n = 1; n <= label.length; n++) {
        const prefix = label.slice(0, n);
        widths.set(prefix, pen.measureText(prefix).width);
      }
    }
    // As in the hero, keep the title's measure while its period follows the ink.
    const width = Math.max(...widths.values());
    text.style.width = px(width);
    return new Map([...widths].map(([prefix, x]) => [prefix, px(x - width)]));
  }

  function animateHeading(elapsed, opening) {
    const from = opening ? '分类' : '文章目录', to = opening ? '文章目录' : '分类';
    const erased = from.length * 70, blinkEnd = erased + 280;
    const label = elapsed < erased ? from.slice(0, from.length - Math.floor(elapsed / 70))
      : to.slice(0, Math.max(0, Math.floor((elapsed - blinkEnd) / 106)));
    if (run.glyphs !== label) {
      run.glyphs = label;
      text.textContent = label;
      period.style.translate = run.stops.get(label);
    }
    period.classList.toggle('is-cursor-blinking', elapsed >= erased && elapsed < blinkEnd);
    const target = opening ? 'ARTICLE INDEX' : 'CATEGORIES';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>_';
    const tick = Math.floor(elapsed / 22);
    if (tick === run.decodeTick) return;
    run.decodeTick = tick;
    const decoded = [...target].map((c, i) => elapsed >= 600 - (target.length - 1 - i) * 22
      ? c : chars[Math.floor(Math.random() * chars.length)]).join('');
    if (eyebrow.textContent !== decoded) eyebrow.textContent = decoded;
  }

  function finish(interrupted = false) {
    if (!run) return;
    cancelAnimationFrame(run.frame);
    run.effects.forEach(effect => effect.cancel());
    run = null;
    writeTitle(active >= 0);
    cleanFinish();
    if (pendingNavigation) {
      const request = pendingNavigation;
      pendingNavigation = null;
      change(request.index, { ...request, instant: interrupted || request.instant });
    }
  }

  function effect(node, frames, delay, duration, easing = move, pseudoElement) {
    const animation = node.animate(frames, { duration: duration * speed, delay: delay * speed,
      easing, fill: 'both', ...(pseudoElement && { pseudoElement }) });
    animation.startTime = run.clock.startTime;
    run.effects.push(animation);
    run.length = Math.max(run.length, delay + duration);
    return animation;
  }

  function animateBoard(from, to, delay, duration) {
    const path = Array.from({ length: 33 }, (_, i) => {
      const progress = i / 32;
      const tracks = from.tracks.map((w, n) => w + (to.tracks[n] - w) * progress);
      const shift = from.shift + (to.shift - from.shift) * progress;
      const foldShift = from.foldShift + (to.foldShift - from.foldShift) * progress;
      return layout(tracks, from.angle + (to.angle - from.angle) * progress, shift, 0, foldShift);
    });
    path[0] = from;
    path[path.length - 1] = to;
    effect(panel, path.map(b => ({ width: px(b.width), left: px(b.shift) })), delay, duration);
    effect(heading, path.map(b => ({ width: px(b.headingWidth), left: px(b.headingShift) })), delay, duration);
    const tracks = b => ({ gridTemplateColumns: b.tracks.map(px).join(' '),
      marginLeft: px(b.leftInset), marginRight: px(b.rightInset) });
    effect(grid, path.map(tracks), delay, duration);
    [0, 3].forEach((i, side) => effect(cells[i].column, path.map(b => ({ transform: b.folds[side] })), delay, duration));
  }

  function animateCell(index, opening, switching, delay, duration) {
    const { column, scene, line, action } = cells[index];
    const visual = (element, frames, start, time, ease, pseudo) =>
      effect(element, opening ? frames : [...frames].reverse(), start, time, ease, pseudo);
    visual(scene, [{ opacity: 1, scale: '1' }, { opacity: .62, scale: '1.3' }], delay, duration);
    visual(action, [{ opacity: 1 }, { opacity: 0 }], delay, 160);
    visual(line, [{ width: 'calc(3 * var(--category-unit))', height: 'calc(3 * var(--category-unit))', top: 'calc(-1 * var(--category-unit))' },
      { width: '24px', height: '1px', top: '0px' }], 0, 180, arrive, '::after');
    const cards = [...column.querySelectorAll('.catalog-card, .catalog-empty')];
    const appear = switching ? 440 : 560;
    column.querySelectorAll('.catalog-group-head').forEach(el =>
      visual(el, [{ opacity: 0 }, { opacity: 1 }], opening ? appear : 0, opening ? 200 : switching ? 140 : 220));
    cards.forEach((el, i) => {
      if (opening) effect(el, [{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }],
        appear + i * 60, 360, arrive);
      else if (switching) effect(el, [{ opacity: 1 }, { opacity: 0 }], 0, 140);
      else effect(el, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 10px' }],
        (cards.length - 1 - i) * 40, 220);
    });
  }

  function change(index, { historyMode = 'push', instant = false, focus = true } = {}) {
    if (run) {
      if (index < 0 || historyMode === null) pendingNavigation = { index, historyMode, instant, focus };
      return;
    }
    if (index === active) return;
    const old = active, opening = index >= 0, switching = opening && old >= 0;
    const desktop = !phone(), motion = !instant && !reduce.matches && !document.hidden && (desktop || !switching);
    const fromKeyboard = focus && document.activeElement?.matches('.category-cover:focus-visible');
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    touch = null;
    if (old < 0) {
      chapters.holdCatalog();
      if (historyMode === 'push' && location.hash !== '#series') history.replaceState(history.state, '', '#series');
    }
    if (desktop && !base) base = measureBase();
    const from = desktop ? board || fit(-1) : null;
    root.classList.add('is-catalog');
    show(index, motion && desktop ? old : -1);
    active = index;
    if (desktop && opening) {
      cells[index].block.style.setProperty('--catalog-row-start', px(base.displays[index] * .62));
      cells[index].block.scrollLeft = 0;
    }
    if (desktop) {
      setBoard(fit(index));
      fitRowHeight(index);
    }
    scrollWidth = desktop && opening ? cells[index].block.clientWidth : 0;
    limit = desktop && opening ? Math.max(0, cells[index].block.scrollWidth - scrollWidth) : 0;
    const fraction = desktop && opening ? scrollState(index) : .5;
    const hash = opening ? '#catalog-' + cells[index].slug : '#series';
    if (historyMode && location.hash !== hash) history[historyMode + 'State'](history.state, '', hash);
    if (!desktop && !opening && location.hash === '#series') chapters.measureCatalogDock();
    if (focus && !opening) cells[old].cover.focus({ preventScroll: true });
    if (fromKeyboard && opening) {
      (cells[index].block.querySelector('a') || document.querySelector('.catalog-back')).focus({ preventScroll: true });
    }
    title.setAttribute('aria-label', opening ? '文章目录' : '分类');
    if (desktop) chapters.setCatalogRuler(index, fraction, { swap: motion && !switching, speed,
      delay: motion && !switching ? (opening ? 200 : 300) : 0, duration: motion ? 400 : 0 });
    if (!motion) { writeTitle(opening); cleanFinish(); return; }
    root.classList.add('is-catalog-transitioning');
    const clock = document.body.animate([{}, {}], { duration: 1, fill: 'both' });
    clock.id = 'catalog-transition-clock';
    clock.startTime = document.timeline.currentTime;
    run = { clock, effects: [clock], length: switching ? 800 : opening ? 1100 : 1000 };
    if (desktop) {
      const duration = switching ? 480 : opening ? 620 : 520, delay = switching ? 140 : 120;
      animateBoard(from, board, delay, duration);
      if (old >= 0) animateCell(old, false, switching, delay, duration);
      if (opening) animateCell(index, true, switching, delay, duration);
      if (!switching) for (const n of neighbours) {
        const rect = n.getBoundingClientRect();
        const cx = innerWidth / 2 - (rect.left + rect.width / 2), cy = innerHeight / 2 - (rect.top + rect.height / 2);
        const tilt = `translateY(46vh) translate(${cx}px,${cy}px) perspective(${base.p}px) translate(${-cx}px,${-cy}px) rotateX(14deg)`;
        const frames = opening ? [{ transform: 'none' }, { transform: tilt }] : [{ transform: tilt }, { transform: 'none' }];
        effect(n, frames, opening ? 0 : 300, opening ? 560 : 600, opening ? move : arrive);
        const opacity = [{ opacity: 1 }, { opacity: 1, offset: .35 }, { opacity: 0 }];
        effect(n, opening ? opacity : [{ opacity: 0 }, { opacity: 1 }], opening ? 0 : 300, opening ? 560 : 600, opening ? move : arrive);
      }
    }
    if (!switching) {
      run.stops = titleStops();
      const erased = (opening ? 2 : 4) * 70;
      effect(period, [{ opacity: 1, easing: 'steps(1,end)' },
        { opacity: 0, offset: .5, easing: 'steps(1,end)' }, { opacity: 1 }], erased, 280, 'linear');
    }
    clock.effect.updateTiming({ duration: run.length * speed });
    function tick() {
      const elapsed = clock.currentTime / speed;
      if (!switching) animateHeading(elapsed, opening);
      if (elapsed >= run.length) finish();
      else run.frame = requestAnimationFrame(tick);
    }
    tick();
  }

  function refresh() {
    finish(true);
    if (active < 0) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    const index = active, block = cells[index].block;
    const fraction = limit ? block.scrollLeft / limit : 0;
    clearBoard();
    cells[index].column.classList.remove('is-catalog-open');
    chapters.measureCatalogDock();
    if (!phone()) base = measureBase();
    show(index);
    if (phone()) { block.removeAttribute('style'); limit = 0; return; }
    block.style.setProperty('--catalog-row-start', px(base.displays[index] * .62));
    setBoard(fit(index));
    fitRowHeight(index);
    scrollWidth = block.clientWidth;
    limit = Math.max(0, block.scrollWidth - scrollWidth);
    block.scrollLeft = fraction * limit;
    chapters.setCatalogRuler(index, scrollState(index));
  }

  function stop(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function exitInstantly() {
    pendingNavigation = null;
    finish();
    if (active >= 0) change(-1, { instant: true, historyMode: null, focus: false });
  }
  document.addEventListener('pointerdown', e => {
    if (run && !e.target.closest('.catalog-back, [data-theme-toggle]')) stop(e);
  }, true);
  document.addEventListener('click', e => {
    if (e.button || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const link = e.target.closest('a[href]');
    if (link?.matches('.catalog-back')) { stop(e); change(-1); return; }
    if (run) {
      if (e.target.closest('[data-theme-toggle]')) finish(true);
      else stop(e);
      return;
    }
    if (!link) return;
    if (link.matches('.category-cover, [data-chapter-link]')) {
      const index = fromHash(link.hash);
      if (index >= 0) { stop(e); change(index); return; }
    }
    if (active >= 0 && (link.matches('.site-brand') || (phone() && link.matches('[data-chapter-link]')))) exitInstantly();
  }, true);
  document.addEventListener('submit', e => {
    if (e.target.id !== 'post-search') return;
    if (run) stop(e);
    else if (active >= 0) exitInstantly();
  }, true);

  window.addEventListener('keydown', e => {
    if (active < 0 && !run) return;
    if (e.key === 'Escape') { stop(e); change(-1); return; }
    if (run) { stop(e); return; }
    if (phone() || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,[contenteditable="true"]')) return;
    const position = scrollFrame ? scrollTarget : cells[active].block.scrollLeft;
    const keys = { ArrowRight: position + 100, ArrowLeft: position - 100, PageDown: position + scrollWidth * .6,
      PageUp: position - scrollWidth * .6, Home: 0, End: limit };
    if (Object.hasOwn(keys, e.key)) { stop(e); scrollToRow(keys[e.key]); }
  }, true);
  window.addEventListener('wheel', e => {
    if (active < 0 && !run || e.ctrlKey || phone() && !run) return;
    stop(e);
    if (run) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    scrollToRow((scrollFrame ? scrollTarget : cells[active].block.scrollLeft) + delta * unit);
  }, { capture: true, passive: false });
  window.addEventListener('touchstart', e => {
    if (active < 0 || phone() || e.touches.length !== 1 || e.target.closest('.chapter-progress')) return;
    const { clientX: x, clientY: y } = e.touches[0];
    touch = { x, y, start: cells[active].block.scrollLeft };
  }, { capture: true, passive: true });
  window.addEventListener('touchmove', e => {
    if (!touch && !run || e.touches.length !== 1) return;
    stop(e);
    if (!touch || run) return;
    const dx = touch.x - e.touches[0].clientX, dy = touch.y - e.touches[0].clientY;
    if (!touch.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 14) touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (touch.axis) scrollToRow(touch.start + (touch.axis === 'x' ? dx : dy));
  }, { capture: true, passive: false });
  for (const name of ['touchend', 'touchcancel']) window.addEventListener(name, () => { touch = null; });
  cells.forEach(({ block }, i) => {
    block.addEventListener('scroll', () => {
      if (active === i && !run && !phone()) chapters.setCatalogRuler(i, scrollState(i));
    });
    block.addEventListener('focusin', e => {
      if (active !== i || run || phone()) return;
      const card = e.target.closest('.catalog-card');
      if (!card) return;
      // Native Tab scrolling can overtake an ease started by the previous card.
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      const left = card.offsetLeft, right = left + card.offsetWidth;
      if (left < block.scrollLeft || right > block.scrollLeft + scrollWidth) {
        scrollToRow(left < block.scrollLeft ? left : right - scrollWidth);
      }
    });
  });
  window.SiteCatalog = {
    scrub(index, fraction) {
      if (run || active < 0 || phone()) return;
      if (index !== active) change(index);
      else scrollToRow(clamp(fraction, 0, 1) * limit);
    },
  };
  function followHistory() {
    const index = fromHash(location.hash);
    if (index !== -1 || location.hash === '#series') change(index, { historyMode: null, focus: false });
    else if (active >= 0 || run) exitInstantly();
  }
  window.addEventListener('popstate', followHistory);
  window.addEventListener('hashchange', followHistory);
  window.addEventListener('resize', refresh);
  window.addEventListener('site:chapter-mode', () => requestAnimationFrame(refresh));
  window.addEventListener('site:revealed', refresh);
  window.addEventListener('pageshow', e => { if (e.persisted) refresh(); });
  window.addEventListener('site:theme', () => finish(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finish(true);
    else refresh();
  });
  reduce.addEventListener('change', refresh);
  const initial = fromHash(location.hash);
  if (initial >= 0) change(initial, { instant: true, historyMode: null, focus: false });
})();
