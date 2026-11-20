// Each end is named the article's "中文 / CODE" way: its compass direction
// (or 上 / 下 for Y) and its signed axis.
const names = { X: ['东', '西'], Y: ['上', '下'], Z: ['南', '北'] };

export function axisEnds({ x, y, z, w }) {
  const ends = [];
  function pair(axis, right, up, depth) {
    for (const sign of [1, -1]) {
      ends.push({ axis, sign, x: sign * right, y: -sign * up, depth: sign * depth });
    }
  }
  // Each row of the camera's rotation gives one world axis in camera space.
  // Only the screen's vertical direction is reversed. Positive depth faces us.
  pair('X', 1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w));
  pair('Y', 2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w));
  pair('Z', 2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y));
  return ends.sort((a, b) => a.depth - b.depth);
}

export function axisView(axis, sign, quaternion) {
  const end = axisEnds(quaternion).find(end => end.axis === axis && end.sign === sign);
  if (end.depth > .9999) sign = -sign;
  if (axis === 'Y') {
    // Just off each pole, OrbitControls retains the heading that puts north up.
    const tilt = .0001;
    return sign > 0 ? { azimuth: 0, polar: tilt } : { azimuth: Math.PI, polar: Math.PI - tilt };
  }
  const azimuth = axis === 'X' ? sign * Math.PI / 2 : (sign > 0 ? 0 : Math.PI);
  return { azimuth, polar: Math.PI / 2 };
}

export function mountAxisGizmo(container, renderer, { signal }) {
  const { controls } = renderer;
  const group = document.createElement('div');
  group.className = 'mc-axes';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '方位轴');
  const ends = new Map();
  let frame = 0;

  function cancel() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function lookFrom(axis, sign) {
    cancel();
    const { camera } = renderer;
    const distance = camera.position.distanceTo(controls.target);
    const startAzimuth = controls.getAzimuthalAngle(), startPolar = controls.getPolarAngle();
    const view = axisView(axis, sign, camera.quaternion);
    const delta = view.azimuth - startAzimuth;
    const turn = Math.atan2(Math.sin(delta), Math.cos(delta));
    function move(t) {
      renderer.camera.position.setFromSphericalCoords(distance,
        startPolar + (view.polar - startPolar) * t, startAzimuth + turn * t).add(controls.target);
      controls.update();
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      move(1);
      return;
    }
    const start = performance.now();
    function step(now) {
      const elapsed = Math.min(1, (now - start) / 400);
      move(1 - (1 - elapsed) ** 3);
      frame = elapsed < 1 ? requestAnimationFrame(step) : 0;
    }
    frame = requestAnimationFrame(step);
  }

  // Each end is a hairline ray from the centre and its name, a button, just
  // beyond the ray's tip. The stylesheet places both from the end's
  // projected direction, which update() writes as custom properties.
  for (const [axis, pair] of Object.entries(names)) {
    for (const sign of [1, -1]) {
      const name = pair[sign > 0 ? 0 : 1], code = (sign > 0 ? '+' : '−') + axis;
      const end = document.createElement('div');
      end.className = 'mc-axes-end';
      end.dataset.axis = axis;
      end.dataset.sign = sign;
      const ray = document.createElement('span');
      ray.className = 'mc-axes-ray';
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'mc-axes-label';
      const nameText = document.createElement('span');
      nameText.className = 'mc-axes-name';
      nameText.textContent = name;
      const codeText = document.createElement('span');
      codeText.className = 'mc-axes-code';
      codeText.textContent = code;
      label.append(nameText, codeText);
      label.title = `从${name}${axis === 'Y' ? '方' : '面'}看（${code}）`;
      label.setAttribute('aria-label', label.title);
      label.addEventListener('click', () => lookFrom(axis, sign), { signal });
      end.append(ray, label);
      group.append(end);
      ends.set(axis + sign, end);
    }
  }

  function update() {
    axisEnds(renderer.camera.quaternion).forEach(({ axis, sign, x, y, depth }, order) => {
      const end = ends.get(axis + sign), style = end.style;
      const length = Math.hypot(x, y);
      // An end turned away recedes. One pointing straight back hides behind
      // the centre, where the end facing us names the view instead.
      const shown = depth >= 0 ? 1 : Math.min(1, Math.max(0, (length - .12) / .25));
      // Paint order can change during keyboard use. Keep the tab order stable.
      style.zIndex = order + 1;
      style.opacity = shown * (1 - .5 * Math.min(1, Math.max(0, -depth * 6)));
      style.visibility = shown ? '' : 'hidden';
      style.setProperty('--x', x.toFixed(4));
      style.setProperty('--y', y.toFixed(4));
      style.setProperty('--len', length.toFixed(4));
      style.setProperty('--angle', Math.atan2(y, x).toFixed(4) + 'rad');
      // The name stands off the tip along the ray, drawing in to the centre
      // as the ray shortens, so it never jumps.
      const reach = Math.max(length, .25);
      style.setProperty('--ux', (x / reach).toFixed(4));
      style.setProperty('--uy', (y / reach).toFixed(4));
      end.classList.toggle('is-facing', depth > .9999);
    });
  }

  container.append(group);
  update();
  controls.addEventListener('change', update);
  container.addEventListener('pointerdown', cancel, { capture: true, signal });
  container.addEventListener('wheel', cancel, { capture: true, passive: true, signal });
  signal.addEventListener('abort', () => {
    cancel();
    controls.removeEventListener('change', update);
    group.remove();
  }, { once: true });
  return { update, cancel };
}
