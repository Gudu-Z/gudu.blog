import { mountEventList } from './mc-event-list.mjs';
import { validSpeed, getDefaultSpeed, saveDefaultSpeed } from './mc-playback-settings.mjs';

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
export function playbackCursor(axis, phases, time, mode) {
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

function timeFor(cursor, axis, phases, mode) {
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
    mark.style.left = (axis.maxOffset ? offset / axis.maxOffset * 100 : 0) + '%';
    scale.append(mark);
  }
  return scale;
}

function sameCursor(a, b) { return a.step === b.step && a.offset === b.offset; }

export function mountTimeline(container, figure, scene, replay, bookmark, onStep, getCamera, options = {}) {
  const { groups, depths } = indexTicks(scene.events);
  const axis = createTickAxis(groups, scene.tickRange);
  const phases = phaseStops(scene.events, groups);
  const hasTime = groups.length > 0 || Boolean(scene.tickRange);
  const panel = element('aside', '', 'mc-timeline');
  panel.setAttribute('aria-label', '回放时间轴');
  const clock = element('output', '', 'mc-clock');
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
  const settings = element('div', '', 'mc-play-settings');
  const secondary = element('div', '', 'mc-secondary-actions');
  const inspect = element('section', '', 'mc-inspect');
  inspect.setAttribute('aria-label', '当前事件详情');
  const eventText = element('div', '', 'mc-event');
  const details = element('div', '', 'mc-state');
  const shareStatus = element('span', '', 'mc-share-status');
  shareStatus.setAttribute('role', 'status');
  let playing = false, ready = false, frame = 0;
  let speed = getDefaultSpeed(options.ticksPerSecond);
  let mode = 'event', cursor = axis.forStep(0);
  let time = 0, baseTime = 0, baseStamp = 0;

  const rateLabel = element('label', '播放速度 (gt/s)', 'mc-rate');
  const rateInput = element('input', '', 'mc-speed-input');
  rateInput.type = 'number';
  rateInput.step = 'any';
  rateInput.min = '0';
  rateInput.value = String(speed);
  rateLabel.append(rateInput);
  function setSpeed(value) {
    if (!validSpeed(value)) return false;
    if (playing) {
      const now = performance.now();
      baseTime = timeAt(now);
      baseStamp = now;
    }
    speed = value;
    return true;
  }
  rateInput.addEventListener('input', () => setSpeed(rateInput.valueAsNumber));
  rateInput.addEventListener('change', () => {
    if (!setSpeed(rateInput.valueAsNumber)) rateInput.value = String(speed);
  });
  const saveSpeed = action('设为默认', () => {
    shareStatus.textContent = saveDefaultSpeed(speed) ? `默认播放速度已设为 ${speed} gt/s。` : '浏览器无法保存默认速度。';
  });
  saveSpeed.className = 'mc-speed-default';
  const resetSpeed = action('恢复默认', () => {
    const cleared = saveDefaultSpeed(null);
    setSpeed(getDefaultSpeed(options.ticksPerSecond));
    rateInput.value = String(speed);
    shareStatus.textContent = cleared ? `已恢复默认速度 ${speed} gt/s。` : '浏览器无法清除默认速度。';
  });
  resetSpeed.className = 'mc-speed-reset';
  const modeLabel = element('label', '显示粒度', 'mc-mode');
  const selectMode = element('select', '', 'mc-granularity');
  for (const [value, name] of [['tick', '游戏刻'], ['phase', '阶段'], ['event', '事件']]) {
    const option = element('option', name);
    option.value = value;
    selectMode.append(option);
  }
  selectMode.value = mode;
  modeLabel.append(selectMode);
  settings.append(rateLabel, saveSpeed, resetSpeed, modeLabel);

  const prev = action('上一步', () => manual(adjacentCursor(axis, phases, cursor, mode, -1)));
  const next = action('下一步', () => manual(adjacentCursor(axis, phases, cursor, mode, 1)));
  const play = action('播放', () => {
    if (playing) { stop(); return; }
    if (time >= axis.maxOffset + 1 || (cursor.offset === axis.maxOffset && cursor.step === axis.end && (cursor.step > 0 || axis.maxOffset > 0))) {
      manual(axis.forStep(0));
    }
    baseTime = time;
    baseStamp = performance.now();
    playing = true;
    play.textContent = '暂停';
    frame = requestAnimationFrame(animate);
  });
  play.disabled = true;
  actions.append(prev, play, next);

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
  const share = action('复制此刻', async () => {
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
  const articleView = action('回到文章书签', () => seek(bookmark.step ?? 0, true, bookmark.tick));
  secondary.append(articleView, share);
  if (figure.closest('[data-mc-author]')) {
    secondary.append(action('复制书签配置', async () => {
      const focused = cursor.groupIndex < 0 ? undefined : replay.event?.pos;
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
    manual(cursor);
  });
  panel.append(clock, scrubber, actions, settings, list.element, inspect, secondary, shareStatus);
  container.append(panel);

  function timeAt(stamp) {
    return Math.min(axis.maxOffset + 1, baseTime + Math.max(0, stamp - baseStamp) * speed / 1000);
  }

  function animate(stamp) {
    if (!playing) return;
    time = timeAt(stamp);
    const due = playbackCursor(axis, phases, time, mode);
    // Starting mid-phase at a bookmark must never rewind to the phase entry.
    if (due.step >= cursor.step && !sameCursor(cursor, due)) present(due);
    if (time >= axis.maxOffset + 1) stop();
    else if (playing) frame = requestAnimationFrame(animate);
  }

  function stop() {
    playing = false;
    play.textContent = '播放';
    play.disabled = !hasTime || !ready;
    cancelAnimationFrame(frame);
  }

  function present(nextCursor, resetCamera = false) {
    cursor = nextCursor;
    const { step, tick, offset, groupIndex } = cursor;
    replay.seek(step);
    const group = groups[groupIndex];
    const event = group && step >= group.first ? replay.event : null;
    const gap = groupIndex < 0;
    slider.value = String(axis.origin + offset);
    const note = !step && offset === 0 ? ' · 录制起点' : gap ? ' · 无事件' : '';
    clock.textContent = `游戏刻 ${tick}${note} · 第 ${step} / ${axis.end} 步`;
    slider.setAttribute('aria-valuetext', clock.textContent);
    prev.disabled = sameCursor(cursor, adjacentCursor(axis, phases, cursor, mode, -1));
    next.disabled = sameCursor(cursor, adjacentCursor(axis, phases, cursor, mode, 1));
    list.sync(step, { ...cursor, mode });
    const label = event ? eventLabel(event) : step === 0 && offset === 0 ? '初始结构' : '本刻没有记录事件';
    const detail = event?.detail;
    eventText.textContent = detail && !Object.hasOwn(subtypes, detail) && detail !== label ? `${label} · ${detail}` : label;
    const notes = [];
    if (event?.pos) {
      notes.push(`坐标 (${worldPosition(scene, event.pos)})`);
      if (event.after !== undefined) {
        const before = event.before !== undefined ? `${scene.palette[event.before]} → ` : '';
        notes.push(before + scene.palette[event.after]);
      } else {
        const index = replay.blocks.get(event.pos.join(','));
        notes.push(index === undefined ? 'minecraft:air' : scene.palette[index]);
      }
    }
    if (event?.piston) notes.push(`移动进度 ${Math.round(event.piston.progress * 100)}%`);
    details.textContent = notes.join(' · ');
    parent.hidden = event?.parent === undefined;
    if (!parent.hidden) parent.textContent = `上级事件 #${event.parent + 1}`;
    shareStatus.replaceChildren();
    onStep(step, resetCamera, { tick, gap, playing });
  }

  function manual(target, resetCamera = false) {
    stop();
    time = timeFor(target, axis, phases, mode);
    present(target, resetCamera);
  }
  function seek(step, resetCamera = false, tickHint) {
    manual(axis.forStep(Math.min(axis.end, Math.max(0, step)), tickHint), resetCamera);
  }
  function setReady(value) {
    ready = value;
    play.disabled = !hasTime || (!ready && !playing);
  }
  return {
    seek, stop, setReady, getTick: () => cursor.tick,
    destroy() { stop(); list.destroy(); },
  };
}
