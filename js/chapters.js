(() => {
  'use strict';

  const root = document.documentElement;
  const hero = document.querySelector('.hero');
  const stage = document.querySelector('#hero-stage');
  const runway = document.querySelector('#chapter-scroll');
  const viewport = document.querySelector('#chapter-viewport');
  const track = document.querySelector('#chapter-track');
  const chapters = [...document.querySelectorAll('.chapter-section')];
  if (!hero || !stage || !runway || !viewport || !track || !chapters.length) return;

  const sections = [hero, ...chapters];
  const header = document.querySelector('.site-header');
  const progressNav = document.querySelector('.chapter-progress');
  const progressMarker = document.querySelector('.chapter-progress-marker');
  const currentLabel = document.querySelector('[data-chapter-current]');
  const links = [...document.querySelectorAll('[data-chapter-link]')];
  const heroText = [...stage.querySelectorAll('.hero-heading')];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let positions = [];
  let panelBounds = [];
  let entry = 0;
  let width = 0;
  let travel = 0;
  let maximum = 0;
  let targetY = 0;
  let smoothY = 0;
  let frame = 0;
  let updateFrame = 0;
  let lastFrame = 0;
  let active = true;
  let initialized = false;
  let transition = null;
  let lastWheel = -Infinity;
  let entryGesture = false;
  let touch = null;
  let lastProgress = -1;
  let transitionPhase = 0;
  let entranceGlow = 0;
  let lastEntranceGlow = -1;
  let currentIndex = -1;
  let measuring = false;
  let lastIndicatorX = null;
  let movingTimer = 0;
  let arrivalTimer = 0;
  let arrivingLink = null;
  let idleTimer = 0;
  let lastIdleActivity = performance.now();
  let touching = false;
  let suspendedPosition = null;
  let pendingHash = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const y = () => window.scrollY || 0;
  const available = () => active && !document.hidden;
  const position = () => y() >= entry ? 1 + (y() - entry) / Math.max(width, 1) : y() / Math.max(entry, 1);
  const blocked = () => root.classList.contains('is-loading') || document.body.dataset.menuOpen === 'true';
  const interactive = target => target?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="slider"]');

  function writeHash(index, mode = 'replace') {
    const url = new URL(window.location.href);
    url.hash = sections[index].id;
    if (url.href !== window.location.href) {
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url);
    }
  }

  function clearArrival() {
    clearTimeout(arrivalTimer);
    arrivalTimer = 0;
    arrivingLink?.classList.remove('is-arriving');
    arrivingLink = null;
    progressMarker?.classList.remove('is-arriving');
  }

  function clearProgressFeedback() {
    clearTimeout(movingTimer);
    movingTimer = 0;
    progressNav?.classList.remove('is-chapter-moving');
    clearArrival();
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    progressNav?.classList.remove('is-chapter-idle');
  }

  function noteIdleActivity() {
    lastIdleActivity = performance.now();
    clearIdle();
  }

  function canIdle() {
    return progressNav && active && initialized && !document.hidden && !motion.matches
      && !blocked() && !frame && !lastFrame && !transition && !touching && y() >= entry - 1;
  }

  function scheduleIdle() {
    if (!canIdle()) { clearIdle(); return; }
    if (idleTimer || progressNav.classList.contains('is-chapter-idle')) return;
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (canIdle()) progressNav.classList.add('is-chapter-idle');
    }, Math.max(0, 1000 - (performance.now() - lastIdleActivity)));
  }

  function emitChapterState(progress = clamp(y() / Math.max(1, entry), 0, 1)) {
    if (progress === lastProgress && entranceGlow === lastEntranceGlow) return;
    lastProgress = progress;
    lastEntranceGlow = entranceGlow;
    window.dispatchEvent(new CustomEvent('site:chapter', { detail: { progress, entranceGlow } }));
  }

  function setTransitionPhase(phase, direction, pulseEnabled = false) {
    transitionPhase = phase;
    root.style.setProperty('--chapter-transition-phase', phase.toFixed(4));
    const pulse = (phase - 0.18) / 0.6;
    entranceGlow = pulseEnabled && direction === 'entering' && pulse > 0 && pulse < 1
      ? Math.sin(Math.PI * pulse) ** 2 : 0;
    root.style.setProperty('--chapter-entrance-glow', entranceGlow.toFixed(5));
  }

  function updateProgressFeedback(x, visible, changed, index) {
    const moved = lastIndicatorX !== null && Math.abs(x - lastIndicatorX) > 0.01;
    lastIndicatorX = x;
    if (!progressNav || !initialized || !visible || motion.matches || document.hidden || transition?.direction) {
      clearProgressFeedback();
      return;
    }
    if (moved) {
      progressNav.classList.add('is-chapter-moving');
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => {
        movingTimer = 0;
        progressNav.classList.remove('is-chapter-moving');
      }, 140);
    }
    if (changed && index > 0) {
      clearArrival();
      arrivingLink = links.find(link => link.hash === `#${sections[index].id}`) || null;
      arrivingLink?.classList.add('is-arriving');
      progressMarker?.classList.add('is-arriving');
      arrivalTimer = setTimeout(clearArrival, 400);
    }
  }

  function update(syncHash = true) {
    if (!active || !positions.length) return;
    const scroll = y();
    const progress = clamp(scroll / Math.max(1, entry), 0, 1);
    const x = clamp(scroll - entry, 0, travel);
    const chapterPosition = x / Math.max(width, 1);
    const siteProgress = travel ? x / travel : 0;
    const visible = progress > 0.55;
    root.style.setProperty('--chapter-progress', progress.toFixed(4));
    root.style.setProperty('--chapter-x', `${-x.toFixed(3)}px`);
    root.style.setProperty('--chapter-position', chapterPosition.toFixed(5));
    root.style.setProperty('--site-progress', siteProgress.toFixed(5));
    root.classList.toggle('is-content', visible);
    if (header) header.inert = !visible;
    if (progressNav) progressNav.inert = !visible;
    for (const element of heroText) element.inert = progress > 0.12;
    // Offscreen panels cannot take keyboard focus and scroll the clipping box.
    chapters.forEach((chapter, index) => {
      const bounds = panelBounds[index];
      chapter.inert = !visible || bounds.left + bounds.width - x <= 1 || bounds.left - x >= window.innerWidth - 1;
    });
    emitChapterState(progress);
    const index = visible ? Math.min(chapters.length, 1 + Math.round(x / Math.max(width, 1))) : 0;
    root.style.setProperty('--chapter-active-index', String(clamp(index - 1, 0, chapters.length - 1)));
    const changed = index !== currentIndex;
    if (changed) {
      currentIndex = index;
      if (currentLabel) currentLabel.textContent = String(Math.max(index, 1)).padStart(2, '0');
      for (const link of links) {
        if (link.hash === `#${sections[index].id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
    updateProgressFeedback(x, visible, changed, index);
    scheduleIdle();
    if (syncHash && initialized && !transition && (scroll >= entry - 1 || scroll <= 1)) writeHash(index);
  }

  function measure() {
    if (!available() || measuring) return;
    measuring = true;
    // Read the actual panel stride, including the fixed gap between chapters.
    width = chapters.length > 1
      ? chapters[1].offsetLeft - chapters[0].offsetLeft
      : chapters[0].offsetWidth;
    width = Math.max(width, 1);
    panelBounds = chapters.map(chapter => ({ left: chapter.offsetLeft, width: chapter.offsetWidth }));
    entry = runway.getBoundingClientRect().top + y();
    travel = width * (chapters.length - 1);
    const runwayHeight = `${window.innerHeight + travel}px`;
    if (runway.style.height !== runwayHeight) runway.style.height = runwayHeight;
    positions = [0, ...chapters.map((_, index) => entry + index * width)];
    maximum = entry + travel;
    const figure = document.querySelector('#black-hole')?.getBoundingClientRect();
    const scene = stage.getBoundingClientRect();
    if (figure) {
      root.style.setProperty('--fallback-shift-x', `${scene.left + scene.width / 2 - figure.left - figure.width / 2}px`);
      root.style.setProperty('--fallback-shift-y', `${scene.top + scene.height / 2 - figure.top - figure.height / 2}px`);
    }
    targetY = clamp(frame ? targetY : y(), 0, maximum);
    measuring = false;
    update(false);
  }

  function queueUpdate() {
    if (available() && !updateFrame) updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      if (available()) update();
    });
  }

  function stop() {
    noteIdleActivity();
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
    transition = null;
    targetY = y();
    smoothY = targetY;
    root.classList.remove('is-chapter-transitioning', 'is-chapter-entering', 'is-chapter-leaving');
    setTransitionPhase(0);
    emitChapterState();
  }

  function setScroll(top) {
    window.scrollTo({ top, behavior: 'instant' });
    update();
  }

  function focusSection(index) {
    const target = sections[index];
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  function goTo(index, { historyMode = 'push', focus = false, instant = false, entrance = false } = {}) {
    if (!available() || index < 0 || index >= sections.length) return;
    const previousDirection = transition?.direction;
    const previousPhase = transitionPhase;
    stop();
    measure();
    if (historyMode) writeHash(index, historyMode);
    const start = y();
    const destination = positions[index];
    const started = performance.now();
    entrance = entrance || index === 0 || (start < entry - 2 && index > 0);
    const direction = index === 0 && (start > 1 || previousDirection) ? 'leaving'
      : index > 0 && (start < entry - 2 || previousDirection) ? 'entering' : null;
    entrance = entrance || Boolean(direction);
    // Both CSS directions share one visual coordinate. Preserve it when a new
    // destination interrupts the layered transition, including a quick reversal.
    const phaseStart = direction && previousDirection
      ? direction === previousDirection ? previousPhase : 1 - previousPhase : 0;
    const pulseEnabled = direction === 'entering' && !previousDirection && start <= 1;
    targetY = destination;
    transition = { index, destination, focus, entrance, direction };
    clearIdle();
    const finish = () => {
      setScroll(destination);
      stop();
      update(false);
      if (focus) focusSection(index);
    };
    if (instant || motion.matches || document.hidden || (!previousDirection && Math.abs(start - destination) < 1)) { finish(); return; }
    root.classList.add('is-chapter-transitioning');
    if (direction) {
      setTransitionPhase(phaseStart, direction, pulseEnabled);
      root.classList.add(`is-chapter-${direction}`);
      clearProgressFeedback();
      emitChapterState();
    }
    const duration = Math.max(1, Math.round((direction === 'entering' ? 900 : direction === 'leaving' ? 680 : 640) * (1 - phaseStart)));
    function step(now) {
      if (!available() || !transition) return;
      const t = clamp((now - started) / duration, 0, 1);
      if (direction) setTransitionPhase(phaseStart + (1 - phaseStart) * t, direction, pulseEnabled);
      setScroll(start + (destination - start) * (1 - Math.pow(1 - t, 4)));
      if (t < 1) frame = requestAnimationFrame(step);
      else finish();
    }
    frame = requestAnimationFrame(step);
  }

  function smoothTick(now) {
    frame = 0;
    if (!available()) return;
    const elapsed = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    // Keep subpixel state: browsers can round scrollY to whole CSS pixels.
    const next = smoothY + (targetY - smoothY) * (1 - Math.exp(-elapsed / 85));
    smoothY = next;
    if (Math.abs(targetY - next) < 0.6) {
      setScroll(targetY);
      lastFrame = 0;
      scheduleIdle();
    } else {
      setScroll(next);
      frame = requestAnimationFrame(smoothTick);
    }
  }

  function advance(delta) {
    // Only the boundary around the hero snaps; the content rail stays continuous.
    const intended = frame && !transition ? targetY : y();
    if (delta < 0 && intended + delta < entry - 2) {
      goTo(0, { historyMode: 'replace', entrance: true });
      return true;
    }
    if (transition) stop();
    if (!frame) smoothY = y();
    // Add to the intended position so quick wheel events retain their distance.
    targetY = clamp((frame ? targetY : y()) + delta, 0, maximum);
    if (motion.matches) { setScroll(targetY); return; }
    if (!frame) frame = requestAnimationFrame(smoothTick);
    return false;
  }

  function scrollableChapter(target, direction, keyboard = false) {
    const chapter = target?.closest?.('.chapter-section') || (keyboard ? chapters[Math.max(0, currentIndex - 1)] : null);
    if (!chapter || chapter.inert) return null;
    const bottom = chapter.scrollHeight - chapter.clientHeight;
    return bottom > 2 && (direction > 0 ? chapter.scrollTop < bottom - 2 : chapter.scrollTop > 2) ? chapter : null;
  }

  window.addEventListener('wheel', event => {
    if (!available()) return;
    noteIdleActivity();
    scheduleIdle();
    if (!active || blocked() || event.ctrlKey || event.metaKey || interactive(event.target)) return;
    const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    const raw = vertical ? event.deltaY : event.deltaX;
    if (!raw) return;
    const delta = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
    const now = performance.now();
    const sameGesture = now - lastWheel < 220;
    lastWheel = now;
    // Entering and leaving the hero are discrete. Ignore that gesture's tail.
    if (transition?.entrance || (entryGesture && sameGesture)) {
      event.preventDefault();
      entryGesture = true;
      return;
    }
    entryGesture = false;
    if (y() < entry - 2 && delta > 0) {
      event.preventDefault();
      entryGesture = true;
      goTo(1, { historyMode: 'replace', entrance: true });
      return;
    }
    if (vertical && scrollableChapter(event.target, Math.sign(delta))) {
      stop();
      scheduleIdle();
      return;
    }
    event.preventDefault();
    if (advance(delta)) entryGesture = true;
  }, { passive: false });

  document.addEventListener('keydown', event => {
    if (!available()) return;
    if (['Home', 'End', 'ArrowDown', 'ArrowRight', 'PageDown', 'Space', 'ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.code)) {
      noteIdleActivity();
      scheduleIdle();
    }
    if (!active || event.defaultPrevented || blocked() || interactive(event.target)
        || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space' && event.target?.closest?.('a')) return;
    if (event.code === 'Home' || event.code === 'End') {
      event.preventDefault();
      goTo(event.code === 'Home' ? 0 : sections.length - 1, { focus: true });
      return;
    }
    const directions = { ArrowDown: 1, ArrowRight: 1, PageDown: 1, Space: event.shiftKey ? -1 : 1, ArrowUp: -1, ArrowLeft: -1, PageUp: -1 };
    const direction = directions[event.code];
    if (!direction) return;
    event.preventDefault();
    if (transition?.entrance || (event.repeat && entryGesture)) return;
    entryGesture = false;
    if (y() < entry - 2 && direction > 0) {
      if (!event.repeat) goTo(1, { focus: true, entrance: true });
      return;
    }
    const distance = event.code.startsWith('Arrow') ? 100 : width * 0.6;
    const vertical = !['ArrowLeft', 'ArrowRight'].includes(event.code);
    const inside = vertical && scrollableChapter(event.target, direction, true);
    if (inside) {
      stop();
      const readingDistance = event.code.startsWith('Arrow') ? 100 : inside.clientHeight * 0.65;
      inside.scrollBy({ top: direction * readingDistance, behavior: motion.matches ? 'instant' : 'smooth' });
      scheduleIdle();
    } else if (advance(direction * distance)) entryGesture = true;
  });

  window.addEventListener('touchstart', event => {
    if (!available()) return;
    touching = event.touches.length > 0;
    noteIdleActivity();
    touch = event.touches.length === 1 && !interactive(event.target) && !blocked()
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY, scroll: y(), axis: null, entrance: false, native: false } : null;
    if (touch && !transition?.entrance) stop();
  }, { passive: true });
  window.addEventListener('touchmove', event => {
    if (!available()) return;
    noteIdleActivity();
    if (!active || !touch || blocked() || event.touches.length !== 1) return;
    const dx = touch.x - event.touches[0].clientX;
    const dy = touch.y - event.touches[0].clientY;
    if (touch.entrance || transition?.entrance) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!touch.axis && Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
    if (!touch.axis) {
      touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      touch.native = touch.axis === 'y' && Boolean(scrollableChapter(event.target, Math.sign(dy)));
    }
    if (touch.native || !event.cancelable) return;
    if (touch.scroll < entry - 2 && dy > 0) {
      event.preventDefault();
      touch.entrance = true;
      goTo(1, { historyMode: 'replace', entrance: true });
      return;
    }
    event.preventDefault();
    const destination = clamp(touch.scroll + (touch.axis === 'x' ? dx : dy), 0, maximum);
    if (advance(destination - (frame ? targetY : y()))) touch.entrance = true;
  }, { passive: false });
  const endTouch = event => {
    if (!available()) return;
    touch = null;
    touching = Boolean(event.touches?.length);
    noteIdleActivity();
    scheduleIdle();
  };
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });

  document.addEventListener('click', event => {
    if (!available() || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || link.target === '_blank') return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== window.location.pathname
        || url.search !== window.location.search) return;
    const index = sections.findIndex(section => `#${section.id}` === url.hash);
    if (index < 0) return;
    event.preventDefault();
    goTo(index, { focus: true, entrance: index === 0 || (y() < entry - 2 && index > 0) });
  });

  document.addEventListener('submit', event => {
    if (!available() || blocked() || event.target.id !== 'post-search') return;
    const index = sections.findIndex(section => section.id === 'journal');
    if (index < 0) return;
    event.preventDefault();
    sections[index].scrollTop = 0;
    goTo(index);
  });

  function restoreHash() {
    if (!available()) { pendingHash = true; return; }
    pendingHash = false;
    const index = sections.findIndex(section => `#${section.id}` === window.location.hash);
    if (index >= 0) goTo(index, { historyMode: null, instant: true });
    else { stop(); queueUpdate(); }
  }

  function reflow() {
    if (!available()) return;
    if (!positions.length) { measure(); return; }
    const previousPosition = suspendedPosition ?? position();
    suspendedPosition = null;
    const navigation = transition;
    stop();
    measure();
    if (navigation) {
      goTo(navigation.index, {
        historyMode: null, focus: navigation.focus, entrance: navigation.entrance,
        // A changed viewport finishes the layered entrance instead of replaying it.
        instant: Boolean(navigation.direction),
      });
    } else {
      const destination = previousPosition >= 1 ? entry + (previousPosition - 1) * width : previousPosition * entry;
      if (Math.abs(destination - y()) > 0.5) setScroll(destination);
    }
  }

  function resumeLayout() {
    if (!available()) return;
    const firstMeasure = !positions.length;
    noteIdleActivity();
    if (pendingHash || (firstMeasure && window.location.hash)) {
      suspendedPosition = null;
      measure();
      restoreHash();
    } else reflow();
    layoutObserver.observe(viewport);
    layoutObserver.observe(chapters[0]);
  }

  root.style.setProperty('--chapter-count', String(chapters.length));
  setTransitionPhase(0);
  root.classList.add('has-chapters');
  measure();
  if (window.location.hash) restoreHash();
  initialized = true;
  scheduleIdle();
  window.addEventListener('scroll', () => { if (available()) { noteIdleActivity(); queueUpdate(); } }, { passive: true });
  document.addEventListener('scroll', event => {
    if (!available() || !event.target?.closest?.('.chapter-section')) return;
    noteIdleActivity();
    scheduleIdle();
  }, { passive: true, capture: true });
  window.addEventListener('resize', reflow, { passive: true });
  window.addEventListener('hashchange', restoreHash);
  window.addEventListener('popstate', () => { if (available()) { stop(); queueUpdate(); } });
  window.addEventListener('site:revealed', () => {
    if (!available()) return;
    if (suspendedPosition !== null || !positions.length) { resumeLayout(); return; }
    noteIdleActivity(); measure(); if (window.location.hash) restoreHash();
  });
  window.addEventListener('pageshow', () => { active = true; resumeLayout(); });
  window.addEventListener('pagehide', () => {
    if (!active) return;
    if (positions.length) suspendedPosition = position();
    active = false;
    layoutObserver.disconnect();
    stop();
    clearProgressFeedback();
    cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    touch = null;
    touching = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { resumeLayout(); return; }
    if (!active) return;
    layoutObserver.disconnect();
    const destination = transition?.destination ?? targetY;
    const focusIndex = transition?.focus ? transition.index : null;
    const wasMoving = Boolean(frame || transition);
    stop();
    if (wasMoving) setScroll(destination);
    if (focusIndex !== null) focusSection(focusIndex);
    if (positions.length) suspendedPosition = position();
    clearProgressFeedback();
    cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    touch = null;
    touching = false;
  });
  motion.addEventListener('change', () => {
    if (!available()) return;
    noteIdleActivity();
    if (motion.matches) clearProgressFeedback();
    if (motion.matches && frame) {
      const destination = transition?.destination ?? targetY;
      const focusIndex = transition?.focus ? transition.index : null;
      stop();
      setScroll(destination);
      if (focusIndex !== null) focusSection(focusIndex);
    }
    scheduleIdle();
  });
  const layoutObserver = new ResizeObserver(reflow);
  if (available()) {
    layoutObserver.observe(viewport);
    // Fonts and intrinsic flex layout can settle after the fixed viewport does.
    layoutObserver.observe(chapters[0]);
  }
})();
