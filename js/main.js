(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  const stage = document.querySelector('#hero-stage') || hero;
  const stars = document.querySelector('#starfield');
  const context = stars.getContext('2d');
  const gpuStars = document.querySelector('#starfield-gpu');
  const blackHoleCanvas = document.querySelector('#black-hole-canvas');
  const sphereSwitch = document.querySelector('.black-hole-switch');
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
  // The loader's readout marks the compiled scene before its first frame.
  let resolveCompiled;
  const sceneCompiled = new Promise(resolve => { resolveCompiled = resolve; });
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
  let catalogue = [];
  let starList = [];
  let starField;
  let fieldNeedsResize = true;
  let sceneContextLost = false;
  // The unmodified catalogue is phase zero. Ink or a lost context holds the
  // last painted phase until a live minimal sky takes over at the same place.
  let driftTime = 0;
  let driftEpoch = null;
  let starFrame = null;
  let starAnchor = null;
  let starQuiet = null;
  let layerX = NaN;
  let layerY = NaN;
  let chapterProgress = 0;
  let entranceGlow = 0;
  // The page entrance (js/intro.js) owns the camera's pull-back: 1 frames the
  // empty sky it starts on, 0 the hero composition.
  let introAmount = 0;
  let introMoving = false;
  // The article catalog (js/catalog.js) tilts the camera up by this share of
  // catalogPitch: the hole and both star layers turn down out of the stage.
  let catalogAmount = 0;
  let catalogMoving = false;
  const catalogPitch = 50 * Math.PI / 180;
  // Page pixels per unit of the scene's screen: half the virtual figure's height.
  let figureUnit = 0;
  let beaming = false;
  let contentMoving = false;
  let heldForInteraction = false;
  let busySince = null;
  let drawnFrames = 0;

  function settleScene(ready) {
    if (sceneSettled) return;
    sceneSettled = true;
    clearTimeout(preparationTimer);
    preparationTimer = 0;
    resolveCompiled(ready);
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
    // However the entrance ends, the camera is back on the hero composition.
    introAmount = 0;
    introMoving = false;
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
  // The full entrance types the title itself and reports its own end.
  window.addEventListener('site:intro-complete', () => {
    finishIntro();
    if (pageActive && visible && !document.hidden && (paused || !frame)) draw();
    start();
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
        renderer.setDay?.(isDay() ? 1 : 0);
        blackHole = renderer;
        renderer.onRestore = () => {
          if (blackHole !== renderer) return;
          sceneContextLost = false;
          starAnchor = null;
          if (!pageActive || document.hidden) return;
          resolveCompiled(true);
          draw();
          start();
        };
        // Also support an already-ready renderer (including older cached builds).
        if (blackHole.ready) { resolveCompiled(true); draw(); start(); }
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

  function isDay() {
    return document.documentElement.dataset.theme === 'light';
  }

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
    // The hero's sky (js/star-sky.js): clear points at their own depths,
    // behind the scene. The shader adds the few stars it bends around the
    // hole on top of them.
    if (dimensionsChanged) {
      catalogue = window.StarSky?.stars(width, height) ?? [];
      starList = driftEpoch === null && driftTime > 0 ? frozenStars() : catalogue;
      starFrame = null;
    }
    fieldNeedsResize = true;
    if (dimensionsChanged || (blackHole?.ready && !blackHole.lost)) starAnchor = null;
    figureUnit = (document.querySelector('#black-hole')?.offsetHeight || height) / 2;
    placeFallback();
    // A bright point among the clock's digits would read as punctuation, so
    // the sky dims around that one line. Offsets ignore the line's parallax
    // and entrance transforms.
    const quiet = clock.offsetWidth ? { left: 0, top: 0, width: clock.offsetWidth, height: clock.offsetHeight } : null;
    for (let node = clock; quiet && node && node !== stage; node = node.offsetParent) {
      quiet.left += node.offsetLeft;
      quiet.top += node.offsetTop;
    }
    if (quiet?.left !== starQuiet?.left || quiet?.top !== starQuiet?.top
        || quiet?.width !== starQuiet?.width || quiet?.height !== starQuiet?.height) {
      starQuiet = quiet;
      starFrame = null;
    }
    blackHole?.resize();
    draw();
  }

  // The page entrance magnifies the sky about its camera's fixed point.
  function starZoom() {
    if (!(introAmount > 0)) return 1;
    if (!starAnchor) {
      if (!blackHole?.ready || blackHole.lost || sceneContextLost) return 1;
      const view = blackHole.introView?.(1);
      if (!view) return 1;
      const box = stage.getBoundingClientRect();
      starAnchor = { x: view.x - box.left, y: view.y - box.top, zoom: view.zoom };
    }
    return starAnchor.zoom ** introAmount;
  }

  // The catalog's tilt carries the sky down the stage. Under the scene's
  // perspective a point at angle e above the view's centre lands at
  // focal * tan(e - pitch) screen units; the hole sits at e = 0. The flat
  // star field can only pan, so it keeps pace with the stars halfway up the
  // stage's upper half, the part of the sky that stays in view.
  function catalogFocal() {
    return (blackHoleStyle === 'ink' ? 3.7 : 4.05) * (1 - 0.66 * chapterProgress);
  }

  function skyPan() {
    const pitch = catalogAmount * catalogPitch;
    if (!pitch || !figureUnit) return 0;
    const focal = catalogFocal(), rise = Math.atan(height / 4 / figureUnit / focal);
    return figureUnit * focal * (Math.tan(rise) - Math.tan(rise - pitch));
  }

  // The static illustration has no camera; it drops as far as the hole does.
  function placeFallback() {
    const image = document.querySelector('.black-hole-fallback');
    const drop = catalogAmount && figureUnit ? figureUnit * catalogFocal() * Math.tan(catalogAmount * catalogPitch) : 0;
    if (image) image.style.translate = drop ? `0 ${drop.toFixed(2)}px` : '';
  }

  function drawStars() {
    if (!pageActive || document.hidden || !context) return;
    const day = isDay();
    const zoom = starZoom();
    // By day the dark points read as dust on the chapters' pale panels, so
    // they fade to two fifths as the chapters arrive; the hero keeps them all.
    const fade = day ? 1 - 0.6 * chapterProgress : 1;
    const pan = skyPan();
    if (starFrame && starFrame.x === pointer.x && starFrame.y === pointer.y && starFrame.zoom === zoom
        && starFrame.amount === introAmount && starFrame.style === blackHoleStyle && starFrame.day === day
        && starFrame.fade === fade && starFrame.pan === pan) return;
    starFrame = { x: pointer.x, y: pointer.y, zoom, amount: introAmount, style: blackHoleStyle, day, fade, pan };
    context.clearRect(0, 0, width, height);
    // Daylight draws the same stars as the night sky's negative.
    const { color, gain: tone } = window.StarSky?.tone({ day, ink: blackHoleStyle === 'ink' }) ?? { color: '193,204,223', gain: 1 };
    const gain = tone * fade;
    const anchorX = starAnchor?.x ?? 0, anchorY = starAnchor?.y ?? 0;
    // The clock's line, with room for its own parallax; the opening sky of the
    // entrance has no clock yet.
    const quiet = starQuiet && introAmount < 1 ? starQuiet : null;
    const quietRight = quiet ? quiet.left + quiet.width + 8 : 0, quietBottom = quiet ? quiet.top + quiet.height + 6 : 0;
    context.lineCap = 'round';
    for (const star of starList) {
      // Magnified, a star moves away from the fixed point by its depth's
      // share. The scene pans a few pixels with the pointer; far stars go
      // with it and nearer ones lag behind.
      const spread = (zoom - 1) * star.depth;
      const x = star.x + (star.x - anchorX) * spread + pointer.x * (7 - 30 * star.depth);
      let y = star.y + (star.y - anchorY) * spread + pointer.y * (5 - 22 * star.depth);
      // The catalog's tilt pans the sky over the same period as the GPU field.
      if (pan) y -= Math.floor((y + pan + 0.06 * height) / (1.12 * height)) * (1.12 * height) - pan;
      const fromX = star.lastX, fromY = star.lastY;
      star.lastX = x;
      star.lastY = y;
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue;
      let alpha = Math.min(1, star.light * gain);
      if (quiet) {
        const outside = Math.hypot(Math.max(quiet.left - 8 - x, 0, x - quietRight), Math.max(quiet.top - 6 - y, 0, y - quietBottom));
        if (outside < 16) alpha *= 1 - 0.85 * (1 - outside / 16) * (1 - introAmount);
      }
      const travel = introMoving ? Math.hypot(x - fromX, y - fromY) : 0;
      if (travel > 1.2 && travel < 90) {
        // Under the entrance's moving camera a star leaves the trace of one
        // frame's travel.
        context.strokeStyle = `rgba(${color},${alpha * 0.85})`;
        context.lineWidth = star.radius * 1.7;
        context.beginPath();
        context.moveTo(fromX, fromY);
        context.lineTo(x, y);
        context.stroke();
      } else {
        context.fillStyle = `rgba(${color},${alpha})`;
        context.beginPath();
        context.arc(x, y, star.radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function frozenStars() {
    return window.StarField.freezeCatalogue(catalogue, width, height, driftTime);
  }

  function drawSky(time) {
    if (gpuStars && window.StarField && blackHoleStyle === 'minimal' && !sceneContextLost && !blackHole?.lost) {
      if (fieldNeedsResize || starField === undefined) {
        fieldNeedsResize = false;
        try {
          if (starField === undefined) starField = new window.StarField(gpuStars);
          starField?.resize(width, height, Math.min(devicePixelRatio || 1, 2), catalogue);
        } catch (error) {
          starField = null;
          console.warn('Using the 2D star field.', error);
        }
      }
      if (starField) {
        const epoch = driftEpoch ?? time - driftTime;
        const phase = time - epoch;
        const day = isDay();
        if (starField.render({
          zoom: starZoom(), anchorX: starAnchor?.x ?? 0, anchorY: starAnchor?.y ?? 0,
          pointerX: pointer.x, pointerY: pointer.y, amount: introAmount, introMoving,
          quiet: starQuiet, time: phase, day, fade: day ? 1 - 0.6 * chapterProgress : 1, pan: skyPan(),
        })) {
          if (driftEpoch === null) {
            // Reduced motion gives all properties a brief transition. A lost
            // canvas needs an atomic visibility swap, even on a paused frame.
            stars.style.transitionProperty = gpuStars.style.transitionProperty = 'none';
            stars.style.visibility = 'hidden';
            gpuStars.style.visibility = 'visible';
          }
          driftEpoch = epoch;
          driftTime = phase;
          return;
        }
      }
    }
    if (driftEpoch !== null) {
      // Bake the orbit once, before the 2D camera transform. The original
      // drawStars continues to paint this frozen sky on pointer/theme changes.
      starList = frozenStars();
      starFrame = null;
      starField?.resetHistory();
      driftEpoch = null;
      drawStars();
      stars.style.visibility = 'visible';
      gpuStars.style.visibility = 'hidden';
    } else drawStars();
  }

  function drawParallax(time) {
    drawSky(time);
    if (pointer.x !== layerX || pointer.y !== layerY) {
      layerX = pointer.x;
      layerY = pointer.y;
      for (const { element, depth } of layers) {
        element.style.setProperty('--pointer-x', `${-pointer.x * depth * 8}px`);
        element.style.setProperty('--pointer-y', `${-pointer.y * depth * 6}px`);
      }
    }
  }

  function draw(time = sceneTime()) {
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (!pageActive || document.hidden) return false;
    if (shouldHoldScene()) { holdScene(); return false; }
    drawParallax(time);
    blackHole?.setIntro?.(introAmount);
    blackHole?.setPitch?.(catalogAmount * catalogPitch);
    const submitted = blackHole?.render(time, pointer.x, -pointer.y, chapterProgress, entranceGlow);
    if (submitted === true) drawnFrames++;
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
    const requestedInterval = animated
      ? blackHole.getFrameInterval?.(((!settled || introMoving) && chapterProgress === 0) || catalogMoving)
        ?? blackHole.frameInterval : 1000 / 60;
    const frameInterval = Number.isFinite(requestedInterval) && requestedInterval > 0
      ? requestedInterval : 1000 / 30;
    // Retain fractional cadence across 60/75/120/144 Hz displays. A busy GPU
    // cannot consume a due frame; submit its latest camera on the next free tick.
    // While the day/night beam is up, the switch itself draws each frame.
    if (!beaming && (!animated || gpuAvailable !== false)
        && (timestamp - lastRender >= frameInterval - 1 || (!animated && settled))) {
      const submitted = draw();
      if (!animated || submitted !== false) {
        if (animated) blackHole.sampleFrame(timestamp);
        lastRender += Math.max(1, Math.floor((timestamp - lastRender + 1) / frameInterval)) * frameInterval;
      }
    } else drawParallax(sceneTime()); // Keep the sky and pointer layers at display cadence.
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

  // The day/night switch (js/theme-jets.js) draws its column out of the
  // hole along the spin axis, through the scene's own camera.
  window.SiteBlackHole = {
    jetCamera() {
      // Under the catalog's tilt the hole has turned away: the switch's beam
      // starts at the toggle, as on pages without a black hole.
      if (!pageActive || catalogAmount > 0) return null;
      const live = blackHole?.ready && !blackHole.lost ? blackHole.jetCamera?.() : null;
      if (live) return live;
      // The static illustration turns and shrinks with the chapters as a
      // whole image, around its centre.
      const image = document.querySelector('.black-hole-fallback');
      const box = image?.getBoundingClientRect();
      if (!box?.width) return null;
      return {
        x: box.left + box.width / 2, y: box.top + box.height / 2,
        roll: 18 * (1 - chapterProgress) * Math.PI / 180,
        inclination: 81 * Math.PI / 180, azimuth: 0, distance: 31.78443, focal: 4.05,
        scale: image.offsetHeight * (1 - 0.66 * chapterProgress) / 2,
      };
    },
    // Frames drawn so far: a switch waits for one in its final theme.
    drawn: () => drawnFrames,
    // The page entrance moves the camera; a moving camera draws at the
    // interactive cadence. A still scene redraws at once, so no page is
    // ever left showing the entrance's starting sky.
    intro(amount, moving = false) {
      const next = Math.max(0, Math.min(1, Number(amount) || 0));
      const changed = next !== introAmount;
      introAmount = next;
      introMoving = Boolean(moving) && next > 0;
      if (changed && pageActive && visible && !document.hidden && (paused || loading || !frame)) draw();
      start();
    },
    // The article catalog tilts the camera up by this share of its full
    // pitch. A moving tilt draws at the interactive cadence; a still one
    // redraws at once.
    catalog(amount, moving = false) {
      const next = Math.max(0, Math.min(1, Number(amount) || 0));
      const changed = next !== catalogAmount;
      catalogAmount = next;
      catalogMoving = Boolean(moving);
      if (!changed) return;
      placeFallback();
      if (pageActive && visible && !document.hidden && (paused || loading || !frame)) draw();
      start();
    },
    // The entrance's own layers follow the camera's fixed point and zoom.
    introView: amount => (blackHole?.ready && !blackHole.lost ? blackHole.introView?.(amount) ?? null : null),
    // The entrance reads the renderer's measurements without polling or
    // disturbing its adaptive window. A pending fence proves only a lower bound.
    introPerformance() {
      if (!pageActive || !blackHole?.ready || blackHole.lost || blackHole.disposed) return null;
      return {
        measured: Boolean(blackHole.webgl2 || blackHole.timerQuery),
        quality: blackHole.quality,
        frameInterval: blackHole.getFrameInterval?.(true) ?? blackHole.frameInterval,
        gpuTimes: blackHole.gpuTimes?.slice() || [],
        gpuPending: blackHole.webgl2 && blackHole.gpuSync && blackHole.gpuTimingValid ? blackHole.gpuWaitMs : null,
      };
    },
    live: () => Boolean(blackHole?.ready && !blackHole.lost),
    // On the hero the day/night switch can draw its beam inside the live
    // scene, behind the disk's near side and bent round the hole. beamReady
    // tells whether that is possible now. beam draws one frame with the given
    // shape at once and reports whether it was drawn, so the page's own clip
    // moves only in step with the scene; null ends the beam.
    beamReady: () => Boolean(pageActive && visible && !document.hidden && !paused && chapterProgress === 0
      && blackHoleStyle === 'minimal' && blackHole?.ready && !blackHole.lost && blackHole.beamPrograms),
    // The switch asks for the beam's shaders up front; they compile once the
    // scene has drawn its first frame, well before anyone can reach the switch.
    prepareBeam: () => scenePreparation.then(ready => Boolean(ready && pageActive && blackHoleStyle === 'minimal'
      && blackHole?.prepareBeam?.())),
    beam(shape) {
      if (!shape) {
        if (!beaming) return false;
        beaming = false;
        blackHole?.setBeam?.(null);
        if (pageActive && visible && !document.hidden) draw();
        start();
        return true;
      }
      if (!pageActive || document.hidden || !blackHole?.ready || blackHole.lost || !blackHole.setBeam?.(shape)) return false;
      beaming = true;
      return draw() === true;
    },
  };


  window.addEventListener('site:theme', () => {
    blackHole?.setDay?.(isDay() ? 1 : 0);
    // Refresh the fallback artwork, then leave ink for day mode if needed.
    blackHoleStyle = blackHoleTheme?.apply(blackHoleStyle) || blackHoleStyle;
    updateBlackHoleTheme();
    if (pageActive && visible && !document.hidden && (paused || !frame)) draw();
  });

  window.addEventListener('site:chapter', event => {
    chapterProgress = Math.max(0, Math.min(1, Number(event.detail?.progress) || 0));
    // The black sphere is the day/night switch on the hero only. The chapters
    // move the hole away from it and use the header's toggle.
    if (sphereSwitch && sphereSwitch.hidden !== chapterProgress > 0) sphereSwitch.hidden = chapterProgress > 0;
    // The hero's scroll cue has done its job once the visitor has left the
    // hero; a restored pixel of scroll is still the hero.
    if (chapterProgress > 0.01) hero.classList.add('is-scrolled');
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
  gpuStars?.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    starField = null;
    if (pageActive && !document.hidden) drawSky(sceneTime());
  });
  gpuStars?.addEventListener('webglcontextrestored', () => {
    starField = undefined;
    if (pageActive && !document.hidden) drawSky(sceneTime());
  });
  blackHoleCanvas?.addEventListener('webglcontextlost', () => {
    sceneContextLost = true;
    stop();
    settleScene(false);
    if (pageActive && !document.hidden) drawSky(sceneTime());
  });
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
  window.SiteLoader?.ready({ scene: scenePreparation, compiled: sceneCompiled });
})();
