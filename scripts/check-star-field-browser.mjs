// Run separately from npm run check. Requires the working tree at localhost:4173
// and Chrome with SwiftShader. Set CHROME_PATH to use a different installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Record the entrance controller's actual previous/current field uniforms.
// The browser comparison can then isolate the camera from the new drift.
function observeEntrance() {
  const trace = window.starFieldTrace = { start: null, hold: null, pull: null, landed: null };
  const images = window.starFieldImages = {};
  window.addEventListener('site:revealing', () => { trace.start = performance.now(); });
  Object.defineProperty(window, 'StarField', {
    configurable: true,
    set(Renderer) {
      let previous = null;
      class ObservedField extends Renderer {
        render(state) {
          const drawn = super.render(state);
          if (drawn) {
            const sample = { previous, current: { ...state }, elapsed: performance.now() - trace.start };
            let phase;
            if (trace.start !== null && state.amount === 1) phase = 'hold';
            if (trace.hold && state.introMoving && previous?.introMoving && state.amount > 0.15
                && state.amount < 0.85 && Math.abs(previous.zoom - state.zoom) > 0.003) phase = 'pull';
            if (trace.pull && state.amount === 0) phase = 'landed';
            if (phase && !trace[phase] && previous?.time !== state.time) {
              trace[phase] = sample;
              const image = images[phase] = document.createElement('canvas');
              image.width = this.canvas.width;
              image.height = this.canvas.height;
              image.getContext('2d').drawImage(this.canvas, 0, 0);
            }
            previous = sample.current;
          }
          return drawn;
        }
      }
      Object.defineProperty(window, 'StarField', { configurable: true, writable: true, value: ObservedField });
    },
  });
}

async function compareFields(entrance, saveFrames) {
  const stage = document.querySelector('#hero-stage').getBoundingClientRect();
  const { width, height } = stage;
  const list = StarSky.stars(width, height);
  const gpuCanvas = document.createElement('canvas');
  const gpu = new StarField(gpuCanvas);
  const reference = document.createElement('canvas');
  const ctx = reference.getContext('2d');
  const source = await fetch('/js/main.js').then(response => response.text());
  const drawStars = source.match(/^  function drawStars\(\) \{[\s\S]*?^  \}/m)?.[0];
  if (!drawStars) throw Error('Could not locate the home page Canvas 2D reference');
  // Execute the preserved home-page routine itself against this other canvas.
  // Only its closure inputs are supplied by the test; count native strokes to
  // confirm the captured moving frame genuinely exercised the trail branch.
  const render2D = new Function('context', 'starList', 's', 'width', 'height', `
    'use strict';
    let starFrame = null;
    const pageActive = true, blackHoleStyle = 'minimal', starQuiet = s.quiet;
    const introMoving = s.introMoving, introAmount = s.amount, chapterProgress = (1 - s.fade) / 0.6;
    const pointer = { x: s.pointerX, y: s.pointerY }, starAnchor = { x: s.anchorX, y: s.anchorY };
    const isDay = () => s.day, starZoom = () => s.zoom;
    ${drawStars}
    drawStars();`);
  let strokes;
  const stroke = ctx.stroke.bind(ctx);
  ctx.stroke = (...args) => { strokes++; stroke(...args); };
  const capture = document.createElement('canvas');
  const pixels = capture.getContext('2d', { willReadFrequently: true });
  let ratio;
  const rest = {
    time: 0, amount: 0, zoom: 1, anchorX: 0, anchorY: 0, pointerX: 0, pointerY: 0,
    introMoving: false, quiet: entrance.hold?.current.quiet ?? null, day: false, fade: 1,
  };
  const rows = [];
  const frames = [];
  const phases = ['hold', 'pull', 'landed'];
  const sheet = saveFrames ? document.createElement('canvas') : null;
  let sheetContext;
  if (sheet) {
    sheet.width = width * 2;
    sheet.height = (height + 36) * phases.length;
    sheetContext = sheet.getContext('2d');
    sheetContext.fillStyle = '#181b20';
    sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    sheetContext.font = '18px sans-serif';
    sheetContext.fillStyle = '#fff';
  }
  function resize(w, h, dpr, stars) {
    ratio = dpr;
    gpu.resize(w, h, dpr, stars);
    reference.width = capture.width = Math.round(w * dpr);
    reference.height = capture.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Independent scalar coordinates for drift and the previous rendered frame.
  function position(star, s, w, h) {
    const distance = 0.0069 * h * s.time * (1 - 0.7 * (star.depth - 0.04) / 0.4);
    const rawX = star.x - 0.832 * distance, rawY = star.y + 0.555 * distance;
    const tileX = Math.floor((rawX + 0.06 * w) / (1.12 * w));
    const tileY = Math.floor((rawY + 0.06 * h) / (1.12 * h));
    const x = rawX - tileX * 1.12 * w, y = rawY - tileY * 1.12 * h;
    const spread = (s.zoom - 1) * star.depth;
    return { x: x + (x - s.anchorX) * spread + s.pointerX * (7 - 30 * star.depth),
      y: y + (y - s.anchorY) * spread + s.pointerY * (5 - 22 * star.depth), baseX: x, baseY: y, tileX, tileY };
  }

  function drawReference(stars, s, prev) {
    const w = reference.width / ratio, h = reference.height / ratio;
    const catalogue = stars.map(star => {
      const p = position(star, s, w, h);
      const from = prev && s.introMoving ? position(star, prev, w, h) : null;
      const continuous = from && from.tileX === p.tileX && from.tileY === p.tileY;
      return { ...star, x: p.baseX, y: p.baseY,
        lastX: continuous ? from.x : NaN, lastY: continuous ? from.y : NaN };
    });
    strokes = 0;
    render2D(ctx, catalogue, s, w, h);
    return strokes;
  }

  // Byte channels over the opaque page background: invisible RGB at alpha
  // zero and the RGB unpremultiplication of tiny alphas cannot skew the diff.
  function read(canvas, day, opaque = true) {
    pixels.clearRect(0, 0, capture.width, capture.height);
    if (opaque) {
      pixels.fillStyle = day ? '#eef0f2' : '#080b10';
      pixels.fillRect(0, 0, capture.width, capture.height);
    }
    pixels.drawImage(canvas, 0, 0);
    return pixels.getImageData(0, 0, capture.width, capture.height).data;
  }

  function compareTransparent() {
    const before = read(reference, false, false), after = read(gpuCanvas, false, false);
    let max = 0, sum = 0;
    for (let i = 0; i < before.length; i += 4) {
      const a = before[i + 3], b = after[i + 3];
      const alphaError = Math.abs(a - b);
      max = Math.max(max, alphaError);
      sum += alphaError;
      if (!a && !b) continue;
      for (let c = 0; c < 3; c++) {
        const error = Math.abs(Math.round(before[i + c] * a / 255) - Math.round(after[i + c] * b / 255));
        max = Math.max(max, error);
        sum += error;
      }
    }
    return { max, mean: sum / before.length };
  }

  function sample(label, s, prev = null, stars = list, rendered = gpuCanvas) {
    if (rendered === gpuCanvas) {
      gpu.resetHistory();
      if (prev) gpu.render(prev);
      if (!gpu.render(s)) throw Error('GPU field failed to render ' + label);
    }
    const trails = drawReference(stars, s, prev);
    const save = saveFrames && ratio === 1 && capture.width === width
      && ['hold', 'pull', 'landed', 'night', 'day', 'drift 10s'].includes(label);
    const phase = phases.indexOf(label);
    function archive(path, column) {
      if (!save) return;
      frames.push({ name: label + '-' + path + '.png', png: capture.toDataURL().split(',')[1] });
      if (phase < 0) return;
      const y = phase * (height + 36), x = width * column;
      sheetContext.fillText(`${label}  ·  ${Math.round(entrance[label].elapsed)} ms  ·  ${path === '2d' ? 'Canvas 2D' : 'GPU particles'}`, x + 10, y + 25);
      sheetContext.drawImage(capture, x, y + 36);
    }
    const baseline = read(reference, s.day);
    archive('2d', 0);
    const actual = read(rendered, s.day);
    archive('gpu', 1);
    const background = s.day ? [238, 240, 242] : [8, 11, 16];
    let max = 0, sum = 0, changed = 0, occupied = 0;
    for (let i = 0; i < actual.length; i += 4) {
      let peak = 0;
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(actual[i + c] - baseline[i + c]);
        sum += delta;
        peak = Math.max(peak, delta);
      }
      if (peak) changed++;
      if (background.some((value, c) => actual[i + c] !== value || baseline[i + c] !== value)) occupied++;
      max = Math.max(max, peak);
    }
    rows.push({ label, width: capture.width / ratio, height: capture.height / ratio, dpr: ratio, max, mean: sum / (3 * actual.length / 4),
      occupiedMean: sum / (3 * occupied || 1), changed, trails });
    if (label === 'night' || label === 'day') rows.at(-1).premultipliedRGBA = compareTransparent();
  }

  for (const dpr of [1, 1.25, 2]) {
    resize(width, height, dpr, list);
    for (const day of [false, true]) sample(day ? 'day' : 'night', { ...rest, day });
  }
  const wider = StarSky.stars(1280, 900);
  resize(1280, 900, 1, wider);
  for (const day of [false, true]) sample(day ? 'day' : 'night', { ...rest, day }, null, wider);
  resize(width, height, 1, list);
  sample('day chapters + pointer', { ...rest, day: true, fade: 0.4, pointerX: 0.7, pointerY: -0.55 });
  for (const key of phases) {
    const frame = entrance[key];
    if (!frame) continue;
    sample(key, { ...frame.current, time: 0 }, frame.previous && { ...frame.previous, time: 0 });
    Object.assign(rows.at(-1), { elapsed: frame.elapsed, zoom: frame.current.zoom, amount: frame.current.amount });
    // Also compare the actual submitted home-page pixels with the reference
    // at the captured live orbit phase, without replaying the GPU draw.
    sample(key + ' with live drift', frame.current, frame.previous, list, window.starFieldImages[key]);
  }
  const t10 = { ...rest, time: 10 };
  sample('drift 10s', t10);
  const second = read(gpuCanvas, false, false);
  gpu.render(rest);
  const first = read(gpuCanvas, false, false);
  const start = list.map(s => position(s, rest, width, height));
  const end = list.map(s => position(s, t10, width, height));

  // Independently measure motion from the two GPU images. Predictions only
  // identify the same isolated star in each frame; the centroid uses pixels.
  function centroid(image, p) {
    let mx = 0, my = 0, total = 0;
    for (let y = Math.floor(p.y) - 3; y <= Math.floor(p.y) + 3; y++) {
      for (let x = Math.floor(p.x) - 3; x <= Math.floor(p.x) + 3; x++) {
        const alpha = image[4 * (y * capture.width + x) + 3];
        mx += (x + 0.5) * alpha;
        my += (y + 0.5) * alpha;
        total += alpha;
      }
    }
    return total > 18 ? { x: mx / total, y: my / total } : null;
  }
  const speeds = [];
  for (const [i, star] of list.entries()) {
    if ([start, end].some(arr => {
      const p = arr[i];
      return p.tileX || p.tileY || p.x < 5 || p.y < 5 || p.x > width - 5 || p.y > height - 5
        || arr.some((q, j) => i !== j && Math.abs(q.x - p.x) < 6 && Math.abs(q.y - p.y) < 6);
    })) continue;
    const a = centroid(first, start[i]), b = centroid(second, end[i]);
    if (!a || !b) continue;
    const vx = (b.x - a.x) / 10, vy = (b.y - a.y) / 10;
    speeds.push({ depth: star.depth, vx, vy, speed: Math.hypot(vx, vy),
      error: Math.hypot(vx - (end[i].x - start[i].x) / 10, vy - (end[i].y - start[i].y) / 10) });
  }
  speeds.sort((a, b) => a.depth - b.depth);
  const bins = new Map();
  for (const s of speeds) {
    const bin = Math.floor(s.speed * 4) / 4;
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  const drift = { measured: speeds.length, farthest: speeds[0], nearest: speeds.at(-1),
    mode: [...bins].sort((a, b) => b[1] - a[1])[0], maxError: Math.max(...speeds.map(s => s.error)) };

  const probe = [{ x: 150, y: 60, light: 1, radius: 1.5, depth: 0.2 }];
  resize(300, 120, 2, probe);
  const threshold = [];
  for (const travel of [1.19, 1.2, 1.21, 89.99, 90, 90.01]) {
    const current = { ...rest, anchorX: 150 - travel * 10, anchorY: 60, zoom: 1.5,
      introMoving: true, quiet: null };
    gpu.resetHistory();
    gpu.render(rest);
    gpu.render(current);
    const rgba = read(gpuCanvas, false, false);
    let mass = 0, xMoment = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      const x = (i - 3) / 4 % capture.width;
      mass += rgba[i];
      xMoment += (x + 0.5) * rgba[i] / ratio;
    }
    const stroke = travel > 1.2 && travel < 90;
    threshold.push({ travel, stroke, expected: 150 + travel * (stroke ? 0.5 : 1), actual: xMoment / mass });
  }
  const quietCases = [];
  const energy = state => {
    gpu.render(state);
    const rgba = read(gpuCanvas, false, false);
    let sum = 0;
    for (let i = 3; i < rgba.length; i += 4) sum += rgba[i];
    return sum;
  };
  const bright = energy({ ...rest, quiet: null });
  for (const [dx, dy, amount, expected] of [[8, 6, 0, 0.15], [8, 6, 0.5, 0.575],
    [8, 6, 1, 1], [16, 6, 0, 0.575], [20, 22, 0, 1]]) {
    const quiet = { left: 150 + dx, top: 60 + dy, width: 80, height: 12 };
    quietCases.push({ dx, dy, amount, expected, actual: energy({ ...rest, quiet, amount }) / bright });
  }

  // On this narrow viewport a wrap is less than the 90 px limit and both
  // endpoints pass the 8 px cull. A missing wrap guard would streak across it.
  const wrapStar = [{ x: -3.8, y: 80, light: 1, radius: 1.5, depth: 0.04 }];
  resize(64, 300, 1, wrapStar);
  sample('wrap during pull', { ...rest, time: 0.2, introMoving: true }, rest, wrapStar);
  if (sheet) frames.push({ name: 'slow-entrance.png', png: sheet.toDataURL().split(',')[1] });
  return { width, height, count: list.length, rows, drift, threshold, quietCases, frames };
}

const profile = await mkdtemp(join(tmpdir(), 'gudu-star-field-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let diagnostics = '';
chrome.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
const closed = once(chrome, 'exit');
let socket;
try {
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    if (chrome.exitCode !== null) throw Error('Chrome exited ' + chrome.exitCode);
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(s => Number(s.split('\n')[0]), () => 0);
    if (!port) await delay(100);
  }
  assert.ok(port, 'Chrome must open its debugging endpoint');
  const [page] = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  const pending = new Map();
  let seq = 0;
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(Error('Chrome connection closed. ' + diagnostics));
    pending.clear();
  });
  socket.onmessage = ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    if (pending.has(id)) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (error) reject(Error(error.message)); else resolve(result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observeEntrance + ')()' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, mobile: false, deviceScaleFactor: 1 });
  const navigation = await send('Page.navigate', { url: 'http://localhost:4173/?intro=slow&blackhole=minimal' });
  assert.ok(!navigation.errorText, navigation.errorText);
  let entrance;
  for (let i = 0; i < 80; i++) {
    await delay(300);
    entrance = await evaluate('window.starFieldTrace');
    if (entrance?.landed) break;
  }
  assert.ok(entrance, 'home page should load: ' + await evaluate('[location.href, document.title, document.readyState].join(" ")'));
  // Keep the hero from consuming software GPU time during readback.
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))");
  const saveFrames = process.argv.includes('--frames');
  const { frames, ...report } = await evaluate('(' + compareFields + ')(' + JSON.stringify(entrance) + ',' + saveFrames + ')');
  if (saveFrames) {
    report.frames = await mkdtemp(join(tmpdir(), 'gudu-star-field-frames-'));
    for (const frame of frames) await writeFile(join(report.frames, frame.name), Buffer.from(frame.png, 'base64'));
    await writeFile(join(report.frames, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  for (const label of ['hold', 'pull', 'landed']) assert.ok(entrance[label], 'missing slow entrance phase: ' + label);
  assert.ok(report.rows.find(r => r.label === 'pull').trails > 0, 'pull-back must contain actual trails');
  for (const row of report.rows) {
    if (row.premultipliedRGBA || row.label === 'landed') {
      // The native masks reproduce even the brightest edge of a resting disc.
      assert.ok(row.max <= 3 && row.mean < 0.0005, 'resting RGB difference in ' + row.label);
      if (row.premultipliedRGBA) assert.ok(row.premultipliedRGBA.max <= 3, 'resting canvas RGBA difference');
    } else {
      // Motion changes which subpixel samples touch a curved edge. Constrain
      // the average on lit pixels, independent of the expanse of empty sky.
      assert.ok(row.occupiedMean < 5.5 && row.max <= (row.trails ? 100 : 64), 'moving edge difference in ' + row.label);
    }
  }
  assert.equal(report.rows.at(-1).max, 0, 'a wrapping star must not streak across the canvas');
  assert.ok(report.drift.measured > 100 && report.drift.maxError < 0.08, 'GPU centroids must follow depth-dependent motion');
  const farSpeed = 0.0069 * report.height;
  assert.ok(Math.abs(report.drift.farthest.speed - farSpeed) < 0.08 && report.drift.farthest.vx < 0 && report.drift.farthest.vy > 0);
  assert.ok(report.drift.nearest.speed / farSpeed < 0.35 && Math.abs(report.drift.mode[0] - farSpeed) < 0.3);
  for (const p of report.threshold) assert.ok(Math.abs(p.actual - p.expected) < 0.22, 'trail threshold at ' + p.travel);
  for (const p of report.quietCases) assert.ok(Math.abs(p.actual - p.expected) < 0.015, 'clock quiet zone factor');
  await send('Browser.close').catch(() => {});
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
  await closed;
  // profile is a fresh OS temp directory created by this process.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
