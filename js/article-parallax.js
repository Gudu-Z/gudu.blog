/* The article page follows a mouse in depth, as the home page does: the
 * page's HUD (the site bar, the contents and the reading progress) travels a
 * little further than the article, and the stars behind move against both
 * (js/article-sky.js reads window.ArticlePointer). The pointer is eased over
 * about 110 ms and comes home when it leaves the window. While a button is
 * held or a field has focus the page holds still, so nothing slides under a
 * selection, a drag or typing. Touch, coarse pointers and reduced motion leave
 * the page still. The depth while scrolling is css/blog.css.
 */
(() => {
  'use strict';

  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = window.ArticlePointer = { x: 0, y: 0 };
  // Each layer's travel at full deflection, in CSS pixels, as on the home page.
  const layers = [
    ['.article-shell', 6, 3.75],
    ['.site-header', 8, 5],
    ['.reading-progress', 8, 5],
    // The contents sit inside the shell, so this is the rest of the HUD's travel.
    ['.article-toc', 2, 1.25],
  ].map(([selector, x, y]) => [document.querySelector(selector), x, y]).filter(([node]) => node);

  let toX = 0, toY = 0, at = 0, frame = 0;
  const live = () => fine.matches && !still.matches;
  const typing = () => document.activeElement?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

  function place() {
    const moved = pointer.x !== 0 || pointer.y !== 0;
    for (const [node, x, y] of layers) node.style.translate = moved ? `${(pointer.x * x).toFixed(2)}px ${(-pointer.y * y).toFixed(2)}px` : '';
  }

  function tick(now) {
    frame = 0;
    const dt = at ? Math.min(0.1, (now - at) / 1000) : 0;
    at = now;
    const k = 1 - Math.exp(-dt / 0.11);
    pointer.x += (toX - pointer.x) * k;
    pointer.y += (toY - pointer.y) * k;
    if (Math.abs(toX - pointer.x) < 0.001 && Math.abs(toY - pointer.y) < 0.001) {
      pointer.x = toX;
      pointer.y = toY;
      at = 0;
    } else frame = requestAnimationFrame(tick);
    place();
  }

  function aim(x, y) {
    toX = x;
    toY = y;
    if (!frame) frame = requestAnimationFrame(tick);
  }

  // Right and up are positive, as js/main.js gives them to the home page.
  window.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || event.buttons || typing() || !live()) return;
    aim(event.clientX / window.innerWidth * 2 - 1, 1 - event.clientY / window.innerHeight * 2);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', event => {
    if (!event.buttons && live()) aim(0, 0);
  });

  // Reduced motion or a coarse pointer puts everything home at once.
  function settle() {
    if (live()) return;
    cancelAnimationFrame(frame);
    frame = 0;
    at = 0;
    toX = toY = pointer.x = pointer.y = 0;
    place();
  }
  fine.addEventListener('change', settle);
  still.addEventListener('change', settle);
})();
