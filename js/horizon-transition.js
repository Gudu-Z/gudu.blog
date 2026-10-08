(() => {
  'use strict';
  const clamp = value => Math.max(0, Math.min(1, value));

  class HorizonTransition {
    constructor(hero, blackHole) {
      this.hero = hero;
      this.blackHole = blackHole;
      this.button = document.querySelector('#shadow-toggle');
      this.base = document.querySelector('#theme-inversion');
      this.sweep = document.querySelector('#theme-sweep');
      this.motion = matchMedia('(prefers-reduced-motion: reduce)');
      this.inverted = false;
      this.active = false;
      this.duration = 1650;
      this.jetActive = false;
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
      if (this.motion.matches || !CSS.supports('clip-path', 'path("M0 0L1 0L1 1Z")')) { this.finish(); return; }

      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.reach = Math.max(...[[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]]
        .map(([x, y]) => Math.hypot(x - geometry.x, y - geometry.y))) + 24;
      this.jetActive = this.blackHole.beginJetBurst();
      this.sweep.style.clipPath = 'inset(50%)';
      this.sweep.hidden = false;
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
      // All white light comes from the depth-tested volume renderer. The
      // color reveal is a separate screen-space transition with no flat rays
      // or central flash that could paint over the hole or accretion disk.
      if (this.jetActive) this.blackHole.renderJetBurst(progress);
      const spread = 1 - Math.pow(1 - clamp((progress - 0.28) / 0.60), 2.2);
      const halfAngle = (Math.PI / 2 + 0.002) * spread;
      const axes = [this.origin.axisAngle, this.origin.axisAngle + Math.PI];
      this.sweep.style.clipPath = spread > 0
        ? 'path("' + axes.map(axis => this.sectorPath(axis, halfAngle, this.reach)).join(' ') + '")'
        : 'inset(50%)';
    }

    finish() {
      if (!this.active) return;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.inverted = this.target;
      // Commit and remove the second difference layer within the same frame.
      this.base.hidden = !this.inverted;
      this.sweep.hidden = true;
      this.sweep.style.clipPath = '';
      if (this.jetActive) this.blackHole.endJetBurst();
      this.jetActive = false;
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
