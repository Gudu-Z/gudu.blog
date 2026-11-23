/* The home page's ruler as an instrument, shared by the desktop ruler
 * (js/chapters.js) and the phone tape (js/chapters-vertical.js).
 *
 * Each station cell carries its ticks as marks, so each can swell. Near the
 * pointer the ticks lengthen and brighten and finer graduations show between
 * them, as under a magnifier; a smaller lens always rides on the cursor, a
 * little stronger while the cursor travels. Pointing at a station runs a wave
 * through its cell's ticks. The marks fold, bend and slide with their cells,
 * so the lens works in the ruler's flat coordinates, along its axis.
 */
(() => {
  'use strict';

  // How far a lens reaches along the ruler, in CSS pixels, and how strongly
  // the cursor's own lens swells the ticks at rest and while it travels.
  const POINTER_REACH = 38;
  const CURSOR_REACH = 24;
  const CURSOR_REST = 0.6;
  const CURSOR_TRAVEL = 0.85;
  // Finer graduations between two ticks under the lens.
  const MICRO = 3;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');

  // `cells`: one element per station, laid along the axis. `axis`: 'x' for a
  // horizontal ruler, 'y' for the phone tape. `kind(j, perCell)`: the class of
  // the j-th tick of a cell ('major', 'mid' or '').
  function create(cells, { axis = 'x', kind = () => '' } = {}) {
    let perCell = 0;
    let rows = [];
    let cell = 1;
    let lastHover = null;
    let lastCursor = null;
    let lastStrength = 0;

    function build(count) {
      if (count === perCell && rows.length) return;
      perCell = count;
      rows = cells.map(element => {
        element.querySelector(':scope > .ruler-marks')?.remove();
        const box = document.createElement('b');
        box.className = 'ruler-marks';
        box.setAttribute('aria-hidden', 'true');
        const marks = [];
        for (let j = 0; j < count; j++) {
          for (let q = 0; q <= MICRO; q++) {
            const mark = document.createElement('i');
            const at = j + q / (MICRO + 1);
            mark.style[axis === 'x' ? 'left' : 'top'] = `${(at / count) * 100}%`;
            mark.style.setProperty('--j', String(j));
            const type = q ? 'micro' : kind(j, count);
            if (type) mark.className = type;
            box.append(mark);
            marks.push({ mark, at, z: '' });
          }
        }
        element.append(box);
        return marks;
      });
      lastHover = lastCursor = null;
    }

    // `hover` and `cursor` are places along the ruler in pixels from its
    // start (null when absent); `travelling` strengthens the cursor's lens.
    function paint(hover, cursor, travelling, size) {
      // Both rulers measure their cells before moving the pointer.
      if (!rows.length || !size) return;
      const strength = travelling ? CURSOR_TRAVEL : CURSOR_REST;
      if (size === cell && hover === lastHover && cursor === lastCursor && strength === lastStrength) return;
      cell = size;
      lastHover = hover;
      lastCursor = cursor;
      lastStrength = strength;
      for (const [index, marks] of rows.entries()) {
        for (const entry of marks) {
          const x = (index + entry.at / perCell) * size;
          const near = hover === null ? 0 : Math.exp(-(((x - hover) / POINTER_REACH) ** 2));
          const lens = cursor === null ? 0 : strength * Math.exp(-(((x - cursor) / CURSOR_REACH) ** 2));
          const z = Math.max(near, lens);
          const value = z < 0.02 ? '' : z.toFixed(2);
          if (value === entry.z) continue;
          entry.z = value;
          if (value) entry.mark.style.setProperty('--z', value);
          else entry.mark.style.removeProperty('--z');
        }
      }
    }

    // A wave runs through one station's ticks; reduced motion leaves them still.
    const timers = new Map();
    function wave(index) {
      const element = cells[index];
      if (!element || still.matches) return;
      element.classList.remove('is-ruler-wave');
      void element.offsetWidth;
      element.classList.add('is-ruler-wave');
      window.clearTimeout(timers.get(index));
      timers.set(index, window.setTimeout(() => element.classList.remove('is-ruler-wave'), 1200));
    }

    function destroy() {
      for (const element of cells) {
        element.querySelector(':scope > .ruler-marks')?.remove();
        element.classList.remove('is-ruler-wave');
      }
      rows = [];
      perCell = 0;
    }

    return { build, paint, wave, destroy };
  }

  window.RulerLens = { create };
})();
