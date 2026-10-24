/* Select the hero theme before its first paint; schedules use the site's timezone. */
(() => {
  'use strict';

  const config = {
    timeZone: 'Asia/Shanghai',
    fixedDates: [], // One-off dates in YYYY-MM-DD format.
    annualDates: [], // Recurring dates in MM-DD format; February 29 matches leap years only.
  };
  const themes = {
    minimal: {
      fallback: './assets/black-hole-minimal-fallback.png?v=20261023-disk-refinement',
      label: '实时三维黑洞：暖白与淡琥珀细线流经倾斜的吸积盘，三维星空粒子随远近距离以不同速度漂移并经引力透镜弯曲，冷灰白细小星点衬托深黑阴影，视角随鼠标轻微转动。',
    },
    ink: {
      fallback: './assets/black-hole-ink-fallback.png?v=20261015-ink-light',
      label: '实时三维水墨黑洞：墨色层次与暖白笔触构成倾斜的吸积盘，光线围绕深黑阴影弯曲，视角随鼠标轻微转动。',
    },
  };

  function resolve({ date = new Date(), search = window.location.search, schedule = config } = {}) {
    const override = new URLSearchParams(search).get('blackhole');
    if (override === 'ink' || override === 'minimal') return override;
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: schedule.timeZone || config.timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const annualDay = `${parts.month}-${parts.day}`;
      const fixed = Array.isArray(schedule.fixedDates) && schedule.fixedDates.includes(day);
      const annual = Array.isArray(schedule.annualDates) && schedule.annualDates.includes(annualDay);
      return fixed || annual ? 'ink' : 'minimal';
    } catch {
      // A malformed date configuration must not prevent the default hero from loading.
      return 'minimal';
    }
  }

  let current = resolve();
  document.documentElement.dataset.blackHoleStyle = current;

  function apply(style = resolve()) {
    current = style === 'ink' ? 'ink' : 'minimal';
    const theme = themes[current];
    document.documentElement.dataset.blackHoleStyle = current;
    const hero = document.querySelector('.hero');
    const figure = document.querySelector('#black-hole');
    const fallback = document.querySelector('.black-hole-fallback');
    if (hero) hero.dataset.blackHoleStyle = current;
    if (figure) {
      figure.dataset.blackHoleStyle = current;
      figure.setAttribute('aria-label', theme.label);
    }
    if (fallback) {
      fallback.dataset.blackHoleStyle = current;
      if (fallback.getAttribute('src') !== theme.fallback) {
        // Do not show the previous theme's decoded bitmap while its replacement loads.
        fallback.dataset.themeReady = 'false';
        const reveal = () => {
          if (fallback.getAttribute('src') === theme.fallback) delete fallback.dataset.themeReady;
        };
        fallback.addEventListener('load', reveal, { once: true });
        fallback.src = theme.fallback;
        if (fallback.complete && fallback.naturalWidth > 0) reveal();
      }
    }
    return current;
  }

  window.BlackHoleTheme = { config, resolve, apply, get current() { return current; } };
})();
