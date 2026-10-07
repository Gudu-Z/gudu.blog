(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = (start, end, value) => {
    const t = clamp((value - start) / (end - start));
    return t * t * (3 - 2 * t);
  };

  class HorizonTransition {
    constructor(hero, blackHole) {
      this.hero = hero;
      this.blackHole = blackHole;
      this.button = document.querySelector('#shadow-toggle');
      this.base = document.querySelector('#theme-inversion');
      this.sweep = document.querySelector('#theme-sweep');
      this.canvas = document.querySelector('#theme-shock');
      this.context = this.canvas.getContext('2d');
      this.motion = matchMedia('(prefers-reduced-motion: reduce)');
      this.inverted = false;
      this.active = false;
      this.duration = 1700;
      this.frame = 0;
      this.gesture = null;
      this.lastToggle = -Infinity;

      this.hero.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || !this.available()) return;
        this.gesture = this.blackHole.hitTestShadow(event.clientX, event.clientY)
          ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
      }, { passive: true });
      this.hero.addEventListener('pointermove', event => {
        if (this.gesture && Math.hypot(event.clientX - this.gesture.x, event.clientY - this.gesture.y) > 10) this.gesture = null;
        if (event.pointerType === 'touch') return;
        this.hero.classList.toggle('is-shadow-hover', this.available() && this.blackHole.hitTestShadow(event.clientX, event.clientY));
      }, { passive: true });
      this.hero.addEventListener('pointerup', event => {
        const gesture = this.gesture;
        this.gesture = null;
        if (gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 10 && this.blackHole.hitTestShadow(event.clientX, event.clientY)) this.toggle();
      }, { passive: true });
      this.hero.addEventListener('pointercancel', () => { this.gesture = null; });
      this.hero.addEventListener('pointerleave', () => {
        this.gesture = null;
        this.hero.classList.remove('is-shadow-hover');
      });
      // The visually hidden control provides the same action with Enter/Space.
      this.button.addEventListener('click', event => { if (event.detail === 0) this.toggle(); });
      this.button.addEventListener('keydown', event => { if (event.repeat) event.preventDefault(); });
      this.motion.addEventListener('change', () => { if (this.motion.matches && this.active) this.finish(); });
      window.addEventListener('resize', () => { if (this.active) this.finish(); this.updateGeometry(); });
      window.addEventListener('scroll', () => { if (this.active) this.finish(); this.gesture = null; }, { passive: true });
      window.addEventListener('pagehide', () => { if (this.active) this.finish(); });
      document.addEventListener('visibilitychange', () => { if (document.hidden && this.active) this.finish(); });
      window.addEventListener('site:revealed', () => this.updateGeometry());
      this.updateGeometry();
    }

    available() {
      return !this.active && !document.hidden && !document.documentElement.classList.contains('is-loading');
    }

    updateGeometry() {
      if (this.active) return;
      const geometry = this.blackHole.getInteractionGeometry();
      if (!geometry) { this.button.disabled = true; return; }
      const bounds = this.hero.getBoundingClientRect();
      const size = Math.max(44, Math.min(120, geometry.radius * 0.55));
      Object.assign(this.button.style, {
        left: `${geometry.x - bounds.left}px`, top: `${geometry.y - bounds.top - geometry.radius * 0.3}px`,
        width: `${size}px`, height: `${size}px`,
      });
      this.button.disabled = document.documentElement.classList.contains('is-loading');
    }

    toggle() {
      if (!this.available() || performance.now() - this.lastToggle < 250) return;
      const geometry = this.blackHole.getInteractionGeometry();
      if (!geometry) return;
      this.lastToggle = performance.now();
      this.target = !this.inverted;
      this.origin = geometry;
      this.active = true;
      this.hero.classList.remove('is-shadow-hover');
      this.hero.classList.add('is-theme-transitioning');
      this.hero.dispatchEvent(new Event('theme:transitionstart'));
      if (this.motion.matches || !this.context || !CSS.supports('clip-path', 'path("M0 0L1 0L1 1Z")')) { this.finish(); return; }

      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.reach = Math.max(...[[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]]
        .map(([x, y]) => Math.hypot(x - geometry.x, y - geometry.y))) + 24;
      const scale = Math.min(devicePixelRatio || 1, 1.5, 2400 / this.width);
      this.canvas.width = Math.ceil(this.width * scale);
      this.canvas.height = Math.ceil(this.height * scale);
      this.context.setTransform(scale, 0, 0, scale, 0, 0);
      this.sweep.style.clipPath = 'inset(50%)';
      this.sweep.hidden = false;
      this.canvas.hidden = false;
      this.started = performance.now();
      const tick = now => {
        if (!this.active) return;
        const progress = clamp((now - this.started) / this.duration);
        this.paint(progress);
        if (progress >= 1) this.finish();
        else this.frame = requestAnimationFrame(tick);
      };
      this.paint(0);
      this.frame = requestAnimationFrame(tick);
    }

    sectorPath(axis, halfAngle, radius) {
      const { x, y } = this.origin;
      const start = axis - halfAngle, end = axis + halfAngle;
      const point = angle => `${(x + Math.cos(angle) * radius).toFixed(2)} ${(y + Math.sin(angle) * radius).toFixed(2)}`;
      return `M${x.toFixed(2)} ${y.toFixed(2)} L${point(start)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${halfAngle > Math.PI / 2 ? 1 : 0} 1 ${point(end)} Z`;
    }

    paint(progress) {
      const spread = smooth(0.16, 0.9, progress);
      const halfAngle = 0.018 + (Math.PI / 2 + 0.002 - 0.018) * spread;
      const distance = clamp(progress / 0.32);
      const radius = Math.max(0.1, this.reach * (1 - Math.pow(1 - distance, 3)));
      const axes = [this.origin.axisAngle, this.origin.axisAngle + Math.PI];
      this.sweep.style.clipPath = `path("${axes.map(axis => this.sectorPath(axis, halfAngle, radius)).join(' ')}")`;

      const ctx = this.context;
      ctx.clearRect(0, 0, this.width, this.height);
      const fade = 1 - smooth(0.86, 1, progress);
      const jet = smooth(0, 0.045, progress) * (1 - smooth(0.22, 0.62, progress));
      const front = smooth(0, 0.06, progress) * fade;
      const { x, y } = this.origin;
      ctx.save();
      ctx.translate(x, y);
      for (const axis of axes) {
        const start = axis - halfAngle, end = axis + halfAngle;
        ctx.save();
        // The passing shock glows above the two independent inversion layers.
        const light = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        light.addColorStop(0, `rgba(255,255,255,${0.1 * front})`);
        light.addColorStop(0.82, 'rgba(255,255,255,0)');
        light.addColorStop(1, `rgba(255,255,255,${0.18 * front})`);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, radius, start, end); ctx.closePath();
        ctx.fillStyle = light; ctx.fill();
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * front})`;
        ctx.shadowColor = '#fff'; ctx.shadowBlur = 22;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(Math.cos(start) * radius, Math.sin(start) * radius);
        ctx.lineTo(0, 0); ctx.lineTo(Math.cos(end) * radius, Math.sin(end) * radius); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, radius, start, end); ctx.stroke();

        if (jet > 0.001) {
          ctx.rotate(axis);
          const beam = ctx.createLinearGradient(0, 0, radius, 0);
          beam.addColorStop(0, `rgba(255,255,255,${jet})`);
          beam.addColorStop(0.82, `rgba(255,255,255,${0.95 * jet})`);
          beam.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = beam; ctx.lineCap = 'butt';
          ctx.shadowBlur = 34; ctx.lineWidth = 18 * jet + 2;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(radius, 0); ctx.stroke();
          ctx.shadowBlur = 10; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(radius, 0); ctx.stroke();
        }
        ctx.restore();
      }
      const core = smooth(0, 0.03, progress) * (1 - smooth(0.08, 0.36, progress));
      if (core > 0) {
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 68);
        glow.addColorStop(0, `rgba(255,255,255,${core})`);
        glow.addColorStop(0.2, `rgba(255,255,255,${0.85 * core})`);
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 68, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    finish() {
      if (!this.active) return;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.inverted = this.target;
      // Commit and remove the second difference layer within the same frame.
      this.base.hidden = !this.inverted;
      this.sweep.hidden = this.canvas.hidden = true;
      this.sweep.style.clipPath = '';
      this.canvas.width = this.canvas.height = 1;
      this.active = false;
      this.gesture = null;
      document.documentElement.dataset.colorMode = this.inverted ? 'inverted' : 'original';
      document.documentElement.style.colorScheme = this.inverted ? 'light' : 'dark';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.inverted ? '#f7f4ef' : '#080b10');
      this.button.setAttribute('aria-pressed', String(this.inverted));
      this.hero.classList.remove('is-theme-transitioning');
      this.updateGeometry();
      this.hero.dispatchEvent(new Event('theme:transitionend'));
    }
  }
  window.HorizonTransition = HorizonTransition;
})();
