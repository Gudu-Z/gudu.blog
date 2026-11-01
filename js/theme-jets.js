/* Day/night switch. A column of the other theme shoots out of the black
 * hole along its spin axis, then swells until the screen lies inside it;
 * inside the column the page already wears the new theme, the site's
 * inverted look. Switching back plays the column in reverse, and a toggle
 * midway reverses it from where it is. One view transition holds both
 * themes for the whole switch, so the page restyles once, at the click.
 * The column is projected through the scene's own camera and shaded as a
 * lit cylinder, with fine lines for its end rims. Reduced motion
 * crossfades; without view transitions the theme changes at once. */
(() => {
  'use strict';

  const theme = window.SiteTheme;
  if (!theme?.useSwitcher) return;
  const root = document.documentElement;
  // Milliseconds along the timeline: night at 0, day at its end. The column
  // shoots out, then swells, starting before its shot has quite finished.
  const shoot = 380, swell = 620;
  const swellFrom = shoot * 0.8;
  const total = swellFrom + swell;
  // ?jets=slow plays the switch at a tenth of its speed, to study it.
  const pace = new URLSearchParams(window.location.search).get('jets') === 'slow' ? 0.1 : 1;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
  // The hero's scene camera, for pages without a black hole. Its column
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
      // Where the camera stands round the axis, to tell the column's near wall.
      phi: Math.atan2(eye[2], eye[0]), rho: Math.hypot(eye[0], eye[2]),
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
  // perspective images is the column's outline on the page.
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
    // A rim behind the camera: the column already reaches past it.
    if (!shape) return true;
    return [[-24, -24], [width + 24, -24], [width + 24, height + 24], [-24, height + 24]].every(corner => contains(shape, corner));
  }

  // How long the column grows: until both of its ends are off the screen.
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
    // The black shadow's radius in Schwarzschild radii (3√3/2): it keeps the
    // column's start, unshaded, and the rims show only beyond it.
    let hide = 2.6;
    if (!['x', 'y', 'roll', 'inclination', 'azimuth', 'distance', 'focal', 'scale'].every(key => Number.isFinite(spot?.[key]))) {
      // Pages without a black hole start the column at the toggle.
      const box = button?.getBoundingClientRect?.();
      spot = {
        ...toggleCamera,
        x: box?.width ? box.left + box.width / 2 : width / 2,
        y: box?.width ? box.top + box.height / 2 : height / 2,
        scale: Math.max(width, height) * 0.45,
      };
      hide = 0;
    }
    const view = lens(spot);
    // The shadow's radius on the page. Light that passes the hole closer than
    // the critical impact parameter falls in; from the camera's distance r
    // that edge lies asin(b / r * sqrt(1 - 1 / r)) off the hole's centre.
    // One pixel more keeps the shading clear of its rim.
    const shadow = hide && Math.tan(Math.asin(hide / view.distance * Math.sqrt(1 - 1 / view.distance)))
      * view.focal * view.scale + 1;
    // About 26 px in radius where the column leaves the hole.
    const thin = 26 / (view.focal / view.distance * view.scale);
    const length = reach(view, width, height);
    return { view, hide, shadow, thin, length, wide: engulf(view, length, thin, width, height) };
  }

  let session = null;
  let time = 0;
  let heading = 0; // +1 towards day, -1 towards night, 0 at rest.
  let frame = 0;
  let last = 0;
  let overlay = null;
  let lines = null;

  function form(state) {
    const swelling = clamp((time - swellFrom) / swell);
    return {
      length: state.length * easeOut(clamp(time / shoot)),
      // Easing in, the wall speeds up as it comes towards the camera.
      radius: state.thin * easeOut(clamp(time / 60)) + (state.wide - state.thin) * swelling ** 2.4,
      swelling,
    };
  }

  function polygon(points) {
    if (!points || points.length < 3) return 'polygon(0 0, 0 0, 0 0)';
    return `polygon(${points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`;
  }

  // The column is lit as a solid cylinder: darker towards both edges, where
  // its wall turns away from the camera, with a soft highlight a third of
  // the way across. The shading lies across the column where it leaves the
  // hole, leaves the black shadow untouched, and fades as the column swells
  // past the screen, so the day page is left as it is.
  function shade(context, state, edge, radius, swelling) {
    const strength = smooth(0, 120, time) * (1 - smooth(0.45, 0.92, swelling));
    if (strength < 0.01 || !edge) return;
    const { view } = state;
    // The wall's two silhouette lines, where the camera's sight grazes it.
    const graze = Math.acos(Math.min(1, radius / view.rho));
    const [from, to] = [graze, -graze].map(turn =>
      project(view, [radius * Math.cos(view.phi + turn), 0, radius * Math.sin(view.phi + turn)]));
    if (!from || !to) return;
    const dark = context.createLinearGradient(from[0], from[1], to[0], to[1]);
    const light = context.createLinearGradient(from[0], from[1], to[0], to[1]);
    for (let i = 0; i <= 40; i++) {
      const across = i / 40, edgeward = Math.abs(2 * across - 1);
      const highlight = Math.exp(-(((across - 0.33) / 0.075) ** 2));
      dark.addColorStop(across, `rgba(8, 11, 16, ${(0.34 * edgeward ** 2.2 * (1 - highlight) * strength).toFixed(4)})`);
      light.addColorStop(across, `rgba(255, 255, 255, ${(0.75 * highlight * strength).toFixed(4)})`);
    }
    const column = new Path2D();
    edge.forEach(([x, y], i) => (i ? column.lineTo(x, y) : column.moveTo(x, y)));
    column.closePath();
    context.save();
    if (state.shadow) {
      const outside = new Path2D();
      outside.rect(-1, -1, window.innerWidth + 2, window.innerHeight + 2);
      outside.arc(view.x, view.y, state.shadow, 0, Math.PI * 2);
      context.clip(outside, 'evenodd');
    }
    context.fillStyle = dark;
    context.fill(column);
    context.fillStyle = light;
    context.fill(column);
    context.restore();
  }

  // Fine lines mark the column's two end rims, firm on the near side and
  // faint on the far one. They come in with the column and thin out as it
  // swells past the screen.
  function paint(state, { length, radius, swelling }, edge) {
    const context = lines.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    shade(context, state, edge, radius, swelling);
    const strength = smooth(20, 140, time) * (1 - smooth(0.4, 0.8, swelling));
    if (strength < 0.01 || length <= state.hide + 0.2) return;
    const { view } = state;
    const near = new Path2D(), far = new Path2D();
    const facing = turn => view.rho * Math.cos(turn - view.phi) > radius;
    const line = (turn, from, to) => {
      const path = facing(turn) ? near : far;
      path.moveTo(from[0], from[1]);
      path.lineTo(to[0], to[1]);
    };
    for (const height of [length, -length]) {
      let previous = null;
      for (let i = 0; i <= 64; i++) {
        const turn = i / 64 * Math.PI * 2;
        const page = project(view, [radius * Math.cos(turn), height, radius * Math.sin(turn)]);
        if (previous && page) line(turn, previous, page);
        previous = page;
      }
    }
    context.lineWidth = 1;
    context.strokeStyle = `rgba(24, 27, 32, ${0.34 * strength})`;
    context.stroke(near);
    context.strokeStyle = `rgba(24, 27, 32, ${0.12 * strength})`;
    context.stroke(far);
  }

  function draw() {
    const state = session;
    const shape = form(state);
    const edge = shape.radius >= state.wide ? null : outline(state.view, shape.length, shape.radius);
    if (state.clip) {
      const clip = shape.radius >= state.wide ? 'none' : polygon(edge);
      state.clip.effect.setKeyframes([{ clipPath: clip }, { clipPath: clip }]);
    }
    paint(state, shape, edge);
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
      lines = document.createElement('canvas');
      overlay.append(lines);
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    lines.width = Math.round(window.innerWidth * ratio);
    lines.height = Math.round(window.innerHeight * ratio);
    lines.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
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
    // The clip is set on the root for its transition pseudo-element, so it
    // would outlive this transition and clip the next one's page image.
    state.clip?.cancel();
    if (state.queued && state.queued !== theme.current) request(state.queued);
  }

  // The column has filled the screen or gone back into the hole. A switch
  // reversed midway restyled the page for the other theme at its click:
  // restyle it back while the final theme's image covers the screen, and
  // let the black hole redraw before the live page shows again.
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
    // A long frame holds the column instead of skipping part of the motion.
    const delta = Math.min(now - last, 50) * pace;
    last = now;
    time = Math.min(total, Math.max(0, time + heading * delta));
    draw();
    if (time === (heading > 0 ? total : 0)) settle();
    else frame = requestAnimationFrame(step);
  }

  function begin(next, button) {
    const opening = next === 'light';
    // The day page fills the column: the new image while opening, the old
    // one while closing.
    const state = { ...measure(button), dayImage: opening ? 'new' : 'old', ready: false, clip: null, ending: false, queued: null };
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
