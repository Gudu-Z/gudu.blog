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
  const flatClock = { shoot, swellFrom, swell, develop, whiteOut, total };
  // The solid beam (?beam=3d, while it is a prototype) is drawn inside the
  // hero's own scene: a column that passes behind the disk's near side,
  // bends round the hole and shows the day page itself inside it. It needs
  // no white-out: once the column has swallowed the screen, the day page is
  // simply there.
  const deepClock = { shoot: 300, swellFrom: 330, swell: 760, develop: 0, whiteOut: 1090, total: 1090 };
  const query = new URLSearchParams(window.location.search);
  // ?jets=slow plays the switch at a tenth of its speed, to study it, and
  // ?beamhold=<ms> stops it that far along its timeline.
  const pace = query.get('jets') === 'slow' ? 0.1 : 1;
  const wantsDeep = query.get('beam') === '3d';
  const holdAt = query.has('beamhold') ? Number(query.get('beamhold')) : NaN;
  // For now the solid beam stops once it has fired and flickered, so the
  // beam itself can be settled before its swell; ?swell=1 plays the swell.
  // A second click sends it back into the hole.
  const beamOnly = wantsDeep && query.get('swell') !== '1';
  const stand = 330;
  if (wantsDeep) window.SiteBlackHole?.prepareBeam?.();
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

  // The solid beam: a column that widens by `taper` per Rs of height from
  // its radius at the disk, with a rounded end each way, `cap` end radii
  // long. Seen along straight lines, its outline is the hull of these points.
  function solid(length, radius, taper, cap, count = 64) {
    const points = [];
    for (const side of [1, -1]) {
      const end = radius * Math.max(0, 1 + taper * side * length);
      for (const along of [0, 0.3, 0.55, 0.75, 0.9, 0.98]) {
        const ring = end * Math.sqrt(1 - along * along), height = side * (length + end * cap * along);
        for (let i = 0; i < count; i++) {
          const turn = i / count * Math.PI * 2;
          points.push([ring * Math.cos(turn), height, ring * Math.sin(turn)]);
        }
      }
      points.push([0, side * (length + end * cap), 0]);
    }
    return points;
  }

  // How far inside the solid beam a scene point lies, in Rs; negative
  // outside. The scene's shader (beamSource in js/black-hole.js) has the same.
  function depthIn(point, length, radius, taper, cap, ball = 0) {
    const across = Math.hypot(point[0], point[2]);
    const outside = Math.hypot(...point) - ball;
    let wide = radius * Math.max(0, 1 + taper * Math.max(-length, Math.min(length, point[1])));
    const over = Math.abs(point[1]) - length;
    if (over > 0) {
      const reach = Math.max(wide * cap, 0.0001);
      if (over >= reach) return Math.min(reach - over - across, outside);
      wide *= Math.sqrt(1 - over * over / (reach * reach));
    }
    return Math.min(wide - across, outside);
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
  function outline(view, length, radius, taper = 0, cap = 0) {
    const points = [];
    for (const point of (taper || cap ? solid(length, radius, taper, cap) : rims(length, radius))) {
      const page = project(view, point);
      if (!page) return null;
      points.push(page);
    }
    return hull(points);
  }

  function covers(view, length, radius, width, height, taper = 0, cap = 0) {
    const shape = outline(view, length, radius, taper, cap);
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
  function engulf(view, length, thin, width, height, taper = 0, cap = 0) {
    let low = thin, high = view.rho * 0.995;
    if (!covers(view, length, high, width, height, taper, cap)) return high;
    for (let i = 0; i < 28; i++) {
      const middle = (low + high) / 2;
      if (covers(view, length, middle, width, height, taper, cap)) high = middle;
      else low = middle;
    }
    return high;
  }

  // The column stands on the disk, which the eye reads as tilted towards
  // it far more than the 9° it really is: the arc above the hole is the
  // disk's far side, lifted by the hole's gravity. Through the scene's long
  // lens a true cylinder's top would be only about 7% wider than its foot,
  // so the column itself widens with height until, from one edge of the
  // screen to the other, its top is `target` times as wide as its foot.
  // The aim is set a little above the 1.25 wanted: across rows of the page the
  // tilted column measures about 6% less than this along-axis estimate.
  function taperFor(view, width, height, length, target = 1.33) {
    const depth = at => dot([-view.eye[0], at - view.eye[1], -view.eye[2]], view.forward);
    const gone = page => !page || page[0] < 0 || page[0] > width || page[1] < 0 || page[1] > height;
    const edge = sign => {
      let low = 0, high = 160;
      for (let i = 0; i < 24; i++) {
        const middle = (low + high) / 2;
        if (gone(project(view, [0, sign * middle, 0]))) high = middle;
        else low = middle;
      }
      return sign * low;
    };
    const top = edge(1), foot = edge(-1);
    if (!(top > 0) || !(foot < 0)) return 0;
    const wanted = target * depth(top) / depth(foot);
    // The narrow end keeps at least a third of the radius, however long.
    return Math.max(0, Math.min((wanted - 1) / (top - wanted * foot), 0.65 / length));
  }

  // The page's background behind the hole in each theme, as the hero paints
  // it (css/style.css): --space under a faint glow centred at 70% 58%.
  // The solid beam's edge frays this deep, in Rs, and the daylight inside it
  // is a little dimmer and cooler than the day page: this colour over it, at
  // this strength (paper 235,238,240 comes out about 207,215,226).
  const beamFray = 0.16;
  const beamTint = [35 / 255, 75 / 255, 140 / 255, 0.14];

  function papers(view) {
    const colour = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
    const [paper, night] = (getComputedStyle(root).getPropertyValue('--space').match(/#[0-9a-f]{6}/gi) || ['#eef0f2', '#080b10']).map(colour);
    const stage = document.querySelector('#hero-stage')?.getBoundingClientRect();
    let glow = 0;
    if (stage?.width) {
      const cx = stage.width * 0.7, cy = stage.height * 0.58;
      const rx = Math.max(cx, stage.width - cx) * Math.SQRT2, ry = Math.max(cy, stage.height - cy) * Math.SQRT2;
      const far = Math.hypot((view.x - stage.left - cx) / rx, (view.y - stage.top - cy) / ry);
      glow = Math.max(0, 1 - far / 0.48) * (0x16 / 255);
    }
    const tint = (base, hex) => base.map((value, i) => value + (colour(hex)[i] - value) * glow);
    return { paper: tint(paper, '#c6d1da'), night: tint(night, '#14232e') };
  }

  function measure(button, solidBeam = false) {
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
    if (!solidBeam) return { view, thin, length, wide: engulf(view, length, thin, width, height) };
    // Each rounded end is 0.42 of its radius long: the far rim of an end
    // seen from about 25° above, as the tilted disk suggests.
    const taper = taperFor(view, width, height, length), cap = 0.42;
    // Once fired the beam is about 0.7 as wide as the hole's shadow looks
    // (2.6 Rs across its radius). Both jets rise out of a dark ball round
    // the hole, a little smaller than that shadow, so the upper jet's foot
    // rests about halfway down the shadow and the lower jet stays behind it.
    const ball = 2.2, stand = 0.68 * 2.6;
    return {
      view, thin, length, taper, cap, ball, stand,
      wide: engulf(view, length, stand, width, height, taper, cap), ...papers(view), sparks: sparks(),
    };
  }

  let session = null;
  let time = 0;
  let heading = 0; // +1 towards day, -1 towards night, 0 at rest.
  let frame = 0;
  let last = 0;
  let overlay = null;
  let canvas = null;

  function form(state) {
    const clock = state.clock;
    const shot = easeOut(clamp(time / clock.shoot));
    const swelling = clamp((time - clock.swellFrom) / clock.swell);
    // A needle that thickens as it flies, then a wall that speeds up as it
    // comes towards the camera.
    const base = state.deep ? state.stand : state.thin;
    const radius = base * (0.2 + 0.8 * shot) + (state.wide - base) * swelling ** 2.4;
    // The screen's roll tips each end's rim, so a wide solid beam reaches
    // further, to keep its ends off the screen.
    const reach = state.deep ? radius * 0.6 * (1 + state.taper * state.length) : 0;
    return {
      length: state.length * shot + reach,
      radius,
      swelling,
      developing: clock.develop ? clamp((time - clock.whiteOut) / clock.develop) : 0,
    };
  }

  // Inside the solid beam the day page flickers on like a tube being lit:
  // pure white as it fires, then a few uneven beats before it holds.
  function flicker(at) {
    const beats = [1, 1, 0.3, 0.9, 0.18, 0.62, 0.08, 0.3];
    return beats[Math.floor(at / 36)] ?? 0;
  }

  // Sparks stream out of each jet's foot, where it leaves the dark ball, and
  // run up parallel to its wall, picking up speed as they go. Seeded, so
  // every switch throws the same ones.
  function sparks(count = 600) {
    let seed = 7;
    const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    return Array.from({ length: count }, (_, index) => ({
      side: index % 2 ? 1 : -1,
      turn: next() * Math.PI * 2,
      // How far off the wall, as a share of its radius, all the way up:
      // most run close to it, a few up to half a radius out.
      hug: 0.03 + 0.5 * next() ** 2,
      // Top speed in Rs per millisecond, the pause before it sets off again,
      // and when it first sets off once the beam has fired, as a share of
      // sparkSpread.
      top: 0.009 + 0.005 * next(),
      lag: 260 * next(),
      born: next(),
      light: 0.35 + 0.65 * next(),
      weight: 0.9 + 0.9 * next(),
    }));
  }
  // Milliseconds: when the first sparks leave, over how long the rest
  // follow, how long each takes to come up to speed, and the stretch of its
  // own path each one's streak shows.
  const sparkStart = 120, sparkSpread = 1000, sparkRamp = 220, sparkTrail = 70;
  // How far a spark has run from its jet's foot, in Rs, `age` ms after leaving it.
  const sparkTravel = (spark, age) => spark.top * (age - sparkRamp * (1 - Math.exp(-age / sparkRamp)));

  // How high each jet's foot stands: where the column's wall meets the dark
  // ball's face (at the ball's top if the column is too thin to reach it).
  function footOf(length, radius, taper, ball, side) {
    const wall = y => radius * Math.max(0, 1 + taper * Math.max(-length, Math.min(length, side * y)));
    const miss = y => y * y + wall(y) ** 2 - ball * ball;
    if (miss(0) >= 0) return 0;
    let low = 0, high = ball;
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (miss(middle) < 0) low = middle;
      else high = middle;
    }
    return high;
  }

  // Whether the straight line from + direction·t, t from `low` to `high`,
  // passes through the beam. Only the stretch near the axis can.
  function crosses(from, direction, low, high, beam) {
    const widest = beam.radius * (1 + Math.abs(beam.taper) * beam.length) * 1.01;
    const a = direction[0] ** 2 + direction[2] ** 2;
    const b = from[0] * direction[0] + from[2] * direction[2];
    const c = from[0] ** 2 + from[2] ** 2 - widest * widest;
    if (a > 1e-9) {
      const reach = b * b - a * c;
      if (reach <= 0) return false;
      low = Math.max(low, (-b - Math.sqrt(reach)) / a);
      high = Math.min(high, (-b + Math.sqrt(reach)) / a);
    } else if (c > 0) return false;
    for (let i = 0; i <= 40 && low < high; i++) {
      const t = low + (high - low) * i / 40;
      const point = [0, 1, 2].map(axis => from[axis] + direction[axis] * t);
      if (depthIn(point, beam.length, beam.radius, beam.taper, beam.cap, beam.ball) > 0) return true;
    }
    return false;
  }

  function paintSparks(state, shape, edge) {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!edge) return;
    const { view, taper, cap, ball } = state;
    const beam = { length: shape.length, radius: shape.radius, taper, cap, ball };
    const wall = at => shape.radius * Math.max(0, 1 + taper * Math.max(-shape.length, Math.min(shape.length, at)));
    // They thin out as the wall comes up to the camera.
    const fade = 1 - smooth(0.5, 0.95, shape.swelling);
    context.lineCap = 'round';
    // Their own clock runs on while the beam stands still: each leaves its
    // jet's foot in turn, runs up to the beam's end and, after a pause, leaves
    // the foot again.
    const run = (performance.now() - state.startedAt) * pace;
    const feet = { 1: footOf(shape.length, shape.radius, taper, ball, 1), [-1]: footOf(shape.length, shape.radius, taper, ball, -1) };
    for (const spark of state.sparks) {
      const foot = feet[spark.side], climb = shape.length - foot;
      if (climb <= 0.5) continue;
      const since = run - sparkStart - spark.born * sparkSpread;
      if (since <= 0) continue;
      const life = climb / spark.top + sparkRamp;
      const age = since % (life + spark.lag);
      const travelled = sparkTravel(spark, age);
      // None outruns the beam's own end.
      if (travelled >= climb) continue;
      const place = along => {
        const at = spark.side * (foot + along);
        const off = wall(at) * (1 + spark.hug);
        return [off * Math.cos(spark.turn), at, off * Math.sin(spark.turn)];
      };
      const head = place(travelled), tail = place(sparkTravel(spark, Math.max(0, age - sparkTrail)));
      const from = project(view, tail), to = project(view, head);
      if (!from || !to) continue;
      // Hidden behind the beam, or under the disk's near side, as the eye
      // sees them along a straight line.
      const sight = [head[0] - view.eye[0], head[1] - view.eye[1], head[2] - view.eye[2]];
      let hidden = crosses(view.eye, sight, 0, 0.985, beam);
      if (!hidden && head[1] < 0 && view.eye[1] > 0) {
        const share = view.eye[1] / (view.eye[1] - head[1]);
        const across = Math.hypot(view.eye[0] + sight[0] * share, view.eye[2] + sight[2] * share);
        hidden = across > 3 && across < 10.4;
      }
      if (hidden) continue;
      // Over the night they are its light. Over the day page they are its ink,
      // at half strength: dark streaks lying along the wall would read as its
      // outline.
      const day = contains(edge, to);
      const color = day ? '62,51,32' : '193,204,223';
      // Each comes out of the foot and fades before the beam's end.
      const alive = smooth(0, 0.1, travelled / climb) * (1 - smooth(0.7, 1, travelled / climb));
      context.strokeStyle = `rgba(${color},${(spark.light * fade * alive * (day ? 0.5 : 1)).toFixed(3)})`;
      context.lineWidth = spark.weight;
      context.beginPath();
      context.moveTo(from[0], from[1]);
      context.lineTo(to[0], to[1]);
      context.stroke();
    }
  }

  // The solid beam: the scene draws it, with the disk in front where it
  // should be, and the page's own layers are clipped to its plain outline.
  function drawDeep(state, shape) {
    const scene = window.SiteBlackHole;
    const whole = shape.radius >= state.wide;
    const drawn = scene?.beam?.({
      radius: shape.radius, length: shape.length, taper: state.taper, cap: state.cap, ball: state.ball, zone: [5, 8.5],
      fray: beamFray, night: state.night, paper: state.paper, flash: [1, 1, 1, flicker(time)],
      // The tint lifts as the beam swells, so the day page it leaves is the page's own.
      tint: [...beamTint.slice(0, 3), beamTint[3] * (1 - shape.swelling)],
    });
    // The page's clip moves only with a frame the scene has drawn, or the
    // two would part while the GPU is busy.
    if (!drawn && state.shown && scene?.beamReady?.()) return;
    state.shown = true;
    const edge = whole ? null : outline(state.view, shape.length, shape.radius, state.taper, state.cap);
    if (state.clip) {
      const clip = whole ? 'none' : polygon(edge);
      state.clip.effect.setKeyframes([{ clipPath: clip }, { clipPath: clip }]);
    }
    paintSparks(state, shape, edge);
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
    if (state.deep) { drawDeep(state, shape); return; }
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
    // The scene goes back to drawing one theme throughout.
    if (state.deep) window.SiteBlackHole?.beam?.(null);
    // Both images now match the live page, which takes over seamlessly.
    if (state.ready) state.transition.skipTransition();
    // The clip and the kick are set on the root for its transition
    // pseudo-elements, so they would outlive this transition and act on the
    // next one's page images.
    state.clip?.cancel();
    state.kick?.cancel();
    state.sceneKick?.cancel();
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
    const whole = session.clock.total;
    // ?beamhold stops a switch part-way either way, where it can be studied.
    let limit = whole;
    if (heading > 0 && Number.isFinite(holdAt)) limit = Math.min(whole, holdAt);
    else if (heading > 0 && beamOnly && session.deep) limit = stand;
    const floor = heading < 0 && Number.isFinite(holdAt) ? Math.max(0, Math.min(whole, holdAt)) : 0;
    time = Math.min(limit, Math.max(floor, time + heading * delta));
    draw();
    if (time === (heading > 0 ? whole : 0)) settle();
    else frame = requestAnimationFrame(step);
  }

  function begin(next, button) {
    const opening = next === 'light';
    // The day page lies under the beam: the new image while opening, the
    // old one while closing. Around the beam the night page shows.
    // On the hero, with the live scene ready for it, the beam is the solid one.
    const solidBeam = wantsDeep && Boolean(window.SiteBlackHole?.beamReady?.());
    const state = {
      ...measure(button, solidBeam), clock: solidBeam ? deepClock : flatClock, deep: solidBeam, shown: false,
      dayImage: opening ? 'new' : 'old', ready: false, clip: null, kick: null, ending: false, queued: null,
    };
    session = state;
    state.startedAt = performance.now();
    time = opening ? (Number.isFinite(holdAt) ? Math.min(state.clock.total, Math.max(0, holdAt)) : 0)
      : beamOnly && solidBeam ? stand : state.clock.total;
    heading = opening ? 1 : -1;
    root.classList.remove('is-theme-jets-opening', 'is-theme-jets-closing');
    root.classList.add('is-theme-jets', opening ? 'is-theme-jets-opening' : 'is-theme-jets-closing');
    // The scene's canvas becomes its own image, live above both pages.
    if (solidBeam) root.classList.add('is-theme-jets-solid');
    else root.classList.remove('is-theme-jets-solid');
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
        // The solid beam's scene is a layer of its own and kicks with the page.
        const box = state.deep ? document.querySelector('#black-hole-canvas')?.getBoundingClientRect() : null;
        if (box?.width) {
          const near = `${state.view.x - box.left}px ${state.view.y - box.top}px`;
          state.sceneKick = root.animate([
            { transformOrigin: near, transform: 'scale(1)' },
            { transformOrigin: near, transform: 'scale(1.018)', offset: 0.16 },
            { transformOrigin: near, transform: 'scale(1)' },
          ], { pseudoElement: '::view-transition-new(theme-jets-scene)', duration: 360 / pace, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
        }
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
      if (!session) root.classList.remove('is-theme-jets', 'is-theme-jets-opening', 'is-theme-jets-closing', 'is-theme-jets-solid');
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
