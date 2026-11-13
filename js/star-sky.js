/* The site's star sky: clear points at their own depths, seeded so every
 * visit and every resize shows the same sky. The home page (js/main.js) draws
 * it behind its black hole and moves it with the camera; any other page can
 * show it still behind its content with
 * <canvas data-star-sky aria-hidden="true"></canvas>.
 */
(() => {
  'use strict';

  function random(seed) {
    let state = seed;
    return () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
  }

  // One star per 2500 square pixels, between 120 and 1400 (as dense as ever
  // up to a 2560 by 1370 window), a little past each edge so a moving sky
  // never shows an empty margin.
  function stars(width, height) {
    const next = random(9);
    const count = Math.max(120, Math.min(1400, Math.round(width * height / 2500)));
    return Array.from({ length: count }, () => {
      const x = (next() * 1.12 - 0.06) * width, y = (next() * 1.12 - 0.06) * height;
      const bright = next(), near = next();
      // Broad clusters leave dark room between them.
      const group = 0.5 + 0.5 * Math.sin(x * 0.006 + Math.sin(y * 0.005)) * Math.cos(y * 0.007);
      return {
        x, y, lastX: NaN, lastY: NaN,
        radius: 0.5 + 1.05 * bright * bright * bright,
        light: (0.14 + 0.86 * bright * bright) * (0.25 + 0.75 * group),
        // How much of a camera's travel a star shares: most lie far away.
        depth: 0.04 + 0.4 * near * near,
      };
    });
  }

  // Night shows cool white points; daylight the same stars as their
  // negative, as the black hole's own sky does; ink a dimmer warm white.
  function tone({ day = false, ink = false } = {}) {
    if (ink) return { color: '225,218,200', gain: 0.55 };
    return day ? { color: '62,51,32', gain: 0.8 } : { color: '193,204,223', gain: 1 };
  }

  // A still sky filling its canvas, redrawn when the canvas or the theme
  // changes and never otherwise.
  function mount(canvas) {
    const context = canvas.getContext?.('2d');
    if (!context) return;
    let list = [], width = 0, height = 0;
    function draw() {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (box.width !== width || box.height !== height) {
        width = box.width;
        height = box.height;
        list = stars(width, height);
      }
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const { color, gain } = tone({ day: document.documentElement.dataset.theme === 'light' });
      for (const star of list) {
        context.fillStyle = `rgba(${color},${Math.min(1, star.light * gain)})`;
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    new ResizeObserver(draw).observe(canvas);
    window.addEventListener('site:theme', draw);
    draw();
  }

  window.StarSky = { stars, tone, mount };
  for (const canvas of document.querySelectorAll('canvas[data-star-sky]')) mount(canvas);
})();
