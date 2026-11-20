export const DEFAULT_SPEED = 20;
export const GRANULARITY_LABELS = Object.freeze({ tick: '游戏刻', phase: '阶段', event: '事件' });
export const SPEED_UNITS = Object.freeze({
  'gt/s': 'gt/s', 's/gt': 's/gt', x: '×', 'event/s': '事件/秒', 'phase/s': '阶段/秒',
});

export function normalizeGranularity(value) {
  for (const [key, label] of Object.entries(GRANULARITY_LABELS)) {
    if (value === key || value === label) return key;
  }
  return undefined;
}

export function normalizeSpeedUnit(value) {
  if (typeof value !== 'string') return undefined;
  const unit = value.trim().toLowerCase();
  for (const [key, label] of Object.entries(SPEED_UNITS)) {
    if (unit === key || unit === label) return key;
  }
  return undefined;
}

export function validSpeed(value) {
  return Number.isFinite(value) && value > 0;
}

export function speedClock(unit) {
  if (unit === 'event/s') return 'event';
  if (unit === 'phase/s') return 'phase';
  return 'tick';
}

export function toClockRate(value, unit = 'gt/s') {
  if (!validSpeed(value) || !Object.hasOwn(SPEED_UNITS, unit)) return undefined;
  if (unit === 's/gt') {
    value = 1 / value;
    if (!validSpeed(1 / value)) return undefined;
  }
  else if (unit === 'x') value *= DEFAULT_SPEED;
  return validSpeed(value) ? value : undefined;
}

export function fromClockRate(rate, unit = 'gt/s') {
  if (!validSpeed(rate)) return undefined;
  if (unit === 'x') {
    const multiple = rate / DEFAULT_SPEED;
    return validSpeed(multiple) ? multiple : undefined;
  }
  return toClockRate(rate, unit);
}

export function validPlaybackRate(value, unit) {
  return toClockRate(value, unit) !== undefined;
}

// Existing preferences are plain GT/s numbers. Count-based clocks carry their unit.
const storageKey = 'mc-replay.speed-gt-per-second';

export function getDefaultPlayback(authorValue, authorUnit = 'gt/s') {
  const unit = normalizeSpeedUnit(authorUnit) ?? 'gt/s';
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey));
    if (validSpeed(saved)) {
      const displayUnit = speedClock(unit) === 'tick' && fromClockRate(saved, unit) !== undefined ? unit : 'gt/s';
      return { rate: saved, unit: displayUnit };
    }
    if (saved && Object.hasOwn(SPEED_UNITS, saved.unit) && fromClockRate(saved.rate, saved.unit) !== undefined) {
      return { rate: saved.rate, unit: saved.unit };
    }
  } catch { /* Private browsing may disable local storage. */ }
  const rate = toClockRate(authorValue, unit) ?? (speedClock(unit) === 'tick' ? DEFAULT_SPEED : 1);
  return { rate, unit };
}

export function saveDefaultPlayback(rate, unit = 'gt/s') {
  if (rate !== null && fromClockRate(rate, unit) === undefined) return false;
  try {
    if (rate === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, unit === 'gt/s' ? String(rate) : JSON.stringify({ rate, unit }));
    return true;
  } catch {
    return false;
  }
}
