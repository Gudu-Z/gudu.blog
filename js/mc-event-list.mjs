// One logical row per game tick plus the events whose rows are open: `shown`
// lists those steps in order, or is null for every event. Store only each
// recorded group's first row. Even long gaps need no row array.
function upperBound(length, read, value) {
  let low = 0, high = length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (read(mid) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function indexEventRows(groups, offsets, shown, eventCount, mode, origin, maxOffset) {
  const before = groups.map(group => shown ? upperBound(shown.length, i => shown[i], group.first - 1) : group.first - 1);
  const totalEvents = shown ? shown.length : eventCount;
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
    const step = shown ? shown[before[i] + relative - 1] : group.first + relative - 1;
    // A row is numbered by its place in the tick, so opening or closing rows
    // above it never renumbers it.
    return { offset: offsets[i], tick: group.tick, groupIndex: i, step, ordinal: step - group.first + 1 };
  }
  // The row of a step, or of its nearest open ancestor while it is folded away.
  function rowOf(step, offset) {
    if (!length) return -1;
    const i = upperBound(offsets.length, j => offsets[j], offset) - 1;
    if (i < 0) return offset;
    if (offset > offsets[i]) return headers[i] + countIn(i) + offset - offsets[i];
    if (!step) return headers[i];
    const ordinal = shown ? upperBound(shown.length, j => shown[j], step) - before[i] : step - groups[i].first + 1;
    return headers[i] + Math.max(0, Math.min(countIn(i), ordinal));
  }
  // At the tick level the cursor stays on its tick's station.
  function selectedRow(step, offset) { return rowOf(mode === 'tick' ? 0 : step, offset); }
  return { length, rowAt, rowOf, selectedRow };
}

// Which steps have a row: an event shows while its tick and every ancestor
// are open. `open(key)` answers for a tick (key -1 - its group's index) or an
// event (its step). Children follow their parent within a tick, so a closed
// row hides everything deeper until the next row at its depth or above.
export function visibleSteps(groups, depths, open) {
  const shown = [];
  for (const [g, group] of groups.entries()) {
    if (!open(-1 - g)) continue;
    let closedAt = Infinity;
    for (let step = group.first; step <= group.last; step++) {
      const depth = depths[step - 1];
      if (depth > closedAt) continue;
      closedAt = open(step) ? Infinity : depth;
      shown.push(step);
    }
  }
  return shown;
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

// Inside each game tick the shown rows form a tree: a row hangs off the
// nearest shown row above it that is shallower, or off the axis when there is
// none, so a level that hides some events hands their children up. For every
// shown step this records its depth in that tree (nesting deeper than `cap`
// shares the last column), whether a later sibling follows it (flag 1) or its
// first child comes next (flag 2), and which ancestors' lines pass through its
// row on their way to a later child (bit j for the line in column j).
export function branchShapes(groups, depths, shown = null, cap = 8) {
  const depth = new Uint8Array(depths.length);
  const pass = new Uint16Array(depths.length);
  const flags = new Uint8Array(depths.length);
  const open = new Uint8Array(cap + 2);
  let k = 0;
  for (const group of groups) {
    const order = [], level = [], stack = [];
    if (shown) {
      while (k < shown.length && shown[k] < group.first) k++;
      for (; k < shown.length && shown[k] <= group.last; k++) order.push(shown[k]);
    } else {
      for (let step = group.first; step <= group.last; step++) order.push(step);
    }
    for (const step of order) {
      const real = depths[step - 1];
      while (stack.length && stack.at(-1) >= real) stack.pop();
      level.push(Math.min(cap, stack.length));
      stack.push(real);
    }
    // A later sibling is the next row at the same depth before any shallower one.
    open.fill(0);
    for (let i = order.length - 1; i >= 0; i--) {
      const d = level[i];
      if (open[d]) flags[order[i] - 1] |= 1;
      open.fill(0, d + 1);
      open[d] = 1;
    }
    // An ancestor's line carries on through a row while the ancestor below it
    // on the way to that row still has a later sibling.
    open.fill(0);
    for (let i = 0; i < order.length; i++) {
      const index = order[i] - 1, d = level[i];
      depth[index] = d;
      for (let j = 0; j + 1 < d; j++) if (open[j + 1]) pass[index] |= 1 << j;
      if (level[i + 1] > d) flags[index] |= 2;
      open[d] = flags[index] & 1;
    }
  }
  return { depth, pass, flags };
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

// One stretch of a branch line in a row (css/mc-article.css, .mc-branch): it
// passes through, ends at this row's tick (└), or drops from under its mark
// towards its children.
function branch(column, part) {
  const node = document.createElement('i');
  node.className = 'mc-branch';
  node.dataset.part = part;
  node.style.setProperty('--mc-column', String(column));
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

  let mode, rows, shapes, active = -1, currentOffset = 0, lastStep, requested = -1;
  let rowHeight = 32, height = 0, rangeStart = -1, rangeEnd = -1, frame = 0;
  let anchorTop = null, anchorFirst = 0;
  // Each level is a starting point for what is open: every event at 事件; at
  // 阶段 the ticks and the events that hold the phase rows (a tick's 维度刻);
  // nothing at 游戏刻. A double-click flips one row's next level against that,
  // until the level changes.
  const holdsPhase = new Set();
  for (const step of phaseSteps) {
    for (let parent = scene.events[step - 1].parent, d = depths[step - 1]; d > 0; d--, parent = scene.events[parent].parent) {
      holdsPhase.add(parent + 1);
    }
  }
  const childCount = new Uint32Array(scene.events.length + 1);
  scene.events.forEach((event, i) => { if (depths[i]) childCount[event.parent + 1]++; });
  const overrides = new Map();
  function isOpen(key) {
    if (overrides.has(key)) return overrides.get(key);
    return mode === 'event' || (mode === 'phase' && (key < 0 || holdsPhase.has(key)));
  }
  function rebuild() {
    const shown = visibleSteps(groups, depths, isOpen);
    rows = indexEventRows(groups, offsets, shown, scene.events.length, mode, origin, maxOffset);
    shapes = branchShapes(groups, depths, shown);
    rangeStart = -1;
    size();
  }

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
      let state = '';
      if (row.groupIndex >= 0) {
        const open = isOpen(-1 - row.groupIndex);
        node.title = open ? '双击收起这一刻' : '双击展开这一刻';
        state = open ? '，已展开' : '，已收起';
      }
      node.setAttribute('aria-label', '第 ' + row.tick + ' 刻，' + row.count + ' 个事件' + state);
    } else {
      const event = scene.events[row.step - 1];
      node.className = 'mc-event-row';
      node.dataset.step = String(row.step);
      node.dataset.kind = eventKind(event);
      // The row's place in its tick's tree and its stretch of the branch lines.
      const at = row.step - 1, depth = shapes.depth[at], flags = shapes.flags[at];
      node.style.setProperty('--mc-depth', String(depth));
      for (let column = 0; column + 1 < depth; column++) {
        if (shapes.pass[at] & 1 << column) node.append(branch(column, 'pass'));
      }
      if (depth) node.append(branch(depth - 1, flags & 1 ? 'pass' : 'end'));
      if (flags & 2) node.append(branch(depth, 'drop'));
      const text = label(event);
      const coords = event.pos ? position(event.pos) : '';
      // A folded row counts its hidden children after its name.
      const name = span('mc-event-name', '');
      name.append(span('mc-event-label', text));
      const children = childCount[row.step];
      let state = '';
      if (children) {
        const open = isOpen(row.step);
        node.title = open ? '双击收起下一级' : '双击展开下一级（' + children + ' 个）';
        if (!open) name.append(span('mc-event-more', '+' + children));
        state = '，' + children + ' 个下级，' + (open ? '已展开' : '已收起');
      }
      node.append(span('mc-event-index', String(row.ordinal).padStart(2, '0')), name);
      if (coords) node.append(span('mc-event-pos', coords));
      const parent = event.parent === undefined ? '' : '，上级第 ' + (event.parent + 1) + ' 步';
      node.setAttribute('aria-label', '第 ' + row.tick + ' 刻，第 ' + row.step + ' 步，' + text
        + (coords ? '，坐标 ' + coords : '') + parent + state);
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
    let push = 0;
    if (!pin.hidden) {
      const group = groups[topRow.groupIndex];
      pinNumber.textContent = String(topRow.tick);
      pinCount.textContent = (group.last - group.first + 1) + ' 个事件';
      pin.toggleAttribute('data-current-tick', topRow.offset === currentOffset);
      // The next station pushes the pinned one up as it arrives.
      const nextRow = topIndex + 1 < rows.length ? rows.rowAt(topIndex + 1) : null;
      push = nextRow && nextRow.step === undefined ? Math.min(0, (topIndex + 1 - firstVisible - 1) * rowHeight) : 0;
      pin.style.transform = push ? 'translateY(' + push + 'px)' : '';
      // What is pushed above the list is cut away, so the station slides
      // under the list's top edge instead of over the settings line.
      pin.style.clipPath = push ? 'inset(' + -push + 'px 0 -2px 0)' : '';
    }
    // The rows passing under the pinned station are masked away
    // (css/mc-article.css), so the station needs no fill of its own and the
    // tree keeps one ground from top to bottom.
    const cover = pin.hidden ? 0 : Math.max(0, 1 + rowHeight + push);
    frameElement.style.setProperty('--mc-pin-cover', cover + 'px');
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
      overrides.clear();
      rebuild();
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
  // A double-click (or Enter) opens or closes a row's next level: a tick's
  // outermost events, or an event's children. The current row stays marked,
  // on its nearest open ancestor while it is folded away.
  function toggle(index) {
    if (!rows || index < 0 || index >= rows.length) return;
    const row = rows.rowAt(index);
    const key = row.step !== undefined ? row.step : row.groupIndex >= 0 ? -1 - row.groupIndex : 0;
    if (!key || (key > 0 && !childCount[key])) return;
    const current = active >= 0 ? rows.rowAt(active) : null;
    overrides.set(key, !isOpen(key));
    rebuild();
    if (current) active = rows.rowOf(current.step ?? 0, current.offset);
    draw();
  }

  // The first click selects a row and the double-click opens or closes that
  // same row, even if the first click scrolled it a little under the pointer.
  let pressed = -1;
  element.addEventListener('click', event => {
    if (event.detail > 1) return;
    const node = event.target.closest('button[data-index]');
    pressed = node ? Number(node.dataset.index) : -1;
    if (!node) return;
    element.focus({preventScroll: true});
    activate(pressed);
  });
  element.addEventListener('dblclick', event => {
    if (pressed >= 0 && event.target.closest('button[data-index]')) toggle(pressed);
  });
  element.addEventListener('keydown', event => {
    if (!rows?.length || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      toggle(active);
      return;
    }
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
