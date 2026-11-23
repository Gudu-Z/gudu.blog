// Track only the translation contributed by following. The reader can orbit,
// pan or zoom freely between frames without any of that input being overwritten.
export function createCameraFollow(translate, clock = globalThis) {
  let shown = [0, 0, 0], target = shown, start = shown;
  let frame = null, started = 0, duration = 0;

  function cancel() {
    if (frame !== null) clock.cancelAnimationFrame(frame);
    frame = null;
  }

  function apply(next) {
    const [x, y, z] = shown;
    shown = next;
    if (next[0] !== x || next[1] !== y || next[2] !== z) translate(next[0] - x, next[1] - y, next[2] - z);
  }

  function advance(stamp) {
    const t = Math.max(0, (stamp - started) / duration);
    if (t >= 1) {
      frame = null;
      apply(target);
      return;
    }
    const share = t * t * (3 - 2 * t);
    frame = clock.requestAnimationFrame(advance);
    apply(start.map((n, axis) => n + (target[axis] - n) * share));
  }

  return {
    get offset() { return [...shown]; },
    to(offset, durationMs = 0) {
      if (offset == null) return;
      const smooth = Number.isFinite(durationMs) && durationMs > 0;
      const sameTarget = offset.every((n, axis) => n === target[axis]);
      if (sameTarget && (frame === null || smooth)) return;
      cancel();
      target = [...offset];
      if (!smooth || target.every((n, axis) => n === shown[axis])) {
        apply(target);
        return;
      }
      start = shown;
      duration = durationMs;
      started = clock.performance.now();
      frame = clock.requestAnimationFrame(advance);
    },
    finish() {
      cancel();
      apply(target);
    },
    hold() {
      cancel();
      target = shown;
      return [...shown];
    },
    reset(offset = [0, 0, 0]) {
      cancel();
      shown = target = [...offset];
    },
  };
}
