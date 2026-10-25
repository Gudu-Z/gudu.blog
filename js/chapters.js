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
  const progressTrack = document.querySelector('.chapter-progress-track');
  const progressMarker = document.querySelector('.chapter-progress-marker');
  const currentLabel = document.querySelector('[data-chapter-current]');
  const links = [...document.querySelectorAll('[data-chapter-link]')];
  const heroText = [...stage.querySelectorAll('.hero-heading')];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const mouseMotion = matchMedia('(hover: hover) and (pointer: fine)');
  let positions = [];
  let panelBounds = [];
  let entry = 0;
  let width = 0;
  let travel = 0;
  let maximum = 0;
  let progressTrackLeft = 0;
  let progressTrackWidth = 0;
  let targetY = 0;
  let smoothY = 0;
  let frame = 0;
  let updateFrame = 0;
  let updatePending = false;
  let pointerTime = 0;
  let pointerPressed = false;
  let pointerInside = false;
  let pointerNavX = 0;
  const pointerLayer = { x: 0, y: 0, targetX: 0, targetY: 0 };
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
  let settingScroll = false;
  let renderedScroll = null;
  let interactionKind = null;
  let scrub = null;
  let scrubFrame = 0;
  let railSeek = null;
  let lastSliderValue = null;
  let lastRevealX = null;
  let lastRevealTime = 0;
  const revealGroups = chapters.map(chapter => ({
    chapter,
    lastScroll: null,
    scrollLimit: 0,
    units: [...chapter.querySelectorAll('.chapter-panel, [data-depth-owner]')]
      .filter(element => element.classList.contains('chapter-panel') || !element.closest('.chapter-panel'))
      .map(element => ({ element, isPanel: element.classList.contains('chapter-panel'), hasParallax: element.classList.contains('chapter-panel') && ['series', 'journal', 'archive'].includes(chapter.id), phase: 'preview', seen: false, exitMinimum: null, exitAxis: 'x', bounds: null, calibrationReady: false, calibrated: false })),
  }));
  const groupsByChapter = new Map(revealGroups.map(group => [group.chapter, group]));
  const revealUnits = revealGroups.flatMap(group => group.units);
  // Outside labels share the spatial plane of the surface they describe;
  // their visibility and text-reveal timing still remain independent.
  const unitsByElement = new Map(revealUnits.map(unit => [unit.element, unit]));
  for (const unit of revealUnits) {
    const ownerId = unit.element.dataset.depthOwner;
    const owner = ownerId ? unitsByElement.get(document.getElementById(ownerId)) : null;
    const compactOwnerId = unit.element.dataset.depthOwnerCompact;
    const compactOwner = compactOwnerId ? unitsByElement.get(document.getElementById(compactOwnerId)) : null;
    unit.wideDepthOwner = !unit.isPanel && owner?.isPanel ? owner : unit;
    unit.compactDepthOwner = !unit.isPanel && compactOwner?.isPanel ? compactOwner : unit.wideDepthOwner;
    unit.depthOwner = unit.wideDepthOwner;
  }
  const calibratingPanels = new Set();
  let revealViewport = { top: 0, bottom: window.innerHeight };
  const chapterLabels = chapters.map((chapter, index) => links[index]?.querySelector('.chapter-station-title')?.textContent.trim() || chapter.id);
  const styleValues = new WeakMap();

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const y = () => window.scrollY || 0;
  const available = () => active && !document.hidden;
  const position = () => y() >= entry ? 1 + (y() - entry) / Math.max(width, 1) : y() / Math.max(entry, 1);
  const blocked = () => root.classList.contains('is-loading') || document.body.dataset.menuOpen === 'true';
  const interactive = target => target?.closest?.('input, textarea, select, button, [contenteditable="true"], [role="slider"]');

  function setStyle(element, name, value) {
    if (!element) return;
    let values = styleValues.get(element);
    if (!values) { values = new Map(); styleValues.set(element, values); }
    if (values.get(name) === value) return;
    values.set(name, value);
    element.style.setProperty(name, value);
  }

  function setClass(element, name, enabled) {
    if (element && element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
  }

  function setInert(element, inert) {
    if (element && element.inert !== inert) element.inert = inert;
  }

  function writeHash(index, mode = 'replace') {
    if (window.location.hash === `#${sections[index].id}`) return;
    const url = new URL(window.location.href);
    url.hash = sections[index].id;
    if (url.href !== window.location.href) {
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url);
    }
  }

  function clearArrival() {
    clearTimeout(arrivalTimer);
    arrivalTimer = 0;
    setClass(arrivingLink, 'is-arriving', false);
    arrivingLink = null;
    setClass(progressMarker, 'is-arriving', false);
  }

  function clearProgressFeedback() {
    clearTimeout(movingTimer);
    movingTimer = 0;
    setClass(progressNav, 'is-chapter-moving', false);
    clearArrival();
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    setClass(progressNav, 'is-chapter-idle', false);
  }

  function noteIdleActivity() {
    resetPointerParallax();
    lastIdleActivity = performance.now();
    clearIdle();
    for (const unit of calibratingPanels) setClass(unit.element, 'is-chapter-calibrating', false);
    calibratingPanels.clear();
  }

  function canIdle() {
    return progressNav && active && initialized && !document.hidden && !motion.matches
      && !blocked() && !frame && !lastFrame && !transition && !railSeek && !scrub && !touching && y() >= entry - 1;
  }

  function scheduleIdle() {
    if (!canIdle()) { clearIdle(); return; }
    if (idleTimer || progressNav.classList.contains('is-chapter-idle')) return;
    // Share the existing quiet-period timer. Each surface calibrates once per
    // visit; the ruler still starts its idle decoration after a full second.
    const pendingCalibration = revealUnits.some(unit => unit.calibrationReady && !unit.calibrated);
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (!canIdle()) return;
      for (const unit of revealUnits) {
        if (!unit.calibrationReady || unit.calibrated) continue;
        unit.calibrated = true;
        calibratingPanels.add(unit);
        setClass(unit.element, 'is-chapter-scanning', false);
        setClass(unit.element, 'is-chapter-calibrating', true);
      }
      if (performance.now() - lastIdleActivity >= 1000) setClass(progressNav, 'is-chapter-idle', true);
      else scheduleIdle();
    }, Math.max(0, (pendingCalibration ? 120 : 1000) - (performance.now() - lastIdleActivity)));
  }

  function emitChapterState(progress = clamp(y() / Math.max(1, entry), 0, 1)) {
    if (progress === lastProgress && entranceGlow === lastEntranceGlow) return;
    lastProgress = progress;
    lastEntranceGlow = entranceGlow;
    window.dispatchEvent(new CustomEvent('site:chapter', { detail: { progress, entranceGlow } }));
  }

  function setInteraction(kind) {
    if (kind === interactionKind) return;
    const previous = interactionKind;
    interactionKind = kind;
    window.dispatchEvent(new CustomEvent('site:interaction', {
      detail: { active: kind !== null, kind: kind || previous },
    }));
  }

  function setTransitionPhase(phase, direction, pulseEnabled = false) {
    transitionPhase = phase;
    setStyle(root, '--chapter-transition-phase', phase.toFixed(4));
    const pulse = (phase - 0.18) / 0.6;
    entranceGlow = pulseEnabled && direction === 'entering' && pulse > 0 && pulse < 1
      ? Math.sin(Math.PI * pulse) ** 2 : 0;
    setStyle(root, '--chapter-entrance-glow', entranceGlow.toFixed(5));
  }

  function updateProgressFeedback(x, visible, changed, index) {
    const moved = lastIndicatorX !== null && Math.abs(x - lastIndicatorX) > 0.01;
    lastIndicatorX = x;
    if (!progressNav || !initialized || !visible || motion.matches || document.hidden || transition?.direction) {
      clearProgressFeedback();
      return;
    }
    if (moved) {
      setClass(progressNav, 'is-chapter-moving', true);
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => {
        movingTimer = 0;
        setClass(progressNav, 'is-chapter-moving', false);
      }, 140);
    }
    if (changed && index > 0) {
      clearArrival();
      arrivingLink = links.find(link => link.hash === `#${sections[index].id}`) || null;
      setClass(arrivingLink, 'is-arriving', true);
      setClass(progressMarker, 'is-arriving', true);
      arrivalTimer = setTimeout(clearArrival, 400);
    }
  }

  function settleRevealMotion() {
    resetPointerParallax(true);
    for (const unit of revealUnits) {
      const { element } = unit;
      setClass(element, 'is-chapter-immediate', true);
      setClass(element, 'is-chapter-scanning', false);
      setUnitDepth(unit, 0);
      if (unit.hasParallax) setStyle(element, '--chapter-parallax-x', '0.000px');
    }
  }

  function arcEdge(position, radius, flatWidth, limit) {
    const distance = Math.max(0, Math.abs(position) - flatWidth);
    const angle = Math.min(limit, distance / radius);
    // The extension is wholly offscreen. Keep moving outward there instead of
    // wrapping around the cylinder or ever crossing the camera plane.
    const extension = Math.max(0, distance - radius * limit);
    return {
      x: Math.sign(position) * (Math.min(flatWidth, Math.abs(position))
        + radius * Math.sin(angle) + extension * Math.max(0.15, Math.cos(limit))),
      z: radius * (1 - Math.cos(angle)),
    };
  }

  function setUnitDepth(unit, enabled, left = 0, top = 0) {
    const compact = window.innerWidth <= 720;
    const surface = unit.depthOwner.bounds;
    const perspective = Math.max(700, window.innerWidth * 1.1);
    let yaw = 0;
    let depth = 0;
    let shift = 0;
    let span = 1;
    let cameraX = 0;
    let cameraY = 0;
    if (enabled && surface) {
      const center = left + surface.width / 2 - window.innerWidth / 2;
      const radius = window.innerWidth * (compact ? 0.9 : 0.65);
      const flatWidth = window.innerWidth * (compact ? 0.12 : 0.1);
      // Leave enough arc for the far end of even the widest visible face.
      const limit = compact ? 1.4 : 1.85;
      const start = arcEdge(center - surface.width / 2, radius, flatWidth, limit);
      const end = arcEdge(center + surface.width / 2, radius, flatWidth, limit);
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      // A flat face joins two points of one shared arc. Its angle, depth and
      // span therefore agree: wide cards can turn fully without an inner edge
      // shrinking behind the reading plane or crossing a neighbor's edge.
      yaw = -Math.atan2(dz, dx) * 180 / Math.PI;
      depth = (start.z + end.z) / 2;
      shift = (start.x + end.x) / 2 - center;
      span = Math.hypot(dx, dz) / Math.max(1, surface.width);
      cameraX = -center;
      cameraY = (revealViewport.top + revealViewport.bottom) / 2 - (top + surface.height / 2);
    }
    setStyle(unit.element, '--chapter-camera-x', `${cameraX.toFixed(3)}px`);
    setStyle(unit.element, '--chapter-camera-y', `${cameraY.toFixed(3)}px`);
    setStyle(unit.element, '--chapter-perspective', `${perspective.toFixed(3)}px`);
    setStyle(unit.element, '--chapter-depth-origin-x', surface && unit.bounds
      ? `${(surface.left + surface.width / 2 - unit.bounds.left).toFixed(3)}px` : '50%');
    setStyle(unit.element, '--chapter-depth-origin-y', surface && unit.bounds
      ? `${(surface.top + surface.height / 2 - unit.bounds.top).toFixed(3)}px` : '50%');
    setStyle(unit.element, '--chapter-depth-yaw', `${yaw.toFixed(3)}deg`);
    setStyle(unit.element, '--chapter-depth-z', `${depth.toFixed(2)}px`);
    setStyle(unit.element, '--chapter-depth-x', `${shift.toFixed(3)}px`);
    setStyle(unit.element, '--chapter-depth-span', span.toFixed(6));
    if (unit.isPanel) {
      const light = clamp(-yaw / 45, -1, 1);
      setStyle(unit.element, '--chapter-light-left', Math.max(0, light).toFixed(3));
      setStyle(unit.element, '--chapter-light-right', Math.max(0, -light).toFixed(3));
    }
  }

  function updateUnitDepth(unit, left, top, enabled) {
    if (!enabled) { setUnitDepth(unit, 0); return; }
    const card = unit.depthOwner.bounds;
    left += card.left - unit.bounds.left;
    top += card.top - unit.bounds.top;
    // Use cached layout coordinates, never transformed readbacks. The same
    // owner plane also carries headings/footnotes outside the black surface.
    setUnitDepth(unit, true, left, top);
  }

  function measureReveals() {
    // Layout coordinates exclude each card's animated transform. Positioned
    // wrappers can sit between a card and its scrollable chapter.
    for (const group of revealGroups) {
      const { chapter, units } = group;
      for (const unit of units) {
        // The journal intro sits over the sidebar on desktop, but above the
        // main article surface once the two columns stack at the CSS breakpoint.
        unit.depthOwner = window.innerWidth <= 720 ? unit.compactDepthOwner : unit.wideDepthOwner;
        let left = 0;
        let top = 0;
        for (let node = unit.element; node && node !== chapter; node = node.offsetParent) {
          left += node.offsetLeft;
          top += node.offsetTop;
        }
        unit.bounds = { left, top, width: unit.element.offsetWidth, height: unit.element.offsetHeight };
      }
      // Transformed corners can enlarge scrollHeight. Only real content that
      // exceeds the reading height should turn this chapter into a scrollport.
      const bottomPadding = parseFloat(getComputedStyle(chapter).paddingBottom) || 0;
      const contentBottom = Math.max(0, ...units.map(unit => unit.bounds.top + unit.bounds.height));
      group.scrollLimit = Math.max(0, contentBottom + bottomPadding - chapter.clientHeight);
      group.scrollable = group.scrollLimit > 2;
    }
    // Use the actual clipping boundary shared with the header and ruler.
    const inset = getComputedStyle(viewport).clipPath?.match(/^inset\(([^)]+)/)?.[1]
      .split(/\s+/).map(value => parseFloat(value)) || [];
    revealViewport = { top: inset[0] || 0, bottom: viewport.clientHeight - (inset[2] ?? inset[0] ?? 0) };
  }

  function updateReveal(unit, axes, visible, revealVisible, immediate, skipCalibration) {
    const offscreen = axes.x.intersection <= 1 || axes.y.intersection <= 1;
    const canReveal = Object.values(axes).every(axis => axis.intersection >= Math.min(80, axis.span * 0.1));
    const closing = Object.values(axes).some(axis => axis.intersection <= Math.min(24, axis.span * 0.03));
    const outgoingAxis = ['x', 'y'].find(name => axes[name].movement * axes[name].side < 0
      && axes[name].intersection <= Math.min(320, axes[name].span * 0.35));
    const previous = unit.phase;
    let axisName = previous === 'departing' ? unit.exitAxis : outgoingAxis
      || (axes.y.intersection / axes.y.span < axes.x.intersection / axes.x.span ? 'y' : 'x');
    let scan = false;
    if (immediate) {
      unit.phase = motion.matches || (revealVisible && canReveal) ? 'open' : 'preview';
      if (!revealVisible || offscreen) unit.seen = false;
      else if (unit.phase === 'open') unit.seen = true;
    } else if (offscreen) {
      unit.phase = 'preview';
      unit.seen = false;
    } else if (unit.seen && closing) {
      unit.phase = 'closing';
    } else if (previous === 'departing') {
      const axis = axes[unit.exitAxis];
      unit.exitMinimum = Math.min(unit.exitMinimum, axis.intersection);
      const reversal = Math.max(1, Math.min(24, axis.span * 0.1));
      if (canReveal && (axis.intersection >= unit.exitMinimum + reversal
        || axis.intersection >= Math.min(320, axis.span * 0.35) + reversal)) unit.phase = 'open';
    } else if (previous === 'open' && outgoingAxis) {
      unit.phase = 'departing';
      unit.exitAxis = axisName = outgoingAxis;
      unit.exitMinimum = axes[outgoingAxis].intersection;
    } else if (canReveal) {
      unit.phase = 'open';
      scan = !unit.seen;
      unit.seen = true;
    }
    if (unit.phase !== 'departing') unit.exitMinimum = null;

    const { element } = unit;
    setClass(element, 'chapter-reveal-unit', true);
    setClass(element, 'has-chapter-reveal', true);
    if (immediate || offscreen) {
      setClass(element, 'is-chapter-immediate', true);
      setClass(element, 'is-chapter-scanning', false);
    } else if (unit.phase !== previous) {
      setClass(element, 'is-chapter-immediate', false);
    }
    if (scan) setClass(element, 'is-chapter-scanning', true);
    if (unit.phase !== previous || immediate || offscreen) {
      setStyle(element, '--chapter-reveal-direction', String(axes[axisName].side));
    }
    const readable = unit.phase === 'open' || unit.phase === 'departing';
    setClass(element, 'is-chapter-revealed', readable);
    setClass(element, 'is-chapter-departing', unit.phase === 'departing');
    setClass(element, 'is-chapter-closing', unit.phase === 'closing');
    setInert(element, !visible || !readable || offscreen);
    unit.calibrationReady = unit.isPanel && visible && unit.phase === 'open'
      && Object.values(axes).every(axis => axis.intersection >= axis.span * 0.55);
    if (!revealVisible || offscreen) unit.calibrated = false;
    else if (skipCalibration && unit.calibrationReady) unit.calibrated = true;
    if (!unit.calibrationReady || skipCalibration) {
      setClass(element, 'is-chapter-calibrating', false);
      calibratingPanels.delete(unit);
    }
  }

  function updateReveals(x, visible, instant, calibratePanels) {
    const now = performance.now();
    const movement = lastRevealX === null ? 0 : x - lastRevealX;
    const distance = Math.abs(movement);
    const fast = distance > width * 0.55 || (scrub?.dragging && distance > width * 0.04
      && distance / Math.max(16, now - lastRevealTime) > width * 0.0025);
    lastRevealX = x;
    lastRevealTime = now;
    const immediate = instant || fast || !initialized || !available() || blocked()
      || motion.matches || Boolean(transition?.direction) || !visible;
    // Prepare the assembled panels before their track slides in. Reveal bounds
    // stay unshifted, while depth follows the actual position on screen.
    const heroPhase = transition?.direction
      ? transition.direction === 'entering' ? transitionPhase : 1 - transitionPhase : null;
    const skipCalibration = !initialized || !available() || blocked() || motion.matches
      || (instant && heroPhase === null && !calibratePanels);
    const revealVisible = visible || heroPhase !== null;
    const depthEnabled = revealVisible && available() && !blocked() && !motion.matches;
    const heroTravel = heroPhase === null ? 1 : clamp((heroPhase - 0.18) / 0.67, 0, 1);
    const heroSlide = motion.matches ? 0 : (window.innerWidth + Math.min(120, window.innerWidth * 0.08))
      * (1 - heroTravel * heroTravel * (3 - 2 * heroTravel));
    setStyle(track, '--chapter-entrance-x', `${heroSlide.toFixed(3)}px`);
    setInert(viewport, !visible || heroPhase !== null);

    revealGroups.forEach((group, index) => {
      const { chapter, units } = group;
      const bounds = panelBounds[index];
      const left = bounds.left - x;
      // Offset from this chapter's reading stop, rather than the asymmetric
      // center of each card: all its text rests at the authored layout on arrival.
      // The Hero displacement shares this coordinate, with no extra animation loop.
      const parallaxPhase = clamp((index * width - x + heroSlide) / Math.max(1, width), -1, 1);
      const parallaxX = depthEnabled ? -Math.sin(parallaxPhase * Math.PI / 2) * (window.innerWidth <= 720 ? 5 : 12) : 0;
      const scroll = chapter.scrollTop;
      const verticalMovement = group.lastScroll === null ? 0 : scroll - group.lastScroll;
      group.lastScroll = scroll;
      // A hidden card must not make its still-visible siblings inert.
      setInert(chapter, !visible || left + bounds.width <= 1 || left >= window.innerWidth - 1);
      for (const unit of units) {
        const card = unit.bounds;
        const cardLeft = left + card.left;
        const cardTop = card.top - scroll;
        updateUnitDepth(unit, cardLeft + heroSlide, cardTop, depthEnabled);
        if (unit.hasParallax) setStyle(unit.element, '--chapter-parallax-x', `${parallaxX.toFixed(3)}px`);
        updateReveal(unit, {
          x: {
            intersection: Math.max(0, Math.min(window.innerWidth, left + bounds.width, cardLeft + card.width) - Math.max(0, left, cardLeft)),
            span: Math.max(1, Math.min(card.width, window.innerWidth)),
            side: cardLeft + card.width / 2 >= window.innerWidth / 2 ? 1 : -1,
            movement,
          },
          y: {
            intersection: Math.max(0, Math.min(revealViewport.bottom, cardTop + card.height) - Math.max(revealViewport.top, cardTop)),
            span: Math.max(1, Math.min(card.height, revealViewport.bottom - revealViewport.top)),
            side: cardTop + card.height / 2 >= (revealViewport.top + revealViewport.bottom) / 2 ? 1 : -1,
            movement: verticalMovement,
          },
        }, visible, revealVisible, immediate, skipCalibration);
      }
    });
  }

  function update(syncHash = true, instantPanels = false, calibratePanels = false) {
    if (!active || !positions.length) return;
    const scroll = y();
    renderedScroll = scroll;
    const progress = clamp(scroll / Math.max(1, entry), 0, 1);
    const x = clamp(scroll - entry, 0, travel);
    const chapterPosition = x / Math.max(width, 1);
    const siteProgress = travel ? x / travel : 0;
    const visible = progress > 0.55;
    setStyle(root, '--chapter-progress', progress.toFixed(4));
    // A local transform avoids inheriting a changing custom property through
    // every panel; navigation-only values belong to the small progress subtree.
    setStyle(track, 'transform', `translate3d(${-x.toFixed(3)}px, 0, 0)`);
    setStyle(progressNav, '--chapter-position', chapterPosition.toFixed(5));
    setStyle(progressNav, '--site-progress', siteProgress.toFixed(5));
    const markerX = `${((chapterPosition + 0.5) * progressTrackWidth / chapters.length).toFixed(3)}px`;
    setStyle(progressMarker, '--chapter-marker-x', markerX);
    setStyle(progressTrack, '--chapter-marker-x', markerX);
    setClass(root, 'is-content', visible);
    // A partly assembled toolbar must not accept Tab focus before docking.
    setInert(header, !visible || Boolean(transition?.direction));
    setInert(progressNav, !visible);
    for (const element of heroText) setInert(element, progress > 0.12);
    // CSS completes the triggered sequences; geometry uses the existing cache.
    updateReveals(x, visible, instantPanels, calibratePanels);
    emitChapterState(progress);
    const index = visible ? Math.min(chapters.length, 1 + Math.round(x / Math.max(width, 1))) : 0;
    setStyle(progressNav, '--chapter-active-index', String(clamp(index - 1, 0, chapters.length - 1)));
    const changed = index !== currentIndex;
    const sliderValue = (siteProgress * 100).toFixed(1);
    if (progressMarker && (sliderValue !== lastSliderValue || changed)) {
      lastSliderValue = sliderValue;
      progressMarker.setAttribute('aria-valuenow', sliderValue);
      progressMarker.setAttribute('aria-valuetext', `${chapterLabels[clamp(index - 1, 0, chapters.length - 1)]}，${Math.round(siteProgress * 100)}%`);
    }
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
    measureReveals();
    entry = runway.getBoundingClientRect().top + y();
    travel = width * (chapters.length - 1);
    // Finish geometry reads before changing the runway height.
    const figure = document.querySelector('#black-hole')?.getBoundingClientRect();
    const scene = stage.getBoundingClientRect();
    const ruler = progressTrack?.getBoundingClientRect();
    // Cache the layout origin, not the ruler's current mouse displacement.
    progressTrackLeft = (ruler?.left || 0) - pointerNavX;
    progressTrackWidth = ruler?.width || 0;
    for (const group of revealGroups) {
      setClass(group.chapter, 'is-chapter-scrollable', group.scrollable);
      clampChapterScroll(group);
    }
    const runwayHeight = `${window.innerHeight + travel}px`;
    if (runway.style.height !== runwayHeight) runway.style.height = runwayHeight;
    positions = [0, ...chapters.map((_, index) => entry + index * width)];
    maximum = entry + travel;
    if (figure) {
      setStyle(root, '--fallback-shift-x', `${scene.left + scene.width / 2 - figure.left - figure.width / 2}px`);
      setStyle(root, '--fallback-shift-y', `${scene.top + scene.height / 2 - figure.top - figure.height / 2}px`);
    }
    targetY = clamp(frame ? targetY : y(), 0, maximum);
    measuring = false;
    update(false, true);
  }

  function canPointerParallax() {
    return available() && initialized && mouseMotion.matches && window.innerWidth > 720
      && !motion.matches && !blocked() && !frame && !lastFrame && !transition && !railSeek
      && !scrub && !pointerPressed && !pointerEditing() && !touching && !interactionKind && y() >= entry - 1;
  }

  function pointerEditing() {
    return document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
  }

  function paintPointerParallax() {
    const { x, y: vertical } = pointerLayer;
    const moved = x !== 0 || vertical !== 0;
    // Move only three composed layers. Removing an idle inline translate lets
    // the existing CSS Hero entrance retain sole control of the track.
    setStyle(track, 'translate', moved ? `calc(var(--chapter-entrance-x, 0px) + ${x.toFixed(3)}px) ${vertical.toFixed(3)}px` : '');
    setStyle(header, 'translate', moved ? `${(x * 0.5).toFixed(3)}px ${(vertical * 0.5).toFixed(3)}px` : '');
    pointerNavX = Number((x * 0.375).toFixed(3));
    setStyle(progressNav, 'translate', moved ? `${pointerNavX.toFixed(3)}px ${(vertical * 0.4).toFixed(3)}px` : '');
  }

  function holdPointerParallax() {
    pointerLayer.targetX = pointerLayer.x;
    pointerLayer.targetY = pointerLayer.y;
    pointerTime = 0;
    if (updateFrame && !updatePending) {
      cancelAnimationFrame(updateFrame);
      updateFrame = 0;
    }
  }

  function resetPointerParallax(force = false) {
    if (!force && (pointerPressed || scrub || pointerEditing())) { holdPointerParallax(); return; }
    if (force) pointerPressed = false;
    pointerLayer.x = pointerLayer.y = pointerLayer.targetX = pointerLayer.targetY = 0;
    holdPointerParallax();
    paintPointerParallax();
  }

  function releasePointerParallax() {
    if (pointerPressed || scrub || pointerEditing()) return;
    pointerLayer.targetX = pointerLayer.targetY = 0;
    if (pointerLayer.x || pointerLayer.y) queueUpdate(true);
  }

  function tickPointerParallax(now) {
    if (pointerPressed || scrub || pointerEditing()) { holdPointerParallax(); return false; }
    const state = pointerLayer;
    if (state.x === state.targetX && state.y === state.targetY) return false;
    if (!canPointerParallax()) { resetPointerParallax(); return false; }
    const elapsed = pointerTime ? clamp(now - pointerTime, 0, 64) : 16;
    pointerTime = now;
    const ease = 1 - Math.exp(-elapsed / 90);
    state.x += (state.targetX - state.x) * ease;
    state.y += (state.targetY - state.y) * ease;
    const settled = Math.max(Math.abs(state.targetX - state.x), Math.abs(state.targetY - state.y)) < 0.015;
    if (settled) { state.x = state.targetX; state.y = state.targetY; pointerTime = 0; }
    paintPointerParallax();
    return !settled;
  }

  function queueUpdate(pointerOnly = false) {
    if (!available()) return;
    if (!pointerOnly) updatePending = true;
    if (!updateFrame) updateFrame = requestAnimationFrame(now => {
      updateFrame = 0;
      if (!available()) { updatePending = false; return; }
      // Pointer-only frames touch the three interface layers, never re-run navigation
      // or measure layout. Both inputs share this coalesced frame and then stop.
      if (updatePending) { updatePending = false; update(); }
      if (tickPointerParallax(now)) queueUpdate(true);
    });
  }

  window.addEventListener('pointermove', event => {
    // A release outside the browser can omit pointerup for ordinary buttons.
    if (pointerPressed && !scrub && event.pointerType === 'mouse' && event.buttons === 0) pointerPressed = false;
    if (pointerPressed || scrub || pointerEditing()) return;
    if (event.pointerType !== 'mouse' || event.isPrimary === false || event.buttons || !canPointerParallax()) {
      resetPointerParallax();
      return;
    }
    pointerInside = true;
    // The same view coordinate applies over panels, empty sky and both HUDs.
    pointerLayer.targetX = clamp(event.clientX / Math.max(1, window.innerWidth) * 2 - 1, -1, 1) * 8;
    pointerLayer.targetY = clamp(event.clientY / Math.max(1, window.innerHeight) * 2 - 1, -1, 1) * 5;
    queueUpdate(true);
  }, { passive: true });
  window.addEventListener('pointerout', event => {
    if (event.relatedTarget == null) { pointerInside = false; releasePointerParallax(); }
  }, { passive: true });
  document.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse') { resetPointerParallax(true); return; }
    if (event.isPrimary === false || event.button !== 0) return;
    pointerPressed = true;
    holdPointerParallax();
  }, { passive: true });
  document.addEventListener('focusin', () => {
    if (pointerPressed || pointerEditing()) holdPointerParallax();
    else resetPointerParallax();
  });
  document.addEventListener('focusout', releasePointerParallax);
  window.addEventListener('pointercancel', () => resetPointerParallax(true), { passive: true });
  window.addEventListener('blur', () => { pointerInside = false; resetPointerParallax(true); });
  mouseMotion.addEventListener('change', () => { finishScrub(); resetPointerParallax(true); });

  function stop({ preserveInteraction = false } = {}) {
    finishScrub();
    noteIdleActivity();
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
    railSeek = null;
    transition = null;
    setStyle(track, '--chapter-entrance-x', '0.000px');
    setInert(viewport, !available() || !root.classList.contains('is-content'));
    targetY = y();
    smoothY = targetY;
    for (const name of ['is-chapter-transitioning', 'is-chapter-entering', 'is-chapter-leaving']) setClass(root, name, false);
    setTransitionPhase(0);
    emitChapterState();
    if (!preserveInteraction) setInteraction(null);
  }

  function setScroll(top, instantPanels = false) {
    noteIdleActivity();
    settingScroll = true;
    window.scrollTo({ top, behavior: 'instant' });
    settingScroll = false;
    cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    updatePending = false;
    update(true, instantPanels);
  }

  function applyScrub(drag = scrub) {
    if (!drag || drag !== scrub) return;
    if (!available() || blocked()) { finishScrub(); return; }
    // Use the grabbed point as the origin: the large hit target must not jump
    // the page when pressed away from the tiny visual cursor. Geometry is cached.
    const top = clamp(drag.startY + (drag.latestX - drag.startX) * drag.scrollPerPixel, entry, maximum);
    targetY = smoothY = top;
    if (Math.abs(top - y()) > 0.01) {
      setInteraction('content');
      setScroll(top);
    }
  }

  function seekRail(destination) {
    targetY = clamp(destination, entry, maximum);
    smoothY = y();
    if (motion.matches || Math.abs(targetY - smoothY) < 0.6) {
      setScroll(targetY);
      setInteraction(null);
      scheduleIdle();
      return;
    }
    const seek = { from: smoothY, to: targetY, started: performance.now() };
    const duration = 320 + Math.min(210, Math.abs(seek.to - seek.from) / Math.max(width, 1) * 70);
    railSeek = seek;
    setInteraction('content');
    function step(now) {
      if (railSeek !== seek) return;
      frame = 0;
      if (!available() || blocked()) { stop(); return; }
      const t = clamp((now - seek.started) / duration, 0, 1);
      // Start and finish at rest; even a distant click has no first-frame leap.
      const eased = t * t * (3 - 2 * t);
      smoothY = t === 1 ? seek.to : seek.from + (seek.to - seek.from) * eased;
      setScroll(smoothY);
      if (t < 1) frame = requestAnimationFrame(step);
      else {
        railSeek = null;
        setInteraction(null);
        scheduleIdle();
      }
    }
    frame = requestAnimationFrame(step);
  }

  function finishScrub({ commit = false } = {}) {
    if (!scrub) return;
    const drag = scrub;
    cancelAnimationFrame(scrubFrame);
    scrubFrame = 0;
    const canCommit = commit && available() && !blocked();
    if (canCommit && drag.dragging) applyScrub(drag);
    scrub = null;
    targetY = smoothY = y();
    setClass(progressNav, 'is-scrubbing', false);
    if (progressMarker?.hasPointerCapture?.(drag.pointerId)) progressMarker.releasePointerCapture(drag.pointerId);
    noteIdleActivity();
    if (canCommit && !drag.dragging) { seekRail(drag.startY); return; }
    setInteraction(null);
    scheduleIdle();
  }

  progressTrack?.addEventListener('pointerdown', event => {
    if (!progressMarker || !available() || blocked() || scrub || event.isPrimary === false || event.button !== 0
        || transition?.direction || y() < entry - 1 || !travel || !progressTrackWidth) return;
    event.preventDefault();
    // Freeze before stop() and focus() can run: the pressed ruler must stay
    // under the mouse through the entire drag, including the initial sample.
    if (event.pointerType === 'mouse') { pointerPressed = true; holdPointerParallax(); }
    else resetPointerParallax(true);
    stop({ preserveInteraction: true });
    entryGesture = false;
    touch = null;
    // Programmatic focus can inherit keyboard focus-visible state. Pointer
    // interaction keeps the focus target without drawing its keyboard outline.
    setClass(progressMarker, 'is-pointer-focused', true);
    progressMarker.focus({ preventScroll: true });
    // Cursor endpoints are the centers of the first and last chapter cells.
    const cursorTravel = progressTrackWidth * (chapters.length - 1) / chapters.length;
    const grabbedMarker = progressMarker.contains(event.target);
    // Rail presses seek between chapter centers; label links still navigate
    // to exact chapter anchors. Keep the outer half-cells within the content.
    const railPosition = (event.clientX - progressTrackLeft - pointerNavX) / progressTrackWidth * chapters.length - 0.5;
    // Clamp only when applying the position so a drag starting in an outer
    // half-cell stays aligned with the pointer as it enters the usable range.
    const startY = grabbedMarker ? y() : entry + railPosition * width;
    scrub = { pointerId: event.pointerId, startX: event.clientX, latestX: event.clientX, startY, scrollPerPixel: travel / cursorTravel, dragging: grabbedMarker };
    setClass(progressNav, 'is-scrubbing', grabbedMarker);
    progressMarker.setPointerCapture(event.pointerId);
  });
  progressTrack?.addEventListener('click', event => event.preventDefault());

  window.addEventListener('pointermove', event => {
    if (!scrub || event.pointerId !== scrub.pointerId) return;
    if (!available() || blocked()) { finishScrub(); return; }
    event.preventDefault();
    scrub.latestX = event.clientX;
    if (!scrub.dragging) {
      if (Math.abs(scrub.latestX - scrub.startX) <= 5) return;
      scrub.dragging = true;
      setClass(progressNav, 'is-scrubbing', true);
    }
    const drag = scrub;
    if (!scrubFrame) scrubFrame = requestAnimationFrame(() => {
      if (scrub !== drag) return;
      scrubFrame = 0;
      applyScrub(drag);
    });
  }, { passive: false });
  window.addEventListener('pointerup', event => {
    if (!scrub || event.pointerId !== scrub.pointerId) return;
    scrub.latestX = event.clientX;
    if (Math.abs(scrub.latestX - scrub.startX) > 5) scrub.dragging = true;
    finishScrub({ commit: true });
  });
  window.addEventListener('pointerup', event => {
    if (event.isPrimary === false) return;
    pointerPressed = false;
    if (!pointerInside) releasePointerParallax();
  });
  window.addEventListener('pointercancel', event => {
    if (scrub?.pointerId === event.pointerId) finishScrub();
  });
  progressMarker?.addEventListener('lostpointercapture', event => {
    if (scrub?.pointerId === event.pointerId) { finishScrub(); resetPointerParallax(true); }
  });
  window.addEventListener('blur', () => finishScrub());
  progressMarker?.addEventListener('blur', () => setClass(progressMarker, 'is-pointer-focused', false));

  progressMarker?.addEventListener('keydown', event => {
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) setClass(progressMarker, 'is-pointer-focused', false);
    if (event.code === 'Escape' && scrub) { event.preventDefault(); finishScrub(); resetPointerParallax(true); return; }
    if (!available() || blocked() || transition?.direction || y() < entry - 1
        || event.altKey || event.ctrlKey || event.metaKey) return;
    const deltas = { ArrowLeft: -width / 20, ArrowDown: -width / 20, ArrowRight: width / 20, ArrowUp: width / 20, PageDown: -width, PageUp: width };
    if (!(event.code in deltas) && event.code !== 'Home' && event.code !== 'End') return;
    event.preventDefault();
    stop();
    entryGesture = false;
    const destination = event.code === 'Home' ? entry : event.code === 'End' ? maximum : clamp(y() + deltas[event.code], entry, maximum);
    targetY = smoothY = destination;
    if (Math.abs(destination - y()) > 0.01) {
      setInteraction('content');
      setScroll(destination);
      setInteraction(null);
    }
    scheduleIdle();
  });

  function focusSection(index) {
    const target = sections[index];
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  function goTo(index, { historyMode = 'push', focus = false, instant = false, entrance = false } = {}) {
    if (!available() || index < 0 || index >= sections.length) return;
    const previousDirection = transition?.direction;
    const previousPhase = transitionPhase;
    // Retargeting an animation keeps its activity continuous until the new
    // mode is known; main must not briefly resume a paused background frame.
    stop({ preserveInteraction: true });
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
      setScroll(destination, instant || Boolean(direction));
      stop();
      update(false, instant || Boolean(direction), direction === 'entering' && !instant);
      if (focus) focusSection(index);
    };
    if (instant || motion.matches || document.hidden || (!previousDirection && Math.abs(start - destination) < 1)) { finish(); return; }
    setInteraction(direction ? 'hero' : 'content');
    root.classList.add('is-chapter-transitioning');
    if (direction) {
      setTransitionPhase(phaseStart, direction, pulseEnabled);
      root.classList.add(`is-chapter-${direction}`);
      clearProgressFeedback();
      update(false, true);
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
      setInteraction(null);
      scheduleIdle();
    } else {
      setScroll(next);
      frame = requestAnimationFrame(smoothTick);
    }
  }

  function advance(delta) {
    if (railSeek) stop({ preserveInteraction: true });
    // Only the boundary around the hero snaps; the content rail stays continuous.
    const intended = frame && !transition ? targetY : y();
    if (delta < 0 && intended + delta < entry - 2) {
      goTo(0, { historyMode: 'replace', entrance: true });
      return true;
    }
    if (transition) stop({ preserveInteraction: true });
    if (!frame) smoothY = y();
    // Add to the intended position so quick wheel events retain their distance.
    targetY = clamp((frame ? targetY : y()) + delta, 0, maximum);
    if (motion.matches) { setScroll(targetY); setInteraction(null); return; }
    if (targetY === y()) { stop(); scheduleIdle(); return false; }
    // A horizontal touch can move through the hero without taking its vertical
    // entrance snap. Keep its camera live while either end is in that range.
    setInteraction(y() < entry || targetY < entry ? 'hero' : 'content');
    if (!frame) frame = requestAnimationFrame(smoothTick);
    return false;
  }

  function clampChapterScroll(group) {
    // CSS projection contributes to scrollHeight even though it adds no text.
    // Keep native scrolling within the measured, untransformed reading area.
    const top = clamp(group.chapter.scrollTop, 0, group.scrollLimit);
    if (top !== group.chapter.scrollTop) group.chapter.scrollTop = top;
  }

  function scrollableChapter(target, direction, keyboard = false) {
    const chapter = target?.closest?.('.chapter-section') || (keyboard ? chapters[Math.max(0, currentIndex - 1)] : null);
    if (!chapter || chapter.inert || !chapter.classList.contains('is-chapter-scrollable')) return null;
    const bottom = groupsByChapter.get(chapter)?.scrollLimit || 0;
    return bottom > 2 && (direction > 0 ? chapter.scrollTop < bottom - 2 : chapter.scrollTop > 2) ? chapter : null;
  }

  window.addEventListener('wheel', event => {
    if (!available()) return;
    if (scrub) { if (!event.ctrlKey && !event.metaKey) event.preventDefault(); return; }
    noteIdleActivity();
    scheduleIdle();
    if (!active || blocked() || event.ctrlKey || event.metaKey
        || (interactive(event.target) && !event.target.closest('.chapter-progress'))) return;
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
      const destination = clamp(inside.scrollTop + direction * readingDistance, 0, groupsByChapter.get(inside).scrollLimit);
      inside.scrollBy({ top: destination - inside.scrollTop, behavior: motion.matches ? 'instant' : 'smooth' });
      scheduleIdle();
    } else if (advance(direction * distance)) entryGesture = true;
  });

  window.addEventListener('touchstart', event => {
    if (!available()) return;
    touching = event.touches.length > 0;
    noteIdleActivity();
    touch = event.touches.length === 1 && !scrub && !interactive(event.target) && !blocked()
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
    resetPointerParallax(true);
    if (!positions.length) { measure(); return; }
    const previousPosition = suspendedPosition ?? position();
    suspendedPosition = null;
    const navigation = transition;
    stop({ preserveInteraction: true });
    measure();
    if (navigation) {
      goTo(navigation.index, {
        historyMode: null, focus: navigation.focus, entrance: navigation.entrance,
        // A changed viewport finishes the layered entrance instead of replaying it.
        instant: Boolean(navigation.direction),
      });
    } else {
      const destination = previousPosition >= 1 ? entry + (previousPosition - 1) * width : previousPosition * entry;
      if (Math.abs(destination - y()) > 0.5) setScroll(destination, true);
      setInteraction(null);
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
    observeLayout();
  }

  setStyle(root, '--chapter-count', String(chapters.length));
  setTransitionPhase(0);
  root.classList.add('has-chapters');
  measure();
  if (window.location.hash) restoreHash();
  initialized = true;
  scheduleIdle();
  window.addEventListener('scroll', () => {
    // Programmatic movement updates synchronously. Its later native scroll
    // event must not create a second animation chain for the same position.
    if (!available() || settingScroll || y() === renderedScroll) return;
    noteIdleActivity();
    queueUpdate();
  }, { passive: true });
  document.addEventListener('scroll', event => {
    if (!available()) return;
    const group = groupsByChapter.get(event.target?.closest?.('.chapter-section'));
    if (!group) return;
    clampChapterScroll(group);
    noteIdleActivity();
    // The coalesced update refreshes each card's visibility before deciding
    // whether the quiet period needs a short calibration or the idle delay.
    queueUpdate();
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
    settleRevealMotion();
    layoutObserver.disconnect();
    stop();
    clearProgressFeedback();
    cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    updatePending = false;
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
    stop({ preserveInteraction: true });
    if (wasMoving) setScroll(destination);
    settleRevealMotion();
    setInteraction(null);
    if (focusIndex !== null) focusSection(focusIndex);
    if (positions.length) suspendedPosition = position();
    clearProgressFeedback();
    cancelAnimationFrame(updateFrame);
    updateFrame = 0;
    updatePending = false;
    touch = null;
    touching = false;
  });
  motion.addEventListener('change', () => {
    if (!available()) return;
    finishScrub();
    resetPointerParallax(true);
    noteIdleActivity();
    if (motion.matches) clearProgressFeedback();
    if (motion.matches && frame) {
      const destination = transition?.destination ?? targetY;
      const focusIndex = transition?.focus ? transition.index : null;
      stop({ preserveInteraction: true });
      setScroll(destination);
      setInteraction(null);
      if (focusIndex !== null) focusSection(focusIndex);
    }
    update(false, true);
  });
  const layoutObserver = new ResizeObserver(reflow);
  function observeLayout() {
    layoutObserver.observe(viewport);
    for (const chapter of chapters) layoutObserver.observe(chapter);
    // Content/search results and fonts can resize cards inside a fixed chapter.
    for (const { element } of revealUnits) layoutObserver.observe(element);
  }
  if (available()) observeLayout();
})();
