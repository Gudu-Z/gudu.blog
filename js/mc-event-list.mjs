// One logical row per game tick plus the events visible at the chosen level.
// Store only each recorded group's first row. Even long gaps need no row array.
function upperBound(length, read, value) {
  let low = 0, high = length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (read(mid) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function indexEventRows(groups, offsets, phaseSteps, eventCount, mode, origin, maxOffset) {
  const before = groups.map(group => {
    if (mode === 'tick') return 0;
    if (mode === 'event') return group.first - 1;
    return upperBound(phaseSteps.length, i => phaseSteps[i], group.first - 1);
  });
  const totalEvents = mode === 'tick' ? 0 : mode === 'phase' ? phaseSteps.length : eventCount;
  const headers = groups.map((_, i) => offsets[i] + before[i]);
  function countIn(i) { return (before[i + 1] ?? totalEvents) - before[i]; }
  const length = maxOffset + 1 + totalEvents;

  function rowAt(index) {
    const i = upperBound(headers.length, j => headers[j], index) - 1;
    if (i < 0) return { offset: index, tick: origin + index, count: 0, groupIndex: -1 };
    const group = groups[i];
    const relative = index - headers[i];
    const count = countIn(i);
    if (relative === 0 || relative > count) {
      const ahead = relative === 0 ? 0 : relative - count;
      return { offset: offsets[i] + ahead, tick: group.tick + ahead,
        count: ahead ? 0 : group.last - group.first + 1, groupIndex: ahead ? -1 : i };
    }
    const step = mode === 'phase' ? phaseSteps[before[i] + relative - 1] : group.first + relative - 1;
    return { offset: offsets[i], tick: group.tick, groupIndex: i, step, ordinal: relative };
  }
  function selectedRow(step, offset) {
    if (!length) return -1;
    const i = upperBound(offsets.length, j => offsets[j], offset) - 1;
    if (i < 0) return offset;
    if (offset > offsets[i]) return headers[i] + countIn(i) + offset - offsets[i];
    if (!step || mode === 'tick') return headers[i];
    const ordinal = mode === 'event' ? step - groups[i].first + 1
      : upperBound(phaseSteps.length, j => phaseSteps[j], step) - before[i];
    return headers[i] + Math.max(0, Math.min(countIn(i), ordinal));
  }
  return { length, rowAt, selectedRow };
}

// A small mark at the end of each event's tick on the ruler: a block change,
// an update, a scheduled tick, a block event, a piston, a game event or an
// entity. Phases mark the structure already and take none.
export function eventKind(event) {
  const { type, detail = '' } = event;
  if (type === 'setBlock' || event.after !== undefined) return 'set';
  if (type === 'update') return 'update';
  if (type === 'addScheduleTick' || /^Execute(Block|Fluid)Tick$/.test(detail)) return 'tick';
  if (type === 'addBlockEvent' || detail === 'ExecuteBlockEvent') return 'event';
  if (/^(pistonStructure|movingPiston|movingPistonTick)$/.test(type)
    || (type === 'blockEntityTick' && /piston/.test(detail))) return 'piston';
  if (/GameEvent$/.test(type)) return 'game';
  if (/^entity/.test(type)) return 'entity';
  if (type === 'phase' || type === 'levelTick') return 'phase';
  return 'other';
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

let nextListId = 0;
export function mountEventList(scene, selectStep, {label, position, groups, depths, offsets, phaseSteps, selectTick, origin, maxOffset}) {
  const element = document.createElement('div');
  element.className = 'mc-event-list';
  element.setAttribute('role', 'listbox');
  element.setAttribute('aria-label', '回放时间轴列表');
  element.tabIndex = 0;
  element.hidden = maxOffset < 0;
  // The list is a vertical ruler (css/mc-article.css). Its axis stands just
  // right of the widest tick number.
  let digits = Math.max(String(origin).length, String(origin + maxOffset).length);
  for (const group of groups) digits = Math.max(digits, String(group.tick).length);
  const id = 'mc-list-' + ++nextListId;
  const track = document.createElement('div');
  track.className = 'mc-list-track';
  track.setAttribute('role', 'presentation');
  const windowRows = document.createElement('div');
  windowRows.className = 'mc-list-window';
  windowRows.setAttribute('role', 'presentation');
  const measure = document.createElement('div');
  measure.className = 'mc-row-measure';
  measure.setAttribute('aria-hidden', 'true');
  track.append(measure, windowRows);
  element.append(track);
  // When the reader scrolls the current row out of view, a pill at that edge
  // leads back to it. It sits outside the listbox, in a frame around it.
  const frameElement = document.createElement('div');
  frameElement.className = 'mc-list-frame';
  frameElement.hidden = element.hidden;
  frameElement.style.setProperty('--mc-list-axis', Math.max(2, digits) * 7 + 18 + 'px');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'mc-list-return';
  back.hidden = true;
  // While a tick's events fill the top of the list, its station stays pinned
  // there, so the reader always knows which game tick the rows belong to.
  const pin = document.createElement('div');
  pin.className = 'mc-list-pin';
  pin.setAttribute('aria-hidden', 'true');
  pin.hidden = true;
  const pinNumber = span('mc-tick-number', '');
  const pinCount = span('mc-tick-count', '');
  pin.append(pinNumber, pinCount);
  frameElement.append(element, pin, back);

  let mode, rows, active = -1, currentOffset = 0, lastStep, requested = -1;
  let rowHeight = 32, height = 0, rangeStart = -1, rangeEnd = -1, frame = 0;
  let anchorTop = null, anchorFirst = 0;
  function rowNode(index) {
    const row = rows.rowAt(index);
    const node = document.createElement('button');
    node.type = 'button';
    node.tabIndex = -1;
    node.id = id + '-' + index;
    node.dataset.index = String(index);
    node.setAttribute('role', 'option');
    node.setAttribute('aria-posinset', String(index + 1));
    node.setAttribute('aria-setsize', String(rows.length));
    if (row.step === undefined) {
      node.className = 'mc-tick-row';
      node.dataset.offset = String(row.offset);
      // A game tick is a numbered station; an empty one keeps only its number.
      node.append(span('mc-tick-number', String(row.tick)), span('mc-tick-count', row.count ? row.count + ' 个事件' : ''));
      node.setAttribute('aria-label', '第 ' + row.tick + ' 刻，' + row.count + ' 个事件');
    } else {
      const event = scene.events[row.step - 1];
      node.className = 'mc-event-row';
      node.dataset.step = String(row.step);
      node.dataset.kind = eventKind(event);
      node.style.setProperty('--mc-depth', String(Math.min(4, depths[row.step - 1])));
      const text = label(event);
      const coords = event.pos ? position(event.pos) : '';
      node.append(span('mc-event-index', String(row.ordinal).padStart(2, '0')), span('mc-event-label', text));
      if (coords) node.append(span('mc-event-pos', coords));
      const parent = event.parent === undefined ? '' : '，上级第 ' + (event.parent + 1) + ' 步';
      node.setAttribute('aria-label', '第 ' + row.tick + ' 刻，第 ' + row.step + ' 步，' + text
        + (coords ? '，坐标 ' + coords : '') + parent);
    }
    return node;
  }

  // Cap the physical scroll height below browser pixel limits. Ordinary
  // recordings scroll at exactly one CSS row per event; huge ranges map their
  // scrollbar proportionally while preserving exact keyboard and seek targets.
  function geometry() {
    const viewport = element.clientHeight;
    const logicalMax = Math.max(0, rows.length - viewport / rowHeight);
    const physicalMax = Math.max(0, height - viewport);
    if (element.scrollTop !== anchorTop) anchorTop = null;
    const firstVisible = anchorTop === null
      ? (physicalMax ? element.scrollTop * logicalMax / physicalMax : 0)
      : Math.min(logicalMax, anchorFirst);
    return { viewport, logicalMax, physicalMax, firstVisible };
  }

  function draw() {
    if (!rows) return;
    const {viewport, firstVisible} = geometry();
    const start = Math.max(0, Math.floor(firstVisible / 4) * 4 - 6);
    const end = Math.min(rows.length, Math.ceil(firstVisible + viewport / rowHeight) + 7);
    if (start !== rangeStart || end !== rangeEnd) {
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i++) fragment.append(rowNode(i));
      windowRows.replaceChildren(fragment);
      rangeStart = start; rangeEnd = end;
    }
    const top = element.scrollTop + (start - firstVisible) * rowHeight;
    windowRows.style.transform = 'translateY(' + top + 'px)';
    for (const node of windowRows.children) {
      const selected = Number(node.dataset.index) === active;
      node.setAttribute('aria-selected', String(selected));
      if (selected) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
      node.toggleAttribute('data-current-tick', node.dataset.offset === String(currentOffset));
    }
    if (active >= start && active < end) element.setAttribute('aria-activedescendant', id + '-' + active);
    else element.removeAttribute('aria-activedescendant');
    const topIndex = Math.min(rows.length - 1, Math.floor(firstVisible + 0.001));
    const topRow = topIndex >= 0 ? rows.rowAt(topIndex) : null;
    pin.hidden = !topRow || topRow.step === undefined;
    if (!pin.hidden) {
      const group = groups[topRow.groupIndex];
      pinNumber.textContent = String(topRow.tick);
      pinCount.textContent = (group.last - group.first + 1) + ' 个事件';
      pin.toggleAttribute('data-current-tick', topRow.offset === currentOffset);
      // The next station pushes the pinned one up as it arrives.
      const nextRow = topIndex + 1 < rows.length ? rows.rowAt(topIndex + 1) : null;
      const push = nextRow && nextRow.step === undefined ? Math.min(0, (topIndex + 1 - firstVisible - 1) * rowHeight) : 0;
      pin.style.transform = push ? 'translateY(' + push + 'px)' : '';
    }
    // The current row is out of view once its middle (where the cursor
    // points) leaves the window; the pill then names its tick.
    const middle = active + 0.5;
    const away = active < 0 || !viewport ? 0 : middle < firstVisible ? -1 : middle > firstVisible + viewport / rowHeight ? 1 : 0;
    back.hidden = !away;
    if (away) {
      back.dataset.edge = away < 0 ? 'top' : 'bottom';
      back.textContent = (away < 0 ? '↑' : '↓') + ' 当前 · 第 ' + rows.rowAt(active).tick + ' 刻';
    }
  }

  function size() {
    rowHeight = measure.getBoundingClientRect().height || rowHeight;
    height = Math.min(4_000_000, (rows?.length ?? 0) * rowHeight);
    track.style.height = height + 'px';
  }

  function reveal(index) {
    const {viewport, firstVisible, logicalMax, physicalMax} = geometry();
    if (!viewport || !logicalMax || index < 0) return;
    let first = firstVisible;
    if (index < first) first = index;
    else if (index + 1 > first + viewport / rowHeight) first = index + 1 - viewport / rowHeight;
    if (first !== firstVisible) {
      element.scrollTop = first / logicalMax * physicalMax;
      // A browser may round scrollTop. Keep subpixel targets exact until the
      // next physical scroll, particularly for very large empty tick ranges.
      anchorTop = element.scrollTop;
      anchorFirst = first;
    }
  }

  function sync(step, {offset = 0, mode: nextMode = 'event'} = {}) {
    const changed = mode !== nextMode;
    if (changed) {
      mode = nextMode;
      rows = indexEventRows(groups, offsets, phaseSteps, scene.events.length, mode, origin, maxOffset);
      rangeStart = -1;
      size();
    }
    let index = rows.selectedRow(step, offset);
    if (requested >= 0) index = requested;
    else if (!changed && step === lastStep && offset === currentOffset) index = active;
    lastStep = step;
    if (changed || active !== index) reveal(index);
    active = index;
    currentOffset = offset;
    draw();
  }

  function activate(index) {
    if (!rows?.length) return;
    requested = Math.max(0, Math.min(rows.length - 1, index));
    try {
      const row = rows.rowAt(requested);
      if (row.step === undefined) selectTick(row.offset);
      else selectStep(row.step);
    } finally { requested = -1; }
  }
  element.addEventListener('click', event => {
    const node = event.target.closest('button[data-index]');
    if (!node) return;
    element.focus({preventScroll: true});
    activate(Number(node.dataset.index));
  });
  element.addEventListener('keydown', event => {
    if (!rows?.length || event.altKey || event.metaKey || event.ctrlKey) return;
    const page = Math.max(1, Math.floor(element.clientHeight / rowHeight));
    const jumps = { ArrowUp: active - 1, ArrowDown: active + 1, PageUp: active - page,
      PageDown: active + page, Home: 0, End: rows.length - 1 };
    if (!Object.hasOwn(jumps, event.key)) return;
    event.preventDefault();
    activate(jumps[event.key]);
  });
  element.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }, {passive: true});
  // The details under the list grow and shrink with each event, changing the
  // list's height after sync() placed the current row; bring it back in view.
  let viewportHeight = 0;
  const resize = new ResizeObserver(() => {
    size();
    if (rangeStart < 0 || !element.scrollTop || element.clientHeight !== viewportHeight) reveal(active);
    viewportHeight = element.clientHeight;
    draw();
  });
  resize.observe(element);
  resize.observe(measure);
  back.addEventListener('click', () => {
    reveal(active);
    draw();
    element.focus({preventScroll: true});
  });
  return {element: frameElement, sync, destroy() { resize.disconnect(); cancelAnimationFrame(frame); }};
}
