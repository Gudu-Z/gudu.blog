import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../js/comments.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function browser({ origin = 'https://gudu.blog', serverURL = 'https://comments.example.test', observer = true, missing = false, turnstileKey = '' } = {}) {
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.children = [];
    }
    addEventListener(name, callback, options = {}) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push({ callback, once: options.once });
    }
    removeEventListener(name, callback) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.callback !== callback));
    }
    dispatch(name) {
      for (const item of [...(this.listeners.get(name) || [])]) {
        if (item.once) this.removeEventListener(name, item.callback);
        item.callback({ target: this });
      }
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; }
  }

  const section = new Element('section');
  section.dataset = { serverUrl: serverURL, siteOrigin: 'https://gudu.blog', commentPath: '/posts/stable-slug.html', turnstileKey };
  const thread = new Element();
  const status = new Element('p');
  const retry = new Element('button');
  status.hidden = true;
  retry.hidden = true;
  section.querySelector = selector => ({ '[data-comments-thread]': thread, '[data-comments-status]': status, '[data-comments-retry]': retry })[selector] ?? null;
  const resources = [];
  const timers = new Map();
  const observers = [];
  const calls = [];
  let timerId = 0;
  let failInit = false;
  const location = new URL(`${origin}/posts/alias.html?preview=1#part-two`);
  const window = {
    location,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  if (observer) window.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  const document = {
    currentScript: { src: `${origin}/js/comments.js` },
    querySelector: () => missing ? null : section,
    createElement: tagName => new Element(tagName),
    head: { appendChild(element) { resources.push(element); } },
  };
  const context = createContext({ window, document, URL, console });
  const execute = () => runInContext(source, context, { timeout: 1000 });
  const setWaline = () => {
    window.Waline = {
      init(options) {
        calls.push(options);
        if (failInit) throw new Error('Simulated initialization failure');
        thread.children.push('mounted');
        return { destroy() { thread.replaceChildren(); } };
      },
    };
  };
  execute();
  return {
    section, thread, status, retry, resources, observers, calls, timers, window, execute, setWaline,
    failInitialization(value) { failInit = value; },
    intersect(value = true) { observers[0].callback([{ isIntersecting: value }]); },
    asset(kind) { return resources.findLast(item => item.tagName === kind && !item.removed); },
    async complete() {
      setWaline();
      this.asset('script')?.dispatch('load');
      this.asset('link')?.dispatch('load');
      await flush();
    },
  };
}

await test('comments load near the viewport, wait for both local assets, and use stable anonymous options', async () => {
  const page = browser({ turnstileKey: 'test-site-key' });
  assert.equal(page.resources.length, 0);
  assert.equal(page.observers[0].target, page.section);
  assert.equal(page.observers[0].options.rootMargin, '300px 0px');
  page.intersect(false);
  assert.equal(page.resources.length, 0);
  page.intersect();
  assert.equal(page.observers[0].disconnected, true);
  assert.equal(page.section.getAttribute('aria-busy'), 'true');
  assert.equal(page.status.hidden, false);
  assert.equal(page.resources.length, 2);
  assert.equal(page.asset('script').src, 'https://gudu.blog/assets/vendor/waline/waline.umd.js');
  assert.equal(page.asset('link').href, 'https://gudu.blog/assets/vendor/waline/waline.css');
  page.setWaline();
  page.asset('script').dispatch('load');
  await flush();
  assert.equal(page.calls.length, 0, 'Do not mount an unstyled comment client.');
  page.asset('link').dispatch('load');
  await flush();
  assert.equal(page.calls.length, 1);
  const options = page.calls[0];
  assert.equal(options.el, page.thread);
  assert.equal(options.serverURL, 'https://comments.example.test');
  assert.equal(options.path, '/posts/stable-slug.html', 'Ignore the current query, hash, and preview route.');
  assert.equal(options.login, 'disable');
  assert.deepEqual([...options.meta], ['nick', 'mail']);
  assert.deepEqual([...options.requiredMeta], ['nick']);
  assert.equal(options.lang, 'zh-CN');
  assert.equal(options.dark, true);
  assert.equal(options.pageSize, 10);
  assert.equal(options.wordLimit, 1000);
  for (const key of ['emoji', 'search', 'imageUploader', 'highlighter', 'texRenderer', 'reaction', 'pageview', 'noCopyright']) assert.equal(options[key], false, key);
  assert.equal(options.turnstileKey, 'test-site-key');
  assert.equal(options.locale.mail, '邮箱');
  assert.equal(options.locale.optional, '选填');
  assert.doesNotMatch(JSON.stringify(options.locale), /通知|邮件提醒/);
  assert.equal(page.status.hidden, true);
  assert.equal(page.retry.hidden, true);
  assert.equal(page.section.getAttribute('aria-busy'), 'false');
  assert.equal(page.timers.size, 0);
});

await test('repeated intersections, clicks, and script execution never duplicate an instance', async () => {
  const page = browser();
  page.intersect();
  page.intersect();
  page.retry.dispatch('click');
  page.execute();
  assert.equal(page.resources.length, 2);
  assert.equal(page.observers.length, 1);
  await page.complete();
  page.retry.dispatch('click');
  page.intersect();
  page.execute();
  await flush();
  assert.equal(page.calls.length, 1);
  assert.equal(page.resources.length, 2);
});

await test('a failed script offers retry and preserves the successfully loaded stylesheet', async () => {
  const page = browser();
  page.intersect();
  const oldScript = page.asset('script');
  page.asset('link').dispatch('load');
  oldScript.dispatch('error');
  await flush();
  assert.equal(page.calls.length, 0);
  assert.equal(oldScript.removed, true);
  assert.match(page.status.textContent, /失败/);
  assert.equal(page.retry.hidden, false);
  assert.equal(page.retry.disabled, false);
  page.retry.dispatch('click');
  assert.equal(page.resources.length, 3);
  assert.equal(page.resources.filter(item => item.tagName === 'link').length, 1);
  await page.complete();
  assert.equal(page.calls.length, 1);
  assert.equal(page.status.hidden, true);
});

await test('stylesheet retry reuses an in-flight script and initializes only when both succeed', async () => {
  const page = browser();
  page.intersect();
  page.asset('link').dispatch('error');
  await flush();
  page.retry.dispatch('click');
  assert.equal(page.resources.length, 3);
  assert.equal(page.resources.filter(item => item.tagName === 'script').length, 1);
  await page.complete();
  assert.equal(page.calls.length, 1);
});

await test('a loaded script missing the Waline API can be fetched again on retry', async () => {
  const page = browser({ observer: false });
  page.asset('script').dispatch('load');
  page.asset('link').dispatch('load');
  await flush();
  assert.equal(page.retry.hidden, false);
  assert.equal(page.calls.length, 0);
  page.retry.dispatch('click');
  assert.equal(page.resources.length, 3);
  await page.complete();
  assert.equal(page.calls.length, 1);
});

await test('resource timeouts allow retry and a failed initialization can recover', async () => {
  const page = browser({ observer: false });
  for (const callback of [...page.timers.values()]) callback();
  await flush();
  assert.equal(page.retry.hidden, false);
  assert.equal(page.timers.size, 0);
  assert.ok(page.resources.every(item => item.removed));
  page.retry.dispatch('click');
  page.failInitialization(true);
  await page.complete();
  assert.equal(page.calls.length, 1);
  assert.equal(page.retry.hidden, false);
  assert.equal(page.thread.children.length, 0);
  page.failInitialization(false);
  page.retry.dispatch('click');
  await flush();
  assert.equal(page.calls.length, 2);
  assert.equal(page.thread.children.length, 1);
  assert.equal(page.resources.length, 4, 'Initialization retry reuses both loaded files.');
});

await test('localhost and other preview origins cannot contact a non-loopback service', () => {
  for (const origin of ['http://localhost:4173', 'https://preview.example.test', 'https://gudu.blog.example.test']) {
    const page = browser({ origin });
    assert.equal(page.resources.length, 0);
    assert.equal(page.observers.length, 0);
    assert.equal(page.status.textContent, '预览模式不连接线上评论。');
    assert.equal(page.status.hidden, false);
    assert.equal(page.retry.hidden, true);
    page.retry.dispatch('click');
    assert.equal(page.resources.length, 0);
  }
});

await test('loopback servers remain usable for local testing and missing observers load immediately', async () => {
  for (const serverURL of ['http://localhost:8360', 'http://127.0.0.1:8360', 'http://[::1]:8360']) {
    const page = browser({ origin: 'http://localhost:4173', serverURL, observer: false });
    assert.equal(page.resources.length, 2);
    assert.equal(page.asset('script').src, 'http://localhost:4173/assets/vendor/waline/waline.umd.js');
    await page.complete();
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].serverURL, serverURL);
    assert.equal(Object.hasOwn(page.calls[0], 'turnstileKey'), false);
  }
});

await test('missing mounts and invalid service URLs never load assets', () => {
  const missing = browser({ missing: true });
  assert.equal(missing.resources.length, 0);
  for (const serverURL of ['', 'not a URL', 'javascript:alert(1)']) {
    const page = browser({ serverURL, observer: false });
    assert.equal(page.resources.length, 0);
    assert.match(page.status.textContent, /配置有误/);
    assert.equal(page.retry.hidden, true);
  }
});
