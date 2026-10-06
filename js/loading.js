/* Start before the first paint; a failed main script must never trap the page. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const started = performance.now();
  let released = false;
  let closing = false;
  let readyRequested = false;
  let closeTimer = 0;
  let exitTimer = 0;
  root.classList.add('is-loading');

  function release() {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    clearTimeout(closeTimer);
    clearTimeout(exitTimer);
    root.classList.remove('is-loading', 'is-loading-exit');
    document.querySelector('#site-loader')?.remove();
    window.dispatchEvent(new Event('site:revealed'));
  }

  // Includes slow downloads, missing assets and a main-script failure.
  const deadline = setTimeout(release, 4000);

  function dismiss() {
    if (released || closing) return;
    closing = true;
    if (reducedMotion.matches || document.hidden) { release(); return; }
    closeTimer = setTimeout(() => {
      if (released) return;
      const loader = document.querySelector('#site-loader');
      if (!loader) { release(); return; }
      loader.addEventListener('transitionend', event => {
        if (event.target === loader && event.propertyName === 'opacity') release();
      });
      root.classList.add('is-loading-exit');
      // Transition events can be skipped when the browser suspends a tab.
      exitTimer = setTimeout(release, 550);
    }, Math.max(0, 600 - (performance.now() - started)));
  }

  function ready() {
    if (released || readyRequested) return;
    readyRequested = true;
    const image = document.querySelector('.black-hole-fallback');
    const sceneReady = document.querySelector('.black-hole')?.classList.contains('is-ready');
    const visual = sceneReady ? Promise.resolve() : image?.decode?.();
    const font = document.fonts?.load('900 1em "Barlow Condensed"');
    Promise.allSettled([font, visual]).then(() => {
      if (released) return;
      if (document.hidden || reducedMotion.matches) dismiss();
      else requestAnimationFrame(() => requestAnimationFrame(dismiss));
    });
  }

  window.SiteLoader = { ready };
  window.addEventListener('pagehide', release, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) release(); });
})();
