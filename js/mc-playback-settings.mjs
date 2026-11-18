export const DEFAULT_SPEED = 20;
const storageKey = 'mc-replay.speed-gt-per-second';

export function validSpeed(value) {
  return Number.isFinite(value) && value > 0;
}

export function getDefaultSpeed(authorSpeed) {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (validSpeed(saved)) return saved;
  } catch { /* Private browsing may disable local storage. */ }
  return validSpeed(authorSpeed) ? authorSpeed : DEFAULT_SPEED;
}

export function saveDefaultSpeed(value) {
  if (value !== null && !validSpeed(value)) return false;
  try {
    if (value === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(value));
    return true;
  } catch {
    return false;
  }
}
