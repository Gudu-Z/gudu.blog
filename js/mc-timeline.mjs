import { eventTarget } from './mc-replay.mjs';
import { eventKind, mountEventList } from './mc-event-list.mjs';
import { validSpeed, getDefaultPlayback, saveDefaultPlayback, SPEED_UNITS, speedClock, toClockRate, fromClockRate,
  GRANULARITY_LABELS, normalizeGranularity } from './mc-playback-settings.mjs';

const eventNames = {
  setBlock: '设置方块', update: '方块更新', phase: '游戏刻阶段', levelTick: '维度刻',
  queue: '队列执行', addScheduleTick: '加入计划刻', addBlockEvent: '加入方块事件',
  postGameEvent: '发出游戏事件', receivedGameEvent: '接收游戏事件', pistonStructure: '活塞推动检查',
  movingPistonTick: '活塞运动', itemTransfer: '物品传输', entityMove: '实体移动',
  entitySpawn: '实体进出', entityTick: '实体刻', entitySetHealth: '实体生命变化',
  entityCollideAxis: '实体碰撞', blockEntityTick: '方块实体刻', blockEntityCreation: '创建方块实体',
  networkPacket: '网络数据包',
};
const subtypes = {
  NeighbourUpdate: '邻居更新', ShapeUpdate: '形状更新', ExecuteBlockTick: '执行方块计划刻',
  ExecuteFluidTick: '执行流体计划刻', ExecuteBlockEvent: '执行方块事件',
  PacketProcessPhase: '数据包处理', ScheduledTickPhase: '计划刻阶段', BlockEventPhase: '方块事件阶段',
  BlockEntityPhase: '方块实体阶段', EntityTickPhase: '实体阶段', LevelTickPhase: '维度刻',
  AsyncTaskPhase: '异步任务阶段', ChunkTickPhase: '区块刻阶段', DragonFightPhase: '末影龙战斗阶段',
  IceAndSnowPhase: '冰雪阶段', PlayerTickPhase: '玩家阶段', RandomTickPhase: '随机刻阶段',
};

function eventLabel(event) {
  if (event.type === 'movingPiston') return event.piston === null ? '移除移动活塞' : '生成移动活塞';
  if (Object.hasOwn(subtypes, event.detail)) return subtypes[event.detail];
  return Object.hasOwn(eventNames, event.type) ? eventNames[event.type] : event.type;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, callback) {
  const button = element('button', label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

// Small line icons for the transport and the links, in the HUD's thin
// stroke (the triangles filled, css/mc-article.css).
const svgNS = 'http://www.w3.org/2000/svg';
const iconShapes = {
  prev: ['M5 4.5v11', 'M15 4.5 7.5 10l7.5 5.5z'],
  play: ['M6.5 4.5 16 10l-9.5 5.5z'],
  pause: ['M7 4.5v11', 'M13 4.5v11'],
  next: ['M15 4.5v11', 'M5 4.5 12.5 10 5 15.5z'],
  bookmark: ['M6 3.5h8v13l-4-3-4 3z'],
  link: ['M8.6 11.4l2.8-2.8', 'M9.2 6.6l1.3-1.3a3 3 0 0 1 4.2 4.2l-1.3 1.3', 'M10.8 13.4l-1.3 1.3a3 3 0 0 1-4.2-4.2l1.3-1.3'],
  tune: ['M3.5 6.5h7', 'M14.5 6.5h2', 'M12.5 4.5v4', 'M3.5 13.5h2', 'M9.5 13.5h7', 'M7.5 11.5v4'],
};
function icon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mc-icon');
  svg.dataset.icon = name;
  for (const shape of iconShapes[name]) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', shape);
    svg.append(path);
  }
  return svg;
}
// A button that shows an icon and gives its name to screen readers and on hover.
function iconAction(name, label, callback) {
  const button = action('', callback);
  button.classList.add('mc-icon-button');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}

// A repeated tick number after a recording was appended must retain its own position.
export function indexTicks(events) {
  const groups = [];
  const depths = new Uint32Array(events.length);
  for (const [i, event] of events.entries()) {
    const step = i + 1;
    let group = groups.at(-1);
    if (!group || group.tick !== event.tick) {
      group = { tick: event.tick, first: step, last: step };
      groups.push(group);
    }
    group.last = step;
    if (event.parent !== undefined && event.parent >= group.first - 1) depths[i] = depths[event.parent] + 1;
  }
  return { groups, depths };
}

function groupContaining(groups, step) {
  let low = 0, high = groups.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (step > groups[mid].last) low = mid + 1;
    else high = mid;
  }
  return low;
}

function worldPosition(scene, pos) {
  return pos.map((n, i) => n + scene.origin[i]).join(', ');
}

function lowerBound(values, target) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createTickAxis(groups, tickRange) {
  const origin = tickRange?.[0] ?? groups[0]?.tick ?? 0;
  const offsets = [];
  let previousTick = origin, offset = 0;
  for (const group of groups) {
    // Appended recordings can reset their game clock. Keep their recording order.
    offset += group.tick >= previousTick ? group.tick - previousTick : 1;
    offsets.push(offset);
    previousTick = group.tick;
  }
  const maxOffset = offset + Math.max(0, (tickRange?.[1] ?? previousTick) - previousTick);
  const end = groups.at(-1)?.last ?? 0;

  function at(value) {
    const offset = Math.max(0, Math.min(maxOffset, Math.floor(value)));
    const next = lowerBound(offsets, offset);
    if (offsets[next] === offset) {
      return { offset, tick: groups[next].tick, groupIndex: next, step: groups[next].last };
    }
    const before = groups[next - 1];
    const tick = before ? before.tick + offset - offsets[next - 1] : origin + offset;
    return { offset, tick, groupIndex: -1, step: before?.last ?? 0 };
  }

  function forStep(step, tickHint) {
    const group = step ? groupContaining(groups, step) : -1;
    const base = at(group < 0 ? 0 : offsets[group]);
    if (Number.isSafeInteger(tickHint) && tickHint >= base.tick) {
      const offset = base.offset + (tickHint - base.tick);
      if (offset <= maxOffset) {
        const candidate = at(offset);
        if (candidate.tick === tickHint && candidate.groupIndex < 0 && candidate.step === step) return candidate;
      }
    }
    return { ...base, step };
  }
  return { groups, offsets, origin, maxOffset, end, at, forStep };
}

export function phaseStops(events, groups) {
  const stops = [];
  for (const group of groups) {
    const length = stops.length;
    for (let step = group.first; step <= group.last; step++) {
      if (['phase', 'levelTick'].includes(events[step - 1].type)) stops.push(step);
    }
    if (stops.length === length) stops.push(group.last);
  }
  return stops;
}

export function adjacentCursor(axis, phases, cursor, mode, direction) {
  const { step, offset, groupIndex } = cursor;
  if (mode === 'tick') {
    if (direction < 0 && offset === 0) return axis.forStep(0);
    if (direction > 0 && groupIndex >= 0 && step < axis.groups[groupIndex].last) return axis.at(offset);
    return axis.at(offset + direction);
  }
  if (direction > 0 && step >= axis.end) return cursor;
  if (mode === 'phase') {
    const keepPrior = groupIndex < 0 && direction < 0;
    const i = lowerBound(phases, step + (direction > 0 || keepPrior ? 1 : 0));
    return axis.forStep(direction > 0 ? phases[i] ?? axis.end : phases[i - 1] ?? 0);
  }
  const delta = groupIndex < 0 && direction < 0 ? 0 : direction;
  return axis.forStep(Math.min(axis.end, Math.max(0, step + delta)));
}

// Sub-tick records have an order and no timestamps. Spread the visible stops
// evenly over their tick for presentation. A dropped UI frame simply seeks to
// the position now due; createReplay still applies all intervening mutations.
export function playbackCursor(axis, phases, time, mode, clock = 'tick') {
  const elapsed = Math.max(0, Math.floor(time));
  if (clock === 'event') return axis.forStep(Math.min(elapsed, axis.end));
  if (clock === 'phase') return axis.forStep(elapsed === 0 ? 0 : phases[elapsed - 1] ?? axis.end);
  const offset = Math.max(0, Math.min(axis.maxOffset, Math.floor(time)));
  const result = axis.at(offset);
  if (time >= axis.maxOffset + 1 || result.groupIndex < 0 || mode === 'tick') return result;
  const group = axis.groups[result.groupIndex];
  const fraction = Math.max(0, Math.min(1, time - offset));
  if (mode === 'phase') {
    const start = lowerBound(phases, group.first), count = lowerBound(phases, group.last + 1) - start;
    result.step = phases[start + Math.min(count - 1, Math.floor(fraction * count))];
  } else {
    result.step = Math.min(group.last, group.first + Math.floor(fraction * (group.last - group.first + 1)));
  }
  return result;
}

export function timeFor(cursor, axis, phases, mode, clock = 'tick') {
  if (clock === 'event') return cursor.step;
  if (clock === 'phase') return lowerBound(phases, cursor.step + 1);
  const { groupIndex, step, offset } = cursor;
  if (groupIndex < 0 || step === 0) return offset;
  const group = axis.groups[groupIndex];
  if (mode === 'tick') return offset;
  if (mode === 'phase') {
    const start = lowerBound(phases, group.first), stop = lowerBound(phases, group.last + 1);
    const index = Math.max(start, lowerBound(phases, step + 1) - 1);
    return offset + (index - start) / (stop - start);
  }
  return offset + (step - group.first) / (group.last - group.first + 1);
}

function createScale(axis) {
  const scale = element('div', '', 'mc-tick-scale');
  scale.setAttribute('aria-hidden', 'true');
  const intervals = Math.min(4, axis.maxOffset);
  for (let i = 0; i <= intervals; i++) {
    const offset = intervals ? Math.round(i * axis.maxOffset / intervals) : 0;
    const mark = element('span', String(axis.at(offset).tick));
    // Along the scale, across a wide figure's side or down a narrow one's.
    mark.style.setProperty('--at', (axis.maxOffset ? offset / axis.maxOffset * 100 : 0) + '%');
    scale.append(mark);
  }
  return scale;
}

function sameCursor(a, b) { return a.step === b.step && a.offset === b.offset; }

// A palette entry such as minecraft:redstone_wire[east=side,power=15] as its
// short name (the vanilla namespace dropped) and its properties.
export function parseBlockState(state) {
  const match = /^([^[]+)(?:\[(.*)\])?$/.exec(state ?? '');
  const id = (match?.[1] ?? '').replace(/^minecraft:/, '');
  const properties = new Map();
  for (const pair of match?.[2] ? match[2].split(',') : []) {
    const [key, value = ''] = pair.split('=');
    if (key) properties.set(key, value);
  }
  return { id, properties };
}

// The properties a block change touched, in the order the states list them.
export function changedProperties(before, after) {
  const keys = [...new Set([...before.properties.keys(), ...after.properties.keys()])];
  return keys.filter(key => before.properties.get(key) !== after.properties.get(key))
    .map(key => ({ key, from: before.properties.get(key) ?? '', to: after.properties.get(key) ?? '' }));
}

// The card's fields stand two to a row, which leaves each value about 16
// monospace characters. A longer value takes the whole row rather than
// running into its neighbour.
const halfRow = 16;

function field(name, code, value, wide = false) {
  const length = typeof value === 'string' ? value.length : value.textContent.length;
  const item = element('div', '', wide || length > halfRow ? 'mc-field mc-field-wide' : 'mc-field');
  const term = element('dt', name + ' ');
  const codeName = element('span', '/ ' + code);
  codeName.setAttribute('aria-hidden', 'true');
  term.append(codeName);
  const data = element('dd');
  data.append(value);
  item.append(term, data);
  return item;
}

// A block or entity id may break after its underscores and its namespace's
// colon, never inside a word.
function idText(id) {
  const text = document.createDocumentFragment();
  for (const part of id.split(/(?<=[_:])/)) {
    if (text.childNodes.length) text.append(document.createElement('wbr'));
    text.append(part);
  }
  return text;
}

function properties(map) {
  const list = document.createDocumentFragment();
  for (const [key, value] of map) {
    const pair = element('span', '', 'mc-prop');
    pair.append(element('span', key, 'mc-prop-key'), ' ' + value);
    list.append(pair, ' ');
  }
  return list;
}

// The current event as named fields, in the article header's "中文 / CODE"
// style. A block change lists only what it changed, the new value in orange.
function eventFields(scene, replay, event) {
  const list = element('dl', '', 'mc-fields');
  if (event?.type.startsWith('entity')) {
    const { actorId } = eventTarget(replay, event);
    const player = replay.players.get(actorId) ?? event.player;
    const pose = player ?? replay.entities.get(actorId) ?? event.entity;
    const type = player ? 'minecraft:player' : pose?.type ?? (/^[\w.-]+:[\w./-]+$/.test(event.detail) ? event.detail : null);
    const pos = pose?.pos ?? event.pos;
    if (pos) {
      const world = pos.map((n, axis) => Number((n + scene.origin[axis]).toFixed(3)));
      list.append(field('坐标', 'POS', world.join(', ')));
    }
    if (type) list.append(field('实体', 'ENTITY', idText(type)));
    if (pose?.pos) list.append(field('朝向 / 俯仰', 'YAW / PITCH', `${pose.yaw.toFixed(1)}° / ${pose.pitch.toFixed(1)}°`));
    return list;
  }
  if (!event?.pos) {
    if (event?.piston) list.append(field('进度', 'PROGRESS', `${Math.round(event.piston.progress * 100)}%`));
    return list;
  }
  list.append(field('坐标', 'POS', worldPosition(scene, event.pos)));
  if (event.after !== undefined) {
    const after = parseBlockState(scene.palette[event.after]);
    const before = event.before !== undefined ? parseBlockState(scene.palette[event.before]) : null;
    if (!before || before.id !== after.id) {
      const swap = document.createDocumentFragment();
      if (before) swap.append(idText(before.id), ' → ');
      const to = element('b', '', 'mc-change-to');
      to.append(idText(after.id));
      swap.append(to);
      list.append(field('方块', 'BLOCK', swap));
      if (after.properties.size) list.append(field('状态', 'STATE', properties(after.properties), true));
    } else {
      list.append(field('方块', 'BLOCK', idText(after.id)));
      const changes = document.createDocumentFragment();
      for (const { key, from, to } of changedProperties(before, after)) {
        const change = element('span', '', 'mc-change');
        change.append(element('span', key, 'mc-prop-key'), ` ${from} → `, element('b', to, 'mc-change-to'));
        changes.append(change, ' ');
      }
      list.append(field('变化', 'CHANGE', changes.childNodes.length ? changes : '状态没有变化'));
    }
  } else {
    const index = replay.blocks.get(event.pos.join(','));
    const state = parseBlockState(index === undefined ? 'minecraft:air' : scene.palette[index]);
    list.append(field('方块', 'BLOCK', idText(state.id)));
    if (state.properties.size) list.append(field('状态', 'STATE', properties(state.properties), true));
  }
  if (event.piston) list.append(field('进度', 'PROGRESS', `${Math.round(event.piston.progress * 100)}%`));
  // A moving piston's cell whose block entity the recording has not caught
  // at this step: the view outlines the empty cell (js/mc-markers.mjs).
  const key = event.pos.join(','), here = replay.blocks.get(key);
  if (here !== undefined && scene.palette[here]?.startsWith('minecraft:moving_piston') && !replay.pistons?.has(key)) {
    list.append(field('活塞', 'PISTON', '这一步没有活塞数据', true));
  }
  return list;
}

export function mountTimeline(container, figure, scene, replay, bookmark, onStep, getCamera, options = {}) {
  const { groups, depths } = indexTicks(scene.events);
  const axis = createTickAxis(groups, scene.tickRange);
  const phases = phaseStops(scene.events, groups);
  // Apply the final phase's trailing mutations as its own stop when needed.
  const phaseDuration = phases.length + (axis.end > (phases.at(-1) ?? 0) ? 1 : 0);
  function duration() {
    const clock = speedClock(speedUnit);
    if (clock === 'event') return axis.end;
    if (clock === 'phase') return phaseDuration;
    return groups.length || scene.tickRange ? axis.maxOffset + 1 : 0;
  }
  const panel = element('aside', '', 'mc-timeline');
  panel.setAttribute('aria-label', '回放时间轴');
  // The clock reads like an instrument: the game tick large, any note (start
  // of the recording, a tick without events) small beside the number, in the
  // room under its label. The note stands out of the flow, so the clock keeps
  // its width as the note comes and goes and the buttons beside it stay put.
  // The step count is left to the scrubber's spoken value.
  const clock = element('output', '', 'mc-clock');
  const clockTick = element('b', '', 'mc-clock-tick');
  const clockNote = element('span', '', 'mc-clock-note');
  const tickLabel = element('span', '游戏刻 ', 'mc-clock-label');
  const tickCode = element('span', '/ GAME TICK');
  tickCode.setAttribute('aria-hidden', 'true');
  tickLabel.append(tickCode);
  const tickValue = element('span', '', 'mc-clock-value');
  tickValue.append(clockTick, clockNote);
  const tickField = element('span', '', 'mc-clock-field');
  tickField.append(tickLabel, tickValue);
  clock.append(tickField);
  const slider = element('input', '', 'mc-slider');
  slider.type = 'range';
  slider.min = String(axis.origin);
  slider.max = String(axis.origin + axis.maxOffset);
  slider.step = '1';
  slider.disabled = !axis.maxOffset;
  slider.setAttribute('aria-label', '游戏刻');
  const scrubber = element('div', '', 'mc-scrubber');
  scrubber.append(slider, createScale(axis));
  const actions = element('div', '', 'mc-actions');
  // Playback settings fold behind a one-line summary of speed and level, so
  // the event list keeps the column's height.
  const settingsPanel = element('details', '', 'mc-settings');
  const settingsSummary = element('summary', '', 'mc-settings-summary');
  const summarySpeed = element('span', '', 'mc-settings-value');
  const summaryMode = element('span', '', 'mc-settings-value');
  const settings = element('div', '', 'mc-play-settings');
  const secondary = element('div', '', 'mc-secondary-actions');
  const inspect = element('section', '', 'mc-inspect');
  inspect.setAttribute('aria-label', '当前事件详情');
  const eventText = element('div', '', 'mc-event');
  const details = element('div', '', 'mc-state');
  const shareStatus = element('span', '', 'mc-share-status');
  shareStatus.setAttribute('role', 'status');
  let playing = false, ready = false, frame = 0, tallest = 0;
  let { rate: speed, unit: speedUnit } = getDefaultPlayback(options.authorSpeed, options.speedUnit);
  let mode = normalizeGranularity(figure.dataset.granularity) ?? 'phase', cursor = axis.forStep(0);
  let time = 0, baseTime = 0, baseStamp = 0;

  // The settings open as a card over the list, styled like the event card,
  // its controls under "中文 / CODE" field names.
  const fieldName = (name, code) => {
    const label = element('span', name + ' ', 'mc-field-name');
    const codeName = element('span', '/ ' + code);
    codeName.setAttribute('aria-hidden', 'true');
    label.append(codeName);
    return label;
  };
  const rateLabel = element('label', '', 'mc-rate');
  const rateInput = element('input', '', 'mc-speed-input');
  rateInput.type = 'number';
  rateInput.step = 'any';
  rateInput.min = '0';
  rateLabel.append(fieldName('速度', 'SPEED'), rateInput);
  const unitLabel = element('label', '', 'mc-unit-label');
  const unitSelect = element('select', '', 'mc-speed-unit');
  for (const [unit, text] of Object.entries(SPEED_UNITS)) {
    const option = element('option', text);
    option.value = unit;
    unitSelect.append(option);
  }
  unitLabel.append(fieldName('单位', 'UNIT'), unitSelect);

  function syncRateControls() {
    unitSelect.value = speedUnit;
    rateInput.value = String(fromClockRate(speed, speedUnit));
  }
  function setSpeed(rate, unit = speedUnit) {
    if (!validSpeed(fromClockRate(rate, unit))) return false;
    const changedClock = speedClock(unit) !== speedClock(speedUnit);
    if (playing && !changedClock && rate !== speed) {
      const now = performance.now();
      baseTime = timeAt(now);
      baseStamp = now;
    }
    speed = rate;
    speedUnit = unit;
    if (changedClock) rebasePlayback();
    summarize();
    return true;
  }
  function summarize() {
    const value = fromClockRate(speed, speedUnit);
    const rounded = Number(value.toPrecision(10));
    const display = Number.isFinite(rounded) ? rounded : value;
    summarySpeed.textContent = speedUnit === 'x' ? `${display}×` : `${display} ${SPEED_UNITS[speedUnit]}`;
    summaryMode.textContent = selectMode.selectedOptions[0]?.textContent ?? '';
    settingsSummary.setAttribute('aria-label', `播放设置：速度 ${summarySpeed.textContent}，粒度 ${summaryMode.textContent}`);
  }
  syncRateControls();
  rateInput.addEventListener('input', () => setSpeed(toClockRate(rateInput.valueAsNumber, speedUnit)));
  rateInput.addEventListener('change', () => {
    if (!setSpeed(toClockRate(rateInput.valueAsNumber, speedUnit))) syncRateControls();
  });
  unitSelect.addEventListener('change', () => {
    let unit = unitSelect.value;
    let rate = speed;
    if (speedClock(unit) !== speedClock(speedUnit)) {
      rate = toClockRate(fromClockRate(speed, speedUnit), unit);
    } else if (!validSpeed(fromClockRate(rate, unit))) {
      unit = 'gt/s';
    }
    setSpeed(rate, unit);
    syncRateControls();
  });
  const saveSpeed = action('设为默认', () => {
    shareStatus.textContent = saveDefaultPlayback(speed, speedUnit) ? `默认播放速度已设为 ${summarySpeed.textContent}。` : '浏览器无法保存默认速度。';
  });
  saveSpeed.className = 'mc-speed-default';
  const resetSpeed = action('恢复默认', () => {
    const cleared = saveDefaultPlayback(null);
    const defaults = getDefaultPlayback(options.authorSpeed, options.speedUnit);
    setSpeed(defaults.rate, defaults.unit);
    syncRateControls();
    shareStatus.textContent = cleared ? `已恢复默认速度 ${summarySpeed.textContent}。` : '浏览器无法清除默认速度。';
  });
  resetSpeed.className = 'mc-speed-reset';
  const modeLabel = element('label', '', 'mc-mode');
  modeLabel.append(fieldName('粒度', 'LEVEL'));
  const selectMode = element('select', '', 'mc-granularity');
  for (const [value, name] of Object.entries(GRANULARITY_LABELS)) {
    const option = element('option', name);
    option.value = value;
    selectMode.append(option);
  }
  selectMode.value = mode;
  modeLabel.append(selectMode);
  // The card also explains the list's marks and the keyboard.
  const legend = element('div', '', 'mc-legend');
  legend.append(fieldName('记号', 'MARKS'));
  for (const [kind, name] of [['set', '方块变化'], ['neighbour', '邻居更新'], ['shape', '形状更新'],
    ['tick', '计划刻'], ['event', '方块事件'], ['piston', '活塞'], ['game', '游戏事件'], ['entity', '实体']]) {
    const item = element('span', '', 'mc-legend-item');
    const glyph = element('i', '', 'mc-glyph');
    glyph.dataset.kind = kind;
    glyph.setAttribute('aria-hidden', 'true');
    item.append(glyph, name);
    legend.append(item);
  }
  const keys = element('div', '', 'mc-legend');
  keys.append(fieldName('快捷键', 'KEYS'), element('span', '空格 播放 / 暂停', 'mc-legend-item'),
    element('span', '← → 上一步 / 下一步', 'mc-legend-item'),
    element('span', '双击 / 回车 展开或收起下一级', 'mc-legend-item'));
  settings.append(rateLabel, unitLabel, modeLabel, saveSpeed, resetSpeed, legend, keys);
  // The summary reads "20 gt/s · 阶段" beside the settings icon.
  settingsSummary.title = '播放设置';
  settingsSummary.append(summarySpeed, element('span', '·', 'mc-settings-dot'), summaryMode, icon('tune'));
  settingsPanel.append(settingsSummary, settings);
  // The card closes on a press outside it or on Escape, which returns focus
  // to its summary.
  const settingsWatch = new AbortController();
  document.addEventListener('pointerdown', event => {
    if (settingsPanel.open && !settingsPanel.contains(event.target)) settingsPanel.open = false;
  }, { signal: settingsWatch.signal });
  settingsPanel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !settingsPanel.open) return;
    event.preventDefault();
    settingsPanel.open = false;
    settingsSummary.focus();
  });
  summarize();

  const prev = iconAction('prev', '上一步（←）', () => manual(adjacentCursor(axis, phases, cursor, mode, -1)));
  const next = iconAction('next', '下一步（→）', () => manual(adjacentCursor(axis, phases, cursor, mode, 1)));
  const play = iconAction('play', '播放（空格）', () => {
    if (playing) { stop(); return; }
    const done = cursor.step === axis.end && (speedClock(speedUnit) !== 'tick' || cursor.offset === axis.maxOffset);
    if (time >= duration() || (done && (cursor.step > 0 || axis.maxOffset > 0))) {
      manual(axis.forStep(0));
    }
    baseTime = time;
    baseStamp = performance.now();
    playing = true;
    showPlaying(true);
    options.onPlaying?.(true);
    frame = requestAnimationFrame(animate);
  });
  // The play button turns into pause while the replay runs.
  function showPlaying(value) {
    const label = value ? '暂停（空格）' : '播放（空格）';
    play.replaceChildren(icon(value ? 'pause' : 'play'));
    play.setAttribute('aria-label', label);
    play.title = label;
  }
  play.disabled = true;
  actions.append(prev, play, next);
  // Keyboard: with focus anywhere in the replay, Space plays or pauses and
  // the left and right arrows step. Fields, menus and the slider keep their
  // own keys, and a focused button keeps Space for itself.
  for (const [button, key] of [[prev, 'ArrowLeft'], [play, 'Space'], [next, 'ArrowRight']]) {
    button.setAttribute('aria-keyshortcuts', key);
  }
  figure.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('input, select, textarea, [contenteditable="true"], details[open] .mc-play-settings')) return;
    const press = button => {
      event.preventDefault();
      if (!button.disabled) button.click();
    };
    if (event.key === ' ' && !target.closest('button, summary, a')) press(play);
    else if (event.key === 'ArrowLeft') press(prev);
    else if (event.key === 'ArrowRight') press(next);
  }, { signal: settingsWatch.signal });

  const list = mountEventList(scene, step => manual(axis.forStep(step)), {
    label: eventLabel, position: pos => worldPosition(scene, pos), groups, depths,
    offsets: axis.offsets, maxOffset: axis.maxOffset, origin: axis.origin,
    phaseSteps: phases, selectTick: offset => manual(axis.at(offset)),
  });
  const parent = action('', () => {
    if (replay.event?.parent !== undefined) manual(axis.forStep(replay.event.parent + 1));
  });
  parent.className = 'mc-parent';
  inspect.append(eventText, details, parent);
  const share = iconAction('link', '复制此刻的链接', async () => {
    const url = new URL(location.href);
    url.hash = figure.id;
    url.searchParams.set('mcstep', String(cursor.step));
    if (cursor.groupIndex < 0) url.searchParams.set('mctick', String(cursor.tick));
    else url.searchParams.delete('mctick');
    try {
      await navigator.clipboard.writeText(url.href);
      shareStatus.textContent = '已复制此刻的链接。';
    } catch {
      const link = element('a', '此刻的链接');
      link.href = url.href;
      shareStatus.replaceChildren(link);
    }
  });
  const articleView = iconAction('bookmark', '回到文章书签', () => seek(bookmark.step ?? 0, true, bookmark.tick));
  secondary.append(articleView, share);
  if (figure.closest('[data-mc-author]')) {
    secondary.append(action('复制书签配置', async () => {
      const focused = cursor.groupIndex < 0 ? undefined : eventTarget(replay, replay.event).block;
      const isBookmark = cursor.step === bookmark.step && (bookmark.tick === undefined || cursor.tick === bookmark.tick);
      const config = JSON.stringify({
        step: cursor.step, tick: cursor.groupIndex < 0 ? cursor.tick : undefined,
        focus: isBookmark ? bookmark.focus ?? focused : focused, camera: getCamera(),
      });
      try {
        await navigator.clipboard.writeText(config);
        shareStatus.textContent = '已复制书签配置。';
      } catch {
        shareStatus.replaceChildren(element('code', config));
      }
    }));
  }
  slider.addEventListener('input', () => manual(axis.at(Number(slider.value) - axis.origin)));
  selectMode.addEventListener('change', () => {
    mode = selectMode.value;
    summarize();
    manual(cursor);
  });
  // The controls (clock, transport, settings, links) and the event tree with
  // its scrubber are two blocks: on a wide figure js/mc-article.mjs floats the
  // controls in the 3D view's lower left, and the panel holds only the tree,
  // the scrubber standing up along its edge.
  const controls = element('div', '', 'mc-controls');
  controls.append(clock, actions, settingsPanel, secondary, shareStatus);
  const tree = element('div', '', 'mc-tree');
  tree.append(scrubber, list.element);
  panel.append(controls, tree, inspect);
  container.append(panel);

  function timeAt(stamp) {
    return Math.min(duration(), baseTime + (Math.max(0, stamp - baseStamp) / 1000) * speed);
  }

  function rebasePlayback() {
    time = baseTime = timeFor(cursor, axis, phases, mode, speedClock(speedUnit));
    baseStamp = performance.now();
    if (!duration() && playing) stop();
    setReady(ready);
  }

  function animate(stamp) {
    if (!playing) return;
    time = timeAt(stamp);
    const clock = speedClock(speedUnit);
    const due = playbackCursor(axis, phases, time, mode, clock);
    // Starting mid-phase at a bookmark must never rewind to the phase entry.
    if (due.step > cursor.step || (clock === 'tick' && due.step === cursor.step && !sameCursor(cursor, due))) present(due);
    if (time >= duration()) stop();
    else if (playing) frame = requestAnimationFrame(animate);
  }

  function stop() {
    const was = playing;
    playing = false;
    if (was) showPlaying(false);
    play.disabled = !duration() || !ready;
    cancelAnimationFrame(frame);
    tallest = 0;
    inspect.style.minHeight = '';
    if (was) options.onPlaying?.(false);
  }

  function present(nextCursor, resetCamera = false) {
    cursor = nextCursor;
    const { step, tick, offset, groupIndex } = cursor;
    replay.seek(step);
    const group = groups[groupIndex];
    const event = group && step >= group.first ? replay.event : null;
    const gap = groupIndex < 0;
    slider.value = String(axis.origin + offset);
    const note = !step && offset === 0 ? '录制起点' : gap ? '无事件' : '';
    clockTick.textContent = String(tick).padStart(3, '0');
    clockNote.textContent = note;
    slider.setAttribute('aria-valuetext', `游戏刻 ${tick}${note ? ' · ' + note : ''} · 第 ${step} / ${axis.end} 步`);
    prev.disabled = sameCursor(cursor, adjacentCursor(axis, phases, cursor, mode, -1));
    next.disabled = sameCursor(cursor, adjacentCursor(axis, phases, cursor, mode, 1));
    list.sync(step, { ...cursor, mode });
    const label = event ? eventLabel(event) : step === 0 && offset === 0 ? '初始结构' : '本刻没有记录事件';
    const detail = event?.detail;
    const title = detail && !Object.hasOwn(subtypes, detail) && detail !== label ? `${label} · ${detail}` : label;
    // The kind's mark, in its colour, ties the card to the event's mark on the model.
    const kind = event && eventKind(event);
    if (kind && kind !== 'phase') {
      const mark = element('i', '', 'mc-glyph');
      mark.dataset.kind = kind;
      mark.setAttribute('aria-hidden', 'true');
      eventText.replaceChildren(mark, title);
    } else eventText.textContent = title;
    const fields = eventFields(scene, replay, event);
    parent.hidden = event?.parent === undefined;
    if (!parent.hidden) {
      // The parent link is one more field, so it costs the list no row.
      parent.textContent = `#${event.parent + 1}`;
      parent.setAttribute('aria-label', `跳到上级事件 #${event.parent + 1}`);
      fields.append(field('上级', 'PARENT', parent));
    }
    details.replaceChildren(fields);
    // While the replay plays, the details keep the height of the tallest event
    // shown so far, so the card (or, on a narrow page, everything below the
    // list) does not jump with every event; stopping lets them fit again.
    if (playing) {
      const height = inspect.offsetHeight;
      if (height > tallest) {
        tallest = height;
        inspect.style.minHeight = height + 'px';
      }
    }
    shareStatus.replaceChildren();
    onStep(step, resetCamera, { tick, gap, playing });
  }

  function manual(target, resetCamera = false) {
    stop();
    time = timeFor(target, axis, phases, mode, speedClock(speedUnit));
    present(target, resetCamera);
  }
  function seek(step, resetCamera = false, tickHint) {
    manual(axis.forStep(Math.min(axis.end, Math.max(0, step)), tickHint), resetCamera);
  }
  function setReady(value) {
    ready = value;
    play.disabled = !duration() || (!ready && !playing);
  }
  return {
    seek, stop, setReady, getTick: () => cursor.tick,
    // The current event's details, for js/mc-callout.mjs to set beside its block.
    details: inspect,
    // The clock, transport, settings and links, which a wide figure floats in its 3D view.
    controls,
    // A switch in the settings card for something the 3D view offers, such as
    // its entity hitboxes; the returned setter follows changes made elsewhere.
    addSwitch(name, code, { checked, keys, onChange }) {
      const row = element('label', '', 'mc-switch');
      const input = element('input', '', 'mc-switch-input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      row.append(fieldName(name, code));
      if (keys) row.append(element('span', keys, 'mc-switch-keys'));
      row.append(input);
      settings.insertBefore(row, legend);
      return value => { input.checked = value; };
    },
    destroy() { stop(); list.destroy(); settingsWatch.abort(); },
  };
}
