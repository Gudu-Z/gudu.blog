/* The home page's full entrance. As the loader's curtain lifts (js/loading.js)
 * the page shows stars alone, the camera pulls back until the black hole sits
 * in its hero composition, and the title is typed in behind its own cursor.
 * The stars are the hero's own sky (js/main.js), magnified with the camera, so
 * the entrance ends on the sky the page keeps.
 * It plays once per browser session, and again whenever the visitor reloads
 * the page themselves. Coming back to the page within the session, a device
 * without the live scene, a slow GPU and reduced motion keep the short CSS entrance, which
 * needs no script; if anything here fails the page falls back to that same
 * settled state.
 * ?intro=slow plays it at a fifth of its speed, ?intro=full replays it, and
 * ?intro=short forces the short entrance.
 */
(() => {
  'use strict';
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hero = document.querySelector('.hero');
  const requested = new URLSearchParams(window.location.search).get('intro');
  const slow = requested === 'slow' ? 5 : 1;
  const forcedFull = requested === 'slow' || requested === 'full';
  let seen = false;
  // A blocked store simply plays the full entrance on every visit.
  try { seen = window.sessionStorage.getItem('gudu-intro') === 'seen'; } catch { seen = false; }
  // A reload is the visitor asking for the page afresh; following a link back
  // to it, or stepping back through history, is not.
  const reloaded = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  const wanted = requested === 'short' ? false : forcedFull || !seen || reloaded;
  // Only a page still behind its loader can open on the starting sky.
  if (!hero || !wanted || reducedMotion.matches || !window.SiteBlackHole?.intro
      || !root.classList.contains('is-loading') || root.classList.contains('is-loading-exit')) return;

  // Milliseconds after the curtain starts to lift, before --intro-slow.
  const PULL_FROM = 460, PULL_TO = 1700;
  const TYPE_FROM = 1180, TYPE_FIRST = 110, TYPE_STEP = 106;
  const CLOCK_FROM = 1260, CLOCK_TO = 1800;
  const END = 1900;
  // Match the renderer's measured quality floor and its 30 fps motion budget.
  const MIN_QUALITY = 0.6, FRAME_BUDGET = 1000 / 30;
  // Any of these skips straight to the settled hero.
  const INPUTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
  // The hero is still the hero within a few pixels of the top, as the chapters
  // themselves treat it: a refresh restores the page's last scroll offset, and
  // a stray pixel of it must not cancel the entrance.
  const HERO_PROGRESS = 0.01, HERO_SCROLL = 8;

  const scene = window.SiteBlackHole;
  const frameLayer = document.querySelector('.intro-frame');
  const grid = hero.querySelector('.space-grid');
  const second = hero.querySelector('.title-second-content');
  const period = hero.querySelector('.title-period');
  const clock = hero.querySelector('#local-time');
  const clockDate = clock?.querySelector('[data-clock-date]');
  const clockTime = clock?.querySelector('[data-clock-time]');
  // The same local wall clock, written the same way, as js/main.js.
  const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let armed = true;
  let playing = false;
  let chapter = 0;
  let startedAt = 0;
  let frame = 0;
  let watchdog = 0;
  let titleText = null;
  let glyphs = [];
  let stops = null;
  let typed = -1;
  let clockSettled = false;
  let measured = false;
  let decided = false;
  const listeners = [];

  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  }

  function shouldShorten(time) {
    if (forcedFull) return false;
    const timing = scene.introPerformance?.();
    // Older scenes without timing keep their existing entrance behavior.
    if (!timing) return false;
    if (timing.frameInterval > FRAME_BUDGET) return true;
    if (!timing.measured) return false;
    const costs = timing.gpuTimes.filter(cost => Number.isFinite(cost) && cost >= 0);
    // Three completed frames establish a window; repeated reads of the same
    // frame do not add evidence. Keep that evidence when adaptation drains it.
    if (costs.length >= 3) measured = true;
    // An unfinished fence can prove overload, but cannot prove headroom.
    if (Number.isFinite(timing.gpuPending) && timing.gpuPending >= 0) costs.push(timing.gpuPending);
    if (costs.length >= 3) {
      const recent = costs.slice(-3).sort((a, b) => a - b);
      // The renderer scales pixel work by area. Even this optimistic estimate
      // must fit 30 fps at its floor; a lone expensive frame is not sustained load.
      const floorCost = recent[1] * (MIN_QUALITY / timing.quality) ** 2;
      if (floorCost > FRAME_BUDGET) return true;
    }
    // A very slow or stalled timed scene may not finish three frames in the
    // sky hold. Do not start moving an unproven camera after that deadline.
    return time >= PULL_FROM && !measured;
  }

  function bezier(x1, y1, x2, y2) {
    const curve = (a, b, t) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let low = 0, high = 1;
      for (let i = 0; i < 22; i++) {
        const middle = (low + high) / 2;
        if (curve(x1, x2, middle) < x) low = middle; else high = middle;
      }
      return curve(y1, y2, (low + high) / 2);
    };
  }
  // A short push, then a long settle as the hole reaches its place.
  const pull = bezier(0.32, 0, 0.14, 1);

  function layout() {
    // Without the scene's camera there is no opening sky to pull back from.
    if (!scene.introView?.(1)) return false;
    // The corner marks open out to the hero's own frame, kept on screen.
    if (frameLayer && grid) {
      const edge = grid.getBoundingClientRect();
      const bottom = Math.min(edge.bottom, (frameLayer.clientHeight || window.innerHeight) - 24);
      for (const [name, value] of [['left', edge.left], ['top', edge.top], ['right', edge.right], ['bottom', bottom]]) {
        frameLayer.style.setProperty(`--page-${name}`, `${value}px`);
      }
    }
    measureTitle();
    return true;
  }

  // The second title line is typed: each character sits in its own span for
  // the entrance, shown once the cursor has passed it, so the line keeps its
  // full text and layout throughout. The original text node returns after.
  function splitTitle() {
    const text = second && [...second.childNodes].find(node => node.nodeType === 3 && node.nodeValue.trim());
    if (!text || !period) return;
    titleText = text;
    glyphs = Array.from(text.nodeValue, character => {
      const glyph = document.createElement('span');
      glyph.textContent = character;
      glyph.style.opacity = '0';
      return glyph;
    });
    text.replaceWith(...glyphs);
  }

  function restoreTitle() {
    if (!titleText) return;
    glyphs[0]?.before(titleText);
    for (const glyph of glyphs) glyph.remove();
    glyphs = [];
    titleText = null;
  }

  // Where the cursor rests before each character and after the last.
  function measureTitle() {
    stops = null;
    if (!glyphs.length) return;
    const left = second.getBoundingClientRect().left;
    stops = glyphs.map(glyph => glyph.getBoundingClientRect().left - left);
    stops.push(glyphs[glyphs.length - 1].getBoundingClientRect().right - left);
    // A new layout keeps the cursor after the same character.
    const count = typed;
    typed = -1;
    if (count >= 0) type(count);
  }

  function type(count) {
    if (!stops || count === typed) return;
    typed = count;
    glyphs.forEach((glyph, index) => { glyph.style.opacity = index < count ? '' : '0'; });
    period.style.transform = `translate3d(${stops[Math.min(count, glyphs.length)] - stops[glyphs.length]}px, 0, 0)`;
    // The line stays clipped away until its cursor first appears.
    second.style.clipPath = 'none';
  }

  function clockText() {
    const parts = Object.fromEntries(clockFormatter.formatToParts(new Date()).map(part => [part.type, part.value]));
    return [`${parts.year}.${parts.month}.${parts.day}`, `${parts.hour}:${parts.minute}:${parts.second}`];
  }

  // Digits spin until each locks, left to right, onto the real time.
  function rollClock(time) {
    if (!clockDate || !clockTime || clockSettled) return;
    const [date, clockNow] = clockText();
    if (time >= CLOCK_TO) {
      clockSettled = true;
      clockDate.textContent = date;
      clockTime.textContent = clockNow;
      return;
    }
    const total = (date + clockNow).replace(/\D/g, '').length;
    const beat = Math.floor(time / 48);
    let index = 0;
    const spin = text => text.replace(/\d/g, digit => {
      const lockAt = CLOCK_FROM + 150 + (CLOCK_TO - CLOCK_FROM - 200) * (index / Math.max(1, total - 1));
      const position = index++;
      if (time >= lockAt) return digit;
      const noise = Math.sin((position + 1) * 12.9898 + beat * 78.233) * 43758.5453;
      return String(Math.floor((noise - Math.floor(noise)) * 10));
    });
    clockDate.textContent = spin(date);
    clockTime.textContent = spin(clockNow);
  }

  function render(time) {
    const progress = Math.max(0, Math.min(1, (time - PULL_FROM) / (PULL_TO - PULL_FROM)));
    const amount = 1 - pull(progress);
    // The scene and the hero's sky both follow this camera.
    scene.intro(amount, progress > 0 && progress < 1);
    if (time >= TYPE_FROM) {
      if (stops) type(Math.max(0, Math.min(glyphs.length, 1 + Math.floor((time - TYPE_FROM - TYPE_FIRST) / TYPE_STEP))));
      // A line that could not be split simply appears.
      else if (second) second.style.clipPath = 'none';
    }
    if (time >= CLOCK_FROM) rollClock(time);
  }

  function tick(now) {
    frame = 0;
    if (!playing) return;
    const time = (now - startedAt) / slow;
    try {
      // A lost or retired scene has no camera left to move.
      if (time >= END || !scene.live?.()) { finish(); return; }
      // Decide before the first moving frame, even if this tick arrived late.
      // Once movement starts, later load cannot jump the camera home.
      if (!decided) {
        if (shouldShorten(time)) { finish({ short: true }); return; }
        if (time >= PULL_FROM) {
          decided = true;
          try { window.sessionStorage.setItem('gudu-intro', 'seen'); } catch { /* A blocked store plays again next visit. */ }
        }
      }
      render(time);
    } catch (error) { fail(error); return; }
    frame = requestAnimationFrame(tick);
  }

  // Every way out lands on the settled hero: a finished entrance, any input,
  // a hidden or leaving page, reduced motion, or an error.
  function finish({ short = false } = {}) {
    if (!playing && !armed) return;
    const complete = playing && !short;
    armed = playing = false;
    cancelAnimationFrame(frame);
    clearTimeout(watchdog);
    frame = watchdog = 0;
    for (const remove of listeners.splice(0)) remove();
    // The page's own content first: nothing below can leave the title split.
    restoreTitle();
    for (const [node, property] of [[second, 'clipPath'], [period, 'transform']]) {
      if (!node) continue;
      node.style[property] = '';
      // Leave the markup as it was written, without an emptied attribute.
      if (node.getAttribute?.('style') === '') node.removeAttribute('style');
    }
    if (clockDate && clockTime && !clockSettled) [clockDate.textContent, clockTime.textContent] = clockText();
    clockSettled = true;
    root.classList.remove('is-intro');
    root.style.removeProperty('--intro-slow');
    for (const name of ['left', 'top', 'right', 'bottom']) frameLayer?.style.removeProperty(`--page-${name}`);
    if (frameLayer?.getAttribute?.('style') === '') frameLayer.removeAttribute('style');
    // js/main.js returns the camera as well when it hears the entrance end.
    try { scene.intro(0); } catch (error) { console.warn('The entrance camera could not be reset.', error); }
    // Keeping has-site-intro lets the short CSS fade hide the camera reset.
    // Its title-period animation, rather than this event, will finish it.
    if (complete) window.dispatchEvent(new Event('site:intro-complete'));
  }

  function fail(error) {
    finish();
    console.warn('The page entrance stopped early.', error);
  }

  // A release without an animated exit returns the camera before it is shown.
  function disarm() {
    if (!armed) return;
    finish({ short: true });
  }

  function begin() {
    if (!armed) return;
    // The opening sky needs the live scene, on the hero, at the top of the
    // page: a link straight to a chapter is about to leave the hero.
    const hash = window.location.hash || '';
    try {
      if (document.hidden || reducedMotion.matches || chapter > HERO_PROGRESS || window.scrollY > HERO_SCROLL
          || (hash.length > 1 && hash !== '#home') || !scene.live?.() || shouldShorten(0)) {
        disarm();
        return;
      }
      armed = false;
      playing = true;
      startedAt = performance.now();
      // The title is measured as the full entrance lays it out.
      if (slow !== 1) root.style.setProperty('--intro-slow', String(slow));
      root.classList.add('is-intro');
      splitTitle();
      if (!layout()) { finish({ short: true }); return; }
      for (const input of INPUTS) listen(window, input, finish, { capture: true, passive: true });
      // A throttled or stalled frame loop cannot hold the page on its entrance.
      watchdog = setTimeout(finish, (END + 1500) * slow);
      render(0);
      frame = requestAnimationFrame(tick);
    } catch (error) {
      fail(error);
    }
  }

  listen(window, 'site:revealing', begin);
  // Released without an animated exit: no entrance follows.
  listen(window, 'site:revealed', disarm);
  listen(window, 'site:chapter', event => {
    chapter = Math.max(0, Math.min(1, Number(event.detail?.progress) || 0));
    if (chapter > HERO_PROGRESS) finish();
  });
  listen(window, 'site:theme', finish);
  listen(window, 'scroll', () => { if (window.scrollY > HERO_SCROLL) finish(); }, { passive: true });
  listen(window, 'resize', () => {
    try { if (playing && !layout()) finish(); } catch (error) { fail(error); }
  });
  listen(window, 'pagehide', finish);
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  listen(reducedMotion, 'change', () => { if (reducedMotion.matches) finish(); });

  // The scene's first frame, drawn behind the loader, already frames that sky.
  try { scene.intro(1); } catch (error) { fail(error); }
})();
