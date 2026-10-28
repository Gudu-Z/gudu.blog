(() => {
  'use strict';

  const root = document.querySelector('#category-surface');
  if (!root) return;

  const duration = 1800;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const viewport = document.querySelector('#chapter-viewport');
  const hasObserver = typeof IntersectionObserver === 'function';
  let pageActive = true;
  let chaptersVisible = contentVisible();
  let frame = 0;

  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => {
    const p = clamp(value);
    return p * p * (3 - 2 * p);
  };

  function contentVisible() {
    const classes = document.documentElement.classList;
    return !classes.contains('has-chapters') || classes.contains('is-content');
  }

  function makeScene(element, draw) {
    draw(0);
    return { element, draw, phase: 0, target: 0, from: 0, startedAt: 0, hovered: false, visible: !hasObserver };
  }

  function createWords(element) {
    if (!element) return null;
    const lines = element.querySelector('.category-word-lines');
    const depth = element.querySelector('.category-art-depth');
    const bracket = element.querySelector('.category-word-bracket');
    if (!lines || !depth || !bracket) return null;

    const rows = [86, 59, 91, 68, 42, 72].map((width, row) => {
      const strip = document.createElement('span');
      strip.className = 'category-word-row';
      strip.style.width = `${width}px`;
      strip.style.opacity = '.70';
      const cipher = document.createElement('span');
      cipher.className = 'category-word-cipher';
      const decoded = document.createElement('span');
      decoded.className = 'category-word-decoded';
      strip.append(cipher, decoded);
      return { strip, cipher, decoded, row };
    });
    const scanner = document.createElement('span');
    scanner.className = 'category-word-scanner';
    lines.replaceChildren(...rows.map(row => row.strip), scanner);
    bracket.style.opacity = '.30';

    return makeScene(element, phase => {
      const p = clamp(phase);
      const scanY = -12 + 92 * p;
      // One scan position drives the hinge and decoding together, including
      // when a pointer leaves before the pass has finished.
      for (const { strip, cipher, decoded, row } of rows) {
        const read = smooth((scanY - row * 12 + 12) / 24);
        const lift = Math.sin(read * Math.PI);
        strip.style.transform = `translate3d(0,${row * 12}px,${22 * lift}px) rotateX(${-68 * lift}deg)`;
        cipher.style.opacity = String(1 - read);
        decoded.style.opacity = String(read);
      }
      depth.style.transform = `rotateX(${5 + 9 * p}deg) rotateY(${18 - 48 * p}deg) rotateZ(${-4 + 7 * p}deg)`;
      scanner.style.transform = `translate3d(0,${scanY}px,25px)`;
      scanner.style.opacity = String(.58 * smooth(p / .08) * smooth((1 - p) / .18));
    });
  }

  function createNetwork(element) {
    if (!element) return null;
    const nodes = [...element.querySelectorAll('.category-node')];
    const edges = [...element.querySelectorAll('.category-node-line')];
    const ring = element.querySelector('.category-node-ring');
    const dot = element.querySelector('.category-art-dot');
    if (nodes.length !== 5 || edges.length !== 4 || !ring || !dot) return null;

    const space = [[-40, -37, -20], [38, -40, 20], [0, 0, 8], [-36, 42, 20], [40, 37, -20]];
    const sizes = [9, 8, 12, 8, 9];
    const connections = [[0, 2], [2, 1], [2, 3], [2, 4]];
    const radians = Math.PI / 180;
    nodes.forEach((node, index) => {
      node.style.width = `${sizes[index]}px`;
      node.style.height = `${sizes[index]}px`;
    });
    ring.style.transform = 'scale(.55)';
    ring.style.opacity = '.13';
    dot.style.zIndex = '150';

    return makeScene(element, phase => {
      const rx = (12 - 36 * phase) * radians;
      const ry = (-18 + 128 * phase) * radians;
      const rz = (-7 + 47 * phase) * radians;
      const points = space.map(([x, y, z]) => {
        const y1 = y * Math.cos(rx) - z * Math.sin(rx);
        const z1 = y * Math.sin(rx) + z * Math.cos(rx);
        const x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
        const z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
        const xx = x2 * Math.cos(rz) - y1 * Math.sin(rz);
        const yy = x2 * Math.sin(rz) + y1 * Math.cos(rz);
        const scale = 300 / (300 - z2);
        return { x: 62 + xx * scale, y: 84 + yy * scale, z: z2, scale };
      });
      nodes.forEach((node, index) => {
        const p = points[index];
        node.style.left = `${p.x - sizes[index] / 2}px`;
        node.style.top = `${p.y - sizes[index] / 2}px`;
        node.style.transform = `rotate(${-7 + 47 * phase}deg) scale(${p.scale})`;
        node.style.opacity = String(.68 + p.z / 180);
        node.style.zIndex = String(Math.round(100 + p.z));
      });
      edges.forEach((edge, index) => {
        const [from, to] = connections[index];
        const p = points[from];
        const q = points[to];
        edge.style.left = `${p.x}px`;
        edge.style.top = `${p.y}px`;
        edge.style.width = `${Math.hypot(q.x - p.x, q.y - p.y)}px`;
        edge.style.transform = `rotate(${Math.atan2(q.y - p.y, q.x - p.x) / radians}deg)`;
        edge.style.opacity = String(.37 + (p.z + q.z) / 550);
      });
      ring.style.left = `${points[2].x - 20}px`;
      ring.style.top = `${points[2].y - 20}px`;
      dot.style.left = `${points[2].x - 1.5}px`;
      dot.style.top = `${points[2].y - 1.5}px`;
    });
  }

  const scenes = [
    createWords(root.querySelector('.category-column[data-category-link="collected"]')),
    createNetwork(root.querySelector('.category-column[data-category-link="other"]')),
  ].filter(Boolean);
  if (!scenes.length) return;

  // Match the CSS diagrams' cubic-bezier(.22,.6,.2,1).
  function orbitEase(value) {
    if (value <= 0 || value >= 1) return clamp(value);
    const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 16; i++) {
      const t = (low + high) / 2;
      if (cubic(t, .22, .2) < value) low = t;
      else high = t;
    }
    return cubic((low + high) / 2, .6, 1);
  }

  function stopFrame() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function updateMotion() {
    const paused = !pageActive || document.hidden || !chaptersVisible || root.hidden;
    const now = performance.now();
    for (const scene of scenes) {
      const visible = !paused && scene.visible;
      const target = visible && (scene.hovered || scene.element.matches(':focus-visible')) ? 1 : 0;
      if (target !== scene.target) {
        scene.from = scene.phase;
        scene.startedAt = now;
        scene.target = target;
      }
      // Hidden diagrams settle immediately; reduced motion retains the static
      // hovered/focused state, rather than disabling the interaction entirely.
      if ((!visible || motion.matches) && scene.phase !== target) {
        scene.phase = target;
        scene.draw(target);
      }
    }
    if (scenes.every(scene => scene.phase === scene.target)) stopFrame();
    else if (!frame) frame = requestAnimationFrame(step);
  }

  function step(now) {
    frame = 0;
    for (const scene of scenes) {
      if (scene.phase === scene.target) continue;
      const time = clamp((now - scene.startedAt) / duration);
      scene.phase = time === 1 ? scene.target : scene.from + (scene.target - scene.from) * orbitEase(time);
      scene.draw(scene.phase);
    }
    if (scenes.some(scene => scene.phase !== scene.target)) frame = requestAnimationFrame(step);
  }

  const observer = hasObserver ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const scene = scenes.find(candidate => candidate.element === entry.target);
      if (!scene) continue;
      scene.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      scene.hovered = scene.visible && scene.element.matches(':hover');
    }
    updateMotion();
  }, { root: viewport, threshold: [0, .001] }) : null;

  function observe() {
    for (const scene of scenes) {
      if (observer) {
        scene.visible = false;
        observer.observe(scene.element);
      } else {
        scene.visible = true;
        scene.hovered = scene.element.matches(':hover');
      }
    }
  }

  for (const scene of scenes) {
    scene.element.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      scene.hovered = true;
      updateMotion();
    });
    scene.element.addEventListener('pointerleave', () => {
      scene.hovered = false;
      updateMotion();
    });
    for (const type of ['focus', 'blur']) {
      scene.element.addEventListener(type, () => queueMicrotask(updateMotion));
    }
  }

  motion.addEventListener('change', updateMotion);
  document.addEventListener('visibilitychange', () => {
    for (const scene of scenes) scene.hovered = !document.hidden && scene.element.matches(':hover');
    updateMotion();
  });
  window.addEventListener('site:chapter', event => {
    const progress = event.detail?.progress;
    if (typeof progress !== 'number') return;
    const visible = progress > .55;
    if (visible === chaptersVisible) return;
    chaptersVisible = visible;
    updateMotion();
  });
  window.addEventListener('site:revealed', () => {
    chaptersVisible = contentVisible();
    updateMotion();
  });
  window.addEventListener('pagehide', () => {
    pageActive = false;
    observer?.disconnect();
    updateMotion();
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    chaptersVisible = contentVisible();
    observe();
    updateMotion();
  });

  observe();
  updateMotion();
})();
