// Checks the phone layout in a real browser: below the phone breakpoint
// js/chapters-vertical.js runs the chapters as one vertical page with an
// altimeter tape, and hands the page back to the horizontal strip when the
// viewport grows. Needs Chrome, Chromium or Edge; CHROME_PATH picks a build.
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
    '--disable-background-networking', '--disable-3d-apis', '--hide-scrollbars', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not start')), 20000);
    browser.stderr.on('data', data => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
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
  if (browser && browser.exitCode === null) {
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

async function viewport(page, { width, height, mobile }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, page.sessionId);
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, page.sessionId);
}

async function open(path = '/', { width = 390, height = 844, mobile = true, reduced = false } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await viewport(page, { width, height, mobile });
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
const sectionTop = (page, id) => evaluate(page, `(() => { let top = 0; for (let node = document.getElementById('${id}'); node; node = node.offsetParent) top += node.offsetTop; return top; })()`);
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

test('section links, categories, search and linked URLs land on their chapter', { skip }, async () => {
  let page = await open();
  await scroll(page, (await state(page)).entry);
  const journalLanding = async () => (await sectionTop(page, 'journal')) - (await state(page)).header - 8;
  await evaluate(page, "document.querySelector('#about a[href=\"#journal\"]').click()");
  await sleep(1100);
  assert.ok(Math.abs((await state(page)).y - await journalLanding()) <= 2, 'the About card opens the journal');
  await scroll(page, (await sectionTop(page, 'series')) - 78);
  await evaluate(page, "document.querySelector('#series a[data-category-link]').click()");
  await sleep(1100);
  let now = await state(page);
  assert.ok(Math.abs(now.y - await journalLanding()) <= 2, 'a category opens the journal');
  assert.match(now.search, /category=/);
  await scroll(page, (await state(page)).entry);
  await evaluate(page, "(document.querySelector('#post-search input').value = 'x', document.querySelector('#post-search').requestSubmit(), 1)");
  await sleep(1100);
  assert.ok(Math.abs((await state(page)).y - await journalLanding()) <= 2, 'a search shows its results in the journal');
  await close(page);

  page = await open('/#archive');
  now = await state(page);
  assert.ok(Math.abs(now.y - Math.min((await sectionTop(page, 'archive')) - now.header - 8, now.height - 844)) <= 2, 'a linked chapter opens on load');
  assert.equal(now.current, '归档');
  await close(page);
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
