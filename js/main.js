(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  const stage = document.querySelector('#hero-stage') || hero;
  const stars = document.querySelector('#starfield');
  const context = stars.getContext('2d');
  const blackHoleCanvas = document.querySelector('#black-hole-canvas');
  const blackHoleTheme = window.BlackHoleTheme;
  let blackHoleStyle = blackHoleTheme?.apply() || 'minimal';
  let blackHole = null;
  let rendererStarted = false;
  let rendererTimer = 0;
  let drawTimer = 0;
  let preparationTimer = 0;
  let firstFrameSubmitted = false;
  let sceneSettled = false;
  let resolveScene;
  const scenePreparation = new Promise(resolve => { resolveScene = resolve; });
  const layers = [...document.querySelectorAll('[data-depth]')].map(element => ({ element, depth: Number(element.dataset.depth) }));
  const titlePeriod = document.querySelector('.title-period');
  const clock = document.querySelector('#local-time');
  const clockDate = clock.querySelector('[data-clock-date]');
  const clockTime = clock.querySelector('[data-clock-time]');
  const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  clock.title = clockFormatter.resolvedOptions().timeZone;
  let clockTimer = 0;
  let themeTimer = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(pointer: fine)');
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let paused = reducedMotion.matches;
  let pageActive = true;
  let loading = document.documentElement.classList.contains('is-loading');
  let visible = true;
  let frame = 0;
  let lastTime = 0;
  let lastRender = 0;
  let elapsed = 12;
  let activeSince = null;
  let width = 0;
  let height = 0;
  let starList = [];
  let starFrame = null;
  let layerX = NaN;
  let layerY = NaN;
  let chapterProgress = 0;
  let entranceGlow = 0;
  let contentMoving = false;
  let heldForInteraction = false;
  let busySince = null;

  function settleScene(ready) {
    if (sceneSettled) return;
    sceneSettled = true;
    clearTimeout(preparationTimer);
    preparationTimer = 0;
    resolveScene(ready);
  }

  function checkFirstFrame() {
    preparationTimer = 0;
    if (sceneSettled || !pageActive || document.hidden || !firstFrameSubmitted) return;
    if (!blackHole?.ready || blackHole.lost) { settleScene(false); return; }
    if (blackHole.pollGpu?.() !== false) { settleScene(true); return; }
    preparationTimer = setTimeout(checkFirstFrame, 32);
  }

  function finishIntro() {
    hero.classList.add('intro-complete');
    document.documentElement.classList.remove('has-site-intro');
    updateTitleBlink();
  }
  function revealScene() {
    // A loader timeout may deliberately reveal the fallback. Late GPU setup
    // can still replace it, but no startup waiter should outlive the loader.
    settleScene(false);
    loading = false;
    start();
    updateTitleBlink();
  }
  window.addEventListener('site:revealing', revealScene);
  window.addEventListener('site:revealed', revealScene);
  if (reducedMotion.matches) finishIntro();
  hero.addEventListener('animationend', event => {
    // The title's period is the final remaining entrance animation.
    if (event.animationName === 'title-period-enter') { finishIntro(); start(); }
  });

  // Prepare behind the loader after the logo strokes, rather than waiting for
  // the page entrance to finish. Readiness is the first completed scene frame.
  function scheduleRenderer() {
    if (!pageActive || rendererStarted || rendererTimer || !blackHoleCanvas || !window.BlackHole
        || !visible || document.hidden) return;
    rendererTimer = setTimeout(function initializeRenderer() {
      rendererTimer = 0;
      if (!pageActive || !visible || document.hidden) return;
      rendererStarted = true;
      try {
        const renderer = new window.BlackHole(blackHoleCanvas, { style: blackHoleStyle });
        blackHole = renderer;
        renderer.onRestore = () => {
          if (!pageActive || document.hidden || blackHole !== renderer) return;
          draw();
          start();
        };
        // Also support an already-ready renderer (including older cached builds).
        if (blackHole.ready) { draw(); start(); }
        renderer.initialization?.then(ready => {
          if (!pageActive || document.hidden || blackHole !== renderer) return;
          if (!ready && !renderer.ready) settleScene(false);
        });
      } catch (error) {
        settleScene(false);
        console.warn('Using the static black-hole illustration.', error);
      }
    }, loading ? 1100 : 32);
  }

  function stopTitleBlink() {
    titlePeriod?.classList.remove('is-cursor-blinking');
  }

  function updateTitleBlink() {
    if (!pageActive || !titlePeriod || loading || paused || !visible || document.hidden || chapterProgress > 0.1
        || document.documentElement.classList.contains('has-site-intro')) {
      stopTitleBlink();
      return;
    }
    titlePeriod.classList.add('is-cursor-blinking');
  }

  // Read the actual wall clock every second, independently of visual animation.
  function updateClock() {
    clearTimeout(clockTimer);
    if (!pageActive || document.hidden) return;
    const now = new Date();
    const parts = Object.fromEntries(clockFormatter.formatToParts(now).map(part => [part.type, part.value]));
    clock.dateTime = now.toISOString();
    clockDate.textContent = `${parts.year}.${parts.month}.${parts.day}`;
    clockTime.textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
    clock.setAttribute('aria-label', `当前本地时间：${clockFormatter.format(now)}`);
    if (!document.hidden) clockTimer = setTimeout(updateClock, 1005 - now.getMilliseconds());
  }

  function stopClock() { clearTimeout(clockTimer); }

  function updateBlackHoleTheme() {
    clearTimeout(themeTimer);
    if (!pageActive || document.hidden) return;
    const nextStyle = blackHoleTheme?.resolve() || 'minimal';
    if (nextStyle !== blackHoleStyle) {
      stop();
      blackHoleStyle = blackHoleTheme.apply(nextStyle);
      blackHoleCanvas?.parentElement.classList.remove('is-ready');
      try {
        if (blackHole) blackHole.setStyle(nextStyle);
      } catch (error) {
        blackHole = null;
        console.warn('Using the static black-hole illustration.', error);
      }
      resize();
      start();
    }
    if (blackHoleTheme && !document.hidden) {
      themeTimer = setTimeout(updateBlackHoleTheme, 60010 - Date.now() % 60000);
    }
  }

  // Seeded positions stay in place when the viewport is resized.
  function random(seed) {
    const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function resize() {
    if (!pageActive || document.hidden) return;
    const bounds = stage.getBoundingClientRect();
    const dimensionsChanged = width !== bounds.width || height !== bounds.height;
    width = bounds.width;
    height = bounds.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const bufferWidth = Math.round(width * dpr), bufferHeight = Math.round(height * dpr);
    // ResizeObserver also reports font/heading changes. Resetting an unchanged
    // full-screen canvas clears its pixels and reallocates its backing store.
    if (stars.width !== bufferWidth || stars.height !== bufferHeight) {
      if (stars.width !== bufferWidth) stars.width = bufferWidth;
      if (stars.height !== bufferHeight) stars.height = bufferHeight;
      starFrame = null;
    }
    context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The shader owns the lensed background; these few dim points fill its edges.
    if (dimensionsChanged) {
      starList = Array.from({ length: Math.round(width * height / 24000) }, (_, i) => ({
        x: random(i * 5 + 1) * width,
        y: random(i * 5 + 2) * height,
        radius: 0.35 + random(i * 5 + 3) * 0.65,
        light: 0.04 + random(i * 5 + 4) * 0.12,
        depth: 0.2 + random(i * 5 + 5) * 1.2,
      }));
      starFrame = null;
    }
    blackHole?.resize();
    draw();
  }

  function drawStars(fallback = false) {
    if (!pageActive || document.hidden || !context) return;
    // The live minimal renderer supplies one continuous, lensed sky across
    // the hero. Keep the old edge stars for ink and the static fallback only.
    const show = fallback || blackHoleStyle !== 'minimal' || !blackHole?.ready || blackHole.lost;
    if (starFrame && starFrame.show === show && (!show || (starFrame.x === pointer.x
        && starFrame.y === pointer.y && starFrame.style === blackHoleStyle))) return;
    starFrame = { show, x: pointer.x, y: pointer.y, style: blackHoleStyle };
    context.clearRect(0, 0, width, height);
    if (!show) return;
    for (const star of starList) {
      const x = star.x + pointer.x * star.depth * 13;
      const y = star.y + pointer.y * star.depth * 10;
      context.fillStyle = blackHoleStyle === 'ink'
        ? `rgba(225,218,200,${star.light * 0.55})`
        : `rgba(193,204,223,${star.light})`;
      context.beginPath();
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  function drawParallax() {
    drawStars();
    if (pointer.x !== layerX || pointer.y !== layerY) {
      layerX = pointer.x;
      layerY = pointer.y;
      for (const { element, depth } of layers) {
        element.style.setProperty('--pointer-x', `${-pointer.x * depth * 8}px`);
        element.style.setProperty('--pointer-y', `${-pointer.y * depth * 6}px`);
      }
    }
  }

  function draw() {
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (!pageActive || document.hidden) return false;
    if (shouldHoldScene()) { holdScene(); return false; }
    drawParallax();
    const submitted = blackHole?.render(sceneTime(), pointer.x, -pointer.y, chapterProgress, entranceGlow);
    if (submitted === true && !sceneSettled) {
      firstFrameSubmitted = true;
      // Let the submitted commands reach the GPU before the first zero-wait poll.
      if (!preparationTimer) preparationTimer = setTimeout(checkFirstFrame, 32);
    }
    // Animation retries on its next scheduled frame. A separate timer would
    // bypass a slower GPU-requested cadence; only a static scene needs one.
    if (submitted === false && blackHole?.ready && !blackHole.lost && visible && (paused || loading)) {
      drawTimer = setTimeout(function retryDraw() {
        drawTimer = 0;
        if (pageActive && !document.hidden && visible && (paused || loading)) draw();
      }, 32);
    }
    return submitted;
  }

  // Orbital phase follows monotonic active time, independently of frame rate
  // and the bounded delta used only to ease the pointer below.
  function sceneTime() {
    return elapsed + (activeSince === null ? 0 : (performance.now() - activeSince) / 1000);
  }

  function resumeSceneClock() {
    if (activeSince === null) activeSince = performance.now();
  }

  function pauseSceneClock() {
    if (activeSince === null) return;
    elapsed = sceneTime();
    activeSince = null;
  }

  function shouldHoldScene() {
    return !paused && chapterProgress >= 1 && contentMoving && (blackHole?.quality < 0.95 || blackHole?.frameInterval >= 49
      || (busySince !== null && performance.now() - busySince >= 80));
  }

  function holdScene() {
    heldForInteraction = true;
    pauseSceneClock();
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = lastRender = 0;
  }

  function tick(timestamp) {
    frame = 0;
    if (!pageActive || loading || paused || !visible || document.hidden) { stop(); return; }
    // Observe completion at display cadence even when expensive draws run less
    // often. This is a zero-timeout poll; it never submits or waits for a frame.
    const gpuAvailable = blackHole?.pollGpu?.();
    if (gpuAvailable === false && blackHole?.ready) busySince ??= performance.now();
    else busySince = null;
    if (shouldHoldScene()) { holdScene(); return; }
    const animated = blackHole?.ready && !blackHole.lost;
    if (animated) resumeSceneClock(); else pauseSceneClock();
    const delta = lastTime ? Math.min(timestamp - lastTime, 100) : 16;
    lastTime = timestamp;
    // About 110 ms of damping keeps direction changes responsive at any refresh rate.
    const ease = 1 - Math.exp(-delta * 0.009);
    pointer.x += (pointer.targetX - pointer.x) * ease;
    pointer.y += (pointer.targetY - pointer.y) * ease;
    const settled = Math.abs(pointer.targetX - pointer.x) < 0.001 && Math.abs(pointer.targetY - pointer.y) < 0.001;
    if (settled) {
      pointer.x = pointer.targetX;
      pointer.y = pointer.targetY;
    }
    // Lightweight layers follow the display even when the GPU is occupied.
    drawParallax();
    const requestedInterval = animated
      ? blackHole.getFrameInterval?.(!settled && chapterProgress === 0) ?? blackHole.frameInterval : 1000 / 60;
    const frameInterval = Number.isFinite(requestedInterval) && requestedInterval > 0
      ? requestedInterval : 1000 / 30;
    // Retain fractional cadence across 60/75/120/144 Hz displays. A busy GPU
    // cannot consume a due frame; submit its latest camera on the next free tick.
    if ((!animated || gpuAvailable !== false)
        && (timestamp - lastRender >= frameInterval - 1 || (!animated && settled))) {
      const submitted = draw();
      if (!animated || submitted !== false) {
        if (animated) blackHole.sampleFrame(timestamp);
        lastRender += Math.max(1, Math.floor((timestamp - lastRender + 1) / frameInterval)) * frameInterval;
      }
    }
    // Rendering may slow under GPU load, but the active scene clock keeps time.
    if (animated || !settled) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function start() {
    scheduleRenderer();
    if (!pageActive || frame || loading || paused || !visible || document.hidden) return;
    if (shouldHoldScene()) { holdScene(); return; }
    heldForInteraction = false;
    const animated = blackHole?.ready && !blackHole.lost;
    if (!animated && pointer.x === pointer.targetX && pointer.y === pointer.targetY) return;
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (animated) resumeSceneClock(); else pauseSceneClock();
    lastTime = 0;
    lastRender = 0;
    blackHole?.resetTiming();
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    clearTimeout(rendererTimer);
    rendererTimer = 0;
    clearTimeout(drawTimer);
    drawTimer = 0;
    clearTimeout(preparationTimer);
    preparationTimer = 0;
    busySince = null;
    heldForInteraction = false;
    entranceGlow = 0;
    pauseSceneClock();
    blackHole?.resetTiming?.();
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }

  function updateMotion() {
    hero.dataset.motion = paused ? 'paused' : 'playing';
    if (paused) { stop(); scheduleRenderer(); } else start();
    updateTitleBlink();
  }

  window.addEventListener('site:interaction', event => {
    contentMoving = Boolean(event.detail?.active && event.detail?.kind === 'content');
    if (!pageActive || document.hidden) return;
    if (shouldHoldScene()) holdScene();
    else if (heldForInteraction) { busySince = null; start(); }
  });

  window.addEventListener('site:chapter', event => {
    chapterProgress = Math.max(0, Math.min(1, Number(event.detail?.progress) || 0));
    entranceGlow = pageActive && visible && !document.hidden && !paused
      ? Math.max(0, Math.min(1, Number(event.detail?.entranceGlow) || 0)) : 0;
    if (chapterProgress > 0) pointer.targetX = pointer.targetY = 0;
    updateTitleBlink();
    // Reduced-motion users still need a fresh static frame at the destination.
    if (pageActive && visible && !document.hidden && (paused || !frame)) draw();
    start();
  });

  hero.addEventListener('pointermove', event => {
    if (!pageActive || document.hidden || loading || paused || !finePointer.matches || event.pointerType === 'touch') return;
    const rect = hero.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    pointer.targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    start();
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { pointer.targetX = pointer.targetY = 0; start(); });
  finePointer.addEventListener('change', () => {
    if (!finePointer.matches) { pointer.targetX = pointer.targetY = 0; start(); }
  });
  reducedMotion.addEventListener('change', () => {
    paused = reducedMotion.matches;
    if (paused) finishIntro();
    pointer.x = pointer.y = pointer.targetX = pointer.targetY = 0;
    updateMotion();
    draw();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); stopClock(); clearTimeout(themeTimer); finishIntro(); }
    else { updateBlackHoleTheme(); resize(); start(); updateClock(); }
    updateTitleBlink();
  });
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) start(); else stop();
    updateTitleBlink();
  }).observe(stage);
  const sceneResize = new ResizeObserver(resize);
  sceneResize.observe(stage);
  // A late web font changes the heading's quiet zone without resizing the hero.
  const heading = document.querySelector('.hero-heading');
  if (heading) sceneResize.observe(heading);
  blackHoleCanvas?.addEventListener('webglcontextlost', () => { stop(); settleScene(false); drawStars(true); });
  window.addEventListener('pagehide', event => {
    // pagehide can precede visibilitychange. Gate every late completion before
    // retiring the renderer, while preserving it for BFCache.
    pageActive = false;
    stop();
    stopClock();
    clearTimeout(themeTimer);
    finishIntro();
    stopTitleBlink();
    if (!event.persisted) {
      // Do not send deletion commands into a busy driver while the tab closes.
      // The browser owns context retirement once this document is discarded.
      blackHole?.dispose?.({ releaseGpu: false });
      blackHole = null;
      rendererStarted = false;
      settleScene(false);
    }
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    updateBlackHoleTheme();
    resize();
    start();
    updateClock();
    updateTitleBlink();
  });
  window.addEventListener('popstate', updateBlackHoleTheme);
  // The loader bounds this wait; unsupported or slow GPUs retain the decoded
  // illustration instead of trapping navigation behind shader compilation.
  resize();
  updateMotion();
  updateClock();
  updateBlackHoleTheme();
  if (!blackHoleCanvas || !window.BlackHole) settleScene(false);
  window.SiteLoader?.ready({ scene: scenePreparation });
})();
