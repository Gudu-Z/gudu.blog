/* Start before the first paint; a failed main script must never trap the page. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let visibleSince = null;
  let released = false;
  let active = true;
  let revealPending = false;
  let closing = false;
  let readyRequested = false;
  let waitingForScene = false;
  let closeTimer = 0;
  let exitTimer = 0;
  let readyFrame = 0;
  root.classList.add('is-loading', 'has-site-intro');

  // Measure the short logo intro from its first paint, not the head-script download.
  function introStarted(event) {
    if (event.animationName !== 'loader-arrive' || !event.target.matches('.loader-symbol')) return;
    visibleSince = performance.now();
    document.removeEventListener('animationstart', introStarted);
  }
  document.addEventListener('animationstart', introStarted);

  function announceReveal() {
    if (!revealPending || !active || document.hidden) return;
    revealPending = false;
    window.dispatchEvent(new Event('site:revealed'));
  }

  function release({ notify = !document.hidden } = {}) {
    if (released) return;
    released = true;
    revealPending = true;
    clearTimeout(softDeadline);
    clearTimeout(deadline);
    clearTimeout(closeTimer);
    clearTimeout(exitTimer);
    cancelAnimationFrame(readyFrame);
    readyFrame = 0;
    document.removeEventListener('animationstart', introStarted);
    if (!notify || reducedMotion.matches || document.hidden || !root.classList.contains('is-loading-exit')) {
      root.classList.remove('has-site-intro');
    }
    root.classList.remove('is-loading', 'is-loading-exit');
    document.querySelector('#site-loader')?.remove();
    if (notify) announceReveal();
  }

  // Give a slow scene a chance to become interactive behind the logo. Begin
  // fallback dismissal early enough to finish its fade before the hard limit;
  // neither a pending resource nor a skipped transition can trap the page.
  const softDeadline = setTimeout(() => { if (readyRequested) dismiss(); }, 3450);
  const deadline = setTimeout(release, 4000);

  function dismiss() {
    if (!active || released || closing) return;
    closing = true;
    if (reducedMotion.matches || document.hidden) { release(); return; }
    // Resource readiness may arrive before the browser delivers animationstart.
    visibleSince ??= performance.now();
    function finishIntro() {
      if (!active || released) return;
      if (document.hidden) { release({ notify: false }); return; }
      const remaining = 1100 - (performance.now() - visibleSince);
      if (remaining > 0) {
        closeTimer = setTimeout(finishIntro, remaining);
        return;
      }
      const loader = document.querySelector('#site-loader');
      if (!loader) { release(); return; }
      loader.addEventListener('transitionend', event => {
        if (event.target === loader && event.propertyName === 'opacity') release();
      });
      root.classList.add('is-loading-exit');
      window.dispatchEvent(new Event('site:revealing'));
      // Allow the 420ms fade to finish even if transitionend is skipped.
      exitTimer = setTimeout(release, 550);
    }
    finishIntro();
  }

  function ready({ scene } = {}) {
    if (released || readyRequested) return;
    readyRequested = true;
    waitingForScene = scene !== undefined;
    const font = Promise.resolve().then(() => document.fonts?.load('900 1em "Barlow Condensed"'));
    const image = document.querySelector('.black-hole-fallback');
    // Decode the fallback in parallel so a failed renderer never starts a new
    // image wait. A live first frame need not wait for an unused fallback.
    const fallback = Promise.resolve().then(() => image?.decode?.()).catch(() => {});
    const sceneReady = document.querySelector('.black-hole')?.classList.contains('is-ready');
    const visual = waitingForScene
      ? Promise.resolve(scene).then(ready => ready === true ? undefined : fallback, () => fallback)
      : sceneReady ? Promise.resolve() : fallback;
    Promise.allSettled([font, visual]).then(() => {
      waitingForScene = false;
      if (!active || released) return;
      if (document.hidden || reducedMotion.matches) dismiss();
      else readyFrame = requestAnimationFrame(() => {
        readyFrame = 0;
        if (!active || released) return;
        if (document.hidden || reducedMotion.matches) { dismiss(); return; }
        readyFrame = requestAnimationFrame(() => {
          readyFrame = 0;
          if (active && !released) dismiss();
        });
      });
    });
  }

  window.SiteLoader = { ready };
  window.addEventListener('pagehide', () => { active = false; release({ notify: false }); });
  window.addEventListener('pageshow', () => { active = true; announceReveal(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) release({ notify: false });
    else announceReveal();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches && !waitingForScene) release();
  });
})();
