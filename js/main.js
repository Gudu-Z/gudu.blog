(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  const stars = document.querySelector('#starfield');
  const context = stars.getContext('2d');
  const blackHoleCanvas = document.querySelector('#black-hole-canvas');
  let blackHole = null;
  try {
    if (blackHoleCanvas && window.BlackHole) blackHole = new window.BlackHole(blackHoleCanvas);
  } catch (error) {
    console.warn('Using the static black-hole illustration.', error);
  }
  const layers = [...document.querySelectorAll('[data-depth]')];
  const clock = document.querySelector('#local-time');
  const clockDate = clock.querySelector('[data-clock-date]');
  const clockTime = clock.querySelector('[data-clock-time]');
  const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  clock.title = clockFormatter.resolvedOptions().timeZone;
  let clockTimer = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(pointer: fine)');
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let paused = reducedMotion.matches;
  let loading = document.documentElement.classList.contains('is-loading');
  let visible = true;
  let frame = 0;
  let lastTime = 0;
  let lastRender = 0;
  let elapsed = 12;
  let width = 0;
  let height = 0;
  let starList = [];

  function finishIntro() { hero.classList.add('intro-complete'); }
  window.addEventListener('site:revealed', () => { loading = false; start(); });
  if (reducedMotion.matches) finishIntro();
  hero.addEventListener('animationend', event => {
    if (event.animationName === 'title-period-enter') finishIntro();
  });

  // Read the actual wall clock every second, independently of visual animation.
  function updateClock() {
    clearTimeout(clockTimer);
    const now = new Date();
    const parts = Object.fromEntries(clockFormatter.formatToParts(now).map(part => [part.type, part.value]));
    clock.dateTime = now.toISOString();
    clockDate.textContent = `${parts.year}.${parts.month}.${parts.day}`;
    clockTime.textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
    clock.setAttribute('aria-label', `当前本地时间：${clockFormatter.format(now)}`);
    if (!document.hidden) clockTimer = setTimeout(updateClock, 1005 - now.getMilliseconds());
  }

  function stopClock() { clearTimeout(clockTimer); }

  // Seeded positions stay in place when the viewport is resized.
  function random(seed) {
    const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function resize() {
    const bounds = hero.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    stars.width = Math.round(width * dpr);
    stars.height = Math.round(height * dpr);
    context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The shader owns the lensed background; these few dim points fill its edges.
    starList = Array.from({ length: Math.round(width * height / 24000) }, (_, i) => ({
      x: random(i * 5 + 1) * width,
      y: random(i * 5 + 2) * height,
      radius: 0.35 + random(i * 5 + 3) * 0.65,
      light: 0.04 + random(i * 5 + 4) * 0.12,
      depth: 0.2 + random(i * 5 + 5) * 1.2,
    }));
    blackHole?.resize();
    draw();
  }

  function drawStars() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const star of starList) {
      const x = star.x + pointer.x * star.depth * 13;
      const y = star.y + pointer.y * star.depth * 10;
      context.fillStyle = `rgba(193,204,223,${star.light})`;
      context.beginPath();
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  function draw() {
    drawStars();
    for (const layer of layers) {
      const depth = Number(layer.dataset.depth);
      layer.style.setProperty('--pointer-x', `${-pointer.x * depth * 8}px`);
      layer.style.setProperty('--pointer-y', `${-pointer.y * depth * 6}px`);
    }
    blackHole?.render(elapsed, pointer.x, -pointer.y);
  }

  function tick(timestamp) {
    frame = 0;
    if (loading || paused || !visible || document.hidden) { lastTime = 0; return; }
    const delta = lastTime ? Math.min(timestamp - lastTime, 100) : 16;
    lastTime = timestamp;
    elapsed += delta / 1000;
    const ease = 1 - Math.exp(-delta * 0.005);
    pointer.x += (pointer.targetX - pointer.x) * ease;
    pointer.y += (pointer.targetY - pointer.y) * ease;
    const settled = Math.abs(pointer.targetX - pointer.x) < 0.001 && Math.abs(pointer.targetY - pointer.y) < 0.001;
    if (settled) {
      pointer.x = pointer.targetX;
      pointer.y = pointer.targetY;
    }
    const animated = blackHole?.ready && !blackHole.lost;
    if (timestamp - lastRender >= 30 || (!animated && settled)) {
      draw();
      if (animated) blackHole.sampleFrame(timestamp);
      lastRender = timestamp;
    }
    // Visible WebGL keeps the disk flowing at about 30 fps; the fallback rests.
    if (animated || !settled) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function start() {
    if (frame || loading || paused || !visible || document.hidden) return;
    const animated = blackHole?.ready && !blackHole.lost;
    if (!animated && pointer.x === pointer.targetX && pointer.y === pointer.targetY) return;
    lastTime = 0;
    lastRender = 0;
    blackHole?.resetTiming();
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }

  function updateMotion() {
    hero.dataset.motion = paused ? 'paused' : 'playing';
    if (paused) stop(); else start();
  }

  hero.addEventListener('pointermove', event => {
    if (loading || paused || !finePointer.matches || event.pointerType === 'touch') return;
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
    if (document.hidden) { stop(); stopClock(); finishIntro(); }
    else { start(); updateClock(); }
  });
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) start(); else stop();
  }).observe(hero);
  if (blackHole) blackHole.onRestore = () => { draw(); start(); };
  new ResizeObserver(resize).observe(hero);
  window.addEventListener('pagehide', () => { stop(); stopClock(); finishIntro(); });
  window.addEventListener('pageshow', () => { start(); updateClock(); });
  // Resize and submit a real scene frame before the loader checks .is-ready.
  // This also supplies the static frame used with reduced motion enabled.
  resize();
  updateMotion();
  updateClock();
  window.SiteLoader?.ready();
})();
