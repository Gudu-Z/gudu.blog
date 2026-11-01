/* Apply the saved day or night theme before the first paint. Night is the
 * default; a visitor's choice is remembered, and ?theme= previews either one. */
(() => {
  'use strict';

  const storageKey = 'gudu-theme';
  const barColors = { dark: '#080b10', light: '#eef0f2' };
  const root = document.documentElement;
  let settleFrame = 0;
  // js/theme-jets.js animates a toggle when it is present; without it, or
  // before it loads, the theme changes at once.
  let switcher = null;

  function normalize(theme) {
    return theme === 'light' ? 'light' : 'dark';
  }

  function initial() {
    const override = new URLSearchParams(window.location.search).get('theme');
    if (override === 'light' || override === 'dark') return override;
    try {
      return normalize(localStorage.getItem(storageKey));
    } catch {
      return 'dark';
    }
  }

  function label(theme) {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.setAttribute('aria-pressed', String(theme === 'light'));
    }
  }

  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', barColors[theme]);
    label(theme);
  }

  function set(theme, { save = true } = {}) {
    const next = normalize(theme);
    if (save) {
      try { localStorage.setItem(storageKey, next); } catch {}
    }
    if (next === root.dataset.theme) return next;
    // Every color changes at once: suppress element transitions for this
    // one style change, so nothing fades through intermediate colors.
    cancelAnimationFrame(settleFrame);
    root.classList.add('is-theme-switching');
    apply(next);
    settleFrame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => root.classList.remove('is-theme-switching'));
    });
    window.dispatchEvent(new CustomEvent('site:theme', { detail: { theme: next } }));
    return next;
  }

  apply(initial());
  // The toggle buttons are parsed after this script runs in <head>.
  document.addEventListener('DOMContentLoaded', () => label(root.dataset.theme));
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-theme-toggle]');
    if (!button) return;
    // Mid-animation, a toggle reverses the theme being travelled towards.
    const next = (switcher?.target ?? root.dataset.theme) === 'light' ? 'dark' : 'light';
    if (switcher) switcher.request(next, button);
    else set(next);
  });
  // Another open tab changed the theme.
  window.addEventListener('storage', event => {
    if (event.key === storageKey) set(event.newValue, { save: false });
  });

  window.SiteTheme = {
    get current() { return root.dataset.theme; },
    set,
    toggle: () => set(root.dataset.theme === 'light' ? 'dark' : 'light'),
    useSwitcher(value) { switcher = value; },
  };
})();
