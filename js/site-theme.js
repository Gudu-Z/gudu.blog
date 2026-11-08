/* Apply the saved day or night theme before the first paint. Night is the
 * default; a visitor's choice is remembered, and ?theme= previews either one. */
(() => {
  'use strict';

  const storageKey = 'gudu-theme';
  const barColors = { dark: '#080b10', light: '#eef0f2' };
  const root = document.documentElement;
  // Every color is written as light-dark(day, night). Browsers without it
  // (Safari before 17.5) drop each such declaration and paint the page
  // colorless; they get the night palette, patched in below, and no switch.
  const legacyColors = !window.CSS?.supports?.('color', 'light-dark(#000, #fff)');
  let settleFrame = 0;
  // js/theme-jets.js animates a toggle when it is present; without it, or
  // before it loads, the theme changes at once.
  let switcher = null;

  function normalize(theme) {
    return theme === 'light' && !legacyColors ? 'light' : 'dark';
  }

  function initial() {
    const override = new URLSearchParams(window.location.search).get('theme');
    if (override === 'light' || override === 'dark') return normalize(override);
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

  // Keep only the night argument of each light-dark(day, night), with
  // balanced parentheses, so nested colors such as rgb() stay intact.
  function nightColors(text) {
    let out = '', from = 0;
    for (;;) {
      const at = text.indexOf('light-dark(', from);
      if (at < 0) return out + text.slice(from);
      let depth = 0, comma = -1, end = at + 'light-dark'.length;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ',' && depth === 1 && comma < 0) comma = end;
        else if (text[end] === ')' && --depth === 0) break;
      }
      out += text.slice(from, at) + (comma < 0 ? 'initial' : text.slice(comma + 1, end).trim());
      from = end + 1;
    }
  }

  // The parser has already discarded these declarations, so re-read each
  // same-origin stylesheet (from the HTTP cache) and swap in a night-only copy
  // at the same place in the cascade. Relative url()s keep their base.
  function patchLegacyColors() {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter(link => new URL(link.href, window.location.href).origin === window.location.origin);
    return Promise.all(links.map(link => fetch(link.href).then(response => {
      if (!response.ok) return;
      return response.text().then(text => {
        const style = document.createElement('style');
        style.textContent = nightColors(text).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, url) =>
          /^(?:[a-z][\w+.-]*:|\/|#)/i.test(url) ? match : `url("${new URL(url, link.href).href}")`);
        link.after(style);
        link.remove();
      });
    }).catch(() => {})));
  }

  if (legacyColors) {
    root.dataset.legacyColors = '';
    // Hold the first paint until the colors exist, but never for long.
    root.style.visibility = 'hidden';
    const reveal = () => root.style.removeProperty('visibility');
    const timer = setTimeout(reveal, 2500);
    document.addEventListener('DOMContentLoaded', () => {
      patchLegacyColors().then(() => { clearTimeout(timer); reveal(); });
    });
  }

  apply(initial());
  // The toggle buttons are parsed after this script runs in <head>.
  document.addEventListener('DOMContentLoaded', () => label(root.dataset.theme));
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-theme-toggle]');
    if (!button || legacyColors) return;
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
    legacyColors,
    nightColors,
    set,
    toggle: () => set(root.dataset.theme === 'light' ? 'dark' : 'light'),
    useSwitcher(value) { switcher = value; },
  };
})();
