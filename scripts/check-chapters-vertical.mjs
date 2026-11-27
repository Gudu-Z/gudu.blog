// Checks the phone layout in a real browser: below the phone breakpoint
// js/chapters-vertical.js runs the chapters as one vertical page with an
// altimeter tape, and hands the page back to the horizontal strip when the
// viewport grows. On wide screens it also checks that the folded ends of the
// HUD land on the flat page's frame and still answer the pointer where they
// show. Needs Chrome, Chromium or Edge; CHROME_PATH picks a build.
// Restricted test hosts can opt out of Chrome's nested sandbox with CHROME_NO_SANDBOX=1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.xml': 'application/xml; charset=utf-8', '.json': 'application/json' };
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const skip = chrome ? false : 'no Chrome, Chromium or Edge found (set CHROME_PATH)';
if (skip) console.warn(`check-chapters-vertical: skipped, ${skip}`);

const sleep = ms => new Promise(done => setTimeout(done, ms));
let server;
let origin;
let browser;
let profile;
let socket;
let sequence = 0;
const pending = new Map();
const failures = [];

function send(method, params = {}, sessionId) {
  return new Promise((done, fail) => {
    const id = ++sequence;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

before(async () => {
  if (skip) return;
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      const path = relative(root, file);
      if (isAbsolute(path) || path.split(/[\\/]/).some(part => part.startsWith('.')) || !types[extname(file)]) throw new Error('not found');
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'gudu-vertical-'));
  // Without WebGL the page shows its static black hole: quick and identical everywhere.
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-3d-apis', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
    ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not start')), 20000);
    browser.once('error', error => { clearTimeout(timer); fail(error); });
    browser.once('exit', code => { clearTimeout(timer); fail(new Error(`Chrome exited before connecting (${code}): ${log}`)); });
    browser.stderr.on('data', data => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onclose = () => {
    for (const call of pending.values()) call.fail(new Error('Chrome disconnected during a check'));
    pending.clear();
  };
  socket.onmessage = message => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const call = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) call.fail(new Error(JSON.stringify(data.error)));
      else call.done(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') failures.push(data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text);
  };
});

after(async () => {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    browser.kill();
    await new Promise(done => browser.once('exit', done));
  }
  server?.close();
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
});

async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(page, expression, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(page, expression).catch(() => false)) return;
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function viewport(page, { width, height, mobile, deviceScaleFactor = 1 }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile }, page.sessionId);
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, page.sessionId);
}

async function open(path = '/', { width = 390, height = 844, mobile = true, deviceScaleFactor = 1, reduced = false, beforeScripts } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  if (beforeScripts) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') { ${beforeScripts} }
      });`,
    }, sessionId);
  }
  await viewport(page, { width, height, mobile, deviceScaleFactor });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] }, sessionId);
  await send('Page.navigate', { url: origin + path }, sessionId);
  await waitFor(page, "document.readyState === 'complete' && !document.documentElement.classList.contains('is-loading')", 10000);
  await evaluate(page, 'document.fonts.ready.then(() => true)');
  await sleep(300);
  return page;
}

const close = page => send('Target.closeTarget', { targetId: page.targetId });

// Layout positions ignore the tilt each block carries on screen.
const STATE = `(() => {
  const pageTop = element => { let top = 0; for (let node = element; node; node = node.offsetParent) top += node.offsetTop; return top; };
  const html = document.documentElement;
  const header = document.querySelector('.site-header').offsetHeight;
  const nav = document.querySelector('.chapter-progress');
  const marker = document.querySelector('.chapter-progress-marker').getBoundingClientRect();
  const window = nav.getBoundingClientRect();
  const stations = [...nav.querySelectorAll('.chapter-progress-links a')].map(link => link.getBoundingClientRect());
  const current = document.querySelector('.chapter-progress-links [aria-current]');
  return {
    y: scrollY,
    vertical: html.classList.contains('has-vertical-chapters'),
    content: html.classList.contains('is-content'),
    entry: pageTop(document.querySelector('#about .chapter-panel')) - header - 28,
    header,
    position: Number(nav.style.getPropertyValue('--chapter-position')),
    current: current?.querySelector('.chapter-station-title').textContent ?? null,
    hash: location.hash,
    search: location.search,
    focus: document.activeElement?.id || '',
    history: history.length,
    pointerY: marker.top + marker.height / 2,
    readingLine: window.top + window.height / 2,
    tape: { top: window.top, bottom: window.bottom, first: stations[0].top, last: stations.at(-1).bottom },
    width: html.scrollWidth,
    height: html.scrollHeight,
    end: pageTop(document.querySelector('#chapter-scroll')) + document.querySelector('#chapter-scroll').offsetHeight,
    runway: document.querySelector('#chapter-scroll').style.height,
    track: document.querySelector('#chapter-track').style.transform,
  };
})()`;
const state = page => evaluate(page, STATE);
const layoutTop = (page, selector) => evaluate(page, `(() => { let top = 0; for (let node = document.querySelector(${JSON.stringify(selector)}); node; node = node.offsetParent) top += node.offsetTop; return top; })()`);
const sectionTop = (page, id) => layoutTop(page, '#' + id);
const scroll = (page, top) => evaluate(page, `(scrollTo({ top: ${top}, behavior: 'instant' }), new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY)))))`);

async function swipe(page, x, from, to) {
  const points = y => [{ x, y, id: 1, radiusX: 4, radiusY: 4 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) }, page.sessionId);
  for (let step = 1; step <= 8; step++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * step / 8) }, page.sessionId);
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId);
}

async function mouse(page, type, x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, page.sessionId);
}
async function click(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, 1);
  await mouse(page, 'mouseReleased', x, y);
}
async function clickLink(page, selector, { touch = false } = {}) {
  const point = await evaluate(page, `(() => {
    const link = document.querySelector(${JSON.stringify(selector)});
    const box = link.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    return { x, y, reachable: link.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.ok(point.reachable, `${selector} can be clicked where it is painted`);
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] }, page.sessionId);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId);
  } else await click(page, point.x, point.y);
}
async function drag(page, x, from, to) {
  await mouse(page, 'mouseMoved', x, from);
  await mouse(page, 'mousePressed', x, from, 1);
  for (let step = 1; step <= 10; step++) {
    await mouse(page, 'mouseMoved', x, from + (to - from) * step / 10, 1);
    await sleep(16);
  }
  await mouse(page, 'mouseReleased', x, to);
}

// Screen geometry of the tape: its axis and each station's stem.
const TAPE = `(() => {
  const axis = document.querySelector('.chapter-progress-track').getBoundingClientRect();
  const stations = [...document.querySelectorAll('.chapter-progress-links a')].map(link => {
    const box = link.getBoundingClientRect();
    const title = link.querySelector('.chapter-station-title').getBoundingClientRect();
    return { top: box.top, height: box.height, titleX: title.left + title.width / 2, titleY: title.top + title.height / 2 };
  });
  return { axisX: axis.left + axis.width / 2, stations };
})()`;

test('phone chapter hashes survive the loader and native fragment scrolling', { skip }, async () => {
  for (const id of ['about', 'series', 'journal', 'archive', 'home', '']) {
    const page = await open(`/?intro=short${id ? '#' + id : ''}`, { width: 375, height: 812 });
    try {
      const now = await state(page);
      const target = !id || id === 'home' ? 0 : id === 'about' ? now.entry
        : Math.min((await sectionTop(page, id)) - now.header - 8, now.height - 812);
      assert.ok(Math.abs(now.y - target) <= 2, `${id || 'no hash'} lands at ${now.y}, expected ${target}`);
      assert.equal(now.hash, id ? '#' + id : '');
    } finally {
      await close(page);
    }
  }
});

test('phone hash changes keep the measured landing in portrait, landscape and reduced motion', { skip }, async () => {
  for (const view of [{ width: 375, height: 812 }, { width: 844, height: 390 }, { width: 375, height: 812, reduced: true }]) {
    const page = await open('/index.html?intro=short#about', view);
    try {
      assert.ok(Math.abs((await state(page)).y - (await state(page)).entry) <= 2, 'the 404 destination opens About');
      for (const id of ['journal', 'about', 'series', 'archive', 'about', 'home']) {
        await evaluate(page, `location.hash = '${id}'`);
        await sleep(1100);
        const now = await state(page);
        const target = id === 'home' ? 0 : id === 'about' ? now.entry
          : Math.min((await sectionTop(page, id)) - now.header - 8, now.height - view.height);
        assert.ok(Math.abs(now.y - target) <= 2, `${id} lands at ${now.y}, expected ${target} on ${view.width}x${view.height}`);
        assert.equal(now.hash, '#' + id);
      }
    } finally {
      await close(page);
    }
  }
});

test('the final loader correction follows layout changes until the reader interacts', { skip }, async () => {
  const page = await open('/?intro=short#series', { width: 375, height: 812 });
  try {
    await evaluate(page, `(() => {
      document.querySelector('#about').style.paddingBottom = '180px';
      window.dispatchEvent(new Event('site:revealed'));
    })()`);
    let now = await state(page);
    assert.ok(Math.abs(now.y - ((await sectionTop(page, 'series')) - now.header - 8)) <= 2, 'startup scroll events do not cancel the final landing correction');
    await swipe(page, 180, 600, 520);
    await sleep(600);
    now = await state(page);
    await evaluate(page, "window.dispatchEvent(new Event('site:revealed'))");
    assert.equal((await state(page)).y, now.y, 'the loader leaves a reader who has scrolled in place');
  } finally {
    await close(page);
  }
});

const FILTERS = `(() => {
  const row = document.querySelector('.journal-toolbar > .filter-list');
  const toolbar = row.parentElement;
  const panel = row.closest('.chapter-panel');
  const style = getComputedStyle(row);
  const panelStyle = getComputedStyle(panel);
  return {
    left: row.scrollLeft, width: row.clientWidth, total: row.scrollWidth,
    panelWidth: panel.clientWidth - parseFloat(panelStyle.paddingLeft) - parseFloat(panelStyle.paddingRight),
    pageWidth: document.documentElement.scrollWidth, y: scrollY, x: scrollX,
    mask: style.maskImage, scrollbar: style.scrollbarWidth, touch: style.touchAction,
    before: { opacity: getComputedStyle(toolbar, '::before').opacity, background: getComputedStyle(toolbar, '::before').backgroundImage },
    after: { opacity: getComputedStyle(toolbar, '::after').opacity, background: getComputedStyle(toolbar, '::after').backgroundImage },
    buttons: [...row.querySelectorAll('button')].map(button => ({
      label: button.querySelector('.filter-label').textContent, left: button.offsetLeft, right: button.offsetLeft + button.offsetWidth,
      active: button.getAttribute('aria-pressed') === 'true', focused: button === document.activeElement, tab: button.tabIndex,
    })),
  };
})()`;

test('phone category filters scroll inside the panel with overlays and keyboard access', { skip }, async () => {
  const page = await open('/?intro=short#journal', { width: 375, height: 812 });
  try {
    let row = await evaluate(page, FILTERS);
    const initialY = row.y;
    assert.ok(row.width <= row.panelWidth + 1, 'the filter row stays inside the panel');
    assert.ok(row.total > row.width, 'the categories have their own horizontal scroll range');
    assert.equal(row.pageWidth, 375);
    assert.equal(row.mask, 'none', 'the row does not mask the phone compositor layer');
    assert.equal(row.scrollbar, 'none');
    assert.ok(row.touch.includes('pan-x') && !row.touch.includes('pan-y'));
    assert.equal(row.before.opacity, '0');
    assert.equal(row.after.opacity, '1');
    assert.match(row.after.background, /linear-gradient/);
    assert.deepEqual(row.buttons.map(button => button.label), ['全部', 'Minecraft', '白日梦话', '神秘文案', '其他']);
    assert.ok(row.buttons.every(button => button.tab === 0), 'every category stays in the tab order');

    await evaluate(page, "document.querySelector('.filter-list').scrollLeft = 40");
    await waitFor(page, "document.querySelector('.journal-toolbar').classList.contains('has-filter-left')");
    row = await evaluate(page, FILTERS);
    assert.equal(row.before.opacity, '1');
    assert.equal(row.after.opacity, '1');

    await evaluate(page, "document.querySelector('.filter-list button:last-child').click()");
    await waitFor(page, "!document.querySelector('.journal-toolbar').classList.contains('has-filter-right')");
    row = await evaluate(page, FILTERS);
    const selected = row.buttons.find(button => button.active);
    assert.ok(selected.left >= row.left - 1 && selected.right <= row.left + row.width + 1, 'an active category is fully visible');
    assert.equal(row.before.opacity, '1');
    assert.equal(row.after.opacity, '0');
    assert.equal(row.y, initialY, 'changing the selection only scrolls the row');

    await evaluate(page, "document.querySelector('.filter-list button').focus({ preventScroll: true })");
    const beforeKeys = (await state(page)).y;
    for (let index = 0; index < row.buttons.length; index++) {
      if (index) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, page.sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, page.sessionId);
      }
      row = await evaluate(page, FILTERS);
      const focused = row.buttons[index];
      assert.equal(focused.focused, true, `${focused.label} is reachable with Tab`);
      assert.ok(focused.left >= row.left - 1 && focused.right <= row.left + row.width + 1, `${focused.label} is visible when focused`);
      assert.equal(row.y, beforeKeys, 'revealing a filter only scrolls the row');
    }
    assert.equal(row.x, 0);

    await evaluate(page, "document.activeElement.blur(); document.querySelector('.filter-list button').click()");
    await waitFor(page, "document.querySelector('.filter-list').scrollLeft === 0");
    const start = await evaluate(page, `(() => {
      const box = document.querySelector('.filter-list').getBoundingClientRect();
      return { x: box.right - 12, end: box.left + 12, y: box.top + box.height / 2, pageY: scrollY };
    })()`);
    const points = step => [{ x: start.x + (start.end - start.x) * step / 8, y: start.y + step, id: 1, radiusX: 4, radiusY: 4 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) }, page.sessionId);
    for (let step = 1; step <= 8; step++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step) }, page.sessionId);
      await sleep(16);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId);
    await sleep(500);
    row = await evaluate(page, FILTERS);
    assert.ok(row.left > 40, 'a horizontal touch swipe scrolls the row');
    assert.equal(row.y, start.pageY, 'a slightly diagonal horizontal swipe leaves the page in place');
    assert.equal(row.x, 0);
    assert.equal(row.pageWidth, 375);

    for (const [theme, color] of [['light', 'rgb(234, 235, 237)'], ['dark', 'rgb(12, 14, 17)']]) {
      await evaluate(page, `window.SiteTheme.set('${theme}')`);
      assert.ok((await evaluate(page, FILTERS)).after.background.includes(color), 'the overlay uses the panel color in each theme');
    }
    await viewport(page, { width: 844, height: 390, mobile: true });
    await sleep(400);
    row = await evaluate(page, FILTERS);
    assert.ok(row.width <= row.panelWidth + 1, 'landscape also contains the row');
    assert.equal(row.pageWidth, 844);
    assert.equal(row.mask, 'none');
    assert.equal(row.before.opacity, row.left > 1 ? '1' : '0');
    assert.equal(row.after.opacity, row.left < row.total - row.width - 1 ? '1' : '0');
    await viewport(page, { width: 1200, height: 800, mobile: false });
    await waitFor(page, "!document.documentElement.classList.contains('has-vertical-chapters')");
    assert.equal(await evaluate(page, "document.querySelector('.journal-toolbar').matches('.has-filter-left, .has-filter-right')"), false, 'desktop mode releases the phone overlays');
    assert.deepEqual(failures, []);
  } finally {
    await close(page);
  }
});

test('phones get the vertical page and the strip hands over everything it wrote', { skip }, async () => {
  const page = await open();
  const now = await state(page);
  assert.equal(now.vertical, true);
  assert.equal(now.runway, '', 'the strip removed its scroll runway');
  assert.equal(now.track, '', 'the strip removed its sideways offset');
  assert.equal(now.width, 390, 'nothing widens the page');
  assert.ok(Math.abs(now.height - now.end) <= 2, `the page ends with its content (${now.height} vs ${now.end})`);
  const nav = await evaluate(page, "(() => { const box = document.querySelector('.chapter-progress').getBoundingClientRect(); return { left: box.left, right: box.right }; })()");
  assert.ok(nav.right >= 384 && nav.left >= 350, 'the tape stands on the right edge');
  assert.equal(await evaluate(page, "document.querySelector('.chapter-progress-marker').getAttribute('aria-orientation')"), 'vertical');
  const column = await evaluate(page, "(() => { const box = document.querySelector('#about').getBoundingClientRect(); return box.right; })()");
  assert.ok(column <= nav.left - 4, 'the reading column leaves room for the tape');
  // Tilted blocks must not lengthen the page as it scrolls.
  await scroll(page, 1200);
  assert.ok(Math.abs((await state(page)).height - now.height) <= 1);
  await close(page);
});

test('the first swipe from the Hero lands on 关于, and going back returns to the Hero', { skip }, async () => {
  const page = await open();
  await swipe(page, 200, 620, 540);
  await sleep(1400);
  let now = await state(page);
  assert.ok(Math.abs(now.y - now.entry) <= 2, `landed at ${now.y}, 关于 rests at ${now.entry}`);
  assert.equal(now.content, true);
  assert.equal(now.current, '关于');
  assert.equal(now.position, 0);
  await swipe(page, 200, 420, 500);
  await sleep(1200);
  now = await state(page);
  assert.equal(now.y, 0, 'back on the Hero');
  assert.equal(now.content, false);
  // A wheel turn takes the same step on desktops with narrow windows.
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 120 }, page.sessionId);
  await sleep(1400);
  now = await state(page);
  assert.ok(Math.abs(now.y - now.entry) <= 2, 'the wheel lands on 关于 too');
  await close(page);
});

test('the pointer holds the middle while the tape follows the chapters, with both ends in view', { skip }, async () => {
  const page = await open();
  const series = await sectionTop(page, 'series');
  const readingLine = (await state(page)).readingLine;
  const positions = [];
  for (const top of [(await state(page)).entry, series - readingLine - 3, series - readingLine + 3, 99999]) {
    await scroll(page, top);
    const now = await state(page);
    positions.push([now.position, now.current]);
    assert.ok(Math.abs(now.pointerY - now.readingLine) <= 1.5, `pointer at ${now.pointerY}, reading line ${now.readingLine}`);
    assert.ok(now.tape.first >= now.tape.top + 4 && now.tape.last <= now.tape.bottom - 4, `both ends of the tape stay in view (${now.tape.first}–${now.tape.last})`);
  }
  assert.deepEqual(positions[0], [0, '关于'], 'the first reading position is 关于');
  assert.ok(positions[1][0] < 0.5 && positions[1][1] === '关于', 'just before 分类 the pointer is still in 关于');
  assert.ok(positions[2][0] > 0.5 && positions[2][1] === '分类', 'the stem passes the pointer as 分类 reaches the reading line');
  assert.deepEqual(positions[3], [3, '归档'], 'the bottom of the page is 归档');
  assert.equal((await state(page)).hash, '#archive', 'reading along renames the URL');
  await close(page);
});

test('the tape is one control: tap the axis, drag it, or tap a name', { skip }, async () => {
  const page = await open();
  await scroll(page, (await state(page)).entry);
  let tape = await evaluate(page, TAPE);
  // A tap on the axis brings that spot to the pointer.
  const journal = tape.stations[2];
  await click(page, tape.axisX, journal.top + journal.height / 2);
  await sleep(1100);
  let now = await state(page);
  assert.ok(Math.abs(now.position - 2) < 0.02, `axis tap reached ${now.position}`);
  assert.equal(now.current, '最新文章');
  // Dragging moves the tape with the finger, one cell per chapter.
  tape = await evaluate(page, TAPE);
  await drag(page, tape.axisX, now.pointerY, now.pointerY + tape.stations[0].height);
  await sleep(900);
  now = await state(page);
  assert.ok(Math.abs(now.position - 1) < 0.02, `drag reached ${now.position}`);
  assert.equal(now.current, '分类');
  // A name opens its chapter at the top of the reading area, as a new history entry.
  const before = now.history;
  tape = await evaluate(page, TAPE);
  await click(page, tape.stations[2].titleX, tape.stations[2].titleY);
  await sleep(1100);
  now = await state(page);
  const top = await sectionTop(page, 'journal');
  assert.ok(Math.abs(now.y - (top - now.header - 8)) <= 2, 'the journal opens under the toolbar');
  assert.equal(now.hash, '#journal');
  assert.equal(now.history, before + 1);
  assert.equal(now.focus, 'journal');
  await close(page);
});

test('section links, catalog search and linked URLs land on their chapter', { skip }, async () => {
  let page = await open();
  await scroll(page, (await state(page)).entry);
  const journalLanding = async () => (await sectionTop(page, 'journal')) - (await state(page)).header - 8;
  await evaluate(page, "document.querySelector('#about a[href=\"#journal\"]').click()");
  await sleep(1100);
  assert.ok(Math.abs((await state(page)).y - await journalLanding()) <= 2, 'the About card opens the journal');
  await scroll(page, (await sectionTop(page, 'series')) - 78);
  await evaluate(page, "document.querySelector('#series a[data-catalog-link]').click()");
  await waitFor(page, "document.documentElement.matches('.is-catalog:not(.is-catalog-transitioning)')");
  let now = await state(page);
  assert.equal(now.hash, '#catalog-minecraft');
  assert.equal(now.current, '分类');
  await evaluate(page, "(document.querySelector('#post-search input').value = 'x', document.querySelector('#post-search').requestSubmit(), 1)");
  await sleep(1100);
  assert.ok(Math.abs((await state(page)).y - await journalLanding()) <= 2, 'a search shows its results in the journal');
  assert.equal(await evaluate(page, "document.documentElement.classList.contains('is-catalog')"), false);
  await close(page);

  page = await open('/#archive');
  now = await state(page);
  assert.ok(Math.abs(now.y - Math.min((await sectionTop(page, 'archive')) - now.header - 8, now.height - 844)) <= 2, 'a linked chapter opens on load');
  assert.equal(now.current, '归档');
  await close(page);
});

const desktop = { width: 1600, height: 860, mobile: false };
const phone = { width: 390, height: 844, mobile: true };
const slugs = ['minecraft', 'daydreams', 'collected', 'other'];
const homeLabels = ['关于', '分类', '最新文章', '归档'];
const catalogLabels = ['Minecraft', '白日梦话', '神秘文案', '其他'];
const cover = slug => `.category-cover[href="#catalog-${slug}"]`;
const catalogSelector = slug => `[data-category-slug="${slug}"] .catalog-block`;
const catalogStation = slug => `.chapter-progress-links a[href="#catalog-${slug}"] .chapter-station-title`;

function withArticles(groups, perGroup, slug = 'minecraft') {
  // Use the builder's real markup for overflow without publishing fixture posts.
  return `{
    const row = document.querySelector('[data-category-slug="${slug}"] .catalog-row');
    const group = document.querySelector('[data-category-slug="minecraft"] .catalog-group').cloneNode(true);
    const card = group.querySelector('li').cloneNode(true);
    row.replaceChildren();
    for (let i = 0; i < ${groups}; i++) {
      const section = group.cloneNode(true);
      const name = '测试分组 ' + (i + 1);
      section.setAttribute('aria-label', name);
      section.querySelector('h3').textContent = name;
      section.querySelector('.catalog-group-count').textContent = String(${perGroup}).padStart(2, '0');
      const list = section.querySelector('ol');
      list.replaceChildren();
      for (let j = 0; j < ${perGroup}; j++) {
        const item = card.cloneNode(true);
        item.querySelector('.catalog-card-index').textContent = String(j + 1).padStart(2, '0');
        item.querySelector('.catalog-card-title').textContent = '测试文章 ' + (i * ${perGroup} + j + 1);
        list.append(item);
      }
      row.append(section);
    }
  }`;
}

async function settledCatalog(page, slug) {
  const condition = slug
    ? `location.hash === '#catalog-${slug}' && document.querySelector('[data-category-slug="${slug}"].is-catalog-open .catalog-block:not([hidden]):not([inert])')`
    : `location.hash === '#series' && !document.documentElement.classList.contains('is-catalog')`;
  await waitFor(page, `(${condition}) && !document.documentElement.classList.contains('is-catalog-transitioning')`);
}

function readBoard(page) {
  return evaluate(page, `(() => {
    const one = selector => document.querySelector(selector);
    const rect = node => {
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const columns = [...document.querySelectorAll('#category-surface .category-column')];
    const neighbors = [...document.querySelectorAll('.chapter-section:not(#series) :is(.chapter-panel, [data-depth-owner])')];
    const ink = node => {
      let opacity = 1;
      for (; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity;
    };
    const visibleText = node => [...node.childNodes].map(child =>
      child.nodeType === Node.TEXT_NODE ? child.textContent : ink(child) > 0.01 ? visibleText(child) : '').join('');
    const group = one('.is-catalog-open .catalog-block');
    const panel = one('#category-surface');
    const facet = col => {
      const light = col.querySelector('.category-facet-light');
      return light.getClientRects().length ? rect(light) : rect(panel);
    };
    const column = group?.closest('.category-column');
    const tracked = [one('#series'), panel, one('.category-heading'), one('.category-heading h2'),
      one('.category-heading-text'), one('.category-heading .accent'), ...columns,
      ...document.querySelectorAll('.catalog-block, .chapter-section:not(#series)'), ...neighbors];
    return {
      title: visibleText(one('.category-heading-text')),
      name: one('#series-title').getAttribute('aria-label'),
      eyebrow: one('.category-heading .eyebrow').textContent.trim().replace(/\\s+/g, ' '),
      labels: [...document.querySelectorAll('.chapter-progress-links > a')].map(link => link.querySelector('.chapter-station-title').textContent),
      links: [...document.querySelectorAll('.chapter-progress-links > a')].map(link => link.hash),
      subs: [...document.querySelectorAll('.chapter-progress-links > a')].map(link => link.querySelector('.chapter-station-subtitle').textContent),
      rulerName: one('.chapter-progress').getAttribute('aria-label'),
      active: columns.map(col => col.classList.contains('is-catalog-open')),
      blocks: columns.map(col => { const block = col.querySelector('.catalog-block'); return [block.hidden, block.inert]; }),
      widths: columns.map(col => col.offsetWidth),
      displays: columns.map(col => col.querySelector('.category-display').offsetWidth),
      transforms: columns.map(col => getComputedStyle(col).transform),
      board: [facet(columns[0]).left, facet(columns.at(-1)).right],
      columns: columns.map(rect),
      openColumn: column && rect(column),
      display: column && rect(column.querySelector('.category-display')),
      items: group && [...group.querySelectorAll('.catalog-card, .catalog-empty')].map(rect),
      overflow: group && group.scrollWidth - group.clientWidth,
      mask: group && getComputedStyle(group).maskImage,
      heading: rect(one('.category-heading')),
      ruleEnd: rect(one('.category-heading-rule')).right,
      frame: [rect(one('.site-header .site-brand')).left, rect(one('.site-header .header-tools')).right],
      y: scrollY, runway: one('#chapter-scroll').style.height, slot: one('#series').offsetWidth,
      neighbors: neighbors.map(el => ({ top: rect(el).top, ink: ink(el) })),
      // Where each side chapter's transform origin has gone: its tilt turns
      // about that point, so only the sink's arc moves it.
      sinks: [...document.querySelectorAll('.chapter-section:not(#series)')].map(el => {
        const m = new DOMMatrix(getComputedStyle(el).transform), box = rect(el);
        return { x: m.m41 / m.m44, y: m.m42 / m.m44, center: (box.left + box.right) / 2 };
      }),
      sky: parseFloat(one('.black-hole-fallback').style.translate.split(' ')[1]) || 0,
      cards: group && [...group.querySelectorAll('ol a')].map(ink),
      // Chapter depth owns these inline variables before a catalog opens.
      styles: tracked.map(node => [...node.style].filter(key => !key.startsWith('--chapter-')).map(key => [key, node.style.getPropertyValue(key)])),
    };
  })()`);
}

function near(value, expected, tolerance, label) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${label}: got ${value}, expected ${expected} ±${tolerance}`);
}

function checkHeading(view) {
  near(view.heading.left, Math.max(view.board[0], view.frame[0]), 1, 'heading starts at the visible board');
  near(view.ruleEnd, Math.min(view.board[1], view.frame[1]), 1, 'rule ends at the visible board');
}

function checkFullRow(view) {
  assert.ok(view.items.length > 0);
  for (const item of view.items) {
    assert.ok(item.left >= view.display.left - 1 && item.right <= view.display.right + 1,
      `card [${item.left}, ${item.right}] fits display [${view.display.left}, ${view.display.right}]`);
    assert.ok(item.left >= view.frame[0] - 1 && item.right <= view.frame[1] + 1, 'the entire card is inside the frames');
  }
  assert.equal(view.overflow, 0);
  assert.equal(view.mask, 'none');
}

async function checkRestored(page, baseline) {
  await settledCatalog(page, '');
  const view = await readBoard(page);
  assert.equal(view.title, '分类');
  assert.equal(view.eyebrow, '02 CATEGORIES');
  assert.equal(view.name, baseline.name);
  assert.deepEqual(view.labels, homeLabels);
  assert.deepEqual(view.board, baseline.board);
  assert.deepEqual(view.heading, baseline.heading);
  assert.equal(view.ruleEnd, baseline.ruleEnd);
  assert.deepEqual(view.widths, baseline.widths);
  assert.deepEqual(view.displays, baseline.displays);
  assert.deepEqual(view.styles, baseline.styles, 'closing removes temporary inline styles');
  assert.deepEqual(view.blocks, Array(4).fill([true, true]));
  assert.deepEqual(view.transforms, Array(4).fill('none'));
  assert.equal(view.sky, 0, 'the hole is back behind the panel');
  assert.equal(view.y, baseline.y);
  await markerAt(page, 2, 0.5);
}

// How far the catalog's full tilt carries the hole down (js/main.js): the
// stage's scene unit times the chapters' focal length times tan 50°.
const FULL_SKY = "document.querySelector('#black-hole').offsetHeight / 2 * 4.05 * 0.34 * Math.tan(50 * Math.PI / 180)";
const SKY = "parseFloat(document.querySelector('.black-hole-fallback').style.translate.split(' ')[1]) || 0";

async function markerAt(page, cell, fraction) {
  const point = await evaluate(page, RULER_POINT(cell, fraction));
  const marker = await evaluate(page, MARKER);
  near(marker.x, point.x, 2, `ruler cell ${cell} at ${Math.round(fraction * 100)}%`);
}

async function press(page, key) {
  const codes = { Enter: 13, Escape: 27, Home: 36, End: 35, Tab: 9, PageDown: 34, ArrowLeft: 37 };
  const params = { key, code: key, windowsVirtualKeyCode: codes[key] };
  await send('Input.dispatchKeyEvent', { ...params, type: 'keyDown' }, page.sessionId);
  await send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, page.sessionId);
}

async function wheel(page, deltaX, deltaY) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 430, deltaX, deltaY }, page.sessionId);
}

const columnEdge = (slug, edge) => `document.querySelector('[data-category-slug="${slug}"]').getBoundingClientRect().${edge}`;
const panelLeft = "document.querySelector('#category-surface').getBoundingClientRect().left";
const flatDock = page => evaluate(page, `(() => {
  const panel = document.querySelector('#category-surface');
  const transform = panel.style.transform;
  panel.style.transform = 'none';
  const { left, right } = panel.getBoundingClientRect();
  const slot = panel.querySelector('.category-column').getBoundingClientRect().left;
  panel.style.transform = transform;
  return { left, right, slot };
})()`);

test('a category opens inside its docked panel and a switch moves the expansion', { skip }, async () => {
  const page = await open('/#series', desktop);
  try {
    const home = await readBoard(page);
    const dock = await flatDock(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    const view = await readBoard(page);
    assert.equal(view.title, '文章目录');
    assert.equal(view.name, '文章目录');
    assert.equal(view.eyebrow, '02 ARTICLE INDEX');
    assert.deepEqual(view.labels, catalogLabels);
    assert.deepEqual(view.links, slugs.map(slug => '#catalog-' + slug));
    assert.deepEqual(view.subs, ['GAME JOURNAL', 'DAYDREAMS', 'COLLECTED WORDS', 'MISCELLANY']);
    assert.equal(view.rulerName, '文章目录分类');
    assert.ok(view.displays[0] > home.displays[0]);
    assert.deepEqual(view.widths.slice(1), home.widths.slice(1));
    assert.deepEqual(view.blocks, [[false, false], [true, true], [true, true], [true, true]]);
    assert.deepEqual(view.transforms, Array(4).fill('none'));
    const material = await evaluate(page, `(() => {
      const panel = document.querySelector('#category-surface');
      const facets = [...panel.querySelectorAll('.category-facet-light')];
      return {
        flat: getComputedStyle(panel.querySelector(':scope > .chapter-panel-light')).display,
        background: getComputedStyle(panel).backgroundImage,
        shadow: getComputedStyle(panel).boxShadow,
        lit: facets.map(el => getComputedStyle(el, '::before').backgroundSize),
        glass: facets.map(el => getComputedStyle(el).backgroundColor),
      };
    })()`);
    assert.deepEqual([material.flat, material.background, material.shadow], ['none', 'none', 'none']);
    assert.ok(material.lit.every(size => parseFloat(size) > 1000), 'each facet samples the common panel light');
    assert.ok(material.glass.every(color => color !== 'rgba(0, 0, 0, 0)'), 'each facet carries the panel material');
    assert.ok(view.neighbors.length > 0 && view.neighbors.every(neighbor => neighbor.ink === 0));
    near(view.board[0], dock.left, 1, 'left panel edge');
    assert.ok(view.board[1] <= view.frame[1] + 1, 'this single article fits beside all three neighbours');
    checkHeading(view);
    checkFullRow(view);
    assert.equal(view.y, home.y);
    assert.equal(view.runway, home.runway);
    assert.equal(view.slot, home.slot);
    await markerAt(page, 1, 0.5);
    await wheel(page, 0, 24);
    await press(page, 'End');
    await sleep(300);
    assert.equal((await state(page)).y, home.y);
    assert.equal((await state(page)).hash, '#catalog-minecraft');

    await clickLink(page, cover('collected'));
    await settledCatalog(page, 'collected');
    const switched = await readBoard(page);
    assert.deepEqual(switched.active, [false, false, true, false]);
    assert.equal(switched.widths[0], home.widths[0]);
    assert.ok(switched.displays[2] > home.displays[2]);
    assert.equal(switched.title, '文章目录');
    await markerAt(page, 3, 0.5);
    await clickLink(page, '.chapter-progress-links a[href="#catalog-minecraft"] .chapter-station-title');
    await evaluate(page, 'history.back()');
    await settledCatalog(page, 'collected');
    await clickLink(page, '.chapter-progress-links a[href="#catalog-minecraft"] .chapter-station-title');
    await settledCatalog(page, 'minecraft');
    const card = catalogSelector('minecraft') + ' ol a';
    const path = await evaluate(page, `document.querySelector(${JSON.stringify(card)}).pathname`);
    await clickLink(page, card);
    await waitFor(page, `location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete'`);
  } finally { await close(page); }
});

test('a catalog that fits keeps its docked left edge for every category', { skip }, async () => {
  for (const [width, height] of [[1280, 720], [1600, 860]]) {
    const page = await open('/#series', { ...desktop, width, height });
    try {
      const dock = await flatDock(page);
      for (const slug of slugs) {
        await clickLink(page, slug === slugs[0] ? cover(slug) : catalogStation(slug));
        await settledCatalog(page, slug);
        const view = await readBoard(page);
        near(view.board[0], dock.left, 1, `${width}px ${slug} keeps the board anchored`);
        assert.ok(view.columns.at(-1).right <= view.frame[1] + 1, 'all four columns fit');
        checkFullRow(view);
        checkHeading(view);
      }
    } finally { await close(page); }
  }
});

test('the narrow catalog slides toward the first slot and stops at the docked panel end', { skip }, async () => {
  const page = await open('/#series', { ...desktop, width: 871, height: 817, deviceScaleFactor: 2,
    beforeScripts: withArticles(1, 5, 'daydreams') + withArticles(1, 2, 'other') });
  try {
    const home = await readBoard(page);
    const dock = await flatDock(page);
    await seekCatalog(page, 0, `document.querySelector('${cover('daydreams')}').click();`);
    await seekCatalog(page, 430);
    const opening = await readBoard(page);
    await seekCatalog(page, 1300);
    await settledCatalog(page, 'daydreams');
    const daydreams = await readBoard(page);
    near(daydreams.openColumn.left, dock.slot, 1, 'a long row in the second category reaches the first slot');
    assert.ok(daydreams.columns[0].left < 0 && daydreams.columns[0].right <= dock.slot + 1);
    assert.ok(daydreams.board[1] > dock.right + 1);
    assert.ok(opening.widths[1] > home.widths[1] && opening.widths[1] < daydreams.widths[1]);
    checkHeading(daydreams);

    await clickLink(page, catalogStation('other'));
    await seekCatalog(page, 380);
    const switching = await readBoard(page);
    await seekCatalog(page, 1200);
    await settledCatalog(page, 'other');
    const last = await readBoard(page);
    assert.ok(last.openColumn.left > dock.slot + 1, 'the shorter row stops short of the first slot');
    near(last.board[1], dock.right, 1, 'the outer edge of the rest panel limits the slide');
    near(switching.widths[3], (daydreams.widths[3] + last.widths[3]) / 2, 1, 'the width moves halfway through the switch');
    checkHeading(last);
    checkFullRow(last);

    await clickLink(page, '.catalog-back');
    await seekCatalog(page, 380);
    const closing = await readBoard(page);
    assert.ok(closing.widths[3] > home.widths[3] && closing.widths[3] < last.widths[3]);
    await seekCatalog(page, 1200);
    await checkRestored(page, home);
  } finally { await close(page); }
});

// The first entry of the open category, read at rest or under the pointer.
// Vertical text stacks its lines across, so its columns are width / line height.
const ENTRY = `(() => {
  const col = document.querySelector('.is-catalog-open');
  const card = col.querySelector('.catalog-card');
  const rect = node => node.getBoundingClientRect();
  const within = (inner, outer) => [inner.top - outer.top, outer.bottom - inner.bottom, inner.left - outer.left, outer.right - inner.right];
  const columns = el => Math.round(el.offsetWidth / parseFloat(getComputedStyle(el).lineHeight));
  const box = rect(card), block = col.querySelector('.catalog-block');
  const centre = [box.left + box.width / 2, box.top + box.height / 2];
  return {
    hover: card.matches(':hover'),
    reachable: card.contains(document.elementFromPoint(...centre)),
    centre,
    clipped: card.classList.contains('is-clipped'),
    columns: ['.catalog-card-title', '.catalog-card-summary'].map(selector => columns(card.querySelector(selector))),
    shown: ['.catalog-card-index', '.catalog-card-summary', '.catalog-card-meta'].map(selector => getComputedStyle(card.querySelector(selector)).opacity),
    title: within(rect(card.querySelector('.catalog-card-title')), box),
    group: within(rect(col.querySelector('.catalog-group')), rect(col.querySelector('.category-display'))),
    footer: within(rect(col.querySelector('.category-bottom')), rect(col.querySelector('.category-facet-light'))),
    overflow: block.scrollHeight - block.clientHeight,
  };
})()`;

test('a short desktop keeps a long title in one column and lets it run on when pointed at', { skip }, async () => {
  const beforeScripts = `{
    const card = document.querySelector('[data-category-slug="minecraft"] .catalog-card');
    card.querySelector('.catalog-card-title').textContent = '在这篇红石笔记里记录一次完整的测试过程';
    card.querySelector('.catalog-card-summary').textContent = '把观察到的细节按顺序记下来，比较每一步变化，再从头检查整个过程。';
  }`;
  const page = await open('/#series', { ...desktop, width: 1280, height: 600, beforeScripts });
  try {
    const home = await readBoard(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    const board = await readBoard(page);
    assert.equal(board.slot, home.slot);
    assert.equal(board.runway, home.runway);
    assert.equal(board.y, home.y);

    // The click leaves the pointer where the cover was; park it off the entries.
    await mouse(page, 'mouseMoved', 1, 1);
    await sleep(450);
    const rest = await evaluate(page, ENTRY);
    assert.equal(rest.hover, false, 'the entry starts unpointed');
    assert.equal(rest.clipped, true, 'the fixture cuts the long title short');
    assert.deepEqual(rest.columns, [1, 2], 'the title keeps one column and the summary fills both of its own');
    assert.equal(rest.shown[1], '1', 'the summary shows at rest');
    assert.ok(rest.title.every(gap => gap >= -1), `the title stays inside its frame (${rest.title})`);
    assert.ok(rest.group.every(gap => gap >= -1) && rest.overflow <= 1, `the group fits the display (${rest.group}; ${rest.overflow}px overflow)`);
    assert.ok(rest.footer.every(gap => gap >= -1), `the spine's count fits the column material (${rest.footer})`);

    assert.ok(rest.reachable, 'the entry can be pointed at where it is painted');
    await mouse(page, 'mouseMoved', ...rest.centre);
    await sleep(450);
    const pointed = await evaluate(page, ENTRY);
    assert.equal(pointed.hover, true);
    assert.ok(pointed.columns[0] >= 2, `the clipped title runs on into the right column (${pointed.columns[0]} columns)`);
    assert.deepEqual(pointed.shown, ['0', '0', '0'], 'the numeral, summary and date step aside for it');
    assert.ok(pointed.title.every(gap => gap >= -1), `the unfolded title stays inside its frame (${pointed.title})`);

    await mouse(page, 'mouseMoved', 1, 1);
    await sleep(450);
    const left = await evaluate(page, ENTRY);
    assert.deepEqual([left.columns, left.shown[1]], [[1, 2], '1'], 'leaving the entry folds the title back');
  } finally { await close(page); }
});

test('the back control, Escape and browser Back restore the home panel', { skip }, async () => {
  const page = await open('/#series', desktop);
  try {
    const baseline = await readBoard(page);
    for (const exit of ['control', 'escape', 'history']) {
      await clickLink(page, cover('minecraft'));
      await settledCatalog(page, 'minecraft');
      if (exit === 'history') await evaluate(page, 'history.back()');
      else if (exit === 'escape') await press(page, 'Escape');
      else await clickLink(page, '.catalog-back');
      await checkRestored(page, baseline);
    }
  } finally { await close(page); }
});

// An open category holds its specimen in the hover pose, in the middle of the
// widened display and dimmed through its line colour. Group opacity would
// flatten the 3D planes into one texture that the panel's perspective blurs.
const SPECIMEN = slug => `(() => {
  const column = document.querySelector('[data-category-slug="${slug}"]');
  const scene = column.querySelector('.category-scene');
  const s = scene.getBoundingClientRect(), d = column.querySelector('.category-display').getBoundingClientRect();
  const css = getComputedStyle(scene);
  return {
    offset: Math.round((s.left + s.width / 2) - (d.left + d.width / 2)),
    opacity: css.opacity, scale: css.scale,
    alpha: Number(css.color.match(/([\\d.]+)\\)$/)[1]),
    camera: Number(getComputedStyle(column.querySelector('.category-stage')).transform.match(/matrix3d\\(([-\\d.e]+)/)[1]).toFixed(3),
  };
})()`;
const specimenStill = slug => `document.querySelector('[data-category-slug="${slug}"] .category-scene').getAnimations({ subtree: true }).length === 0`;

test('an open category keeps its specimen open, centred and dimmed without group opacity', { skip }, async () => {
  const page = await open('/#series', desktop);
  try {
    const rest = await evaluate(page, SPECIMEN('minecraft'));
    const restCollected = await evaluate(page, SPECIMEN('collected'));
    assert.ok(rest.offset > 10 && rest.camera === '0.788' && rest.alpha === .55,
      `the resting specimen stands right of the display's middle, clear of the spine, and closed (${JSON.stringify(rest)})`);
    for (const slug of ['minecraft', 'collected']) {
      await clickLink(page, cover(slug));
      await settledCatalog(page, slug);
      await waitFor(page, specimenStill(slug), 4000);
      const open = await evaluate(page, SPECIMEN(slug));
      assert.ok(Math.abs(open.offset) <= 2, `${slug}: the specimen moves to the middle of the widened display (${open.offset}px off)`);
      assert.equal(open.opacity, '1', `${slug}: no group opacity on the 3D specimen`);
      assert.equal(open.scale, 'none', `${slug}: the specimen keeps its size`);
      assert.equal(open.camera, '0.940', `${slug}: the specimen holds its open pose`);
      assert.equal(open.alpha, .2, `${slug}: the open specimen dims through its line colour`);
    }
    await clickLink(page, '.catalog-back');
    await settledCatalog(page, '');
    await waitFor(page, specimenStill('collected'), 4000);
    const closed = await evaluate(page, SPECIMEN('collected'));
    assert.ok(Math.abs(closed.offset - restCollected.offset) <= 1 && closed.camera === '0.788' && closed.alpha === .55 && closed.opacity === '1',
      `closing returns the specimen to its resting place, pose and brightness (${JSON.stringify(closed)} vs ${restCollected.offset})`);
  } finally { await close(page); }
});

// Every desktop column stands its name, description and count as a spine at
// its left, and opening a category leaves the spine where it is. The
// specimen keeps clear of the spine: under it in a tall column, beside it in
// a short one.
const SPINE = slug => `(() => {
  const column = document.querySelector('[data-category-slug="${slug}"]');
  const parts = { name: '.category-name', description: '.category-description', count: '.category-bottom' };
  const rect = node => node.getBoundingClientRect();
  const union = rects => rects.reduce((u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top),
    right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const boxes = Object.fromEntries(Object.entries(parts).map(([key, selector]) => [key, rect(column.querySelector(selector))]));
  // Only the parts that show: the moon, core and node stay clear until hovered.
  boxes.specimen = union([...column.querySelectorAll('.category-specimen *')].filter(node => getComputedStyle(node).opacity !== '0')
    .map(rect).filter(r => r.width && r.height));
  const keys = Object.keys(boxes), clashes = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = boxes[keys[i]], b = boxes[keys[j]];
    const across = Math.min(a.right, b.right) - Math.max(a.left, b.left), down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (across > 1 && down > 1) clashes.push(keys[i] + '/' + keys[j]);
  }
  const display = rect(column.querySelector('.category-display')), s = boxes.specimen;
  return {
    // Layout offsets within the column, which the panel's 3D pose cannot skew.
    places: Object.fromEntries(Object.entries(parts).map(([key, selector]) => {
      const node = column.querySelector(selector);
      return [key, [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight].map(Math.round)];
    })),
    modes: Object.values(parts).map(selector => getComputedStyle(column.querySelector(selector)).writingMode),
    clashes,
    inside: s.left >= display.left - 1 && s.right <= display.right + 1 && s.top >= display.top - 1 && s.bottom <= display.bottom + 1,
  };
})()`;

test('desktop columns stand as spines that opening leaves in place, with the specimen clear of them', { skip }, async () => {
  for (const size of [desktop, { ...desktop, width: 1280, height: 600 }, { ...desktop, width: 1024, height: 768 }]) {
    const label = `${size.width}×${size.height}`;
    const page = await open('/#series', size);
    try {
      const rest = {};
      for (const slug of slugs) {
        rest[slug] = await evaluate(page, SPINE(slug));
        assert.deepEqual(rest[slug].modes, ['vertical-lr', 'vertical-lr', 'vertical-lr'], `${label} ${slug}: name, description and count stand vertical`);
        assert.deepEqual(rest[slug].clashes, [], `${label} ${slug}: the spine's parts and the specimen keep apart`);
        assert.ok(rest[slug].inside, `${label} ${slug}: the specimen stays inside its display`);
      }
      await clickLink(page, cover('minecraft'));
      await settledCatalog(page, 'minecraft');
      await waitFor(page, specimenStill('minecraft'), 4000);
      const open = await evaluate(page, SPINE('minecraft'));
      for (const part of ['name', 'description', 'count']) {
        assert.ok(open.places[part].every((value, i) => Math.abs(value - rest.minecraft.places[part][i]) <= 1),
          `${label}: opening leaves the ${part} where it stood (${rest.minecraft.places[part]} → ${open.places[part]})`);
      }
      // The open specimen is a dimmed background behind the entries.
      assert.deepEqual(open.clashes.filter(pair => !pair.includes('specimen')), [], `${label}: the open spine keeps its parts apart`);
    } finally { await close(page); }
  }
});

test("catalog entries start after the open category's spine and every entry shares one frame", { skip }, async () => {
  // Two groups of two; the second group's first title is too long for its column.
  const longTitle = `document.querySelectorAll('[data-category-slug="minecraft"] .catalog-group')[1]
    .querySelector('.catalog-card-title').textContent = '一个很长很长的测试标题，长到在一列里怎么也放不下，只好先截断';`;
  const page = await open('/#series', { ...desktop, beforeScripts: withArticles(2, 2) + longTitle });
  try {
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    await mouse(page, 'mouseMoved', 1, 1);
    await sleep(450);
    const row = await evaluate(page, `(() => {
      const column = document.querySelector('[data-category-slug="minecraft"]');
      const row = column.querySelector('.catalog-row');
      const rect = node => node.getBoundingClientRect();
      const probe = column.appendChild(document.createElement('div'));
      probe.style.cssText = 'position: absolute; width: var(--category-spine)';
      const spine = parseFloat(getComputedStyle(probe).width);
      probe.remove();
      const group = row.querySelector('.catalog-group');
      const cards = [...row.querySelectorAll('.catalog-card')];
      const titles = cards.map(card => card.querySelector('.catalog-card-title'));
      return {
        padding: parseFloat(getComputedStyle(row).paddingLeft), spine,
        start: rect(group).left - rect(row).left,
        spineEnd: Math.max(...[...column.querySelectorAll(':is(.category-name, .category-description, .category-bottom)')].map(node => rect(node).right)) - rect(group).left,
        level: rect(column.querySelector('.category-name')).top - rect(titles[0]).top,
        width: row.offsetWidth, display: column.querySelector('.category-display').clientWidth,
        heads: [...row.querySelectorAll('.catalog-group-head')].map(head => head.offsetTop),
        cards: cards.map(card => [card.offsetTop, card.offsetHeight, card.offsetWidth]),
        columns: titles.map(title => title.offsetWidth / parseFloat(getComputedStyle(title).lineHeight)),
        clipped: cards.map(card => card.classList.contains('is-clipped')),
      };
    })()`);
    assert.deepEqual(row.clipped, [false, false, true, false], 'only the long title is marked as cut short');
    assert.ok(row.columns.every(columns => Math.round(columns) === 1), `every title keeps one column (${row.columns})`);
    near(row.padding, row.spine, 1 / 64, "the row's start padding holds the spine");
    near(row.start, row.padding, 1 / 64, 'the first group starts where the spine ends');
    assert.ok(row.spineEnd <= 1, `the spine stays clear of the first group (${row.spineEnd}px over)`);
    assert.ok(Math.abs(row.level) <= 2, `the category name starts level with the first title (${row.level}px off)`);
    assert.ok(Math.abs(row.display - row.width) <= 1, `the open display widens to fit its row (${row.display} vs ${row.width})`);
    assert.equal(new Set(row.heads).size, 1, `group heads share one line (${row.heads})`);
    assert.equal(new Set(row.cards.map(String)).size, 1, `every entry shares one top edge, height and width (${JSON.stringify(row.cards)})`);
  } finally { await close(page); }
});

test('a long catalog scrolls the whole board with the heading clamped to the frame', { skip }, async () => {
  const page = await open('/#series', { ...desktop, beforeScripts: withArticles(3, 4) });
  try {
    const home = await readBoard(page);
    const dock = await flatDock(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    const view = await readBoard(page);
    assert.equal(view.cards.length, 12);
    near(view.openColumn.left, dock.slot, 1, 'the first column grows from its rest slot');
    const range = view.openColumn.right - view.frame[1];
    assert.ok(range > 1000);
    assert.ok(view.items.at(-1).right <= view.display.right);
    near(view.overflow, 0, 1, 'the display fits the entire row');
    assert.equal(view.mask, 'none');
    const displacement = `(${view.board[0]} - ${panelLeft})`;
    const startFraction = (await state(page)).position + 0.5;
    assert.ok(startFraction >= 0.25 && startFraction <= 0.5);
    await wheel(page, 0, 160);
    await waitFor(page, `Math.abs(${displacement} - 160) < 1`);
    await wheel(page, 220, 0);
    await waitFor(page, `Math.abs(${displacement} - 380) < 1`);
    const moved = await readBoard(page);
    near(view.items[0].left - moved.items[0].left, 380, 1, 'the cards travel with the panel');
    near(view.columns[1].left - moved.columns[1].left, 380, 1, 'the collapsed columns travel with the panel');
    near(moved.heading.left, view.frame[0], 1, 'the heading holds the left frame');
    checkHeading(moved);
    await press(page, 'End');
    await waitFor(page, `Math.abs(${displacement} - ${range}) < 1`);
    await markerAt(page, 1, 0.9);
    await press(page, 'Home');
    await waitFor(page, `Math.abs(${displacement}) < 1`);
    await markerAt(page, 1, startFraction);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page.sessionId);
    await swipe(page, 800, 490, 350);
    await waitFor(page, `${displacement} > 10`);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false }, page.sessionId);
    const fromTouch = await evaluate(page, displacement);
    await press(page, 'PageDown');
    await waitFor(page, `${displacement} > ${fromTouch + 10}`);
    await press(page, 'Home');
    await waitFor(page, `Math.abs(${displacement}) < 1`);
    const axis = await evaluate(page, RULER_POINT(1, startFraction + (0.9 - startFraction) * 0.5));
    await click(page, axis.x, axis.y);
    await waitFor(page, `Math.abs((${MARKER}).x - ${axis.x}) <= 1 && Math.abs(${displacement} / ${range} - .5) < .035`);
    const start = await evaluate(page, MARKER);
    const target = await evaluate(page, RULER_POINT(1, startFraction + (0.9 - startFraction) * 0.75));
    await mouse(page, 'mousePressed', start.x, start.y, 1);
    await mouse(page, 'mouseMoved', target.x, target.y, 1);
    await mouse(page, 'mouseReleased', target.x, target.y);
    await waitFor(page, `Math.abs(${displacement} / ${range} - .75) < .035`);
    await press(page, 'Home');
    await waitFor(page, `Math.abs(${displacement}) < 1`);
    const read = `document.querySelector(${JSON.stringify(catalogSelector('minecraft'))})`;
    await evaluate(page, `[...${read}.querySelectorAll('ol a')].at(-2).focus({preventScroll: true})`);
    await press(page, 'Tab');
    await waitFor(page, `(() => {
      const last = [...${read}.querySelectorAll('ol a')].at(-1);
      const card = last.getBoundingClientRect();
      return document.activeElement === last && card.left >= ${view.frame[0]} - 1 && card.right <= ${view.frame[1]} + 1;
    })()`);
    assert.equal(await evaluate(page, `${read}.scrollLeft`), 0, 'the row remains at its native origin');
    assert.equal((await state(page)).y, view.y);
    const second = await evaluate(page, RULER_POINT(2, 0.5));
    await click(page, second.x, second.y);
    await settledCatalog(page, 'daydreams');
    await clickLink(page, catalogStation('minecraft'));
    await settledCatalog(page, 'minecraft');
    await clickLink(page, '.catalog-back');
    await checkRestored(page, home);
  } finally { await close(page); }
});

test('the catalog cursor clears its labels and tracks clicks and drags through category switches', { skip }, async () => {
  for (const [width, height] of [[871, 817], [1440, 900]]) {
    const page = await open('/#catalog-minecraft', { ...desktop, width, height, beforeScripts: withArticles(3, 4) });
    try {
      await settledCatalog(page, 'minecraft');
      const marker = await evaluate(page, MARKER);
      const opened = await readBoard(page);
      const range = opened.openColumn.right - opened.frame[1];
      const startFraction = (await state(page)).position + .5;
      const expectedShift = range * (.77 - startFraction) / (.9 - startFraction);
      const right = await evaluate(page, `Math.max(...[...document.querySelector('[data-chapter-link][aria-current]')
        .querySelectorAll('.chapter-station-title, .chapter-station-subtitle')].map(el => el.getBoundingClientRect().right))`);
      assert.ok(marker.x - right >= 8, `at ${width}px the marker clears the label by ${marker.x - right}px`);
      const here = await evaluate(page, RULER_POINT(1, .77));
      await click(page, here.x, here.y);
      await waitFor(page, `Math.abs((${MARKER}).x - ${here.x}) <= 1`);
      near(opened.board[0] - await evaluate(page, panelLeft), expectedShift, range * .025, 'the pointer picks its fraction of the board range');
      // Drag into station B, then release over C before B's switch finishes.
      await mouse(page, 'mousePressed', here.x, here.y, 1);
      const middle = await evaluate(page, RULER_POINT(2, .6));
      await mouse(page, 'mouseMoved', middle.x, middle.y, 1);
      await waitFor(page, "location.hash === '#catalog-daydreams' && document.documentElement.classList.contains('is-catalog-transitioning')");
      const end = await evaluate(page, RULER_POINT(3, .72));
      await mouse(page, 'mouseMoved', end.x, end.y, 1);
      await mouse(page, 'mouseReleased', end.x, end.y);
      await settledCatalog(page, 'collected');
      // A click partway into an overflowing category must survive the switch too.
      await click(page, here.x, here.y);
      await settledCatalog(page, 'minecraft');
      await waitFor(page, `Math.abs((${MARKER}).x - ${here.x}) <= 1`);
    } finally { await close(page); }
  }
});

test('the catalog slider keys scroll the board, change categories, and expose the new value', { skip }, async () => {
  const page = await open('/#catalog-minecraft', { ...desktop, reduced: true,
    beforeScripts: withArticles(3, 4) + withArticles(1, 5, 'collected') + withArticles(3, 4, 'other') });
  try {
    const initial = await readBoard(page);
    const displacement = `(${initial.board[0]} - ${panelLeft})`;
    const marker = "document.querySelector('.chapter-progress-marker')";
    await evaluate(page, `${marker}.focus({preventScroll: true})`);
    for (const [key, target] of [['ArrowRight', 100], ['ArrowUp', 200], ['ArrowDown', 100], ['ArrowLeft', 0]]) {
      await press(page, key);
      await waitFor(page, `Math.abs(${displacement} - ${target}) < 1`);
    }
    await press(page, 'End');
    await settledCatalog(page, 'other');
    await waitFor(page, `Math.abs(${columnEdge('other', 'right')} - ${initial.frame[1]}) < 1`);
    await waitFor(page, `${marker}.getAttribute('aria-valuenow') === '97.5'`);
    assert.deepEqual(failures, []);
    const end = await evaluate(page, RULER_POINT(4, .9));
    await waitFor(page, `Math.abs((${MARKER}).x - ${end.x}) <= 1`);
    await markerAt(page, 4, .9);
    const atEnd = await evaluate(page, panelLeft);
    await evaluate(page, wheelEvent(1200));
    await waitFor(page, `Math.abs(${panelLeft} - ${atEnd}) < 1`);
    assert.equal((await state(page)).hash, '#catalog-other');
    assert.equal(await evaluate(page, `${marker}.getAttribute('aria-valuenow')`), '97.5');
    assert.equal(await evaluate(page, `${marker}.getAttribute('aria-valuetext')`), '其他，98%');
    assert.ok(await evaluate(page, `!${marker}.dispatchEvent(new KeyboardEvent('keydown', {key:' ', code:'Space', bubbles:true, cancelable:true}))`));
    await press(page, 'PageDown');
    assert.ok(await evaluate(page, `${panelLeft} > ${atEnd + 100}`), 'PageDown reads backward through the last row');
    for (const [key, slug] of [['PageDown', 'collected'], ['PageUp', 'other'], ['ArrowLeft', 'collected'], ['ArrowRight', 'other']]) {
      for (let i = 0; i < 60 && await evaluate(page, 'location.hash') !== '#catalog-' + slug; i++) {
        await press(page, key);
      }
      await settledCatalog(page, slug);
      assert.ok(await evaluate(page, `document.activeElement === ${marker}`));
    }
    await press(page, 'Home');
    await settledCatalog(page, 'minecraft');
    near(await evaluate(page, displacement), 0, 1, 'Home returns to the first landing');
    await waitFor(page, `${marker}.getAttribute('aria-valuetext').startsWith('Minecraft，')`);
    assert.ok(await evaluate(page, `document.activeElement === ${marker}`));
  } finally { await close(page); }
});

test('a short catalog scrolls the chapter to its bottom before the board and keeps the offset on return', { skip }, async () => {
  for (const height of [480, 720]) {
    const page = await open('/#series', { ...desktop, width: 1280, height, beforeScripts: withArticles(3, 4) });
    try {
      const chapter = "document.querySelector('#series')";
      assert.equal(await evaluate(page, `${chapter}.classList.contains('is-chapter-scrollable')`), height === 480);
      const initial = await evaluate(page, `(${chapter}.scrollTop = 20, ${chapter}.scrollTop)`);
      await evaluate(page, `document.querySelector('${cover('minecraft')}').click()`);
      await settledCatalog(page, 'minecraft');
      const displacement = `(${await evaluate(page, panelLeft)} - ${panelLeft})`;
      near(await evaluate(page, `${chapter}.scrollTop`), initial, 1, 'the chapter offset carries into the catalog');
      await wheel(page, 0, 800);
      if (height === 480) {
        await waitFor(page, `${chapter}.scrollTop > ${initial}`);
        near(await evaluate(page, displacement), 0, 1, 'vertical scroll leaves the board in place');
        assert.ok(await evaluate(page, `(() => {
          const clip = getComputedStyle(document.querySelector('.chapter-viewport')).clipPath.match(/inset\\(([^)]+)/)[1].split(/\\s+/).map(parseFloat);
          return document.querySelector('.is-catalog-open .category-bottom').getBoundingClientRect().bottom < innerHeight - clip[2];
        })()`), 'the category count is above the ruler clip');
        await wheel(page, 0, 150);
        await waitFor(page, `${displacement} > 10`);
        const bottom = await evaluate(page, `${chapter}.scrollTop`);
        await press(page, 'ArrowUp');
        await waitFor(page, `${chapter}.scrollTop < ${bottom}`);
        const above = await evaluate(page, `${chapter}.scrollTop`);
        const left = await evaluate(page, displacement);
        await wheel(page, 300, 2);
        await waitFor(page, `${displacement} > ${left + 10}`);
        assert.equal(await evaluate(page, `${chapter}.scrollTop`), above);
        await press(page, 'ArrowDown');
        await waitFor(page, `${chapter}.scrollTop > ${above}`);
      } else {
        await waitFor(page, `${displacement} > 10`);
        assert.equal(await evaluate(page, `${chapter}.scrollTop`), 0);
      }
      const carried = await evaluate(page, `${chapter}.scrollTop`);
      await press(page, 'Escape');
      await settledCatalog(page, '');
      near(await evaluate(page, `${chapter}.scrollTop`), carried, 1, 'closing preserves the chapter scroll position');
    } finally { await close(page); }
  }
});

test('the catalog plate eases flat with its heading and restores the chapter arc', { skip }, async () => {
  const page = await open('/#series', desktop);
  try {
    const poses = () => evaluate(page, `[...document.querySelectorAll('#series :is(.chapter-panel,.chapter-reveal-unit)')]
      .map(el => getComputedStyle(el).transform)`);
    const rest = await poses();
    assert.ok(rest.length >= 2 && rest.every(pose => pose.startsWith('matrix3d(')));
    await seekCatalog(page, 430, `document.querySelector('${cover('minecraft')}').click();`);
    const opening = await poses();
    assert.ok(opening.every((pose, i) => pose !== 'none' && pose !== rest[i]), 'each unit has a partial arc pose during opening');
    await seekCatalog(page, 750);
    assert.ok((await poses()).every(pose => pose === 'none'), 'the series is flat by the end of the board move');
    await seekCatalog(page, 1400);
    await settledCatalog(page, 'minecraft');
    const chain = await evaluate(page, `(() => {
      const result = [];
      for (let el = document.querySelector('.is-catalog-open .catalog-card').parentElement; el; el = el.parentElement) {
        const transform = getComputedStyle(el).transform;
        result.push([el.id || el.className || el.tagName, transform]);
      }
      return result;
    })()`);
    for (const [element, pose] of chain) {
      if (element === 'chapter-track') {
        const matrix = await evaluate(page, `new DOMMatrix(${JSON.stringify(pose)}).toJSON()`);
        assert.ok(matrix.is2D && matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1
          && Number.isInteger(matrix.e) && matrix.f === 0, 'the track uses an integer horizontal translation');
      } else assert.equal(pose, 'none', `${element} lies flat behind the cards`);
    }
    assert.deepEqual((await readBoard(page)).transforms, Array(4).fill('none'));
    await seekCatalog(page, 380, "document.querySelector('.catalog-back').click();");
    assert.ok((await poses()).every((pose, i) => pose !== 'none' && pose !== rest[i]), 'each unit eases back to its arc');
    await seekCatalog(page, 1200);
    await settledCatalog(page, '');
    assert.deepEqual(await poses(), rest);
  } finally { await close(page); }
});

const wheelEvent = x => `window.dispatchEvent(new WheelEvent('wheel', { deltaX: ${x}, bubbles: true, cancelable: true }))`;

for (const fitted of [false, true]) {
  test(`a fully visible neighbour opens on the 40th pixel of ${fitted ? 'wheel input on a fitted board' : 'board travel'}`, { skip }, async () => {
    const page = await open('/#catalog-minecraft', { ...desktop, reduced: true,
      beforeScripts: withArticles(1, fitted ? 1 : 12) + withArticles(1, 3, 'daydreams') });
    try {
      await settledCatalog(page, 'minecraft');
      const start = await evaluate(page, panelLeft);
      await evaluate(page, wheelEvent(-1200));
      near(await evaluate(page, panelLeft), start, 1, 'the first click landing is a hard stop');
      await press(page, 'End');
      const end = await readBoard(page);
      const reveal = Math.max(0, end.columns[1].right - end.frame[1]);
      assert.equal(reveal > 0, !fitted);
      if (fitted) {
        assert.ok(end.columns.at(-1).right <= end.frame[1]);
        await evaluate(page, wheelEvent(35));
        await sleep(600); // The next gesture starts with the neighbour already fully inside.
      }
      const samples = await evaluate(page, `(() => {
        const next = document.querySelector('[data-category-slug="daydreams"]');
        const sample = () => ({ left: ${panelLeft}, width: next.getBoundingClientRect().width,
          expanded: next.classList.contains('is-catalog-open') });
        ${wheelEvent(reveal + 39)};
        const before = sample();
        ${wheelEvent(1)};
        return [before, sample()];
      })()`);
      assert.equal(samples[0].expanded, false, '39 pixels after the neighbour enters do not open it');
      assert.equal(samples[1].expanded, true, `40px beyond full entry opens the neighbour: reveal ${reveal}, ${JSON.stringify(samples)}`);
      assert.ok(samples[1].width > samples[0].width + 5, 'reduced motion widens in the input frame');
      for (const [i, sample] of samples.entries()) {
        near(end.board[0] - sample.left, fitted ? 0 : reveal + 39 + i, 1, 'wheel travel through the threshold');
      }
    } finally { await close(page); }
  });
}

const longPair = withArticles(3, 4) + withArticles(3, 4, 'daydreams');
const shortPair = withArticles(1, 7) + withArticles(1, 3, 'daydreams') + withArticles(1, 2, 'collected');

test('opening backward on a fitted board creates no extra scroll travel', { skip }, async () => {
  const page = await open('/#catalog-daydreams', { ...desktop, width: 2048, height: 1152, reduced: true,
    beforeScripts: withArticles(1, 1) + withArticles(1, 1, 'daydreams') });
  try {
    const initial = await readBoard(page);
    await evaluate(page, wheelEvent(-39));
    assert.equal((await readBoard(page)).active[0], false);
    await evaluate(page, wheelEvent(-1));
    const widened = await readBoard(page);
    assert.ok(widened.active[0] && widened.columns[0].width > initial.columns[0].width + 1);
    near(widened.columns[0].right, initial.columns[0].right, 1, 'the first column opens to the left');
    assert.ok(widened.columns[0].left >= initial.frame[0] && widened.columns.at(-1).right <= initial.frame[1]);
    for (const delta of [-200, 24]) {
      await evaluate(page, wheelEvent(delta));
      near(await evaluate(page, panelLeft), widened.board[0], 1, 'the entire fitted board stays where it widened');
    }
  } finally { await close(page); }
});

test('a continuous scroll can read through several short neighbours to either hard stop', { skip }, async () => {
  const page = await open('/#catalog-minecraft', { ...desktop, reduced: true,
    beforeScripts: shortPair + withArticles(2, 4, 'other') });
  try {
    const start = await readBoard(page);
    const history = (await state(page)).history;
    const firstFraction = (await state(page)).position + .5;
    await evaluate(page, wheelEvent(30000));
    await settledCatalog(page, 'other');
    near(await evaluate(page, columnEdge('other', 'right')), start.frame[1], 1, 'the last column ends at the frame');
    await markerAt(page, 4, .9);
    await evaluate(page, wheelEvent(-30000));
    await settledCatalog(page, 'minecraft');
    near(await evaluate(page, panelLeft), start.board[0], 1, 'reading back stops at the first click landing');
    await markerAt(page, 1, firstFraction);
    assert.equal((await state(page)).history, history);
  } finally { await close(page); }
});

// Record rendered geometry in the page, including the frame on which a column opens or folds.
function sampleHandOver(page, from, to, delta, inputDuringEntrance = 0) {
  return evaluate(page, `(async () => {
    const columns = [...document.querySelectorAll('#category-surface .category-column')];
    const panel = document.querySelector('#category-surface');
    const grid = panel.querySelector('.category-columns');
    const edge = ${from < to ? "'left'" : "'right'"};
    const oldCards = columns[${from}].querySelectorAll('.catalog-card');
    const reference = oldCards[${from < to ? 'oldCards.length - 1' : '0'}];
    const incoming = [...columns[${to}].querySelectorAll('.catalog-card')];
    const keyframeMetadata = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    const station = document.querySelector('.chapter-progress-links');
    const sample = () => {
      const rect = panel.getBoundingClientRect();
      const boxes = columns.map(col => {
        const { left, right, width } = col.getBoundingClientRect();
        return { left, right, width, expanded: col.classList.contains('is-catalog-open'),
          folding: col.classList.contains('is-catalog-folding') };
      });
      const unsupported = new Set(), movingColumns = new Set();
      let entering = false;
      for (const animation of panel.getAnimations({ subtree: true })) {
        const { effect } = animation;
        // A folding category's specimen returns to rest through its own CSS
        // transitions, as it does when the pointer leaves a cover.
        if (animation instanceof CSSTransition && effect.target.closest('.is-catalog-folding .category-scene')) continue;
        const keys = new Set(effect.getKeyframes().flatMap(Object.keys));
        for (const key of keys) {
          if (!keyframeMetadata.has(key) && !['opacity', 'transform', 'translate'].includes(key)) {
            const name = effect.target.className || effect.target.localName;
            unsupported.add(name + (effect.pseudoElement || '') + ': ' + key);
          }
        }
        if (!keys.has('transform') && !keys.has('translate')) continue;
        const column = columns.indexOf(effect.target);
        if (column >= 0 && !effect.pseudoElement) movingColumns.add(column);
        if (incoming.includes(effect.target) && keys.has('opacity')) entering = true;
      }
      const style = getComputedStyle(panel);
      return { time: performance.now(), columns: boxes, left: rect.left, right: rect.right, anchor: boxes[${to}][edge],
        tracks: getComputedStyle(grid).gridTemplateColumns, width: style.width, cssLeft: parseFloat(style.left),
        unsupported: [...unsupported], movingColumns: [...movingColumns], entering,
        reference: reference.getBoundingClientRect().left, marker: (${MARKER}).x,
        fading: incoming.some(card => {
          const opacity = Number(getComputedStyle(card).opacity);
          return opacity > 0 && opacity < 1;
        }),
        hash: location.hash, title: document.title, station: station.querySelector('[aria-current]')?.hash,
        focus: document.activeElement.closest('.category-column')?.dataset.categorySlug };
    };
    const frames = [sample()];
    const start = performance.now();
    let extraAt = null, openedAt = null;
    ${wheelEvent(delta)};
    do {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      const frame = sample();
      frames.push(frame);
      if (frame.columns[${to}].expanded) openedAt ??= now;
      if (${inputDuringEntrance} && openedAt !== null && now - openedAt >= 80 && extraAt === null) {
        extraAt = frames.length - 1;
        ${wheelEvent(inputDuringEntrance)};
      }
    } while (performance.now() - start < ${inputDuringEntrance ? 2000 : 1100});
    return { frames, extraAt };
  })()`);
}

function checkHandOverFrames(frames, direction, center, dock) {
  for (const [i, f] of frames.entries()) {
    assert.deepEqual(f.unsupported, [], `frame ${i}: every board animation uses compositor properties`);
    assert.ok(f.left <= dock.left + 1 && f.right >= dock.right - 1,
      `frame ${i}: board [${f.left}, ${f.right}] covers the dock [${dock.left}, ${dock.right}]`);
    // Layout snaps edges to 1/64px, so a frame within a hair of a column edge
    // can read either way. Check the reading line away from the edges.
    const reading = f.columns.findIndex(col => col.expanded && col.left + 1 / 16 <= center && center < col.right - 1 / 16);
    if (reading >= 0) {
      assert.equal(f.hash, '#catalog-' + slugs[reading], `frame ${i}: the reading line sets the URL`);
      assert.equal(f.station, f.hash, `frame ${i}: the current station matches the URL`);
      assert.equal(f.title, catalogLabels[reading] + ' · 文章目录 · Gŭdù || 个人博客');
    }
    if (!i) continue;
    const travel = direction * (frames[i - 1].anchor - f.anchor);
    assert.ok(travel >= -1, `frame ${i}: the anchored edge reversed by ${-travel}px`);
    const markerTravel = direction * (f.marker - frames[i - 1].marker);
    assert.ok(markerTravel >= -1 && markerTravel <= travel + 1,
      `frame ${i}: ruler moved ${markerTravel}px with ${travel}px of board travel`);
  }
}

function checkSingleResize(frames, changedAt) {
  assert.ok(changedAt > 0, 'the sample includes the frame before the resize');
  for (const [i, frame] of frames.entries()) {
    const layout = frames[i < changedAt ? 0 : changedAt];
    assert.equal(frame.tracks, layout.tracks, `frame ${i}: grid tracks change only on the resize frame`);
    assert.equal(frame.width, layout.width, `frame ${i}: panel width changes only on the resize frame`);
    assert.equal(frame.cssLeft, layout.cssLeft, `frame ${i}: panel left changes only on the resize frame`);
  }
}

for (const [from, to, short] of [[0, 1, false], [1, 0, false], [0, 1, true], [1, 2, true], [2, 1, true]]) {
  const width = short ? 2048 : 871;
  const dir = Math.sign(to - from);
  test(`scroll opens ${slugs[to]} ${dir > 0 ? 'forward' : 'backward'} in place at ${width}px`, { skip }, async () => {
    const page = await open('/#series', { ...desktop, width, height: short ? 1152 : 817,
      beforeScripts: short ? shortPair : longPair });
    try {
      const dock = await flatDock(page);
      const restWidth = (await readBoard(page)).widths[from];
      const oldHistory = (await state(page)).history;
      await clickLink(page, cover(slugs[from]));
      await mouse(page, 'mouseMoved', 1, 1, 0);
      await settledCatalog(page, slugs[from]);
      const history = (await state(page)).history;
      assert.equal(history, oldHistory + 1);
      if (dir > 0) {
        await evaluate(page, "document.querySelector('.is-catalog-open .catalog-card').focus({preventScroll:true})");
        await evaluate(page, `window.SiteCatalog.scrub(${from}, 1, true)`);
      } else await evaluate(page, "document.querySelector('.chapter-progress-marker').focus({preventScroll:true})");
      const opened = await readBoard(page);
      const center = (opened.frame[0] + opened.frame[1]) / 2;
      const neighbour = opened.columns[to];
      const reveal = Math.max(0, dir > 0 ? neighbour.right - opened.frame[1] : opened.frame[0] - neighbour.left);
      const available = dir < 0 ? dock.left - opened.board[0]
        : Math.min(opened.board[1] - dock.right, opened.columns.at(-1).right - opened.frame[1]);
      const travelToOpen = Math.min(reveal + 40, Math.max(0, available));
      const { frames, extraAt } = await sampleHandOver(page, from, to, dir * (reveal + 40), dir * 24);
      checkHandOverFrames(frames, dir, center, dock);
      const first = frames[0], last = frames.at(-1);
      const started = frames.findIndex(f => f.columns[to].expanded);
      checkSingleResize(frames, started);
      assert.ok(extraAt > started && frames[extraAt].entering, 'the second wheel event arrives during the card entrance');
      const before = frames[started - 1], after = frames[started];
      const gain = after.columns[to].width - before.columns[to].width;
      assert.ok(gain > 1, 'the incoming column widens on the opening frame');
      const expectedMoves = [];
      if (dir > 0) {
        for (let i = to + 1; i < before.columns.length; i++) {
          const old = before.columns[i];
          const travel = after.anchor - before.anchor;
          if (old.left + travel >= width || old.right + travel <= 0) continue;
          expectedMoves.push(i);
          near(after.columns[i].left, old.left + travel, 1, `column ${i} starts its FLIP in its old position`);
          near(last.columns[i].left - last.anchor, old.left - before.anchor + gain, 1,
            `column ${i} reaches its widened grid position`);
        }
        assert.ok(expectedMoves.length, 'the fixture exposes a following column');
      }
      const movingColumns = [...new Set(frames.flatMap(f => f.movingColumns))].sort();
      assert.deepEqual(movingColumns, expectedMoves, 'only visible columns following a forward opening get a FLIP');
      const referenceRight = dir > 0 ? opened.items.at(-1).width : opened.items[0].width;
      assert.ok(frames[started].reference < width && frames[started].reference + referenceRight > 0,
        'the outgoing article used as a reference is on screen');
      for (const f of frames.slice(started, extraAt + 1)) {
        near(f.anchor, first.anchor - dir * travelToOpen, 1, 'the neighbour widens about its on-screen edge');
      }
      for (const f of frames) {
        near(f.reference - first.reference, f.anchor - first.anchor, 1, 'the outgoing card follows only the input');
      }
      assert.ok(frames.slice(extraAt + 1).some(f => dir * (frames[extraAt].anchor - f.anchor) > 1
        && f.entering), 'the board accepts input before the card entrance ends');
      near(dir * (frames[extraAt].anchor - last.anchor), 24, 1, 'the additional input moves the board 1:1');
      assert.ok(last.columns[from].expanded && last.columns[to].expanded, 'both visible columns remain expanded');
      assert.ok(frames.some(f => f.fading), 'the incoming cards fade in while their column opens');

      if (!short) {
        // Read on into the neighbour. The old column folds once the reading line
        // has left it and its folded board still covers the dock, in view and
        // toward the reading line, without moving the neighbour.
        const untilFold = `(() => {
          const panel = document.querySelector('#category-surface').getBoundingClientRect();
          const columns = [...document.querySelectorAll('#category-surface .category-column')];
          const brand = document.querySelector('.site-header .site-brand').getBoundingClientRect();
          const tools = document.querySelector('.site-header .header-tools').getBoundingClientRect();
          const center = (brand.left + tools.right) / 2;
          const next = columns[${to}].getBoundingClientRect(), old = columns[${from}].getBoundingClientRect();
          const loss = old.width - ${restWidth};
          const line = ${dir > 0} ? next.left - center : center - next.right;
          const gap = ${dir > 0} ? panel.left + loss - ${dock.left} : ${dock.right} - (panel.right - loss);
          return Math.max(line, gap);
        })()`;
        const distance = await evaluate(page, untilFold);
        assert.ok(distance > 60, `the fold is still ${distance}px away`);
        await evaluate(page, wheelEvent(dir * (distance - 60)));
        await sleep(900);
        const before = await evaluate(page, untilFold);
        assert.ok(before > 0 && (await readBoard(page)).active[from], 'the old column stays open before the fold');
        const fold = await sampleHandOver(page, from, to, dir * (before + 2));
        checkHandOverFrames([last, ...fold.frames], dir, center, dock);
        const started = fold.frames.findIndex(f => !f.columns[from].expanded);
        assert.ok(started > 0, 'the sample includes the frame before the fold');
        const ahead = fold.frames[started - 1], begin = fold.frames[started];
        assert.ok(begin.columns[from].folding, 'the old column folds in view');
        assert.ok(dir > 0 ? begin.columns[from].right > 0 : begin.columns[from].left < width, 'the fold starts on screen');
        assert.equal(begin.hash, '#catalog-' + slugs[to]);
        const restTracks = f => f.tracks.split(' ').filter((_, i) => i !== from).join(' ');
        let previous = ahead.columns[from].width;
        for (const f of fold.frames.slice(started)) {
          assert.ok(Math.abs(f.anchor - ahead.anchor) <= 3, `folding never displaces the neighbour (${f.anchor} vs ${ahead.anchor})`);
          assert.equal(restTracks(f), restTracks(begin), 'only the folding track changes');
          assert.ok(f.columns[from].width <= previous + .02, 'the old column narrows steadily');
          previous = f.columns[from].width;
        }
        const done = fold.frames.findIndex(f => !f.columns[from].folding && Math.abs(f.columns[from].width - restWidth) <= 1);
        assert.ok(done > started, 'the old column reaches its rest width');
        assert.ok(fold.frames[done].time - begin.time < 650, `the fold takes ${fold.frames[done].time - begin.time}ms`);
        const end = fold.frames.at(-1);
        assert.ok(!end.columns[from].expanded && !end.columns[from].folding);
        near(end.columns[from].width, restWidth, 1, 'the folded column returns to rest');
        assert.ok(await evaluate(page, `document.querySelector(${JSON.stringify(catalogSelector(slugs[from]))}).hidden`));
        if (dir > 0) assert.equal(end.focus, slugs[to], 'card focus follows the reading line');
        else assert.ok(await evaluate(page, "document.activeElement.matches('.chapter-progress-marker')"));
        assert.ok(dir * (end.marker - last.marker) > 2, 'the ruler advances with the reading line');
      }
      assert.equal((await state(page)).history, history, 'scroll hand-over replaces the history entry');
      await evaluate(page, 'history.back()');
      await settledCatalog(page, '');
    } finally { await close(page); }
  });
}

// Minecraft has nothing to its left, so it waits until its folded board still
// reaches the dock's left end. Scrolling back, 白日梦话 folds as the reading
// line leaves it: the folded categories after it reach the dock's right end.
for (const [from, to, limit] of [[0, 1, 'dock'], [1, 0, 'line']]) {
  const dir = Math.sign(to - from);
  test(`${slugs[from]} folds ${dir > 0 ? 'forward' : 'backward'} on the pixel where its ${limit === 'dock' ? 'folded board covers the dock' : 'reading line leaves it'}`, { skip }, async () => {
    const page = await open('/#series', { ...desktop, reduced: true, beforeScripts: longPair });
    try {
      const dock = await flatDock(page);
      const rest = await evaluate(page, `document.querySelectorAll('#category-surface .category-column')[${from}].getBoundingClientRect().width`);
      await clickLink(page, cover(slugs[from]));
      await settledCatalog(page, slugs[from]);
      await evaluate(page, `window.SiteCatalog.scrub(${from}, ${dir > 0 ? 1 : 0}, true)`);
      const read = `(() => {
        const panel = document.querySelector('#category-surface').getBoundingClientRect();
        const columns = [...document.querySelectorAll('#category-surface .category-column')];
        const brand = document.querySelector('.site-header .site-brand').getBoundingClientRect();
        const tools = document.querySelector('.site-header .header-tools').getBoundingClientRect();
        const center = (brand.left + tools.right) / 2;
        const next = columns[${to}].getBoundingClientRect(), old = columns[${from}].getBoundingClientRect();
        const loss = old.width - ${rest};
        return { open: columns.map(c => c.classList.contains('is-catalog-open')), hash: location.hash,
          line: ${dir > 0} ? next.left - center : center - next.right,
          gap: ${dir > 0} ? panel.left + loss - ${dock.left} : ${dock.right} - (panel.right - loss),
          board: [panel.left, panel.right] };
      })()`;
      let view = await evaluate(page, read);
      for (let i = 0; i < 400 && !view.open[to]; i++) {
        await evaluate(page, wheelEvent(dir * 10));
        view = await evaluate(page, read);
      }
      assert.ok(view.open[from] && view.open[to], 'both categories are open after the hand-over');
      const distance = Math.max(view.line, view.gap);
      assert.ok(distance > 8, `the fold is still ${distance}px away`);
      await evaluate(page, wheelEvent(dir * (distance - 2)));
      view = await evaluate(page, read);
      assert.ok(view.open[from], `2px before the fold ${slugs[from]} is open: ${JSON.stringify(view)}`);
      assert.equal(view.line > view.gap ? 'line' : 'dock', limit, `what holds the fold back: ${JSON.stringify(view)}`);
      if (limit === 'dock') assert.equal(view.hash, '#catalog-' + slugs[to], 'the reading line has already left');
      await evaluate(page, wheelEvent(dir * 4));
      view = await evaluate(page, read);
      assert.ok(!view.open[from], `2px past the fold ${slugs[from]} has folded: ${JSON.stringify(view)}`);
      assert.equal(view.hash, '#catalog-' + slugs[to]);
      assert.ok(view.board[0] <= dock.left + 1 && view.board[1] >= dock.right - 1,
        `the folded board [${view.board}] covers the dock [${dock.left}, ${dock.right}]`);
    } finally { await close(page); }
  });
}

// A category that opened ahead of the reader folds no later than the one
// between them once the reader turns back. Folding the nearer one first
// pulled 其他 back into view, still open, past a folded 神秘文案. The far
// category is long enough to open past the frame: a short one that the
// reading line can never reach is stepped to by the push that opens it, so
// it never waits ahead.
for (const [start, ahead, turnedTo, fixtures] of [
  ['collected', 1, 'daydreams', withArticles(1, 3, 'daydreams') + withArticles(1, 3, 'collected') + withArticles(2, 4, 'other')],
  ['daydreams', -1, 'collected', withArticles(2, 4) + withArticles(1, 3, 'daydreams') + withArticles(1, 3, 'collected')],
]) {
  test(`turning back from ${start} never leaves an open category beyond a folded one`, { skip }, async () => {
    const page = await open('/#catalog-' + start, { ...desktop, reduced: true, beforeScripts: fixtures });
    try {
      await settledCatalog(page, start);
      const read = "({ open: [...document.querySelectorAll('#category-surface .category-column')].map(c => c.classList.contains('is-catalog-open')), hash: location.hash })";
      const here = slugs.indexOf(start), far = here + ahead;
      let view = await evaluate(page, read);
      for (let i = 0; i < 200 && !view.open[far]; i++) {
        await evaluate(page, wheelEvent(ahead * 10));
        view = await evaluate(page, read);
      }
      assert.ok(view.open[far] && view.hash === '#catalog-' + start, `${slugs[far]} opens ahead while ${start} is read: ${JSON.stringify(view)}`);
      const seen = [];
      for (let i = 0; i < 400 && (view.open[far] || view.open[here]); i++) {
        await evaluate(page, wheelEvent(-ahead * 10));
        view = await evaluate(page, read);
        seen.push(view.open.map(Number).join('') + view.hash.replace('#catalog-', ' '));
        const open = view.open.flatMap((isOpen, j) => isOpen ? [j] : []);
        assert.equal(open.at(-1) - open[0] + 1, open.length, `open categories stand side by side: ${seen.join(', ')}`);
      }
      assert.ok(seen.some(step => step.endsWith(' ' + turnedTo)), `the reader reached ${turnedTo}: ${seen.join(', ')}`);
      assert.ok(!view.open[far] && !view.open[here], `both categories the reader left have folded: ${seen.join(', ')}`);
    } finally { await close(page); }
  });
}

const catalogNow = () => `(() => {
  const brand = document.querySelector('.site-header .site-brand').getBoundingClientRect();
  const tools = document.querySelector('.site-header .header-tools').getBoundingClientRect();
  const columns = [...document.querySelectorAll('#category-surface .category-column')];
  const panel = document.querySelector('#category-surface').getBoundingClientRect();
  const station = document.querySelector('.chapter-progress-links a[aria-current]');
  return { open: columns.map(c => c.classList.contains('is-catalog-open')), hash: location.hash,
    title: document.title.split(' · ')[0], station: station?.hash, centre: (brand.left + tools.right) / 2,
    lefts: columns.map(c => c.getBoundingClientRect().left), board: [panel.left, panel.right], marker: (${MARKER}).x,
    segments: [...document.querySelectorAll('.chapter-progress-scales > span')].slice(0, 4).map(span => (r => [r.left, r.right])(span.getBoundingClientRect())),
    // The station coordinate the ruler aims at; a step aims at the middle of its station.
    target: Number(document.querySelector('.chapter-progress').style.getPropertyValue('--chapter-position')) + 0.5 };
})()`;

// The reading line cannot reach a short last category. At the hard stop,
// forty more pixels step to it: it becomes current, the URL, title and ruler
// follow, and the category before it folds.
test('pushing past the end of the board steps to a short last category', { skip }, async () => {
  const page = await open('/#series', { ...desktop, reduced: true, beforeScripts: withArticles(3, 4)
    + withArticles(1, 3, 'daydreams') + withArticles(1, 2, 'collected') + withArticles(1, 1, 'other') });
  try {
    const dock = await flatDock(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    let view = await evaluate(page, catalogNow());
    for (let i = 0; i < 800 && view.hash !== '#catalog-other'; i++) {
      await evaluate(page, wheelEvent(10));
      view = await evaluate(page, catalogNow());
    }
    assert.equal(view.hash, '#catalog-other', `the reader reaches 其他: ${JSON.stringify(view)}`);
    // The board only ever moved left, so 其他 has never been further left.
    assert.ok(view.lefts[3] > view.centre, `the reading line never reached 其他 (${view.lefts[3] - view.centre}px short), so the reader stepped`);
    assert.equal(view.title, '其他');
    assert.equal(view.station, '#catalog-other', 'the ruler lights the last station');
    assert.ok(view.marker > view.segments[3][0] && view.marker < view.segments[3][1], `the marker ${view.marker} sits in [${view.segments[3]}]`);
    assert.deepEqual(view.open, [false, false, false, true], 'only the last category stays open');
    assert.ok(view.board[0] <= dock.left + 1 && view.board[1] >= dock.right - 1, `the board [${view.board}] covers the dock`);
  } finally { await close(page); }
});

// A board that fits its frame never moves, so its reading line never moves
// either. Each push steps one category at once, with no pause after the
// last; the category left folds, and the board slides only as far as it must
// to keep covering the dock. The ruler's marker comes along.
test('on a board that fits its frame each push steps one category at once and folds the last', { skip }, async () => {
  const page = await open('/#series', { ...desktop, reduced: true, beforeScripts: withArticles(1, 1)
    + withArticles(1, 1, 'daydreams') + withArticles(1, 1, 'collected') + withArticles(1, 1, 'other') });
  try {
    const dock = await flatDock(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    const start = await readBoard(page);
    assert.ok(start.columns[0].left >= start.frame[0] && start.columns.at(-1).right <= start.frame[1], 'the fixture fits its frame');
    for (const [dir, sequence] of [[1, ['daydreams', 'collected', 'other']], [-1, ['collected', 'daydreams', 'minecraft']]]) {
      for (const slug of sequence) {
        // The pushes follow one another within a few milliseconds.
        await evaluate(page, wheelEvent(dir * 100));
        const view = await evaluate(page, catalogNow());
        assert.equal(view.hash, '#catalog-' + slug, `each push moves one category: ${JSON.stringify(view)}`);
        assert.deepEqual(view.open, slugs.map(s => s === slug), `only ${slug} is open: ${JSON.stringify(view)}`);
        assert.ok(view.board[0] <= dock.left + 1 && view.board[1] >= dock.right - 1, `the board covers the dock: ${JSON.stringify(view)}`);
        assert.equal(view.station, view.hash, 'the ruler lights the current station');
        const segment = view.segments[slugs.indexOf(slug)];
        assert.ok(view.marker > segment[0] && view.marker < segment[1], `the marker ${view.marker} sits in [${segment}]`);
      }
    }
  } finally { await close(page); }
});

// The builder's markup for a category without articles (scripts/build-blog.mjs).
function withoutArticles(slug) {
  return `{
    document.querySelector('[data-category-slug="${slug}"] .catalog-row').innerHTML = '<p class="catalog-empty">'
      + '<span class="catalog-empty-count" aria-hidden="true">00</span><span class="catalog-empty-code" aria-hidden="true">NO ENTRIES</span>'
      + '<span class="catalog-empty-text">这个分类还没有文章<br />写好的文章会归到这里。</span></p>';
  }`;
}

// One short category and three empty ones, as the live catalog has, on a
// board that fits a wide frame.
const liveCatalog = { width: 2113, height: 1257, mobile: false, reduced: true, beforeScripts: withArticles(1, 1)
  + withoutArticles('daydreams') + withoutArticles('collected') + withoutArticles('other') };

// Small pushes pass through every state on the way to each end of the live
// catalog and back; the ruler stays on the category the reader is in.
test('quick pushes on a board that fits keep the ruler on the current category', { skip }, async () => {
  const page = await open('/#series', liveCatalog);
  try {
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    let view;
    for (const dir of [1, -1]) {
      const end = '#catalog-' + (dir > 0 ? 'other' : 'minecraft');
      for (let i = 0; i < 300 && view?.hash !== end; i++) {
        await evaluate(page, wheelEvent(dir * 10));
        view = await evaluate(page, catalogNow());
        const current = slugs.indexOf(view.hash.replace('#catalog-', ''));
        assert.equal(view.station, view.hash, `the ruler lights the current station: ${JSON.stringify(view)}`);
        assert.ok(Math.floor(view.target) === current, `the ruler aims inside ${view.hash}'s station: ${JSON.stringify(view)}`);
        const segment = view.segments[current];
        assert.ok(view.marker > segment[0] && view.marker < segment[1],
          `the marker ${view.marker} sits in ${view.hash}'s segment [${segment}]: ${JSON.stringify(view)}`);
      }
      assert.equal(view.hash, end, 'the pushes reach the end of the board');
    }
  } finally { await close(page); }
});

// Home and End after steps seek within the category the steps reached: the
// category, the board and the ruler stay where the steps left them. (Once a
// seek started from the reading distance of a category the board never left,
// and travelled the board back toward it.)
test('home and end after steps on a board that fits stay on the current category', { skip }, async () => {
  const page = await open('/#series', liveCatalog);
  try {
    await clickLink(page, cover('other'));
    await settledCatalog(page, 'other');
    let view = await evaluate(page, catalogNow());
    for (let i = 0; i < 6 && view.hash !== '#catalog-minecraft'; i++) {
      await evaluate(page, wheelEvent(-100));
      view = await evaluate(page, catalogNow());
    }
    assert.equal(view.hash, '#catalog-minecraft', `the pushes step back to Minecraft: ${JSON.stringify(view)}`);
    const left = await evaluate(page, panelLeft);
    for (const key of ['End', 'Home']) {
      await press(page, key);
      view = await evaluate(page, catalogNow());
      assert.equal(view.hash, '#catalog-minecraft', `${key} keeps Minecraft current: ${JSON.stringify(view)}`);
      near(await evaluate(page, panelLeft), left, 1, `${key} leaves the board where the steps left it`);
      assert.ok(Math.floor(view.target) === 0, `after ${key} the ruler aims inside Minecraft's station: ${JSON.stringify(view)}`);
      const segment = view.segments[0];
      assert.ok(view.marker > segment[0] && view.marker < segment[1], `after ${key} the marker ${view.marker} sits in [${segment}]: ${JSON.stringify(view)}`);
    }
  } finally { await close(page); }
});

// One push on the live catalog steps on, and the category left folds at
// once. The board could still travel a few pixels, too few to make room for
// a fold toward the reader, so the board slides instead of waiting for the
// next push. Going back, Minecraft opens away from the reading line, which
// can never reach it; the push that opens it steps to it, as going forward.
test('each push on the live catalog moves one category both ways and folds the one left at once', { skip }, async () => {
  const page = await open('/#series', liveCatalog);
  try {
    const dock = await flatDock(page);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    for (const [dir, slug] of [[1, 'daydreams'], [1, 'collected'], [1, 'other'], [-1, 'collected'], [-1, 'daydreams'], [-1, 'minecraft']]) {
      await evaluate(page, wheelEvent(dir * 100));
      const view = await evaluate(page, catalogNow());
      assert.equal(view.hash, '#catalog-' + slug, `the push steps to ${slug}: ${JSON.stringify(view)}`);
      assert.deepEqual(view.open, slugs.map(s => s === slug), `only ${slug} is open: ${JSON.stringify(view)}`);
      assert.ok(view.board[0] <= dock.left + 1 && view.board[1] >= dock.right - 1, `the board covers the dock: ${JSON.stringify(view)}`);
    }
  } finally { await close(page); }
});

// Seeking all live effects also advances the heading's typing clock.
async function seekCatalog(page, time, action = '') {
  await evaluate(page, `(async () => {
    ${action}
    for (let i = 0; i < 3; i++) {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = ${time};
      }
      await new Promise(requestAnimationFrame);
    }
  })()`);
}

test('a station switch and the back link start at the board position reached by the wheel', { skip }, async () => {
  const page = await open('/#catalog-minecraft', { ...desktop, beforeScripts: longPair });
  try {
    for (const [from, link] of [['minecraft', catalogStation('daydreams')], ['daydreams', '.catalog-back']]) {
      await settledCatalog(page, from);
      const start = await evaluate(page, panelLeft);
      await wheel(page, 0, 180);
      await waitFor(page, `Math.abs(${panelLeft} - (${start} - 180)) < .05`);
      const scrolled = await evaluate(page, panelLeft);
      await seekCatalog(page, 0, `document.querySelector(${JSON.stringify(link)}).click();`);
      near(await evaluate(page, panelLeft), scrolled, 1, `${link} keeps the scrolled board in place on its first frame`);
      await seekCatalog(page, 1600);
    }
    await settledCatalog(page, '');
  } finally { await close(page); }
});

test('catalog frames show the sink, heading rewrite, widening and card stagger', { skip }, async () => {
  const page = await open('/#series', { ...desktop, beforeScripts: withArticles(1, 3) });
  try {
    const home = await readBoard(page);
    const witness = home.neighbors.findIndex(item => item.ink > .01);
    assert.ok(witness >= 0);
    assert.equal(home.sky, 0, 'the sky rests behind the panel');
    await seekCatalog(page, 0, `document.querySelector(${JSON.stringify(cover('minecraft'))}).click();`);
    let frame = await readBoard(page);
    assert.equal(frame.title, '分类');
    assert.equal(frame.displays[0], home.displays[0]);
    await seekCatalog(page, 200);
    const early = await readBoard(page);
    assert.equal(early.title, '', 'both source glyphs have been erased');
    assert.ok(early.neighbors[witness].top > home.neighbors[witness].top + 2);
    assert.equal(await evaluate(page, "getComputedStyle(document.querySelector('.is-catalog-open .category-index-line'), '::after').width"), '24px');
    await seekCatalog(page, 350);
    const sinking = await readBoard(page);
    // The side chapters leave along arcs: nearly straight down at first, then
    // bending away from the panel on their own side.
    const centre = (home.columns[0].left + home.columns.at(-1).right) / 2;
    home.sinks.forEach((rest, i) => {
      assert.deepEqual([rest.x, rest.y], [0, 0], 'the side chapters rest untransformed');
      const side = Math.sign(rest.center - centre), bend = view => side * view.sinks[i].x / view.sinks[i].y;
      assert.ok(early.sinks[i].y > 0 && sinking.sinks[i].y > early.sinks[i].y, 'they sink');
      assert.ok(bend(early) >= 0 && bend(early) < bend(sinking) / 2, `the path curves: ${bend(early)} then ${bend(sinking)} across per pixel down`);
      assert.ok(bend(sinking) > 0.2, `outward: ${sinking.sinks[i].x} across, ${sinking.sinks[i].y} down`);
    });
    // The hole and its sky turn down with the camera, faster as they go.
    assert.ok(early.sky > 0 && sinking.sky - early.sky > early.sky, `the sky speeds up: ${early.sky}, ${sinking.sky}`);
    assert.equal(await evaluate(page, "getComputedStyle(document.querySelector('#series-title .accent')).opacity"), '0');
    await seekCatalog(page, 560);
    const middle = await readBoard(page);
    assert.match(middle.title, /^文章?$/);
    assert.equal(await evaluate(page, "getComputedStyle(document.querySelector('#series-title .accent')).opacity"), '1');
    assert.ok(middle.neighbors.every(neighbor => neighbor.ink < .01));
    assert.ok(early.displays[0] > home.displays[0] && middle.displays[0] > early.displays[0]);
    assert.deepEqual(middle.cards, [0, 0, 0]);
    await seekCatalog(page, 800);
    frame = await readBoard(page);
    assert.ok(frame.displays[0] > middle.displays[0]);
    assert.ok(frame.cards[0] > frame.cards[1] && frame.cards[1] > frame.cards[2] && frame.cards[2] > 0,
      `cards appear from left to right (${frame.cards})`);
    assert.equal(frame.eyebrow, '02 ARTICLE INDEX');
    await seekCatalog(page, 1200);
    frame = await readBoard(page);
    assert.equal(frame.title, '文章目录');
    assert.deepEqual(frame.cards, [1, 1, 1]);
    near(frame.sky, await evaluate(page, FULL_SKY), 0.01, 'the hole has turned down out of the stage');
    // The hole sits at the stage's centre; its lensed arc reaches about a
    // quarter of a scene unit above it.
    assert.ok(await evaluate(page, `${SKY} - 0.4 * document.querySelector('#black-hole').offsetHeight / 2 > innerHeight / 2`),
      'the whole hole is past the bottom edge');
    assert.ok(!await evaluate(page, "document.documentElement.classList.contains('is-catalog-transitioning')"));
  } finally { await close(page); }
});

test('only cards in the open window stagger, even with a hundred articles', { skip }, async () => {
  const page = await open('/#series', { width: 1440, height: 900, mobile: false, beforeScripts: withArticles(4, 25) });
  const running = "document.documentElement.classList.contains('is-catalog-transitioning')";
  const block = `document.querySelector(${JSON.stringify(catalogSelector('minecraft'))})`;
  const effects = () => evaluate(page, `[...${block}.querySelectorAll('.catalog-card')].flatMap((card, i) =>
    card.getAnimations().filter(animation => animation.effect.getKeyframes().some(frame => frame.opacity !== undefined))
      .map(animation => [i, animation.effect.getTiming().delay]))`);
  const visible = (closeCatalog = false) => evaluate(page, `(() => {
    const block = ${block};
    const left = document.querySelector('.site-brand').getBoundingClientRect().left;
    const right = document.querySelector('.header-tools').getBoundingClientRect().right;
    const cards = [...block.querySelectorAll('.catalog-card')].flatMap((card, i) => {
      const box = card.getBoundingClientRect();
      return box.left < right && box.right > left ? [i] : [];
    });
    // The last fraction of an End-key scroll can carry a card across the frame between CDP calls.
    if (${closeCatalog}) document.querySelector('.catalog-back').click();
    return cards;
  })()`);
  const neighbours = () => evaluate(page, "[...document.querySelectorAll('.chapter-section:not(#series)')].map(el => el.inert)");
  const covers = () => evaluate(page, `[...document.querySelectorAll('.category-column')].map(column => {
    const box = column.getBoundingClientRect();
    return [column.querySelector('.category-cover').inert,
      column.matches('.is-catalog-open') || box.right <= 0 || box.left >= innerWidth];
  })`);
  try {
    const original = await neighbours();
    assert.ok(original.includes(false), 'one or more neighbouring sections are at least partly on screen at rest');
    await seekCatalog(page, 0, `document.querySelector(${JSON.stringify(cover('minecraft'))}).click();`);
    const entrance = await effects();
    await seekCatalog(page, 1599);
    assert.equal(await evaluate(page, running), false, 'opening has released input by 1.6 seconds');
    const first = await visible();
    assert.ok(first.length > 1 && first.length < 100);
    assert.deepEqual(entrance, first.map((i, k) => [i, 560 + k * 60]));
    assert.ok((await neighbours()).every(Boolean), 'the hidden sections are inert while reading');
    const held = await covers();
    assert.ok(held.filter(([inert]) => inert).length > 1, 'the open cover and at least one offscreen cover are inert');
    assert.ok(held.every(([inert, expected]) => inert === expected));
    await evaluate(page, "window.dispatchEvent(new Event('resize'))");
    assert.ok((await neighbours()).every(Boolean), 'measuring the dock restored its inert attributes');
    assert.ok((await covers()).every(([inert, expected]) => inert === expected));

    await press(page, 'End');
    await waitFor(page, `Math.abs(${columnEdge('minecraft', 'right')} - document.querySelector('.header-tools').getBoundingClientRect().right) < 1`);
    const last = await visible(true);
    assert.ok(last.includes(99));
    await seekCatalog(page, 0);
    assert.deepEqual(await effects(), last.map((i, k) => [i, (last.length - 1 - k) * 40]));
    await seekCatalog(page, 1199);
    assert.equal(await evaluate(page, running), false, 'closing has released input by 1.2 seconds');
    assert.deepEqual(await neighbours(), original);
    assert.ok((await covers()).every(([inert]) => !inert));
  } finally { await close(page); }
});

test('catalog keyboard focus follows card entrance, interrupted runs and browser history', { skip }, async () => {
  const page = await open('/#series', { ...desktop, beforeScripts: withArticles(3, 4) });
  const first = "document.querySelector('.is-catalog-open .catalog-card')";
  const back = "document.querySelector('.catalog-back')";
  const minecraft = `document.querySelector(${JSON.stringify(cover('minecraft'))})`;
  try {
    await press(page, 'Tab');
    await evaluate(page, `window.cardFocus = [];
      document.addEventListener('focusin', e => {
        if (e.target.matches('.catalog-card')) cardFocus.push({
          opacity: Number(getComputedStyle(e.target).opacity),
          running: document.documentElement.classList.contains('is-catalog-transitioning')
        });
      });
      ${minecraft}.focus({preventScroll: true})`);
    await press(page, 'Enter');
    await waitFor(page, `document.activeElement === ${first}`);
    const log = await evaluate(page, 'cardFocus');
    assert.deepEqual(log, [{ opacity: 1, running: true }], 'focus arrives on the opaque card while later cards still enter');
    await settledCatalog(page, 'minecraft');

    await clickLink(page, catalogStation('other'));
    await settledCatalog(page, 'other');
    await evaluate(page, `${back}.focus(); history.back()`);
    await settledCatalog(page, 'minecraft');
    assert.equal(await evaluate(page, `document.activeElement === ${first}`), true, 'Back from the return link focuses the new first card');
    await evaluate(page, 'history.forward()');
    await settledCatalog(page, 'other');
    assert.equal(await evaluate(page, `document.activeElement === ${back}`), true, 'Forward from a card focuses the empty category’s return link');
    await evaluate(page, 'history.back()');
    await settledCatalog(page, 'minecraft');
    await evaluate(page, 'history.back()');
    await settledCatalog(page, '');
    assert.equal(await evaluate(page, `document.activeElement === ${minecraft}`), true, 'Back to the chapter focuses the old cover');

    await press(page, 'Tab');
    await evaluate(page, `${minecraft}.focus({preventScroll: true})`);
    await press(page, 'Enter');
    await evaluate(page, "window.dispatchEvent(new Event('site:theme'))");
    assert.equal(await evaluate(page, `document.activeElement === ${first}`), true, 'interrupting the run completes its focus transfer');
    await press(page, 'Escape');
    await settledCatalog(page, '');
    await evaluate(page, 'cardFocus.length = 0');
    await press(page, 'Enter');
    await press(page, 'Escape');
    await settledCatalog(page, '');
    assert.deepEqual(await evaluate(page, 'cardFocus'), [], 'a pending close cancels the focus transfer');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page.sessionId);
    await press(page, 'Enter');
    assert.equal(await evaluate(page, `document.activeElement === ${first}`), true, 'reduced motion focuses the first card immediately');
    near(await evaluate(page, SKY), await evaluate(page, FULL_SKY), 0.01, 'reduced motion turns the sky at once');
    await viewport(page, { width: 390, height: 844, mobile: true });
    await waitFor(page, `document.documentElement.classList.contains('has-vertical-chapters')
      && [...document.querySelectorAll('.chapter-section:not(#series)')].every(el => !el.inert)
      && [...document.querySelectorAll('.category-column:not(.is-catalog-open) .category-cover')].every(el => !el.inert)`);
    assert.equal(await evaluate(page, SKY), 0, 'phones keep the sky still under an open catalog');
  } finally { await close(page); }
});

test('Escape collapses an expanded header search before closing its catalog', { skip }, async () => {
  const page = await open('/#catalog-minecraft', desktop);
  try {
    await clickLink(page, '.header-search-toggle');
    await waitFor(page, "document.activeElement.matches('.header-search.is-expanded input')");
    await press(page, 'Escape');
    assert.equal(await evaluate(page, "document.activeElement.matches('.header-search:not(.is-expanded) .header-search-toggle')"), true);
    await settledCatalog(page, 'minecraft');
    await press(page, 'Escape');
    await settledCatalog(page, '');
  } finally { await close(page); }
});

test('a chapter hash opens the selected catalog directly on load and reload', { skip }, async () => {
  const beforeScripts = `{
    window.animatedCatalogOnLoad = false;
    const root = document.documentElement;
    new MutationObserver(records => {
      if (root.classList.contains('is-catalog-transitioning') || records.some(record =>
        record.oldValue?.split(' ').includes('is-catalog-transitioning'))) window.animatedCatalogOnLoad = true;
    }).observe(root, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  }`;
  const page = await open('/#catalog-daydreams', { ...desktop, beforeScripts });
  try {
    for (const reload of [false, true]) {
      if (reload) {
        await send('Page.reload', {}, page.sessionId);
        await waitFor(page, "document.readyState === 'complete' && !document.documentElement.classList.contains('is-loading')");
      }
      await settledCatalog(page, 'daydreams');
      assert.equal((await readBoard(page)).title, '文章目录');
      assert.equal(await evaluate(page, 'window.animatedCatalogOnLoad'), false);
      await markerAt(page, 2, 0.5);
    }
  } finally { await close(page); }
});

test('slow catalog transitions finish on theme, resize or visibility changes and queue a return', { skip }, async () => {
  const page = await open('/?catalogslow=1#series', desktop);
  try {
    const choose = `document.querySelector(${JSON.stringify(cover('minecraft'))}).click()`;
    await seekCatalog(page, 1000, choose);
    assert.equal((await readBoard(page)).title, '', '1000 ms in slow mode samples the 200 ms typing stage');
    await evaluate(page, 'SiteTheme.toggle()');
    await settledCatalog(page, 'minecraft');
    await evaluate(page, "document.querySelector('.catalog-back').click()");
    await viewport(page, { ...desktop, width: 1599 });
    await settledCatalog(page, '');
    await evaluate(page, `(() => {
      ${choose};
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      try { document.dispatchEvent(new Event('visibilitychange')); }
      finally { delete document.hidden; }
    })()`);
    await settledCatalog(page, 'minecraft');
    await evaluate(page, `document.querySelector(${JSON.stringify(cover('collected'))}).click()`);
    await evaluate(page, `document.querySelector(${JSON.stringify(cover('other'))}).click()`);
    assert.equal(await evaluate(page, 'location.hash'), '#catalog-collected');
    await press(page, 'Escape');
    await waitFor(page, "location.hash === '#series'", 12000);
    await waitFor(page, "!document.documentElement.matches('.is-catalog, .is-catalog-transitioning')", 8000);
  } finally { await close(page); }
});

test('deep links, reduced motion and both theme palettes render the selected category', { skip }, async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`/?theme=${theme}#catalog-daydreams`, { ...desktop, reduced: true });
    try {
      await settledCatalog(page, 'daydreams');
      assert.equal((await readBoard(page)).title, '文章目录');
      await markerAt(page, 2, 0.5);
      const snap = await evaluate(page, `(() => {
        document.querySelector(${JSON.stringify(cover('minecraft'))}).click();
        const root = document.documentElement;
        const card = document.querySelector('.is-catalog-open .catalog-card');
        return [location.hash, root.classList.contains('is-catalog-transitioning'), root.dataset.theme, getComputedStyle(card).borderTopColor];
      })()`);
      assert.deepEqual(snap, ['#catalog-minecraft', false, theme, theme === 'dark' ? 'rgba(226, 230, 234, 0.44)' : 'rgba(24, 28, 32, 0.46)']);
      assert.deepEqual((await readBoard(page)).transforms, Array(4).fill('none'));
      await clickLink(page, '.site-header .site-brand');
      await waitFor(page, "location.hash === '#home' && !document.documentElement.classList.contains('is-catalog')");
    } finally { await close(page); }
  }
});

test('the phone expands only the chosen grid cell and keeps the home tape', { skip }, async () => {
  for (const size of [phone, { ...phone, reduced: true }, { ...phone, width: 650, height: 900 }, { ...phone, width: 844, height: 390 }]) {
    const page = await open('/#series', { ...size, beforeScripts: withArticles(1, 3) });
    try {
      const old = await readBoard(page);
      const tracks = () => evaluate(page, "getComputedStyle(document.querySelector('.category-columns')).gridTemplateColumns.split(' ').length");
      assert.equal(await tracks(), size.width > 600 ? 4 : 2);
      await evaluate(page, `document.querySelector(${JSON.stringify(cover('minecraft'))}).click()`);
      if (size.reduced) assert.equal((await readBoard(page)).title, '文章目录');
      await settledCatalog(page, 'minecraft');
      const now = await readBoard(page);
      assert.deepEqual(now.labels, homeLabels);
      assert.ok(now.widths[0] > old.widths[0]);
      assert.equal(await tracks(), 2);
      for (const width of now.widths.slice(1)) near(width, now.widths[0] / 2, 1, 'the other cells occupy one track');
      const grid = await evaluate(page, `(() => {
        const column = document.querySelector('.is-catalog-open');
        const width = column.parentElement.clientWidth;
        const cards = [...column.querySelectorAll('.catalog-card')].map(el => {
          let top = 0;
          for (let node = el; node; node = node.offsetParent) top += node.offsetTop;
          return { top, height: el.offsetHeight, width: el.offsetWidth };
        });
        const display = column.querySelector('.category-display');
        return { width, column: column.offsetWidth, display: display.clientWidth, height: display.clientHeight, cards };
      })()`);
      near(grid.column, grid.width, 1, 'phone cell spans its grid');
      assert.ok(grid.height >= grid.cards.reduce((height, card) => height + card.height, 0) + 20, 'the display contains every card');
      for (const [index, card] of grid.cards.entries()) {
        near(card.width, grid.display - 32, 1, 'phone card gutters');
        if (index) near(card.top - grid.cards[index - 1].top - grid.cards[index - 1].height, 0, 1, 'phone entries meet at their rules');
      }
      assert.equal((await state(page)).width, size.width);
      await scroll(page, now.y + 450);
      await clickLink(page, '.catalog-back');
      await settledCatalog(page, '');
      assert.equal(await tracks(), size.width > 600 ? 4 : 2);
      near((await state(page)).y, old.y, 2, 'return to the phone category heading');
    } finally { await close(page); }
  }
});

test('the catalog back link sits beside the folded brand and leaves the search room to open', { skip }, async () => {
  const page = await open('/#catalog-minecraft', phone);
  try {
    for (const width of [320, 360, 390, 721, 871, 1024, 1440, 1920]) {
      const mobile = width <= 720;
      await viewport(page, { width, height: width === 1024 ? 700 : width === 1920 ? 1080 : 844, mobile });
      await waitFor(page, `innerWidth === ${width} && document.documentElement.classList.contains('has-vertical-chapters') === ${mobile}`);
      // Mode and resize hooks complete the HUD and catalog measurements on the next frame.
      await evaluate(page, 'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      await settledCatalog(page, 'minecraft');
      if (mobile) await scroll(page, (await state(page)).y + 200);
      const geometry = await evaluate(page, `(() => {
        const back = document.querySelector('.site-header > .site-brand + .catalog-back');
        const brand = back.previousElementSibling.getBoundingClientRect(), box = back.getBoundingClientRect();
        const style = getComputedStyle(back);
        const tools = [...back.nextElementSibling.querySelectorAll('.header-search-toggle, .header-tool')];
        return {
          centerDifference: (box.top + box.bottom - brand.top - brand.bottom) / 2,
          gap: box.left - brand.right, unit: parseFloat(style.fontSize) / 12,
          overlapsTools: tools.some(tool => box.right > tool.getBoundingClientRect().left),
          text: back.innerText.replace(/\\s+/g, ' ').trim(), name: back.getAttribute('aria-label'),
          reachable: back.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)),
          bottom: box.bottom, eyebrow: document.querySelector('.category-heading .eyebrow').getBoundingClientRect().top,
        };
      })()`);
      near(geometry.centerDifference, 0, 1, `back link and brand center at ${width}px`);
      near(geometry.gap, mobile ? 14 : 44 * geometry.unit, 1, `gap after the brand at ${width}px`);
      assert.equal(geometry.overlapsTools, false, `back link clears all three tools at ${width}px`);
      assert.ok(geometry.reachable, `back link is above the page at ${width}px`);
      assert.equal(geometry.name, '返回分类');
      assert.equal(geometry.text, width < 360 ? '← 分类' : mobile ? '← 返回分类' : '← 返回分类 / CATEGORIES');
      if (width === 1024) assert.ok(geometry.bottom < geometry.eyebrow, 'the back link clears ARTICLE INDEX');
      await evaluate(page, "document.querySelector('.header-search-toggle').focus()");
      await waitFor(page, "document.querySelector('.catalog-back').inert && getComputedStyle(document.querySelector('.catalog-back')).visibility === 'hidden'");
      assert.ok(await evaluate(page, `(() => {
        const back = document.querySelector('.catalog-back');
        back.focus();
        return document.activeElement !== back && getComputedStyle(back).pointerEvents === 'none';
      })()`));
      await press(page, 'Escape');
      await waitFor(page, "!document.querySelector('.catalog-back').inert && getComputedStyle(document.querySelector('.catalog-back')).opacity === '1'");
      await evaluate(page, "document.querySelector('.site-header .site-brand').focus()");
      await press(page, 'Tab');
      assert.ok(await evaluate(page, "document.activeElement.matches('.catalog-back')"), 'back follows the brand in tab order');
    }
  } finally { await close(page); }
});

test('the phone catalog wraps group names and sets its articles as a typographic index', { skip }, async () => {
  const page = await open('/?theme=dark#catalog-minecraft', { ...phone, width: 320, reduced: true });
  try {
    const styles = await evaluate(page, `(() => {
      const column = document.querySelector('.is-catalog-open'), heading = column.querySelector('h3');
      heading.textContent = 'SubcategoryName'.repeat(12);
      const head = heading.parentElement;
      const line = parseFloat(getComputedStyle(heading).lineHeight);
      // No box: a bare entry under a 1px rule, solid for an article, dashed when empty.
      const material = el => { const css = getComputedStyle(el); return [css.backgroundColor, css.backdropFilter, css.borderTopWidth, css.borderTopStyle, css.borderLeftStyle]; };
      return {
        lines: heading.offsetHeight / line, fits: heading.scrollWidth <= heading.clientWidth,
        contains: head.offsetHeight >= heading.offsetHeight,
        headStyles: [getComputedStyle(heading).whiteSpace, getComputedStyle(heading).overflowWrap],
        firstLine: [...head.children].filter(el => el !== heading).every(el => el.offsetWidth > 0 &&
          Math.abs((el.offsetTop + el.offsetHeight / 2) - (heading.offsetTop + line / 2)) <= 1),
        materials: [column.querySelector('.catalog-card'), document.querySelector('.catalog-empty')].map(material),
        type: (card => [getComputedStyle(card.querySelector('.catalog-card-index')).fontSize, getComputedStyle(card.querySelector('.catalog-card-title')).fontWeight,
          getComputedStyle(card.querySelector('.catalog-card-reading')).display])(column.querySelector('.catalog-card')),
      };
    })()`);
    assert.ok(styles.lines > 1 && styles.fits && styles.contains);
    assert.deepEqual(styles.headStyles, ['normal', 'anywhere']);
    assert.ok(styles.firstLine, 'the symbol, rule and count follow the first line');
    assert.deepEqual(styles.materials, [['rgba(0, 0, 0, 0)', 'none', '1px', 'solid', 'none'], ['rgba(0, 0, 0, 0)', 'none', '1px', 'dashed', 'none']]);
    assert.deepEqual(styles.type, ['34px', '600', 'inline'], 'a large numeral, a bold title, and the reading time beside the date');
  } finally { await close(page); }
});

test('desktop catalog cards have a keyboard focus frame and the viewport allows pinch zoom', { skip }, async () => {
  const page = await open('/?theme=dark#catalog-minecraft', { ...desktop, reduced: true });
  try {
    await press(page, 'Tab');
    const styles = await evaluate(page, `(() => {
      const card = document.querySelector('.is-catalog-open .catalog-card');
      card.focus({ preventScroll: true });
      const style = getComputedStyle(card);
      const viewport = document.querySelector('.chapter-viewport');
      const gesture = name => viewport.dispatchEvent(new TouchEvent(name, { bubbles: true, cancelable: true,
        touches: [1, 2].map(identifier => new Touch({ identifier, target: viewport })) }));
      return [card.matches(':focus-visible'), style.outlineWidth, style.outlineStyle, style.outlineColor,
        style.outlineOffset, getComputedStyle(viewport).touchAction, gesture('touchstart'), gesture('touchmove')];
    })()`);
    assert.deepEqual(styles, [true, '1px', 'solid', 'rgba(182, 196, 208, 0.46)', '4px', 'pinch-zoom', true, true]);
  } finally { await close(page); }
});

test('phone catalog landings follow the tapped cell and preserve the reading position across refreshes', { skip }, async () => {
  const page = await open('/#series', { ...phone, beforeScripts: withArticles(1, 12) });
  const column = slug => `[data-category-slug="${slug}"]`;
  const original = await evaluate(page, 'document.title');
  try {
    const home = await state(page);
    await clickLink(page, cover('other'), { touch: true });
    await settledCatalog(page, 'other');
    const otherOffset = await layoutTop(page, column('other')) - (await state(page)).y;
    assert.ok(otherOffset >= home.header + 7 && otherOffset <= home.header + .45 * (phone.height - home.header) + 1,
      `the lower cell opens in reading range at ${otherOffset}px`);
    assert.equal(await evaluate(page, 'document.title'), '其他 · 文章目录 · ' + original);
    await clickLink(page, '.catalog-back');
    await settledCatalog(page, '');
    near((await state(page)).y, home.y, 2, 'closing returns to the category heading');
    assert.equal(await evaluate(page, 'document.title'), original);
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    near((await state(page)).y, home.y, 2, 'the first row keeps the heading in view');
    assert.equal(await evaluate(page, 'document.title'), 'Minecraft · 文章目录 · ' + original);

    const reading = await scroll(page, home.y + 420);
    await viewport(page, { ...phone, height: phone.height + 56 });
    await waitFor(page, `innerHeight === ${phone.height + 56}`);
    for (const action of ['', "document.dispatchEvent(new Event('visibilitychange'));",
      "dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));", "dispatchEvent(new Event('site:revealed'));"]) {
      await evaluate(page, `${action} new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
      near((await state(page)).y, reading, 2, 'catalog refresh preserves the reading position');
      assert.equal(await evaluate(page, "document.querySelector('.is-catalog-open').dataset.categorySlug"), 'minecraft');
    }

    await scroll(page, await layoutTop(page, column('daydreams')) - 600);
    await clickLink(page, cover('daydreams'));
    await settledCatalog(page, 'daydreams');
    const daydreamTop = await layoutTop(page, column('daydreams'));
    await waitFor(page, `Math.abs(scrollY - ${daydreamTop - home.header - 8}) <= 2`);
    assert.equal(await evaluate(page, 'document.title'), '白日梦话 · 文章目录 · ' + original);
    await evaluate(page, 'history.back()');
    await settledCatalog(page, 'minecraft');
    assert.equal(await evaluate(page, 'document.title'), 'Minecraft · 文章目录 · ' + original);
    await evaluate(page, 'history.forward()');
    await settledCatalog(page, 'daydreams');
    assert.equal(await evaluate(page, 'document.title'), '白日梦话 · 文章目录 · ' + original);
  } finally { await close(page); }
});

test('the phone journal link leaves the open catalog and lands on About', { skip }, async () => {
  const page = await open('/#series', phone);
  try {
    const original = await evaluate(page, 'document.title');
    await clickLink(page, cover('minecraft'));
    await settledCatalog(page, 'minecraft');
    const journalLink = '#journal-note .text-link';
    await scroll(page, await layoutTop(page, journalLink) - 350);
    await clickLink(page, journalLink, { touch: true });
    await waitFor(page, "location.hash === '#about' && !document.documentElement.matches('.is-catalog') && document.activeElement.id === 'about'");
    near((await state(page)).y, (await state(page)).entry, 2, 'the journal link lands on About');
    assert.equal(await evaluate(page, 'document.title'), original);
  } finally { await close(page); }
});

test('the lower catalog deep link lands by its cell on load and on returning to the phone layout', { skip }, async () => {
  // Model a late layout change under the loader just before its landing correction.
  const beforeScripts = `window.addEventListener('site:revealed', () => {
    const about = document.querySelector('#about');
    about.style.paddingBottom = (parseFloat(getComputedStyle(about).paddingBottom) + 160) + 'px';
  }, { once: true });`;
  const page = await open('/#catalog-other', { ...phone, beforeScripts });
  try {
    for (const mode of ['load', 'mode change']) {
      if (mode === 'mode change') {
        await viewport(page, desktop);
        await waitFor(page, "document.querySelector('#series.has-catalog-board')");
        await viewport(page, phone);
        await waitFor(page, "document.documentElement.matches('.has-vertical-chapters') && !document.querySelector('#series.has-catalog-board')");
      }
      await settledCatalog(page, 'other');
      const now = await state(page);
      near(await layoutTop(page, '.is-catalog-open') - now.y, now.header + 8, 2, `the lower deep link on ${mode}`);
      assert.equal(await evaluate(page, 'document.title'), '其他 · 文章目录 · Gŭdù || 个人博客');
      const reading = await scroll(page, now.y + 420);
      await evaluate(page, "dispatchEvent(new Event('site:revealed'))");
      near((await state(page)).y, reading, 2, 'a later reveal preserves reading after a deep link');
    }
  } finally { await close(page); }
});

test('the desktop skip link leaves the open catalog and focuses About', { skip }, async () => {
  const page = await open('/#catalog-minecraft', { ...desktop, reduced: true });
  try {
    await evaluate(page, "document.querySelector('.skip-link').focus({ preventScroll: true })");
    await press(page, 'Enter');
    await waitFor(page, "location.hash === '#about' && !document.documentElement.matches('.is-catalog') && document.activeElement.id === 'about'");
    assert.equal((await state(page)).current, '关于');
  } finally { await close(page); }
});

test('each region tilts as one straight plate, flat in the middle and leaning in at the edges', { skip }, async () => {
  const page = await open();
  // A panel and the headings that belong to it share one plane: the face
  // spanning the arc points of the panel's part on screen.
  const plates = async () => evaluate(page, `(() => {
    const pageTop = element => { let top = 0; for (let node = element; node; node = node.offsetParent) top += node.offsetTop; return top; };
    const header = document.querySelector('.site-header').offsetHeight;
    const area = document.documentElement.clientHeight - header;
    const center = header + area / 2;
    const pitch = element => Number(element.style.transform.match(/rotateX\\((-?[\\d.]+)deg\\)/)?.[1] ?? NaN);
    return [...document.querySelectorAll('.chapter-reveal-unit')].map(element => {
      const owner = document.getElementById(element.dataset.depthOwnerCompact || element.dataset.depthOwner || '');
      const top = pageTop(element) - scrollY - center;
      return { id: element.id || element.className.split(' ')[0], panel: element.classList.contains('chapter-panel'), top, bottom: top + element.offsetHeight, pitch: pitch(element), ownerPitch: owner ? pitch(owner) : null, flat: area * 0.1, half: area / 2 };
    });
  })()`);
  assert.equal(await evaluate(page, "document.querySelectorAll('.chapter-panel-slice, .is-chapter-sliced, .is-chapter-facet').length"), 0, 'panels are never cut up');
  assert.equal(await evaluate(page, "[...document.querySelectorAll('.chapter-panel *')].some(element => element.style.transform)"), false, 'nothing inside a panel bends on its own');
  for (const offset of [640, 120, -300]) {
    await scroll(page, (await sectionTop(page, 'series')) - offset);
    const all = await plates();
    assert.ok(all.every(plate => Number.isFinite(plate.pitch)), 'every region carries its place on the arc');
    for (const plate of all) {
      if (plate.ownerPitch !== null) assert.equal(plate.pitch, plate.ownerPitch, `${plate.id} shares its panel's plane`);
      if (!plate.panel || plate.bottom <= -plate.half || plate.top >= plate.half) continue;
      if (plate.top > plate.flat) assert.ok(plate.pitch > 0, `${plate.id} rising from the bottom leans its lower edge in`);
      if (plate.bottom < -plate.flat) assert.ok(plate.pitch < 0, `${plate.id} leaving at the top leans its upper edge in`);
    }
    if (offset === 640) assert.ok(all.some(plate => plate.id === 'category-surface' && plate.pitch > 8), '分类 rising from the bottom is visibly tilted');
  }
  // A panel that fills the screen, both its edges off it, lies flat.
  await scroll(page, (await evaluate(page, "(() => { let top = 0; for (let node = document.querySelector('#about .chapter-panel'); node; node = node.offsetParent) top += node.offsetTop; return top; })()")) + 100);
  const about = (await plates()).find(plate => plate.panel && plate.id.startsWith('about'));
  assert.ok(Math.abs(about.pitch) < 3, `a screen-filling panel lies flat (${about.pitch})`);
  await close(page);

  const still = await open('/', { reduced: true });
  await scroll(still, 1500);
  assert.equal(await evaluate(still, "[...document.querySelectorAll('.chapter-section *')].some(element => element.style.transform)"), false, 'reduced motion keeps every block flat');
  assert.equal(await evaluate(still, "document.querySelectorAll('.chapter-panel-slice, .is-chapter-sliced').length"), 0, 'and every panel whole');
  await swipe(still, 200, 300, 380);
  await sleep(200);
  assert.ok((await state(still)).y < 1500, 'reduced motion still scrolls back natively');
  await close(still);
});

test('text and images rise into place one block at a time as they scroll into view', { skip }, async () => {
  const page = await open();
  await scroll(page, (await state(page)).entry);
  const blocks = () => evaluate(page, `[...document.querySelectorAll('.is-vertical-reveal')].map(element => {
    const box = element.getBoundingClientRect();
    return { image: element.tagName === 'IMG', top: box.top, bottom: box.bottom, shown: element.classList.contains('is-vertical-shown') };
  })`);
  let now = await blocks();
  assert.ok(now.length > 20, 'text blocks and the portrait each rise on their own');
  assert.ok(now.some(block => block.image), 'the portrait is one of them');
  assert.ok(now.filter(block => block.top > 900).every(block => !block.shown), 'blocks further down wait out of view');
  assert.ok(now.filter(block => block.bottom > 120 && block.top < 700).every(block => block.shown), 'blocks in view have risen');
  // Further down, the next blocks rise as they arrive; the first ones reset once off screen.
  await scroll(page, (await sectionTop(page, 'journal')) - 78);
  await sleep(300);
  now = await blocks();
  assert.ok(now.filter(block => block.bottom > 120 && block.top < 700).every(block => block.shown));
  assert.ok(now.filter(block => block.bottom < -50).every(block => !block.shown), 'blocks above the screen reset to rise again');
  const hidden = await evaluate(page, "getComputedStyle(document.querySelector('.is-vertical-reveal:not(.is-vertical-shown)')).opacity");
  assert.equal(hidden, '0', 'a waiting block is hidden');
  await close(page);
});

// Where a point of the ruler shows once its segment is folded: a probe at a
// fraction of one of the four scale segments, on the axis.
const RULER_POINT = (segment, fraction) => `(() => {
  const host = document.querySelector('.chapter-progress-scales > span:nth-child(${segment})');
  const probe = document.createElement('i');
  probe.style.cssText = 'position: absolute; left: ${fraction * 100}%; bottom: 2px; width: 0; height: 1px';
  host.append(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  return { x: box.left, y: box.top + 0.5 };
})()`;
const RAIL_HOVER = `(() => {
  const track = document.querySelector('.chapter-progress-track');
  const box = track.getBoundingClientRect();
  return {
    x: box.left + parseFloat(track.style.getPropertyValue('--chapter-hover-view-x')),
    drop: parseFloat(track.style.getPropertyValue('--chapter-hover-view-y')),
    coordinate: parseFloat(track.style.getPropertyValue('--chapter-hover-x')) / (box.width / 4) - 0.5,
    fold: document.querySelector('.chapter-progress-rail').getAttribute('data-fold'),
  };
})()`;
const MARKER = "(box => ({ x: box.left + box.width / 2, y: box.top + 5 }))(document.querySelector('.chapter-progress-marker').getBoundingClientRect())";
// The HUD drifts after the mouse for about half a second, and a press holds it.
async function stillHud(page) {
  let last = null;
  for (let tries = 0; tries < 40; tries++) {
    const now = await evaluate(page, "document.querySelector('.chapter-progress').style.translate");
    if (now === last) return;
    last = now;
    await sleep(120);
  }
}
async function settledPosition(page) {
  let last = NaN;
  for (let tries = 0; tries < 40; tries++) {
    await sleep(150);
    const now = (await state(page)).position;
    if (now === last) return now;
    last = now;
  }
  return last;
}

test('on wide screens the HUD folds in at both ends and still answers where it shows', { skip }, async () => {
  const page = await open('/#about', { width: 1600, height: 860, mobile: false });
  await waitFor(page, "document.documentElement.classList.contains('is-content')");
  await sleep(400);
  const turned = await evaluate(page, `(() => {
    const turned = element => getComputedStyle(element).transform.startsWith('matrix3d');
    return {
      stations: [...document.querySelectorAll('.chapter-progress-links > a')].map(turned),
      scales: [...document.querySelectorAll('.chapter-progress-scales > span')].map(turned),
      header: [turned(document.querySelector('.site-brand')), turned(document.querySelector('.header-tools'))],
    };
  })()`);
  assert.deepEqual(turned, { stations: [true, false, false, true], scales: [true, false, false, true], header: [true, true] }, 'the end stations and the header ends turn; the middle stays flat');
  const far = await evaluate(page, RULER_POINT(1, 0));
  const hinge = await evaluate(page, RULER_POINT(2, 0));
  const end = await evaluate(page, RULER_POINT(4, 1));
  assert.ok(far.y - hinge.y > 6 && end.y - hinge.y > 6, 'both ends come towards the reader, below the flat middle');
  // The ends' drift away from the middle is split: each HUD moves in by half of it.
  const shift = await evaluate(page, "({ lift: parseFloat(document.querySelector('.chapter-progress').style.getPropertyValue('--hud-ruler-lift')), drop: parseFloat(document.querySelector('.site-header').style.getPropertyValue('--hud-header-drop')) })");
  assert.ok(Math.abs((far.y - hinge.y) / 2 - shift.lift) < 0.75, `the ruler sits higher by half the dip of its ends (${shift.lift} vs ${(far.y - hinge.y) / 2})`);
  assert.ok(shift.drop > 1, 'and the header lower by half the rise of its ends');
  // Sideways, every far end lands back on the frame the flat page draws the
  // HUD in: the ruler's on the ends of its box, the header's on the brand's
  // and the tools' laid-out edges. The tools fold about their search icon, so
  // the logo and the icons stay level.
  const frame = await evaluate(page, `(() => {
    const probe = (host, css) => {
      const point = document.createElement('i');
      point.style.cssText = 'position: absolute; width: 0; height: 0; ' + css;
      host.append(point);
      const left = point.getBoundingClientRect().left;
      point.remove();
      return left;
    };
    const middle = element => { const box = element.getBoundingClientRect(); return (box.top + box.bottom) / 2; };
    const shown = element => element.getBoundingClientRect().width > 0;
    const header = document.querySelector('.site-header');
    const brand = header.querySelector('.site-brand');
    const tools = header.querySelector('.header-tools');
    const box = header.getBoundingClientRect();
    const nav = document.querySelector('.chapter-progress').getBoundingClientRect();
    const logo = [...brand.querySelectorAll('.brand-logo')].find(shown);
    return {
      ruler: [probe(document.querySelector('.chapter-progress-scales > span:first-child'), 'left: 0') - nav.left,
        probe(document.querySelector('.chapter-progress-scales > span:last-child'), 'right: 0') - nav.right],
      header: [probe(brand, 'left: 0; top: 0') - (box.left + brand.offsetLeft), probe(tools, 'right: 0; top: 0') - (box.left + tools.offsetLeft + tools.offsetWidth)],
      level: [...tools.querySelectorAll('svg')].filter(shown).map(icon => middle(icon) - middle(logo)),
    };
  })()`);
  assert.ok([...frame.ruler, ...frame.header].every(offset => Math.abs(offset) < 1), `the HUD's far ends land on the flat frame (ruler ${frame.ruler}, header ${frame.header})`);
  assert.ok(frame.level.length === 3 && frame.level.every(offset => Math.abs(offset) < 3), `the logo and the tools' icons sit level (${frame.level})`);

  // A folded station is one layer: its names, its label and the rest of its
  // cell must still be the link, and its axis band the ruler, as on the flat ones.
  const links = await evaluate(page, `[...document.querySelectorAll('.chapter-progress-links > a')].map(link => {
    const at = (x, y) => document.elementFromPoint(x, y)?.closest('a') === link;
    const title = link.querySelector('.chapter-station-title').getBoundingClientRect();
    const label = link.querySelector('.chapter-station-subtitle').getBoundingClientRect();
    const cell = link.getBoundingClientRect();
    return [at(title.left + title.width / 2, title.bottom - 3), at(label.left + label.width / 2, label.top + label.height / 2), at(cell.left + cell.width / 2, cell.top + 16)];
  })`);
  assert.deepEqual(links, Array(4).fill([true, true, true]), 'names, labels and cells stay links');
  for (const [segment, fraction] of [[1, 0.8], [4, 0.3]]) {
    const point = await evaluate(page, RULER_POINT(segment, fraction));
    const band = await evaluate(page, `[-10, 0, 10].map(dy => Boolean(document.elementFromPoint(${point.x}, ${point.y} + dy)?.closest('.chapter-progress-rail')))`);
    assert.deepEqual(band, [true, true, true], 'the axis band of a folded station belongs to the ruler');
  }

  // Hover and press on each fold: the landing mark shows under the pointer and
  // the page lands where it showed.
  for (const [segment, fraction, side] of [[1, 0.8, 'left'], [4, 0.3, 'right']]) {
    const point = await evaluate(page, RULER_POINT(segment, fraction));
    await mouse(page, 'mouseMoved', point.x - 12, point.y);
    await mouse(page, 'mouseMoved', point.x, point.y);
    await stillHud(page);
    const hover = await evaluate(page, RAIL_HOVER);
    assert.equal(hover.fold, side);
    assert.ok(Math.abs(hover.x - point.x) < 0.75, `the landing mark on the ${side} fold shows under the pointer (${hover.x} vs ${point.x})`);
    assert.ok(hover.drop > 1, 'below the flat axis, where the fold shows it');
    await mouse(page, 'mousePressed', point.x, point.y, 1);
    await mouse(page, 'mouseReleased', point.x, point.y);
    const landed = await settledPosition(page);
    assert.ok(Math.abs(landed - hover.coordinate) < 0.01, `a press on the ${side} fold lands where its mark showed (${landed} vs ${hover.coordinate})`);
  }

  // Dragging the cursor along a fold keeps it under the pointer.
  const start = await evaluate(page, MARKER);
  await mouse(page, 'mouseMoved', start.x, start.y);
  await stillHud(page);
  const grip = await evaluate(page, MARKER);
  await mouse(page, 'mousePressed', grip.x, grip.y, 1);
  const goal = await evaluate(page, RULER_POINT(4, 0.1));
  for (let step = 1; step <= 10; step++) {
    await mouse(page, 'mouseMoved', grip.x + (goal.x - grip.x) * step / 10, grip.y, 1);
    await sleep(16);
  }
  await sleep(200);
  const held = await evaluate(page, MARKER);
  assert.ok(Math.abs(held.x - goal.x) < 1, `the dragged cursor stays under the pointer (${held.x} vs ${goal.x})`);
  await mouse(page, 'mouseReleased', goal.x, grip.y);
  assert.ok(Math.abs((await settledPosition(page)) - 2.6) < 0.01, 'and lands where it was let go');
  await close(page);

  const still = await open('/#about', { width: 1600, height: 860, mobile: false, reduced: true });
  await waitFor(still, "document.documentElement.classList.contains('is-content')");
  assert.equal(await evaluate(still, "[...document.querySelectorAll('.chapter-progress-links > a, .chapter-progress-scales > span, .site-brand, .header-tools')].every(element => getComputedStyle(element).transform === 'none')"), true, 'reduced motion keeps the HUD flat');
  await close(still);
  assert.deepEqual(failures, []);
});

test('on tall windows the HUD moves in with the panels and their clip follows', { skip }, async () => {
  const seen = {};
  for (const [width, height] of [[1600, 860], [1774, 1266]]) {
    const page = await open('/#about', { width, height, mobile: false });
    await waitFor(page, "document.documentElement.classList.contains('is-content')");
    await sleep(400);
    seen[height] = await evaluate(page, `(() => {
      const header = document.querySelector('.site-header');
      const nav = document.querySelector('.chapter-progress');
      const clip = getComputedStyle(document.querySelector('.chapter-viewport')).clipPath.match(/^inset\\(([^)]+)\\)/)[1].split(/\\s+/).map(parseFloat);
      const panels = [...document.querySelectorAll('#about .chapter-panel')].map(panel => panel.getBoundingClientRect());
      return {
        // The inset alone, without the folds' half-drift shift.
        top: parseFloat(getComputedStyle(header).marginTop) - parseFloat(header.style.getPropertyValue('--hud-header-drop') || 0),
        bottom: parseFloat(getComputedStyle(nav).marginBottom) - parseFloat(nav.style.getPropertyValue('--hud-ruler-lift') || 0),
        clip: [clip[0], clip[2]],
        headerHeight: header.getBoundingClientRect().height,
        panels: [Math.min(...panels.map(box => box.top)), Math.max(...panels.map(box => box.bottom))],
      };
    })()`);
    await close(page);
  }
  const short = seen[860], tall = seen[1266];
  assert.ok(Math.abs(short.top - 6) < 1 && short.bottom < 1, `a short window moves only the header in, by 6px (${short.top}, ${short.bottom})`);
  assert.ok(tall.top > 30 && tall.bottom > 30, `a tall window moves both in by half of the panels' extra margin (${tall.top}, ${tall.bottom})`);
  for (const view of [short, tall]) {
    assert.ok(Math.abs(view.clip[0] - (view.headerHeight + 8 + view.top)) < 1 && Math.abs(view.clip[1] - (118 + view.bottom)) < 1, `the panels' clip follows the HUD (${view.clip})`);
  }
  assert.ok(tall.panels[0] >= tall.clip[0] && tall.panels[1] <= 1266 - tall.clip[1], `the panels stay clear of the moved clip (${tall.panels} within ${tall.clip})`);
  assert.deepEqual(failures, []);
});

test('the About record reads as an ID card and fits its chapter', { skip }, async () => {
  const card = `(() => {
    const box = selector => {
      const element = document.querySelector('#about ' + selector);
      const b = element.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    return {
      scrollable: document.querySelector('#about').classList.contains('is-chapter-scrollable'),
      width: innerWidth,
      copy: box('.about-copy'), photo: box('.about-avatar'), links: box('.about-socials'), name: box('.about-name'),
      facts: box('.about-dossier'), bio: box('.about-bio'), strip: box('.about-mrz'),
      last: document.querySelector('#about .about-copy').lastElementChild.className,
      fields: [...document.querySelectorAll('#about .about-fact dt')].map(dt => dt.firstChild.textContent.trim()),
    };
  })()`;
  // On wide screens: the photo with its links beside the name, the form and
  // the introduction, then the strip across the card, all above the ruler
  // even in a short window.
  for (const [width, height] of [[1600, 860], [1280, 720]]) {
    const page = await open('/#about', { width, height, mobile: false });
    await waitFor(page, "document.documentElement.classList.contains('is-content')");
    await sleep(400);
    const view = await evaluate(page, card);
    assert.equal(view.scrollable, false, `the record fits its chapter at ${width}x${height}`);
    assert.ok(view.photo.right < view.name.left && view.photo.right < view.facts.left, 'the photo sits beside the name and the form');
    assert.ok(view.links.top >= view.photo.bottom - 1 && Math.abs(view.links.left - view.photo.left) < 8, 'the links stay under the photo');
    assert.ok(view.bio.left > view.photo.right && Math.abs(view.bio.left - view.facts.left) < 8 && view.bio.top >= view.facts.bottom - 1, 'the introduction closes the right column, under the form');
    assert.ok(view.strip.top >= Math.max(view.bio.bottom, view.links.bottom) - 1, 'the strip closes the card');
    assert.equal(view.last, 'about-mrz');
    assert.deepEqual(view.fields, ['现居', '身份', '爱好', '最喜欢的类型', '玩的游戏']);
    await close(page);
  }
  // A phone stacks the same card, and the strip never widens it.
  const phone = await open();
  await scroll(phone, (await state(phone)).entry);
  await sleep(400);
  const view = await evaluate(phone, card);
  assert.ok(view.copy.left >= 0 && view.copy.right <= view.width, `the card stays inside the screen (${view.copy.left}, ${view.copy.right})`);
  assert.ok(view.links.top >= view.photo.bottom - 1 && view.name.top >= view.links.bottom - 1, 'the photo and its links come first, then the name');
  assert.ok(view.bio.top >= view.facts.bottom - 1 && view.strip.top >= view.bio.bottom - 1, 'the introduction follows the form and the strip closes the card');
  await close(phone);
  assert.deepEqual(failures, []);
});

// The tape's names hang under their station lines. Each must end above the
// next line and stay on screen, on short phones and phones on their side too.
const TAPE_LABELS = `(() => {
  const shown = element => getComputedStyle(element).display !== 'none';
  const links = [...document.querySelectorAll('.chapter-progress-links > a')];
  return {
    vertical: document.documentElement.classList.contains('has-vertical-chapters'),
    width: innerWidth,
    stations: links.map((link, index) => {
      const title = link.querySelector('.chapter-station-title');
      const box = title.getBoundingClientRect();
      const next = links[index + 1]?.getBoundingClientRect().top ?? link.getBoundingClientRect().bottom;
      return {
        name: title.textContent, clear: next - box.bottom, right: box.right, size: parseFloat(getComputedStyle(title).fontSize),
        number: shown(link.querySelector('.chapter-station-index')), english: shown(link.querySelector('.chapter-station-subtitle')),
      };
    }),
  };
})()`;

test('the phone tape keeps its names apart and on screen, on its side too', { skip }, async () => {
  for (const size of [{ width: 390, height: 844 }, { width: 375, height: 553 }, { width: 844, height: 390 }, { width: 915, height: 356 }, { width: 740, height: 300 }]) {
    const at = `${size.width}x${size.height}`;
    const page = await open('/?intro=short#series', size);
    try {
      await waitFor(page, "document.documentElement.classList.contains('is-content')");
      const tape = await evaluate(page, TAPE_LABELS);
      assert.equal(tape.vertical, true, at);
      for (const station of tape.stations) {
        assert.equal(station.english, false, `${at}: ${station.name} leaves out its English name`);
        assert.ok(station.clear >= 1, `${at}: ${station.name} ends ${station.clear.toFixed(1)}px above the next station line`);
        assert.ok(station.right <= tape.width, `${at}: ${station.name} stays on screen (${station.right.toFixed(1)} of ${tape.width})`);
        assert.ok(station.size >= 9, `${at}: ${station.name} stays readable at ${station.size}px`);
      }
      if (size.height === 844) assert.ok(tape.stations.every(station => station.number && station.size === 12), 'a tall phone keeps the numbers and 12px names');
      if (size.width === 844) assert.ok(tape.stations.every(station => !station.number && station.size === 12), 'on its side the tape drops the numbers before shrinking the names');
    } finally {
      await close(page);
    }
  }
});

test('resizing hands the page between the strip and the vertical page', { skip }, async () => {
  const page = await open();
  await scroll(page, (await sectionTop(page, 'series')) - 78);
  assert.equal((await state(page)).current, '分类');
  await viewport(page, { width: 1200, height: 800, mobile: false });
  await waitFor(page, "!document.documentElement.classList.contains('has-vertical-chapters')");
  await sleep(400);
  let now = await state(page);
  assert.notEqual(now.runway, '', 'the strip rebuilt its scroll runway');
  assert.match(now.track, /translate3d/);
  assert.equal(now.hash, '#series');
  assert.equal(now.current, '分类', 'the strip reopens on the chapter being read');
  assert.equal(await evaluate(page, "document.querySelector('.chapter-progress-marker').getAttribute('aria-orientation')"), 'horizontal');
  assert.equal(await evaluate(page, "document.querySelectorAll('.chapter-panel-slice, .is-chapter-sliced, .is-chapter-facet').length"), 0, 'the strip gets its panels back whole');
  await viewport(page, { width: 390, height: 844, mobile: true });
  await waitFor(page, "document.documentElement.classList.contains('has-vertical-chapters')");
  await sleep(400);
  now = await state(page);
  assert.equal(now.runway, '');
  assert.equal(now.track, '');
  assert.equal(now.current, '分类', 'the vertical page reopens on it too');
  await close(page);

  const tablet = await open('/', { width: 768, height: 1024 });
  assert.equal((await state(tablet)).vertical, false, 'tablets keep the strip');
  await close(tablet);
  const landscape = await open('/', { width: 844, height: 390 });
  assert.equal((await state(landscape)).vertical, true, 'phones on their side read vertically too');
  await close(landscape);
  assert.deepEqual(failures, []);
});
