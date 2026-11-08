import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { dayColor, dayPaper, nightSky } from './day-palette.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const source = await read('js/site-theme.js');
const cssFiles = (await readdir(new URL('css/', root))).filter(name => name.endsWith('.css'));

// A minimal document: one toggle button, the theme-color meta and storage.
function loadSiteTheme({ search = '', saved = null, storageBlocked = false, lightDark = true, sheets = {} } = {}) {
  const classes = new Set();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storage = new Map(saved === null ? [] : [['gudu-theme', saved]]);
  const writes = [];
  const frames = [];
  const events = [];
  const meta = { setAttribute(name, value) { this[name] = value; } };
  const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const timers = [];
  const styles = [];
  const links = Object.keys(sheets).map(href => ({
    href, removed: false,
    after(style) { styles.push({ href, text: style.textContent }); },
    remove() { this.removed = true; },
  }));
  const rootStyle = {
    values: {},
    set visibility(value) { this.values.visibility = value; },
    get visibility() { return this.values.visibility; },
    removeProperty(name) { delete this.values[name]; },
  };
  const document = {
    documentElement: { dataset: {}, style: rootStyle, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    querySelector: selector => (selector === 'meta[name="theme-color"]' ? meta : null),
    querySelectorAll: selector => (selector === '[data-theme-toggle]' ? [button]
      : selector === 'link[rel="stylesheet"]' ? links : []),
    createElement: () => ({ textContent: '' }),
    addEventListener: (type, listener) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
  };
  const fetch = async href => href in sheets
    ? { ok: true, text: async () => sheets[href] } : { ok: false, text: async () => '' };
  const localStorage = {
    getItem(key) { if (storageBlocked) throw new Error('blocked'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageBlocked) throw new Error('blocked'); writes.push(value); storage.set(key, value); },
  };
  const window = {
    CSS: { supports: (property, value) => lightDark || !/light-dark/.test(value) },
    location: { search, href: 'https://gudu.blog/posts/a.html', origin: 'https://gudu.blog' },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    dispatchEvent: event => events.push(event),
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  runInNewContext(source, {
    window, document, localStorage, URLSearchParams, URL, CustomEvent, fetch,
    setTimeout: callback => timers.push(callback), clearTimeout: () => timers.length = 0,
    requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame() {},
  });
  return {
    theme: () => document.documentElement.dataset.theme, classes, meta, button, storage, writes, events,
    click: inside => documentListeners.get('click')[0]({ target: { closest: () => (inside ? button : null) } }),
    otherTab: value => windowListeners.get('storage')({ key: 'gudu-theme', newValue: value }),
    ready: () => documentListeners.get('DOMContentLoaded').forEach(listener => listener()),
    visibility: () => rootStyle.visibility, timers, styles, links,
    flushFrames() { while (frames.length) frames.shift()(); },
    api: window.SiteTheme,
  };
}

await test('night is the default, and a saved day choice applies before the first paint', () => {
  const night = loadSiteTheme();
  assert.equal(night.theme(), 'dark');
  assert.equal(night.meta.content, nightSky);
  const day = loadSiteTheme({ saved: 'light' });
  assert.equal(day.theme(), 'light');
  assert.equal(day.meta.content, dayPaper);
  day.ready();
  assert.equal(day.button.attributes['aria-pressed'], 'true');
  for (const saved of ['', 'LIGHT', 'sepia']) assert.equal(loadSiteTheme({ saved }).theme(), 'dark', saved);
});

await test('a ?theme preview never overwrites the saved choice', () => {
  const preview = loadSiteTheme({ search: '?theme=light', saved: 'dark' });
  assert.equal(preview.theme(), 'light');
  assert.deepEqual(preview.writes, []);
  assert.equal(loadSiteTheme({ search: '?theme=sepia', saved: 'light' }).theme(), 'light');
});

await test('the toggle saves the choice, announces it once, and skips transitions for one frame', () => {
  const site = loadSiteTheme();
  site.click(false);
  assert.equal(site.theme(), 'dark', 'clicks elsewhere do nothing');
  site.click(true);
  assert.equal(site.theme(), 'light');
  assert.equal(site.storage.get('gudu-theme'), 'light');
  assert.equal(site.button.attributes['aria-pressed'], 'true');
  assert.deepEqual(site.events.map(event => [event.type, event.detail.theme]), [['site:theme', 'light']]);
  assert.ok(site.classes.has('is-theme-switching'));
  site.flushFrames();
  assert.ok(!site.classes.has('is-theme-switching'));
  site.api.set('light');
  assert.equal(site.events.length, 1, 'an unchanged theme is not announced again');
  site.api.toggle();
  assert.equal(site.theme(), 'dark');
  assert.equal(site.meta.content, nightSky);
});

await test('another tab\'s choice applies here without writing it back', () => {
  const site = loadSiteTheme();
  site.otherTab('light');
  assert.equal(site.theme(), 'light');
  assert.deepEqual(site.writes, []);
});

await test('blocked storage still allows a session-only switch', () => {
  const site = loadSiteTheme({ storageBlocked: true });
  assert.equal(site.theme(), 'dark');
  assert.equal(site.api.set('light'), 'light');
  assert.equal(site.theme(), 'light');
});

await test('without light-dark() the page keeps night, hides nothing behind a broken switch, and patches colors in place', async () => {
  const sheets = {
    'https://gudu.blog/css/style.css?v=1': ':root { --space: light-dark(#eef0f2, #080b10); }\n'
      + '.a { box-shadow: 0 8px 24px light-dark(rgb(0 0 0 / 7%), rgb(0 0 0 / 15%)), 0 0 0 1px light-dark(#000, #fff); }\n'
      + '@font-face { src: url("../assets/fonts/x.woff2"); } .b { background: url(data:image/png;base64,AA) , url(/abs.svg); }',
  };
  const site = loadSiteTheme({ saved: 'light', search: '?theme=light', lightDark: false, sheets });
  assert.equal(site.theme(), 'dark', 'neither a saved nor a previewed day theme applies');
  assert.equal(site.api.legacyColors, true);
  assert.equal(site.visibility(), 'hidden', 'the colorless page is not painted');
  site.click(true);
  site.otherTab('light');
  assert.equal(site.theme(), 'dark');
  assert.equal(site.api.set('light'), 'dark');
  site.ready();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(site.visibility(), undefined, 'the page appears once its colors exist');
  assert.equal(site.styles.length, 1);
  assert.equal(site.links[0].removed, true);
  const css = site.styles[0].text;
  assert.doesNotMatch(css, /light-dark/);
  assert.match(css, /--space: #080b10;/);
  assert.match(css, /box-shadow: 0 8px 24px rgb\(0 0 0 \/ 15%\), 0 0 0 1px #fff;/);
  assert.match(css, /url\("https:\/\/gudu\.blog\/assets\/fonts\/x\.woff2"\)/, 'relative urls keep their stylesheet base');
  assert.match(css, /url\(data:image\/png;base64,AA\) , url\(\/abs\.svg\)/);
});

await test('a stalled stylesheet patch cannot keep the page hidden', () => {
  const site = loadSiteTheme({ lightDark: false });
  assert.equal(site.visibility(), 'hidden');
  site.timers.forEach(callback => callback());
  assert.equal(site.visibility(), undefined);
});

await test('browsers with light-dark() never touch the stylesheets', () => {
  const site = loadSiteTheme({ saved: 'light', sheets: { 'https://gudu.blog/css/style.css': 'a{}' } });
  site.ready();
  assert.equal(site.theme(), 'light');
  assert.equal(site.api.legacyColors, false);
  assert.equal(site.visibility(), undefined);
  assert.equal(site.styles.length, 0);
});

await test('every real stylesheet reduces to plain night colors', async () => {
  const { api } = loadSiteTheme();
  for (const name of cssFiles) {
    const night = api.nightColors(await read(`css/${name}`));
    assert.doesNotMatch(night, /light-dark/, name);
    assert.doesNotMatch(night, /:\s*initial\b/, `${name}: every light-dark() has a night value`);
    assert.equal((night.match(/\(/g) || []).length, (night.match(/\)/g) || []).length, `${name}: balanced`);
  }
});

// Every color the CSS paints must name both of its themes.
function colorLiterals(text) {
  const comments = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map(match => [match.index, match.index + match[0].length]);
  const outside = index => !comments.some(([start, end]) => index >= start && index < end);
  const spans = [];
  for (const match of text.matchAll(/light-dark\(/g)) {
    let depth = 0, end = match.index + 'light-dark'.length;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    if (outside(match.index)) spans.push([match.index, end, text.slice(match.index + 'light-dark('.length, end)]);
  }
  const literals = [...text.matchAll(/(?<![\w-])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|rgba?\()/gi)]
    .filter(match => outside(match.index)).map(match => match.index);
  return { spans, literals };
}

function declaration(text, index) {
  for (let i = index - 1, depth = 0; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(') depth--;
    else if (depth <= 0 && '{;}'.includes(text[i])) {
      const head = text.slice(i + 1, index);
      return text[i] === "}" ? `prelude ${head.trim()}` : head.slice(0, head.indexOf(":")).trim();
    }
  }
  return '';
}

await test('every CSS color pairs a day value with its night value', async () => {
  const exempt = /^(-webkit-)?mask(-image)?$|-mask$|^initial-value$|^prelude @supports/;
  for (const name of cssFiles) {
    const text = await read(`css/${name}`);
    const { spans, literals } = colorLiterals(text);
    for (const index of literals) {
      if (spans.some(([start, end]) => index > start && index < end)) continue;
      const property = declaration(text, index);
      assert.match(property, exempt, `${name}: ${text.slice(index, index + 24)} in "${property}" needs light-dark(day, night)`);
    }
    for (const [, , inner] of spans) {
      const parts = [];
      let depth = 0, from = 0;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') depth++;
        else if (inner[i] === ')') depth--;
        else if (inner[i] === ',' && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
      }
      parts.push(inner.slice(from));
      assert.equal(parts.length, 2, `${name}: light-dark(${inner}) needs exactly a day and a night color`);
      for (const part of parts) assert.match(part.trim(), /^(#[0-9a-f]{3,8}|rgba?\(.+\))$/i, `${name}: ${part}`);
    }
  }
});

await test('pages pick their theme before any stylesheet and pair every logo with its day artwork', async () => {
  const posts = (await readdir(new URL('posts/', root)).catch(() => [])).filter(name => name.endsWith('.html')).map(name => `posts/${name}`);
  for (const path of ['index.html', '404.html', ...posts]) {
    const html = await read(path);
    const script = html.indexOf('js/site-theme.js');
    assert.ok(script > 0 && script < html.indexOf('rel="stylesheet"'), `${path} must apply the theme before its first stylesheet`);
    // Every header has the toggle; on the home page the hero's black sphere is one too.
    assert.equal(html.match(/data-theme-toggle/g)?.length, path === 'index.html' ? 2 : 1, `${path} theme toggles`);
    if (path === 'index.html') {
      assert.match(html, /<figure class="black-hole"[^>]*>(?:(?!<\/figure>)[\s\S])*<button class="black-hole-switch" type="button" data-theme-toggle aria-label="日间模式" aria-pressed="false"><\/button>\s*<\/figure>/,
        'the black sphere is a labelled button inside the black hole figure');
    }
    assert.match(html, /<script src="[^"]*js\/theme-jets\.js[^"]*" defer><\/script>/, `${path} animates its toggle`);
    const logos = html.match(/<img class="brand-logo"/g)?.length ?? 0;
    assert.ok(logos > 0);
    assert.equal(html.match(/<img class="brand-logo brand-logo-day"/g)?.length, logos, `${path} pairs each logo`);
  }
});

const luminance = hex => {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

await test('the day palette mirrors night contrast and keeps the brand orange and shadows', () => {
  assert.equal(dayColor(nightSky), dayPaper);
  assert.equal(dayColor('#f06446'), '#f06446');
  assert.equal(dayColor('#f0644633'), '#f0644633');
  assert.equal(dayColor('rgb(0 0 0 / 24%)'), 'rgb(0 0 0 / 10.8%)');
  assert.equal(dayColor('#9d9da33d').slice(-2), '3d', 'a tint keeps its opacity');
  assert.equal(dayColor('rgb(170 188 202 / var(--opacity))').endsWith('/ var(--opacity))'), true);
  // Night text against the sky, and its day counterpart against the paper.
  for (const [text, minimum] of [['#e6e9ec', 12], ['#a0a0aa', 6], ['#f69b85', 4.5]]) {
    const day = dayColor(text);
    assert.ok(contrast(day, dayPaper) >= minimum, `${text} → ${day} on paper: ${contrast(day, dayPaper).toFixed(2)}`);
  }
  assert.ok(Math.abs(contrast(dayColor('#a0a0aa'), dayPaper) - contrast('#a0a0aa', nightSky)) < 1.5,
    'secondary text keeps about the same contrast in both themes');
});
