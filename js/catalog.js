(() => {
  'use strict';
  const root = document.documentElement;
  const originalTitle = document.title;
  const series = document.querySelector('#series');
  const chapters = window.SiteChapters;
  if (!series || !chapters) return;
  const header = document.querySelector('.site-header');
  const brand = header.querySelector('.site-brand');
  const back = header.querySelector('.catalog-back');
  const search = header.querySelector('.header-search');
  const panel = series.querySelector('.category-panel');
  const grid = panel.querySelector('.category-columns');
  const heading = series.querySelector('.category-heading');
  const title = heading.querySelector('h2');
  const text = title.querySelector('.category-heading-text');
  const period = title.querySelector('.accent');
  const eyebrow = heading.querySelector('.category-heading-label');
  const neighbours = [...document.querySelectorAll('.chapter-section:not(#series)')];
  const inertNeighbours = new Set();
  const cells = [...grid.children].map(column => ({
    column, slug: column.dataset.categorySlug, cover: column.querySelector('.category-cover'),
    display: column.querySelector('.category-display'), scene: column.querySelector('.category-scene'),
    action: column.querySelector('.category-action'), line: column.querySelector('.category-index-line'),
    block: column.querySelector('.catalog-block'), row: column.querySelector('.catalog-row'),
    light: column.querySelector('.category-facet-light'),
  }));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = () => root.classList.contains('has-vertical-chapters');
  const speed = new URLSearchParams(location.search).get('catalogslow') === '1' ? 5 : 1;
  const move = 'cubic-bezier(.65,0,.35,1)', arrive = 'cubic-bezier(.16,1,.3,1)';
  const px = value => value + 'px';
  const clamp = (n, low, high) => Math.max(low, Math.min(n, high));
  const fromHash = hash => cells.findIndex(cell => hash === '#catalog-' + cell.slug);
  function bezier(x1, y1, x2, y2) {
    const at = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    return t => {
      let low = 0, high = 1;
      for (let n = 0; n < 24; n++) {
        const s = (low + high) / 2;
        if (at(x1, x2, s) < t) low = s; else high = s;
      }
      return at(y1, y2, (low + high) / 2);
    };
  }
  function viewportTop(element) {
    let top = -window.scrollY;
    for (let node = element; node; node = node.offsetParent) top += node.offsetTop;
    return top;
  }
  let active = -1, base, board, layoutShift = 0, run, pendingNavigation, touch;
  let landmarks, distanceRead = 0, remaining = 0, scrollFrame = 0, lastFrame = 0, gesture;
  const openingDistance = 40;
  // CSS grid rounds edges independently to 1/64px during layout.
  const layoutTolerance = 1 / 32;
  const flips = new Map();
  const entrances = new Map();
  // A category the reading line has left folds toward it as soon as the
  // folded board still reaches both ends of the slot (see foldBehind).
  const folds = new Map(), behind = new Set();
  const foldDuration = 450;
  const foldCurve = bezier(.16, 1, .3, 1); // `arrive`, for the per-frame fold width
  const moveCurve = bezier(.65, 0, .35, 1); // `move`
  // The side chapters sink this many vh along an arc of this angle.
  const sinkDepth = 46, sinkArc = 50 * Math.PI / 180;
  // The camera turns up with the panel; the hole and its sky turn down out of
  // the stage (js/main.js). Phones keep the hero's sky.
  const tiltSky = (amount, moving = false) => window.SiteBlackHole?.catalog?.(amount, moving);
  let pendingScrub, transferringFocus = false;
  if (speed !== 1) root.style.setProperty('--catalog-speed', String(speed));

  function positionBack() {
    const frame = header.getBoundingClientRect(), logo = brand.getBoundingClientRect();
    const gap = phone() ? '14px' : '44 * var(--header-unit)';
    back.style.setProperty('--catalog-back-x', `calc(${logo.right - frame.left}px + ${gap})`);
    // Perspective lifts the visual center of the folded brand above the header's center.
    back.style.marginTop = px((logo.top + logo.bottom - frame.top - frame.bottom) / 2);
  }

  // Keep focus out of the back link as soon as the search starts its fade.
  const syncSearch = () => { back.inert = search.classList.contains('is-expanded'); };
  new MutationObserver(syncSearch).observe(search, { attributes: true, attributeFilter: ['class'] });
  syncSearch();

  function measureBase() {
    const css = getComputedStyle(panel);
    // Keep the flat grid's exact layout units. Serialised CSS lengths lose
    // fractions that accumulate when the pixel tracks are written back.
    const rect = panel.getBoundingClientRect();
    const tracks = cells.map(({ column }) => column.getBoundingClientRect().width);
    const hidden = cells.map(c => c.block.hidden);
    // Measure at rest, including rows that may open later during scrolling.
    for (const { block } of cells) block.hidden = false;
    const gains = cells.map(({ row, display }) => Math.max(0,
      row.getBoundingClientRect().width - display.getBoundingClientRect().width));
    cells.forEach(({ block }, i) => { block.hidden = hidden[i]; });
    return {
      w: rect.width, left: rect.left,
      padX: grid.getBoundingClientRect().left - rect.left, padY: parseFloat(css.paddingTop),
      frameLeft: brand.getBoundingClientRect().left,
      frameRight: document.querySelector('.header-tools').getBoundingClientRect().right,
      tracks, gains, art: cells.map(c => getComputedStyle(c.scene).getPropertyValue('--category-art-size').trim() || '1'),
    };
  }

  function layout(tracks, shift) {
    const width = base.w + tracks.reduce((gain, w, i) => gain + w - base.tracks[i], 0);
    const headingLeft = Math.max(base.frameLeft, base.left + shift);
    const headingRight = Math.min(base.frameRight, base.left + shift + width);
    return { width, tracks, shift, headingShift: headingLeft - base.left, headingWidth: headingRight - headingLeft };
  }

  // Each category has the same reading range however the reader enters it.
  function fit(index) {
    const tracks = [...base.tracks];
    const gain = base.gains[index];
    tracks[index] += gain;
    const preceding = tracks.slice(0, index).reduce((a, b) => a + b, 0);
    const left = base.left + base.padX + preceding, right = left + tracks[index];
    const overflow = base.left + base.w + gain - base.padX > base.frameRight;
    const start = overflow ? -Math.min(preceding, gain) : 0;
    const end = Math.min(start, base.frameRight - right);
    const limit = start - end;
    return { tracks, start, limit };
  }

  function placeBoard(b) {
    // Keep wheel travel separate from the left offset committed with the grid.
    const travel = b.shift - layoutShift;
    panel.style.translate = travel ? px(travel) : '';
    heading.style.width = px(b.headingWidth);
    heading.style.left = px(b.headingShift);
    board = b;
  }

  // Values that change with the board go straight to the grid, the panel and
  // the lights. As inherited custom properties they restyled every element on
  // the board, specimens included, on each frame of a fold.
  function setBoard(b) {
    layoutShift = b.shift;
    panel.style.left = px(layoutShift);
    if (!series.classList.contains('has-catalog-board')) {
      series.style.setProperty('--board-base', px(base.w));
      series.style.setProperty('--board-pad-x', px(base.padX));
      series.style.setProperty('--board-pad-y', px(base.padY));
      cells.forEach(({ column }, i) => column.style.setProperty('--catalog-scene-size', base.art[i]));
      series.classList.add('has-catalog-board');
    }
    panel.style.width = px(b.width);
    grid.style.gridTemplateColumns = b.tracks.map(px).join(' ');
    let start = base.padX;
    cells.forEach(({ light }, i) => {
      light.style.setProperty('--board-width', px(b.width));
      light.style.setProperty('--catalog-light-x', px(i === 0 ? 0 : -start));
      start += b.tracks[i];
    });
    placeBoard(b);
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
    panel.style.removeProperty('left');
    panel.style.removeProperty('translate');
    panel.style.removeProperty('width');
    grid.style.removeProperty('grid-template-columns');
    if (!grid.style.length) grid.removeAttribute('style');
    heading.style.removeProperty('width');
    heading.style.removeProperty('left');
    for (const el of [series, ...cells.flatMap(c => [c.column, c.light])]) {
      el.classList.remove('has-compact-row');
      for (const name of [...el.style]) {
        if (name.startsWith('--board-') || name.startsWith('--catalog-')) el.style.removeProperty(name);
      }
      if (!el.style.length) el.removeAttribute('style');
    }
    board = base = null;
  }

  const expanded = i => cells[i].column.classList.contains('is-catalog-open');

  // Distances along the board with all rows laid out end to end. Only travel
  // from input advances this coordinate. Growing or removing a track cannot
  // move the marker, even when it changes the panel's CSS left by thousands.
  function startReading(index) {
    let precedingGain = 0, left = base.left + base.padX;
    const centre = (base.frameLeft + base.frameRight) / 2;
    landmarks = cells.map((_, i) => {
      const { start, limit, tracks } = fit(i);
      const origin = limit || i === index ? precedingGain - start : left + tracks[i] / 2 - centre;
      precedingGain += base.gains[i];
      left += tracks[i];
      return { start: origin, end: origin + limit, limit };
    });
    // Short rows can share a click landing. Space their midpoint markers
    // between the known reading ranges, keeping each long row's endpoints
    // and the explicitly selected landing at their physical positions.
    let previous = -1;
    for (let next = 0; next <= landmarks.length; next++) {
      if (next < landmarks.length && next !== index && !landmarks[next].limit) continue;
      let left = landmarks[previous]?.end ?? -Infinity;
      const right = landmarks[next]?.start ?? Infinity;
      const gap = Math.min(chapters.catalogStationWidth, (right - left) / (next - previous));
      for (let i = previous + 1; i < next; i++) {
        left = clamp(landmarks[i].start, left + gap, right - (next - i) * gap);
        landmarks[i].start = landmarks[i].end = left;
      }
      previous = next;
    }
    distanceRead = landmarks[index].start;
  }

  function scrollState(index = active) {
    const { start, limit } = landmarks[index];
    return limit ? clamp((distanceRead - start) / limit, 0, 1) : null;
  }

  function paintRuler(travel) {
    let i = 0;
    while (i + 1 < cells.length && distanceRead >= landmarks[i + 1].start) i++;
    const here = landmarks[i], next = landmarks[i + 1];
    const between = next ? clamp((distanceRead - here.end) / (next.start - here.end), 0, 1) : 0;
    chapters.setCatalogRuler(active, scrollState(i), {
      cursorIndex: i, between, nextProgress: next?.limit ? 0 : null, travel,
    });
  }

  function columnLeft(index) {
    return board.tracks.slice(0, index).reduce((left, width) => left + width, base.left + board.shift + base.padX);
  }

  function focusReadingCard() {
    transferringFocus = true;
    (cells[active].block.querySelector('.catalog-card') || back).focus({ preventScroll: true });
    transferringFocus = false;
  }

  function readingLine() {
    const centre = (base.frameLeft + base.frameRight) / 2;
    let left = columnLeft(0);
    for (let i = 0; i < cells.length; i++) {
      const right = left + board.tracks[i];
      const offset = flipOffset(i);
      if (expanded(i) && left + offset <= centre && centre < right + offset) {
        if (active === i) return;
        const transfer = cells[active].block.contains(document.activeElement);
        behind.add(active);
        behind.delete(i);
        active = i;
        setPageTitle(i);
        history.replaceState(history.state, '', '#catalog-' + cells[i].slug);
        if (transfer) focusReadingCard();
        break;
      }
      left = right;
    }
  }

  function cancelEntrance(index) {
    entrances.get(index)?.forEach(animation => animation.cancel());
    entrances.delete(index);
  }

  function finishHandOver() {
    if (!flips.size && !entrances.size && !folds.size && !scrollFrame) panel.classList.remove('is-catalog-hand-over');
  }

  function flipOffset(index) {
    const flip = flips.get(index);
    if (!flip) return 0;
    const progress = flip.animation.effect.getComputedTiming().progress ?? (flip.animation.pending ? 0 : 1);
    return flip.from * (1 - progress);
  }

  function cancelFlip(index) {
    flips.get(index)?.animation.cancel();
    flips.delete(index);
  }

  function carryFollowingColumns(index, gain) {
    let left = columnLeft(index + 1);
    for (let i = index + 1; i < cells.length; i++) {
      const width = board.tracks[i];
      const offset = flipOffset(i);
      cancelFlip(i);
      if (left + offset < innerWidth && left + offset + width > 0) {
        // Rebase an unfinished FLIP at its current visual position. Input moves
        // the whole panel independently of this column-local displacement.
        const from = offset - gain;
        const animation = cells[i].column.animate([{ transform: `translateX(${px(from)})` }, { transform: 'none' }],
          { duration: 480 * speed, easing: 'cubic-bezier(.333333,0,.666667,1)' }); // the previous smoothstep
        flips.set(i, { from, animation });
        animation.onfinish = () => {
          if (flips.get(i)?.animation !== animation) return;
          flips.delete(i);
          updateCoverInert();
          finishHandOver();
        };
      }
      left += width;
    }
  }

  function resizeTrack(index, width, fixRight) {
    const tracks = [...board.tracks];
    const gain = width - tracks[index];
    tracks[index] = width;
    board = layout(tracks, board.shift - (fixRight ? gain : 0));
  }

  function foldInstantly(i, fixRight) {
    if (cells[i].block.contains(document.activeElement)) focusReadingCard();
    cancelFlip(i);
    cancelEntrance(i);
    endFold(i);
    setExpanded(i, false);
    resizeTrack(i, base.tracks[i], fixRight);
  }

  // The board as it will stand once every running fold has finished.
  function settledBoard() {
    let b = board;
    for (const [i, fold] of folds) {
      const tracks = [...b.tracks], loss = tracks[i] - base.tracks[i];
      tracks[i] = base.tracks[i];
      b = layout(tracks, b.shift + (fold.fixRight ? loss : 0));
    }
    return b;
  }

  // Folding toward the reading line keeps the edge that faces it in place, so
  // the folded board must still cover the slot on the far side.
  function foldFits(i, fixRight) {
    const b = settledBoard(), loss = b.tracks[i] - base.tracks[i];
    return fixRight ? b.shift + loss <= layoutTolerance : b.shift + b.width - loss >= base.w - layoutTolerance;
  }

  function startFold(i, fixRight, now) {
    const { column, block, line, action } = cells[i];
    if (block.contains(document.activeElement)) focusReadingCard();
    cancelFlip(i);
    cancelEntrance(i);
    panel.classList.add('is-catalog-hand-over');
    column.classList.add('is-catalog-folding');
    column.classList.toggle('is-catalog-fold-right', fixRight);
    column.classList.remove('is-catalog-open');
    block.inert = true;
    const play = (node, frames, delay, duration, easing, pseudoElement) => node.animate(frames, { delay: delay * speed,
      duration: duration * speed, easing, fill: 'both', ...(pseudoElement && { pseudoElement }) });
    folds.set(i, { from: board.tracks[i], fixRight, start: now, effects: [
      play(block, [{ opacity: 1 }, { opacity: 0 }], 0, 140, move),
      // The open 24 × 1 mark draws back into its resting dot about its top right.
      play(line, [{ transform: 'translateY(calc(1 * var(--category-unit))) scale(calc(24px / (3 * var(--category-unit))), calc(1px / (3 * var(--category-unit))))' },
        { transform: 'none' }], 0, 180, arrive, '::after'),
      play(action, [{ opacity: 0 }, { opacity: 1 }], 120, 200, move),
    ] });
  }

  function endFold(i) {
    const fold = folds.get(i);
    if (!fold) return;
    folds.delete(i);
    cells[i].block.hidden = true;
    fold.effects.forEach(animation => animation.cancel());
    cells[i].column.classList.remove('is-catalog-folding', 'is-catalog-fold-right');
  }

  function advanceFolds(now) {
    for (const [i, fold] of folds) {
      const left = columnLeft(i), right = left + board.tracks[i];
      const t = right <= 0 || left >= innerWidth ? 1 : clamp((now - fold.start) / (foldDuration * speed), 0, 1);
      resizeTrack(i, fold.from + (base.tracks[i] - fold.from) * foldCurve(t), fold.fixRight);
      if (t === 1) endFold(i);
    }
  }

  function foldBehind(now) {
    for (let i = 0; i < cells.length; i++) {
      if (i === active || !expanded(i)) continue;
      const left = columnLeft(i) + flipOffset(i), before = left + board.tracks[i] <= 0;
      if (before || left >= innerWidth) {
        behind.delete(i);
        foldInstantly(i, before);
      } else if (behind.has(i) && foldFits(i, i < active)) {
        behind.delete(i);
        if (reduce.matches) foldInstantly(i, i < active);
        else startFold(i, i < active, now);
      }
    }
  }

  function openInPlace(index, direction) {
    endFold(index);
    const width = base.tracks[index] + base.gains[index], gain = width - board.tracks[index];
    if (!reduce.matches && direction > 0 && gain) carryFollowingColumns(index, gain);
    setExpanded(index, true);
    resizeTrack(index, width, direction < 0);
  }

  function enterInPlace(index) {
    const effects = [];
    const play = (node, frames, delay, duration, easing = move, pseudoElement) => {
      const animation = node.animate(frames, { delay: delay * speed, duration: duration * speed,
        easing, fill: 'backwards', ...(pseudoElement && { pseudoElement }) });
      effects.push(animation);
      return animation;
    };
    // Scale the final 24 × 1 mark from its resting dot, about its top right.
    play(cells[index].line, [{ transform: 'translateY(calc(-1 * var(--category-unit))) scale(calc(3 * var(--category-unit) / 24px), calc(3 * var(--category-unit) / 1px))' },
      { transform: 'none' }], 0, 180, arrive, '::after');
    animateCellContents(index, true, true, 0, rowCards(index), play);
    entrances.set(index, effects);
    Promise.all(effects.map(a => a.finished)).then(() => {
      if (entrances.get(index) === effects) entrances.delete(index);
      finishHandOver();
    }, () => {}); // A fold or explicit navigation cancels the entrance.
  }

  function travelAvailable(direction) {
    // The ends hold for the board that running folds are heading to.
    const b = folds.size ? settledBoard() : board;
    const left = base.left + b.shift + base.padX, right = b.tracks.reduce((x, width) => x + width, left);
    // A backward opening can leave a fully fitted board at a negative CSS
    // left. That anchor correction does not create a new scrolling range.
    if (right - b.shift <= base.frameRight && left >= base.frameLeft) return 0;
    if (direction < 0) return Math.max(0, -b.shift);
    return Math.max(0, Math.min(right - base.frameRight, b.width - base.w + b.shift));
  }

  function travel(distance) {
    if (!distance) return;
    board = layout(board.tracks, board.shift - distance);
    distanceRead += distance;
  }

  function applyInput(delta, opened) {
    const direction = Math.sign(delta);
    let amount = Math.abs(delta);
    while (amount > 0) {
      const travelLimit = Math.min(amount, travelAvailable(direction));
      let next = active + direction;
      while (cells[next] && expanded(next)) next += direction;
      if (!gesture || gesture.direction !== direction || !cells[next]) {
        travel(direction * travelLimit);
        if (travelLimit < amount) remaining = 0;
        break;
      }
      const left = columnLeft(next) + flipOffset(next), right = left + board.tracks[next];
      const enter = Math.max(0, direction > 0 ? right - base.frameRight : base.frameLeft - left);
      const leave = direction > 0 ? left - base.frameLeft : base.frameRight - right;
      if (gesture.next !== next || enter > layoutTolerance || leave < -layoutTolerance) gesture.credit = 0;
      gesture.next = next;
      const needed = enter + openingDistance - gesture.credit;
      // Count just the part of this sample after full entry. At a hard stop
      // input can complete the forty pixels without moving the board.
      if (enter <= travelLimit + layoutTolerance && needed <= amount + layoutTolerance
          && Math.min(needed, travelLimit) <= leave + layoutTolerance) {
        travel(direction * Math.min(needed, travelLimit));
        amount = Math.max(0, amount - needed);
        openInPlace(next, direction);
        opened.push(next);
        gesture.credit = 0;
        readingLine();
      } else {
        travel(direction * travelLimit);
        if (travelLimit + layoutTolerance >= enter && travelLimit <= leave + layoutTolerance) {
          gesture.credit += Math.max(0, amount - enter);
        }
        break;
      }
    }
  }

  function renderScroll(now, instant = false) {
    scrollFrame = 0;
    const before = board;
    const previousDistance = distanceRead, previousActive = active;
    const opened = [];
    // The first rAF timestamp can precede the input event in the same
    // display frame. A zero time step leaves that input for the next frame.
    const step = instant ? 1 : 1 - Math.exp(-clamp(now - lastFrame, 0, 64) / (85 * speed));
    let delta = remaining * step;
    if (Math.abs(remaining - delta) < .5) delta = remaining;
    remaining -= delta;
    if (delta) applyInput(delta, opened);
    readingLine();
    foldBehind(now);
    advanceFolds(now);
    if (before.tracks !== board.tracks) setBoard(board);
    else if (before.shift !== board.shift) placeBoard(board);
    for (const index of opened) {
      if (!expanded(index)) continue;
      fitRowHeight(index);
      if (!reduce.matches) enterInPlace(index);
    }
    updateCoverInert();
    if (!gesture || delta || previousActive !== active) paintRuler(gesture ? distanceRead - previousDistance : undefined);
    lastFrame = now;
    if (remaining || flips.size || folds.size) scrollFrame = requestAnimationFrame(renderScroll);
    else if (!entrances.size && panel.classList.contains('is-catalog-hand-over')) requestAnimationFrame(finishHandOver);
  }

  function advanceScroll(instant = false) {
    if (instant || reduce.matches) {
      cancelAnimationFrame(scrollFrame);
      renderScroll(performance.now(), true);
    } else if (!scrollFrame) {
      lastFrame = performance.now();
      scrollFrame = requestAnimationFrame(renderScroll);
    }
  }

  function stopScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = remaining = 0;
    gesture = null;
    for (const index of flips.keys()) cancelFlip(index);
    for (const index of entrances.keys()) cancelEntrance(index);
    if (folds.size) {
      for (const [index, fold] of folds) {
        endFold(index);
        resizeTrack(index, base.tracks[index], fold.fixRight);
      }
      setBoard(board);
    }
    behind.clear();
    finishHandOver();
  }

  function seekBoard(fraction, instant = false) {
    gesture = null;
    remaining = landmarks[active].start + fraction * landmarks[active].limit - distanceRead;
    advanceScroll(instant);
  }

  function moveBoard(delta, source) {
    if (!delta) return;
    const now = performance.now(), direction = Math.sign(delta);
    if (!gesture || gesture.direction !== direction || gesture.source !== source
        || (source !== 'touch' && now - gesture.time >= 400)) {
      gesture = { direction, source, credit: 0 };
    }
    gesture.time = now;
    remaining += delta;
    advanceScroll(!travelAvailable(direction) && Math.sign(remaining) === direction);
  }

  function setExpanded(i, open) {
    const { column, cover, block } = cells[i];
    panel.classList.add('is-catalog-hand-over');
    column.classList.toggle('is-catalog-open', open);
    cover.inert = open;
    block.hidden = block.inert = !open;
  }

  function show(index, leaving = []) {
    cells.forEach(({ column, cover, block }, i) => {
      column.classList.toggle('is-catalog-open', i === index);
      cover.inert = i === index;
      block.hidden = i !== index && !leaving.includes(i);
      block.inert = i !== index;
    });
  }

  function holdNeighbourInert() {
    for (const section of neighbours) {
      if (section.inert) continue;
      section.inert = true;
      inertNeighbours.add(section);
    }
  }

  function clearNeighbourInert() {
    for (const section of inertNeighbours) section.inert = false;
    inertNeighbours.clear();
  }

  function updateCoverInert() {
    let left = board ? base.left + board.shift + base.padX : 0;
    cells.forEach(({ cover }, i) => {
      const right = left + (board?.tracks[i] || 0);
      const offset = flipOffset(i);
      const inert = expanded(i) || Boolean(board && (right + offset <= 0 || left + offset >= innerWidth));
      if (cover.inert !== inert) cover.inert = inert;
      left = right;
    });
  }

  function cleanFinish() {
    tiltSky(active >= 0 && !phone() ? 1 : 0);
    show(active);
    if (active < 0) {
      root.classList.remove('is-catalog');
      clearBoard();
      clearNeighbourInert();
      chapters.releaseCatalog();
    } else updateCoverInert();
    root.classList.remove('is-catalog-transitioning');
    chapters.finishCatalogRuler();
    if (active >= 0 && !phone()) paintRuler();
  }

  function setPageTitle(index) {
    document.title = index < 0 ? originalTitle
      : cells[index].column.querySelector('.category-name').textContent.trim() + ' · 文章目录 · ' + originalTitle;
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

  function focusEnteredCard(transition) {
    if (run !== transition || !transition.focusTarget || (pendingNavigation && pendingNavigation.index !== active)
        || (pendingScrub && pendingScrub.index !== active)) return;
    transition.focusTarget.focus({ preventScroll: true });
    transition.focusTarget = null;
  }

  function finish(interrupted = false) {
    if (!run) return;
    cancelAnimationFrame(run.frame);
    run.effects.forEach(effect => effect.cancel());
    focusEnteredCard(run);
    const deferred = run.wheel;
    run = null;
    writeTitle(active >= 0);
    cleanFinish();
    if (pendingNavigation) {
      const request = pendingNavigation;
      pendingNavigation = null;
      pendingScrub = null;
      change(request.index, { ...request, instant: interrupted || request.instant });
    } else if (pendingScrub) {
      const { index, fraction } = pendingScrub;
      pendingScrub = null;
      scrub(index, fraction, interrupted);
    } else if (deferred && active >= 0 && !phone()) {
      const { limit } = landmarks[active];
      if (limit) seekBoard(clamp(deferred / limit, 0, 1), interrupted);
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
    const box = b => ({ width: px(b.width), left: px(b.shift) });
    effect(panel, [box(from), box(to)], delay, duration);
    effect(grid, [from, to].map(b => ({ gridTemplateColumns: b.tracks.map(px).join(' ') })), delay, duration);
    // The heading meets each frame at a precise point along the same motion.
    const cross = (a, b, edge) => (edge - a) / (b - a);
    const leftCross = cross(from.shift, to.shift, base.frameLeft - base.left);
    const rightCross = cross(from.shift + from.width, to.shift + to.width, base.frameRight - base.left);
    const offsets = [0, ...[leftCross, rightCross].filter(f => f > 0 && f < 1).sort((a, b) => a - b), 1];
    effect(heading, offsets.map(offset => {
      const b = layout(from.tracks.map((w, i) => w + (to.tracks[i] - w) * offset),
        from.shift + (to.shift - from.shift) * offset);
      return { offset, width: px(b.headingWidth), left: px(b.headingShift) };
    }), delay, duration);
  }

  function rowCards(index) {
    return [...cells[index].block.querySelectorAll('.catalog-card, .catalog-empty')].filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.left < base.frameRight && rect.right > base.frameLeft;
    });
  }

  function animateCell(index, opening, switching, delay, cards) {
    const mark = [{ width: 'calc(3 * var(--category-unit))', height: 'calc(3 * var(--category-unit))', top: 'calc(-1 * var(--category-unit))' },
      { width: '24px', height: '1px', top: '0px' }];
    effect(cells[index].line, opening ? mark : mark.reverse(), 0, 180, arrive, '::after');
    animateCellContents(index, opening, switching, delay, cards, effect);
  }

  function animateCellContents(index, opening, switching, delay, cards, play) {
    // The specimen opens, dims and centres itself through CSS (css/catalog.css).
    const { column, action } = cells[index];
    const visual = (element, frames, start, time) =>
      play(element, opening ? frames : [...frames].reverse(), start, time);
    visual(action, [{ opacity: 1 }, { opacity: 0 }], delay, 160);
    if (switching && !opening) {
      // Earlier cards can re-enter the frame while their track collapses.
      play(cells[index].block, [{ opacity: 1 }, { opacity: 0 }], 0, 140);
      return;
    }
    const appear = switching ? 440 : 560;
    column.querySelectorAll('.catalog-group-head').forEach(el =>
      visual(el, [{ opacity: 0 }, { opacity: 1 }], opening ? appear : 0, opening ? 200 : 220));
    cards.forEach((el, i) => {
      if (opening) {
        const animation = play(el, [{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }],
          appear + i * 60, 360, arrive);
        if (el === run?.focusTarget) {
          const transition = run;
          animation.onfinish = () => focusEnteredCard(transition);
        }
      } else play(el, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 10px' }],
        (cards.length - 1 - i) * 40, 220);
    });
  }

  function change(index, { historyMode = 'push', instant = false, focus = true } = {}) {
    if (run) {
      if (index < 0 || historyMode === null) pendingNavigation = { index, historyMode, instant, focus };
      return;
    }
    const leaving = cells.map((_, i) => i).filter(i => i !== index && expanded(i));
    if (index === active && !leaving.length) return;
    const old = active, opening = index >= 0, switching = opening && old >= 0;
    const desktop = !phone(), motion = !instant && !reduce.matches && !document.hidden && (desktop || !switching);
    const keep = !desktop && opening ? viewportTop(cells[index].column) : null;
    const fromKeyboard = focus && document.activeElement?.matches('.category-cover:focus-visible');
    const previousFocus = document.activeElement;
    const losingFocus = leaving.some(i => cells[i].block.contains(previousFocus)) || old >= 0 && previousFocus?.matches('.catalog-back');
    const outgoingCards = desktop && motion && !opening ? leaving.map(i => rowCards(i)) : [];
    stopScroll();
    touch = null;
    if (old < 0) {
      chapters.holdCatalog();
      positionBack();
      if (desktop) holdNeighbourInert();
      if (historyMode === 'push' && location.hash !== '#series') history.replaceState(history.state, '', '#series');
    }
    if (desktop && !base) base = measureBase();
    const from = desktop ? board || layout(base.tracks, 0) : null;
    root.classList.add('is-catalog');
    show(index, motion && desktop ? leaving : []);
    active = index;
    setPageTitle(index);
    if (!desktop && opening) window.dispatchEvent(new CustomEvent('site:catalog-layout', {
      detail: { cell: cells[index].column, keep, instant },
    }));
    if (desktop) {
      const range = opening ? fit(index) : null;
      if (opening) startReading(index);
      setBoard(opening ? layout(range.tracks, range.start) : layout(base.tracks, 0));
      fitRowHeight(index);
    }
    const incomingCards = desktop && motion && opening ? rowCards(index) : [];
    const fraction = desktop && opening ? scrollState() : null;
    const hash = opening ? '#catalog-' + cells[index].slug : '#series';
    if (historyMode && location.hash !== hash) history[historyMode + 'State'](history.state, '', hash);
    if (!desktop && !opening && location.hash === '#series') chapters.measureCatalogDock();
    if ((focus || losingFocus) && !opening) cells[old].cover.focus({ preventScroll: true });
    let focusTarget;
    if ((fromKeyboard || losingFocus) && opening) {
      focusTarget = cells[index].block.querySelector('.catalog-card');
      if (!focusTarget || !motion) {
        transferringFocus = true;
        (focusTarget || back).focus({ preventScroll: true });
        transferringFocus = false;
      }
    }
    title.setAttribute('aria-label', opening ? '文章目录' : '分类');
    if (desktop) chapters.setCatalogRuler(index, fraction, { swap: motion && !switching, speed,
      delay: motion && !switching ? (opening ? 200 : 300) : 0, duration: motion ? 400 : 0 });
    if (!motion) {
      writeTitle(opening);
      cleanFinish();
      return;
    }
    root.classList.add('is-catalog-transitioning');
    const clock = document.body.animate([{}, {}], { duration: 1, fill: 'both' });
    clock.id = 'catalog-transition-clock';
    clock.startTime = document.timeline.currentTime;
    run = { clock, effects: [clock], switching, wheel: 0, focusTarget, length: switching ? 800 : opening ? 1100 : 1000 };
    if (desktop) {
      const duration = switching ? 480 : opening ? 620 : 520, delay = switching ? 140 : 120;
      animateBoard(from, board, delay, duration);
      if (!switching) chapters.animateCatalogPose(opening, (node, frames) => effect(node, frames, delay, duration));
      leaving.forEach((i, n) => animateCell(i, false, switching, delay, outgoingCards[n] || []));
      if (opening) animateCell(index, true, switching, delay, incomingCards);
      if (!switching) for (const n of neighbours) {
        const rect = n.getBoundingClientRect();
        const cx = innerWidth / 2 - (rect.left + rect.width / 2), cy = innerHeight / 2 - (rect.top + rect.height / 2);
        // Each side chapter sinks along a circle whose centre lies level with
        // it, on its outer side: it leaves straight down and bends outward.
        // The two turns about that centre cancel, so the chapter never rolls.
        const side = cx < 0 ? 1 : -1, radius = sinkDepth / Math.sin(sinkArc);
        const pose = (turn, tilt) => `translate(${side * radius}vh,0px) rotate(${-side * turn}rad) `
          + `translate(${-side * radius}vh,0px) rotate(${side * turn}rad) translate(${cx}px,${cy}px) `
          + `perspective(${Math.max(700, 1.1 * innerWidth)}px) translate(${-cx}px,${-cy}px) rotateX(${tilt}deg)`;
        const frames = [{ transform: pose(0, 0) }, { transform: pose(sinkArc, 14) }];
        if (!opening) frames.reverse();
        effect(n, frames, opening ? 0 : 300, opening ? 560 : 600, opening ? move : arrive);
        const opacity = [{ opacity: 1 }, { opacity: 1, offset: .35 }, { opacity: 0 }];
        effect(n, opening ? opacity : [{ opacity: 0 }, { opacity: 1 }], opening ? 0 : 300, opening ? 560 : 600, opening ? move : arrive);
      }
      // The hole speeds up as it nears the stage's edge and eases out of
      // view; coming back it rises fast and settles behind the panel.
      if (!switching) {
        run.sky = opening ? { from: 0, to: 1, delay: 0, duration: 900, curve: moveCurve }
          : { from: 1, to: 0, delay: 250, duration: 900, curve: foldCurve };
        run.length = Math.max(run.length, run.sky.delay + run.sky.duration);
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
      const tilt = run.sky;
      if (tilt) {
        const t = clamp((elapsed - tilt.delay) / tilt.duration, 0, 1);
        tiltSky(tilt.from + (tilt.to - tilt.from) * tilt.curve(t), t > 0 && t < 1);
      }
      if (elapsed >= run.length) finish();
      else run.frame = requestAnimationFrame(tick);
    }
    tick();
  }

  function refresh() {
    finish(true);
    tiltSky(active >= 0 && !phone() ? 1 : 0);
    if (active < 0) return;
    stopScroll();
    const index = active;
    if (phone()) {
      positionBack();
      if (base) clearBoard();
      show(index);
      landmarks = null;
      clearNeighbourInert();
      updateCoverInert();
      return;
    }
    const fraction = landmarks ? scrollState() || 0 : 0;
    clearBoard();
    show(-1);
    chapters.measureCatalogDock();
    positionBack();
    holdNeighbourInert();
    base = measureBase();
    show(index);
    const range = fit(index);
    startReading(index);
    distanceRead += fraction * range.limit;
    setBoard(layout(range.tracks, range.start - fraction * range.limit));
    fitRowHeight(index);
    updateCoverInert();
    chapters.setCatalogRuler(index, scrollState());
  }

  function stop(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function exitInstantly() {
    pendingNavigation = null;
    pendingScrub = null;
    if (run) run.focusTarget = null;
    finish();
    if (active >= 0) change(-1, { instant: true, historyMode: null, focus: false });
  }
  function exitsCatalog(link) {
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
    if (link.origin !== location.origin || link.pathname !== location.pathname || link.search !== location.search) return false;
    return link.hash === '#home' || neighbours.some(section => link.hash === '#' + section.id)
      || (phone() && link.hash === '#series' && link.matches('[data-chapter-link]'));
  }
  document.addEventListener('pointerdown', e => {
    if (run && !e.target.closest('.catalog-back, [data-theme-toggle]') && !exitsCatalog(e.target.closest('a[href]'))) stop(e);
  }, true);
  document.addEventListener('click', e => {
    if (e.button || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const link = e.target.closest('a[href]');
    if (link?.matches('.catalog-back')) { stop(e); change(-1); return; }
    if ((active >= 0 || run) && exitsCatalog(link)) { exitInstantly(); return; }
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
  }, true);
  document.addEventListener('submit', e => {
    if (e.target.id !== 'post-search') return;
    if (run) stop(e);
    else if (active >= 0) exitInstantly();
  }, true);

  window.addEventListener('keydown', e => {
    if (active < 0 && !run) return;
    if (e.key === 'Escape') {
      if (e.target.closest?.('.header-search.is-expanded')) return;
      stop(e); change(-1); return;
    }
    if (run && e.key === 'Enter' && exitsCatalog(e.target.closest?.('a[href]'))) return;
    if (run) { stop(e); return; }
    if (phone() || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable="true"],.chapter-progress-marker')) return;
    if (['ArrowUp', 'ArrowDown'].includes(e.key) && series.classList.contains('is-chapter-scrollable')) {
      stop(e);
      chapters.scrollCatalogChapter(e.key === 'ArrowDown' ? 100 : -100);
      return;
    }
    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      stop(e);
      moveBoard(e.key === 'ArrowRight' ? 100 : -100, 'key');
      return;
    }
    const page = (base.frameRight - base.frameLeft) * .6;
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      stop(e); moveBoard(e.key === 'PageDown' ? page : -page, 'key');
    } else if (e.key === 'Home' || e.key === 'End') {
      stop(e); seekBoard(e.key === 'Home' ? 0 : 1);
    }
  }, true);
  window.addEventListener('wheel', e => {
    if (active < 0 && !run || e.ctrlKey || phone() && !run) return;
    stop(e);
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const distance = (vertical ? e.deltaY : e.deltaX) * unit;
    if (!distance) return;
    if (run) {
      if (run.switching && !phone()) run.wheel += distance;
      return;
    }
    if (vertical && chapters.scrollCatalogChapter(distance)) return;
    moveBoard(distance, 'wheel');
  }, { capture: true, passive: false });
  window.addEventListener('touchstart', e => {
    if (active < 0 || phone() || e.touches.length !== 1 || e.target.closest('.chapter-progress')) return;
    const { clientX: x, clientY: y } = e.touches[0];
    gesture = null;
    touch = { x, y, previous: 0 };
  }, { capture: true, passive: true });
  window.addEventListener('touchmove', e => {
    if (!touch && !run || e.touches.length !== 1) return;
    stop(e);
    if (!touch || run) return;
    const dx = touch.x - e.touches[0].clientX, dy = touch.y - e.touches[0].clientY;
    if (!touch.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 14) touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (touch.axis) {
      const offset = touch.axis === 'x' ? dx : dy;
      const delta = offset - touch.previous;
      touch.previous = offset;
      moveBoard(delta, 'touch');
    }
  }, { capture: true, passive: false });
  for (const name of ['touchend', 'touchcancel']) window.addEventListener(name, () => { touch = null; });
  cells.forEach(({ block }, i) => {
    block.addEventListener('transitionend', e => {
      if (phone() && e.propertyName === 'translate' && e.target === run?.focusTarget
          && e.target.classList.contains('is-vertical-shown')) focusEnteredCard(run);
    });
    block.addEventListener('focusin', e => {
      if (active !== i || run || transferringFocus || phone()) return;
      const card = e.target.closest('.catalog-card');
      if (!card) return;
      // A short chapter is a native vertical scrollport. Chrome can also pan
      // it horizontally when focus lands on a distant card.
      if (series.scrollLeft) series.scrollLeft = 0;
      const rect = card.getBoundingClientRect();
      if (rect.left < base.frameLeft || rect.right > base.frameRight) {
        const delta = rect.left < base.frameLeft ? rect.left - base.frameLeft : rect.right - base.frameRight;
        gesture = null;
        remaining = delta;
        advanceScroll();
      }
    });
  });
  function scrub(index, fraction, instant = false) {
    if (active < 0 || phone() || pendingNavigation) return;
    if (!run && (index !== active || cells.some((_, i) => i !== index && expanded(i)))) {
      change(index, { instant, focus: false });
    }
    if (run) { pendingScrub = { index, fraction }; return; }
    seekBoard(clamp(fraction, 0, 1), instant);
  }
  window.SiteCatalog = {
    scrub,
    markerKey(code) {
      if (code === 'Space') return true;
      if (code === 'Home' || code === 'End') {
        if (code === 'Home') scrub(0, 0);
        else scrub(cells.length - 1, 1);
        return true;
      }
      const directions = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1 };
      const direction = directions[code];
      if (!direction) return false;
      const step = code.startsWith('Arrow') ? 100 : (base.frameRight - base.frameLeft) * .6;
      moveBoard(direction * step, 'key');
      return true;
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
  window.addEventListener('site:chapter-mode', e => {
    if (e.detail.vertical) refresh();
    else requestAnimationFrame(refresh);
  });
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
