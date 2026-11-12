/* Day/night switch. A solid white beam shoots out of the black hole both
 * ways along its spin axis, as the night page kicks towards the camera,
 * then swells until the screen is white; the day page then develops out of
 * the white. Switching back plays it in reverse, and a toggle midway
 * reverses it from where it is. One view transition holds both themes for
 * the whole switch, so the page restyles once, at the click; the beam is
 * drawn over both page images, through the scene's own camera. Reduced
 * motion crossfades; without view transitions the theme changes at once. */
(() => {
  'use strict';

  const theme = window.SiteTheme;
  if (!theme?.useSwitcher) return;
  const root = document.documentElement;
  // Milliseconds along the timeline: night at 0, day at its end. The beam
  // shoots out, swells (starting before its shot has quite finished) until
  // the screen is white, and the white then lifts off the day page.
  const shoot = 240, swell = 620, develop = 320;
  const swellFrom = shoot * 0.8;
  const whiteOut = swellFrom + swell;
  const total = whiteOut + develop;
  // ?jets=slow plays the switch at a tenth of its speed, to study it.
  const pace = new URLSearchParams(window.location.search).get('jets') === 'slow' ? 0.1 : 1;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
  // The hero's scene camera, for pages without a black hole. Its beam
  // leans the other way, like the toggle's icon, so that from the toggle in
  // the top right corner it crosses the page instead of leaving it.
  const toggleCamera = { roll: -Math.PI / 10, inclination: 81 * Math.PI / 180, azimuth: 0, distance: 31.78443, focal: 4.05 };

  const clamp = value => Math.min(1, Math.max(0, value));
  const easeOut = x => 1 - (1 - x) ** 3;
  const smooth = (from, to, x) => {
    const t = clamp((x - from) / (to - from));
    return t * t * (3 - 2 * t);
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => a.map(value => value / Math.hypot(...a));

  // js/black-hole.js orbits its camera round the hole, tilted from the spin
  // axis (the scene's y axis) and looking at the hole.
  function lens(spot) {
    const { inclination, azimuth, distance } = spot;
    const eye = [
      distance * Math.sin(azimuth) * Math.sin(inclination),
      distance * Math.cos(inclination),
      distance * Math.cos(azimuth) * Math.sin(inclination),
    ];
    const forward = eye.map(value => -value / distance);
    const right = unit([-forward[2], 0, forward[0]]);
    return {
      ...spot, eye, forward, right, up: cross(right, forward),
      // How far the camera stands from the axis: the beam swells up to it.
      rho: Math.hypot(eye[0], eye[2]),
    };
  }

  // A scene point, in Schwarzschild radii, on the page; null behind the camera.
  function project(view, point) {
    const offset = [point[0] - view.eye[0], point[1] - view.eye[1], point[2] - view.eye[2]];
    const depth = dot(offset, view.forward);
    if (depth < 0.2) return null;
    const sx = view.focal * dot(offset, view.right) / depth;
    const sy = view.focal * dot(offset, view.up) / depth;
    // The shader rolls its screen before casting rays; roll the point back.
    const c = Math.cos(view.roll), s = Math.sin(view.roll);
    return [view.x + (sx * c - sy * s) * view.scale, view.y - (sx * s + sy * c) * view.scale];
  }

  function rims(length, radius, count = 48) {
    const points = [];
    for (const height of [length, -length]) {
      for (let i = 0; i < count; i++) {
        const turn = i / count * Math.PI * 2;
        points.push([radius * Math.cos(turn), height, radius * Math.sin(turn)]);
      }
    }
    return points;
  }

  function hull(points) {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (sorted.length < 3) return sorted;
    const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const chain = list => {
      const side = [];
      for (const point of list) {
        while (side.length > 1 && turn(side.at(-2), side.at(-1), point) <= 0) side.pop();
        side.push(point);
      }
      return side.slice(0, -1);
    };
    return [...chain(sorted), ...chain(sorted.reverse())];
  }

  function contains(shape, [x, y]) {
    let sign = 0;
    for (let i = 0; i < shape.length; i++) {
      const [ax, ay] = shape[i], [bx, by] = shape[(i + 1) % shape.length];
      const turn = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
      if (!turn) continue;
      if (!sign) sign = turn;
      else if (turn !== sign) return false;
    }
    return shape.length > 2;
  }

  // A cylinder is the hull of its two end circles, so the hull of their
  // perspective images is the beam's outline on the page.
  function outline(view, length, radius) {
    const points = [];
    for (const point of rims(length, radius)) {
      const page = project(view, point);
      if (!page) return null;
      points.push(page);
    }
    return hull(points);
  }

  function covers(view, length, radius, width, height) {
    const shape = outline(view, length, radius);
    // A rim behind the camera: the beam already reaches past it.
    if (!shape) return true;
    return [[-24, -24], [width + 24, -24], [width + 24, height + 24], [-24, height + 24]].every(corner => contains(shape, corner));
  }

  // How long the beam grows: until both of its ends are off the screen.
  function reach(view, width, height) {
    const gone = page => !page || page[0] < -80 || page[0] > width + 80 || page[1] < -80 || page[1] > height + 80;
    let length = 0;
    for (const sign of [1, -1]) {
      let low = 1, high = 160;
      if (gone(project(view, [0, sign * high, 0]))) {
        for (let i = 0; i < 24; i++) {
          const middle = (low + high) / 2;
          if (gone(project(view, [0, sign * middle, 0]))) high = middle;
          else low = middle;
        }
      }
      length = Math.max(length, high);
    }
    return length;
  }

  // How wide it swells: until the screen lies inside it.
  function engulf(view, length, thin, width, height) {
    let low = thin, high = view.rho * 0.995;
    if (!covers(view, length, high, width, height)) return high;
    for (let i = 0; i < 28; i++) {
      const middle = (low + high) / 2;
      if (covers(view, length, middle, width, height)) high = middle;
      else low = middle;
    }
    return high;
  }

  function measure(button) {
    const width = window.innerWidth, height = window.innerHeight;
    let spot = window.SiteBlackHole?.jetCamera?.();
    if (!['x', 'y', 'roll', 'inclination', 'azimuth', 'distance', 'focal', 'scale'].every(key => Number.isFinite(spot?.[key]))) {
      // Pages without a black hole start the beam at the toggle.
      const box = button?.getBoundingClientRect?.();
      spot = {
        ...toggleCamera,
        x: box?.width ? box.left + box.width / 2 : width / 2,
        y: box?.width ? box.top + box.height / 2 : height / 2,
        scale: Math.max(width, height) * 0.45,
      };
    }
    const view = lens(spot);
    // About 26 px in radius once the beam has flown out of the hole.
    const thin = 26 / (view.focal / view.distance * view.scale);
    const length = reach(view, width, height);
    return { view, thin, length, wide: engulf(view, length, thin, width, height) };
  }

  let session = null;
  let time = 0;
  let heading = 0; // +1 towards day, -1 towards night, 0 at rest.
  let frame = 0;
  let last = 0;
  let overlay = null;
  let canvas = null;

  function form(state) {
    const shot = easeOut(clamp(time / shoot));
    const swelling = clamp((time - swellFrom) / swell);
    return {
      length: state.length * shot,
      // A needle that thickens as it flies, then a wall that speeds up as it
      // comes towards the camera.
      radius: state.thin * (0.2 + 0.8 * shot) + (state.wide - state.thin) * swelling ** 2.4,
      developing: clamp((time - whiteOut) / develop),
    };
  }

  function polygon(points) {
    if (!points || points.length < 3) return 'polygon(0 0, 0 0, 0 0)';
    return `polygon(${points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`;
  }

  // The beam is solid white, so nothing shows through it. Once it fills the
  // screen, the white lifts off the day page.
  function paint(edge, developing) {
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = window.innerWidth, height = window.innerHeight;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fff';
    if (developing !== null) {
      context.globalAlpha = 1 - smooth(0, 1, developing);
      context.fillRect(0, 0, width, height);
      context.globalAlpha = 1;
    } else if (edge) {
      const beam = new Path2D();
      edge.forEach(([x, y], i) => (i ? beam.lineTo(x, y) : beam.moveTo(x, y)));
      beam.closePath();
      context.fill(beam);
    }
  }

  function draw() {
    const state = session;
    const shape = form(state);
    // From the white-out on, the day page lies whole beneath the white;
    // before it, the day image is clipped to the beam that covers it.
    const whole = shape.radius >= state.wide || shape.developing > 0;
    const edge = whole ? null : outline(state.view, shape.length, shape.radius);
    if (state.clip) {
      const clip = whole ? 'none' : polygon(edge);
      state.clip.effect.setKeyframes([{ clipPath: clip }, { clipPath: clip }]);
    }
    paint(edge, whole ? shape.developing : null);
  }

  // While both themes share the screen, the page must not move under the
  // frozen one; scrolling waits until the switch is done.
  function holdScroll(event) {
    if (event.type === 'keydown' && !scrollKeys.has(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function listen(add) {
    for (const type of ['wheel', 'touchmove', 'keydown']) {
      window[add ? 'addEventListener' : 'removeEventListener'](type, holdScroll, { capture: true, passive: false });
    }
  }

  function mount() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'theme-jets';
      overlay.setAttribute('aria-hidden', 'true');
      canvas = document.createElement('canvas');
      overlay.append(canvas);
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
    document.body.append(overlay);
  }

  function end() {
    const state = session;
    session = null;
    heading = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    listen(false);
    overlay.remove();
    // Both images now match the live page, which takes over seamlessly.
    if (state.ready) state.transition.skipTransition();
    // The clip and the kick are set on the root for its transition
    // pseudo-elements, so they would outlive this transition and act on the
    // next one's page images.
    state.clip?.cancel();
    state.kick?.cancel();
    if (state.queued && state.queued !== theme.current) request(state.queued);
  }

  // The day page has developed, or the beam has gone back into the hole. A
  // switch reversed midway restyled the page for the other theme at its
  // click: restyle it back while the final theme's image covers the screen,
  // and let the black hole redraw before the live page shows again.
  function settle() {
    const state = session;
    const final = heading > 0 ? 'light' : 'dark';
    state.ending = true;
    if (theme.current === final) {
      end();
      return;
    }
    theme.set(final);
    const counter = window.SiteBlackHole?.drawn;
    const drawn = counter?.() ?? null;
    let waited = 0;
    const wait = () => {
      if (session !== state) return;
      waited++;
      if ((waited > 1 && (drawn === null || counter() > drawn)) || waited > 12) end();
      else frame = requestAnimationFrame(wait);
    };
    frame = requestAnimationFrame(wait);
  }

  function step() {
    frame = 0;
    const now = performance.now();
    // A long frame holds the beam instead of skipping part of the motion.
    const delta = Math.min(now - last, 50) * pace;
    last = now;
    time = Math.min(total, Math.max(0, time + heading * delta));
    draw();
    if (time === (heading > 0 ? total : 0)) settle();
    else frame = requestAnimationFrame(step);
  }

  function begin(next, button) {
    const opening = next === 'light';
    // The day page lies under the beam: the new image while opening, the
    // old one while closing. Around the beam the night page shows.
    const state = { ...measure(button), dayImage: opening ? 'new' : 'old', ready: false, clip: null, kick: null, ending: false, queued: null };
    session = state;
    time = opening ? 0 : total;
    heading = opening ? 1 : -1;
    root.classList.remove('is-theme-jets-opening', 'is-theme-jets-closing');
    root.classList.add('is-theme-jets', opening ? 'is-theme-jets-opening' : 'is-theme-jets-closing');
    listen(true);
    mount();
    state.transition = document.startViewTransition(() => theme.set(next));
    state.transition.ready.then(() => {
      if (session !== state) return;
      state.clip = root.animate([{ clipPath: 'none' }, { clipPath: 'none' }], {
        pseudoElement: `::view-transition-${state.dayImage}(root)`, duration: 1000, fill: 'both',
      });
      state.clip.pause();
      // As the beam fires, the night page kicks towards the camera around
      // the hole, then settles.
      if (opening) {
        const origin = `${state.view.x}px ${state.view.y}px`;
        state.kick = root.animate([
          { transformOrigin: origin, transform: 'scale(1)' },
          { transformOrigin: origin, transform: 'scale(1.018)', offset: 0.16 },
          { transformOrigin: origin, transform: 'scale(1)' },
        ], { pseudoElement: '::view-transition-old(root)', duration: 360 / pace, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
      }
      state.ready = true;
      // The restyle pause does not count towards the motion.
      last = performance.now();
      draw();
      frame = requestAnimationFrame(step);
    }, () => {
      // The browser skipped the transition; the theme has changed anyway.
      if (session === state) end();
    });
    // A switch that follows at once may already have taken these classes.
    state.transition.finished.catch(() => {}).then(() => {
      if (!session) root.classList.remove('is-theme-jets', 'is-theme-jets-opening', 'is-theme-jets-closing');
    });
  }

  function crossfade(next) {
    root.classList.add('is-theme-fade');
    document.startViewTransition(() => theme.set(next)).finished.catch(() => {})
      .then(() => root.classList.remove('is-theme-fade'));
  }

  function request(next, button) {
    if (session) {
      if (session.ending) session.queued = next;
      else heading = next === 'light' ? 1 : -1;
      return;
    }
    if (next === theme.current) return;
    if (typeof document.startViewTransition !== 'function') theme.set(next);
    else if (reducedMotion.matches) crossfade(next);
    else begin(next, button);
  }

  theme.useSwitcher({
    request,
    get target() {
      if (session?.queued) return session.queued;
      return heading > 0 ? 'light' : heading < 0 ? 'dark' : null;
    },
  });
})();
