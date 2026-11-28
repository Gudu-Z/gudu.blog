/* The article page follows a mouse in depth, as the home page does: the
 * page's HUD (the site bar, the contents, the article index and the reading
 * progress) travels a little further than the article, and the stars behind
 * move against both (js/article-sky.js reads window.ArticlePointer). The
 * pointer is eased over about 110 ms and comes home when it leaves the
 * window. While a button is held or a field has focus the page holds still,
 * so nothing slides under a selection, a drag or typing. Touch, coarse
 * pointers and reduced motion leave the page still. The depth while
 * scrolling is css/blog.css.
 *
 * The eased pointer is written as --pointer-x and --pointer-y on the root
 * (right and up positive, −1 to 1), and css/blog.css turns them into each
 * layer's travel. As the page goes, the pointer is saved, and the next
 * article restores it in its head before it first paints
 * (scripts/build-blog.mjs), so a new article opens where the last one stood
 * instead of jumping home and sliding back on the first move.
 */
(() => {
  'use strict';

  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const live = () => fine.matches && !still.matches;
  const start = live() ? window.ArticlePointerStart : null;
  const pointer = window.ArticlePointer = { x: start?.x ?? 0, y: start?.y ?? 0 };
  const saveKey = 'gudu:article-pointer';

  let toX = pointer.x, toY = pointer.y, at = 0, frame = 0;
  const typing = () => document.activeElement?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

  function place() {
    if (pointer.x !== 0 || pointer.y !== 0) {
      root.style.setProperty('--pointer-x', pointer.x.toFixed(4));
      root.style.setProperty('--pointer-y', pointer.y.toFixed(4));
    } else {
      root.style.removeProperty('--pointer-x');
      root.style.removeProperty('--pointer-y');
    }
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

  // The mouse stays where it was when a link opens the next article.
  window.addEventListener('pagehide', () => {
    if (!live()) return;
    try { sessionStorage.setItem(saveKey, JSON.stringify({ x: toX, y: toY, at: Date.now() })); } catch {}
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
  place();
})();
