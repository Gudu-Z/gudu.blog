#!/usr/bin/env node
/**
 * Reproject the approved illustration onto the current renderer's disk.
 * Requires Node 22+ and an ALREADY RUNNING Chromium remote-debugging endpoint.
 * Usage: node scripts/bake-ink-material.mjs --port 9243 --site http://127.0.0.1:4173
 * This is an artistic material reconstruction, not a physical measurement.
 * The reference image is unchanged. Material and illumination PNGs are written
 * only after both outputs have been reconstructed and validated.
 */
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT = 'assets/black-hole-ink-reference.png';
const OUTPUT = 'assets/black-hole-ink-material.png';
const LIGHT_OUTPUT = 'assets/black-hole-ink-light.png';
const SHADER = 'js/black-hole.js';
const INNER = 1.85;
const OUTER = 12;
const CONFIG = Object.freeze({ width: 1536, height: 1024, atlasWidth: 2048, atlasHeight: 512, inner: INNER, outer: OUTER, time: 12,
  lightSigmaPhi: 32, lightSigmaRadial: 3, lightRatioFloor: 0.02 });
const sha256 = value => createHash('sha256').update(value).digest('hex');

function options(args) {
  const result = { port: 9243, site: 'http://127.0.0.1:4173', help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (arg !== '--port' && arg !== '--site') throw new Error(`Unknown option: ${arg}. Use --help.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('--port must be an integer from 1 to 65535.');
      result.port = Number(value);
    } else result.site = value;
  }
  const site = new URL(result.site);
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password) throw new Error('--site must be an HTTP(S) URL without credentials.');
  if (site.search || site.hash) throw new Error('--site must not contain a query string or fragment.');
  if (!site.pathname.endsWith('/')) site.pathname += '/';
  result.site = site.href;
  return result;
}

// Keep source positions while masking comments, so braces inside prose cannot
// accidentally truncate a function. This deliberately supports literal GLSL
// template strings only; a renderer refactor must fail clearly, not mis-bake.
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, match => match.replace(/[^\r\n]/g, ' '));
}

function oneMatch(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`Renderer source contract changed: expected one ${label}, found ${matches.length}. Update the baker before writing an atlas.`);
  return matches[0];
}

function literal(source, name) {
  const declaration = oneMatch(source, new RegExp(`\\bconst\\s+${name}\\s*=\\s*\u0060`), `${name} template`);
  const start = declaration.index + declaration[0].length;
  for (let index = start; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '$' && source[index + 1] === '{') throw new Error(`${name} contains interpolation; update the baker's GLSL extraction.`);
    if (source[index] === '`') return source.slice(start, index);
  }
  throw new Error(`Unterminated ${name} template.`);
}

function block(source, pattern, label) {
  const masked = codeOnly(source);
  const match = oneMatch(masked, pattern, label);
  const open = masked.indexOf('{', match.index);
  let depth = 1;
  for (let index = open + 1; index < masked.length; index++) {
    if (masked[index] === '{') depth++;
    if (masked[index] === '}' && --depth === 0) return { open, close: index, body: source.slice(open + 1, index) };
  }
  throw new Error(`Unterminated ${label} block.`);
}

function bakeShader(source) {
  const vertex = literal(source, 'vertexSource');
  let fragment = literal(source, 'sceneSource');
  const range = oneMatch(codeOnly(fragment), /diskRadius\s*>\s*mix\(\s*[\d.]+\s*,\s*([\d.]+)\s*,\s*u_ink\s*\)\s*&&\s*diskRadius\s*<\s*(?:mix\(\s*[\d.]+\s*,\s*([\d.]+)\s*,\s*u_ink\s*\)|([\d.]+))/g, 'disk radius range');
  const sourceOuter = Number(range[2] ?? range[3]);
  if (Number(range[1]) !== INNER || sourceOuter !== OUTER) throw new Error(`Renderer disk range ${range[1]}..${sourceOuter} differs from atlas range ${INNER}..${OUTER}. Update both together.`);

  const hitStruct = block(fragment, /\bstruct\s+RayHit\s*\{/g, 'RayHit struct');
  oneMatch(codeOnly(hitStruct.body), /\bfloat\s+order\s*;/g, 'RayHit order field');
  const trace = block(fragment, /\bRayHit\s+traceLayers\s*\([^)]*\)\s*\{/g, 'traceLayers function');
  if (!/hit\.order\s*=/.test(codeOnly(trace.body))) throw new Error('traceLayers must record hit.order for incoming/outgoing/secondary material separation.');
  const firstLayer = block(fragment, /\bRayHit\s+traceRay\s*\([^)]*\)\s*\{/g, 'traceRay wrapper');
  if (!/^\s*return\s+traceLayers\(\s*origin\s*,\s*direction\s*,\s*0(?:\.0)?\s*\)\s*;\s*$/.test(codeOnly(firstLayer.body))) throw new Error('traceRay must select traceLayers(origin, direction, 0.0); update the baker if the first-hit geometry changes.');

  const main = block(fragment, /\bvoid\s+main\s*\(\s*\)\s*\{/g, 'scene main function');
  const ray = oneMatch(codeOnly(main.body), /\bRayHit\s+hit\s*=\s*traceRay\(\s*origin\s*,\s*direction\s*\)\s*;/g, 'main camera ray');
  // Reuse the renderer's camera code verbatim. All post-hit shading, texture
  // sampling, derivatives and screen compositing are replaced by data output.
  const camera = main.body.slice(0, ray.index + ray[0].length);
  const output = `
      if (hit.material == 1.0) {
        float radius = length(hit.point.xz);
        if (radius < ${INNER.toFixed(2)} || radius > ${OUTER.toFixed(1)}) { gl_FragColor = vec4(0.0); return; }
        float radial = floor(clamp((radius - ${INNER.toFixed(2)}) / ${(OUTER - INNER).toFixed(2)}, 0.0, 1.0) * 65534.0) + 1.0;
        float phase = floor(fract(atan(hit.point.z, hit.point.x) / (2.0 * PI) + 0.5) * 16384.0);
        gl_FragColor = vec4(floor(radial / 256.0), mod(radial, 256.0),
          floor(phase / 256.0) + min(hit.order, 3.0) * 64.0, mod(phase, 256.0)) / 255.0;
      } else gl_FragColor = vec4(0.0);
    `;
  fragment = fragment.slice(0, main.open + 1) + camera + output + fragment.slice(main.close);
  return { vertex, fragment, camera };
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.method === 'Runtime.consoleAPICalled') {
        const value = message.params?.args?.[0]?.value;
        if (typeof value === 'string' && value.startsWith('Ink bake:')) console.warn(value);
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending(new Error('Chromium disconnected during the material bake.')));
    socket.addEventListener('error', () => this.rejectPending(new Error('Chromium CDP connection failed.')));
  }

  static async connect(port) {
    if (typeof WebSocket !== 'function') throw new Error('This script requires Node 22+ with the built-in WebSocket API.');
    let endpoint;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      endpoint = (await response.json()).webSocketDebuggerUrl;
      if (!endpoint) throw new Error('The endpoint did not return a browser WebSocket URL.');
    } catch (error) { throw new Error(`Cannot connect to Chromium on port ${port}. Start it separately with remote debugging enabled. ${error.message}`); }
    const socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Opening the Chromium WebSocket timed out.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Opening the Chromium WebSocket failed.')); }, { once: true });
    });
    return new CDP(socket);
  }

  rejectPending(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chromium CDP connection is closed.'));
    return new Promise((resolveResponse, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after 60 seconds.`)); }, 60000);
      this.pending.set(id, { resolve: resolveResponse, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async evaluate(expression, sessionId) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(`Browser bake failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
    return response.result.value;
  }

  close() { this.socket.close(); }
}

// Runs only in a fresh, private CDP tab. It does not touch the website DOM or
// renderer instance; the reference bytes and shaders come from this checkout.
async function browserBake({ vertex, fragment, imageURL, config }) {
  const { width: width, height: height, atlasWidth, atlasHeight } = config;
  console.info('Ink bake: decoding the local reference bytes.');
  const image = new Image();
  image.src = imageURL;
  await image.decode();
  if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error(`Reference must be ${width}×${height}; found ${image.naturalWidth}×${image.naturalHeight}. Recalibrate the camera before changing the source dimensions.`);
  const input = document.createElement('canvas');
  input.width = width; input.height = height;
  const context = input.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Cannot create the reference-image 2D context.');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL is unavailable in the connected browser.');
  try {
    console.info('Ink bake: compiling the G-buffer shader.');
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < Math.max(width, height)) throw new Error('GPU texture limit is too small for the reference image.');
    const derivatives = Boolean(gl.getExtension('OES_standard_derivatives'));
    const lod = Boolean(gl.getExtension('EXT_shader_texture_lod'));
    const prefix = (derivatives ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES\n' : '')
      + (lod ? '#extension GL_EXT_shader_texture_lod : enable\n#define HAS_TEXTURE_LOD\n' : '');
    function shader(type, source) {
      const object = gl.createShader(type);
      gl.shaderSource(object, source); gl.compileShader(object);
      if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) throw new Error(`G-buffer shader compilation failed: ${gl.getShaderInfoLog(object)}`);
      return object;
    }
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, prefix + fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`G-buffer shader linking failed: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    for (let index = 0; index < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); index++) {
      const uniform = gl.getActiveUniform(program, index);
      if (uniform.type === gl.SAMPLER_2D || uniform.type === gl.SAMPLER_CUBE) throw new Error(`G-buffer unexpectedly depends on texture ${uniform.name}. Update the baker for the new geometry dependency.`);
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    if (position < 0) throw new Error('Vertex shader no longer exposes a_position.');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniform = name => gl.getUniformLocation(program, name);
    gl.uniform2f(uniform('u_resolution'), width, height);
    gl.uniform4f(uniform('u_crop'), 0, 0, 1, 1);
    gl.uniform2f(uniform('u_pointer'), 0, 0);
    gl.uniform1f(uniform('u_time'), config.time);
    gl.uniform1f(uniform('u_ink'), 1);
    // RGBA8 data target: alpha is a packed phase byte, not transparency.
    const target = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('G-buffer framebuffer allocation failed.');
    gl.disable(gl.DITHER); gl.disable(gl.BLEND);
    console.info('Ink bake: rendering and reading the G-buffer.');
    gl.viewport(0, 0, width, height); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const maps = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, maps);
    const error = gl.getError();
    if (error !== gl.NO_ERROR || gl.isContextLost()) throw new Error(`G-buffer rendering/readback failed (WebGL ${error}).`);
    console.info('Ink bake: scattering incoming, outgoing and secondary samples independently.');

    // RayHit.order includes the incoming/outgoing distinction around periapsis.
    // Keep each authored image's brushwork in its own raw-luminance channel.
    const branches = ['incoming', 'outgoing', 'secondary'].map(name => ({
      name, accum: new Float64Array(atlasWidth * atlasHeight), weights: new Float64Array(atlasWidth * atlasHeight),
      raw: new Float32Array(atlasWidth * atlasHeight), samples: 0, covered: 0, knownRows: [], emptyRows: [], borrowedOtherRows: 0, borrowedNeighborRows: 0,
      longGaps: Array.from({ length: atlasHeight }, () => []), synthetic: new Uint8Array(atlasWidth * atlasHeight), mirroredTexels: 0,
    }));
    let samples = 0, rejectedDark = 0;
    const orderHistogram = [0, 0, 0, 0];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const radialCode = maps[offset] * 256 + maps[offset + 1];
      if (!radialCode) continue;
      const radial = (radialCode - 1) / 65534;
      const phase = ((maps[offset + 2] % 64) * 256 + maps[offset + 3]) / 16384;
      const order = Math.floor(maps[offset + 2] / 64);
      const sourceOffset = ((height - 1 - y) * width + x) * 4;
      // Display-referred brush contrast, deliberately matching the original
      // artistic bake; these weights are not physical radiometric luminance.
      const luminance = (pixels[sourceOffset] * 0.2126 + pixels[sourceOffset + 1] * 0.7152 + pixels[sourceOffset + 2] * 0.0722) / 255;
      // Preserve dark samples: in the reference they also describe dry-brush
      // breaks. Geometric material==1 masking already excludes the black core.
      const branch = branches[Math.min(order, 2)];
      const tx = phase * atlasWidth, ty = radial * (atlasHeight - 1);
      const ix = Math.floor(tx), iy = Math.floor(ty), fx = tx - ix, fy = ty - iy;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const row = Math.min(atlasHeight - 1, iy + dy), column = (ix + dx) % atlasWidth;
        const index = row * atlasWidth + column;
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        branch.accum[index] += luminance * weight; branch.weights[index] += weight;
      }
      samples++;
      branch.samples++; orderHistogram[order]++;
    }
    if (!samples) throw new Error('No usable disk samples. Check reference alignment, shader geometry and radius bounds.');
    console.info('Ink bake: filling periodic gaps and constructing the RGB channels.');
    for (const branch of branches) {
      const { raw, weights, accum } = branch;
      for (let y = 0; y < atlasHeight; y++) {
        const known = [];
        for (let x = 0; x < atlasWidth; x++) {
          const index = y * atlasWidth + x;
          if (weights[index] > 0.0001) { raw[index] = accum[index] / weights[index]; known.push(x); branch.covered++; }
        }
        if (!known.length) { branch.emptyRows.push(y); continue; }
        branch.knownRows.push(y);
        for (let index = 0; index < known.length; index++) {
          const left = known[index], right = index + 1 < known.length ? known[index + 1] : known[0] + atlasWidth;
          const a = raw[y * atlasWidth + left], b = raw[y * atlasWidth + right % atlasWidth];
          for (let x = left + 1; x < right; x++) raw[y * atlasWidth + x % atlasWidth] = a + (b - a) * (x - left) / (right - left);
          if (right - left > atlasWidth * 0.08) branch.longGaps[y].push({ left, right });
        }
      }
      // Linear interpolation is appropriate for tiny sampling holes. Across
      // an unseen half-orbit it instead makes featureless painted bands. Use
      // the two adjacent supported texture runs as reflected continuations.
      const wrap = x => (x % atlasWidth + atlasWidth) % atlasWidth;
      const read = (y, x) => {
        const left = Math.floor(x), fraction = x - left;
        return raw[y * atlasWidth + wrap(left)] * (1 - fraction) + raw[y * atlasWidth + wrap(left + 1)] * fraction;
      };
      const reflect = (distance, span) => span > 0 ? span - Math.abs(distance % (span * 2) - span) : 0;
      const smoothstep = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
      for (let y = 0; y < atlasHeight; y++) {
        const gaps = branch.longGaps[y];
        for (let index = 0; index < gaps.length; index++) {
          const { left, right } = gaps[index];
          let previousRight = gaps[(index + gaps.length - 1) % gaps.length].right;
          let nextLeft = gaps[(index + 1) % gaps.length].left;
          while (previousRight > left) previousRight -= atlasWidth;
          while (nextLeft < right) nextLeft += atlasWidth;
          const leftSpan = left - previousRight, rightSpan = nextLeft - right;
          for (let x = left + 1; x < right; x++) {
            const a = read(y, left - reflect(x - left, leftSpan));
            const b = read(y, right + reflect(right - x, rightSpan));
            const blend = smoothstep(((x - left) / (right - left) - 0.35) / 0.30);
            const pixel = y * atlasWidth + wrap(x);
            raw[pixel] = a * (1 - blend) + b * blend;
            // Blend the two synthesized fields in the middle, while keeping
            // the sampled boundary texels and their immediate neighbours intact.
            branch.synthetic[pixel] = Math.round(smoothstep(Math.min(x - left, right - x) / 8) * 255);
            branch.mirroredTexels++;
          }
        }
      }
      // Keep row-to-row changes in the extrapolated field continuous. Only
      // synthetic samples participate; original brush texels are never blurred.
      const reflected = raw.slice();
      const rowWeights = [1, 2, 3, 2, 1];
      for (let y = 0; y < atlasHeight; y++) for (let x = 0; x < atlasWidth; x++) {
        const pixel = y * atlasWidth + x;
        if (!branch.synthetic[pixel]) continue;
        let sum = 0, weight = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const row = y + dy;
          if (row < 0 || row >= atlasHeight) continue;
          const adjacent = row * atlasWidth + x;
          if (!branch.synthetic[adjacent]) continue;
          const w = rowWeights[dy + 2];
          sum += reflected[adjacent] * w; weight += w;
        }
        const blend = branch.synthetic[pixel] / 255 * 0.5;
        raw[pixel] = reflected[pixel] * (1 - blend) + sum / weight * blend;
      }
    }
    if (!branches.some(branch => branch.knownRows.length)) throw new Error('All atlas rows are empty after sampling.');
    for (let index = 0; index < branches.length; index++) {
      const branch = branches[index];
      const others = branches.map((candidate, candidateIndex) => ({ candidate, distance: Math.abs(candidateIndex - index) }))
        .filter(entry => entry.candidate !== branch).sort((a, b) => a.distance - b.distance).map(entry => entry.candidate);
      for (const y of branch.emptyRows) {
        // Cross-branch borrowing is allowed only for wholly unsupported rows;
        // existing samples and their angular interpolation are never blended.
        let donor, row;
        const sameRow = others.find(candidate => candidate.knownRows.includes(y));
        if (sameRow) { donor = sameRow; row = y; branch.borrowedOtherRows++; }
        else {
          donor = branch.knownRows.length ? branch : others.find(candidate => candidate.knownRows.length);
          row = donor.knownRows[0];
          for (const candidate of donor.knownRows) if (Math.abs(candidate - y) < Math.abs(row - y)) row = candidate;
          branch.borrowedNeighborRows++;
        }
        branch.raw.set(donor.raw.subarray(row * atlasWidth, (row + 1) * atlasWidth), y * atlasWidth);
      }
    }
    const data = new Uint8Array(atlasWidth * atlasHeight * 4);
    const clamp = value => Math.max(0, Math.min(1, value));
    for (let index = 0; index < branches[0].raw.length; index++) {
      data[index * 4] = Math.round(clamp(branches[0].raw[index]) * 255);
      data[index * 4 + 1] = Math.round(clamp(branches[1].raw[index]) * 255);
      data[index * 4 + 2] = Math.round(clamp(branches[2].raw[index]) * 255);
      data[index * 4 + 3] = 255;
    }
    // Separate the broad light field without touching the reconstructed brush
    // material. Three box passes approximate a Gaussian in each atlas axis;
    // azimuth wraps at the seam, while the inner/outer radii clamp to the edge.
    function gaussianBoxes(sigma) {
      const ideal = Math.sqrt(4 * sigma * sigma + 1);
      let lower = Math.floor(ideal);
      if (lower % 2 === 0) lower--;
      const lowerCount = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
      return Array.from({ length: 3 }, (_, index) => index < lowerCount ? lower : lower + 2);
    }
    function boxPass(source, destination, size, angular) {
      const radius = (size - 1) / 2;
      if (angular) {
        for (let y = 0; y < atlasHeight; y++) {
          const row = y * atlasWidth;
          let sum = 0;
          for (let x = -radius; x <= radius; x++) sum += source[row + (x + atlasWidth) % atlasWidth];
          for (let x = 0; x < atlasWidth; x++) {
            destination[row + x] = sum / size;
            sum += source[row + (x + radius + 1) % atlasWidth] - source[row + (x - radius + atlasWidth) % atlasWidth];
          }
        }
      } else {
        const edgeRow = y => Math.max(0, Math.min(atlasHeight - 1, y)) * atlasWidth;
        for (let x = 0; x < atlasWidth; x++) {
          let sum = 0;
          for (let y = -radius; y <= radius; y++) sum += source[edgeRow(y) + x];
          for (let y = 0; y < atlasHeight; y++) {
            destination[y * atlasWidth + x] = sum / size;
            sum += source[edgeRow(y + radius + 1) + x] - source[edgeRow(y - radius) + x];
          }
        }
      }
    }
    const angularBoxes = gaussianBoxes(config.lightSigmaPhi);
    const radialBoxes = gaussianBoxes(config.lightSigmaRadial);
    const lightData = new Uint8Array(data.length);
    const lightBranches = [];
    console.info('Ink bake: separating stationary illumination from independent material branches.');
    for (let channel = 0; channel < branches.length; channel++) {
      let light = branches[channel].raw.slice();
      let scratch = new Float32Array(light.length);
      for (const angular of [true, false]) for (const size of angular ? angularBoxes : radialBoxes) {
        boxPass(light, scratch, size, angular);
        [light, scratch] = [scratch, light];
      }
      let min = 1, max = 0, rawOverLightPeak = 0, sameRadiusGainPeak = 1;
      for (let y = 0; y < atlasHeight; y++) {
        let rowMin = 1, rowMax = 0;
        for (let x = 0; x < atlasWidth; x++) {
          const index = y * atlasWidth + x;
          const byte = Math.round(clamp(light[index]) * 255);
          lightData[index * 4 + channel] = byte;
          lightData[index * 4 + 3] = 255;
          const value = byte / 255;
          const denominator = Math.max(value, config.lightRatioFloor);
          min = Math.min(min, value); max = Math.max(max, value);
          rowMin = Math.min(rowMin, denominator); rowMax = Math.max(rowMax, denominator);
          rawOverLightPeak = Math.max(rawOverLightPeak, data[index * 4 + channel] / 255 / denominator);
        }
        sameRadiusGainPeak = Math.max(sameRadiusGainPeak, rowMax / rowMin);
      }
      lightBranches.push({ name: branches[channel].name, min, max, rawOverLightPeak, sameRadiusGainPeak });
    }
    // Alpha stays opaque; these three independent data channels survive a
    // normal PNG/canvas path without premultiplication losses.
    const output = document.createElement('canvas'); output.width = atlasWidth; output.height = atlasHeight;
    const out = output.getContext('2d');
    if (!out) throw new Error('Cannot create the material-output 2D context.');
    const imageData = out.createImageData(atlasWidth, atlasHeight);
    imageData.data.set(data); out.putImageData(imageData, 0, 0);
    console.info('Ink bake: encoding the completed opaque material and illumination PNGs.');
    const dataURL = output.toDataURL('image/png');
    imageData.data.set(lightData); out.putImageData(imageData, 0, 0);
    return {
      dataURL,
      lightDataURL: output.toDataURL('image/png'),
      illumination: { method: 'Separable three-box Gaussian approximation; angular wrap and radial edge clamp.', sigmaPhiPixels: config.lightSigmaPhi, sigmaRadialPixels: config.lightSigmaRadial, angularBoxWidths: angularBoxes, radialBoxWidths: radialBoxes, ratioFloor: config.lightRatioFloor, statisticsDomain: 'Quantized PNG texels; rawOverLightPeak is raw/max(light,floor), sameRadiusGainPeak is the greatest max(light,floor)/min(light,floor) along one radial row.', branches: lightBranches },
      statistics: { samples, rejectedDark, orderHistogram, order3IncludesHigherOrders: true, longGapThresholdFraction: 0.08, branches: branches.map(branch => ({ name: branch.name, samples: branch.samples, coveredTexels: branch.covered, coverageBeforeFill: branch.covered / branch.raw.length, emptyRows: branch.emptyRows.length, borrowedOtherRows: branch.borrowedOtherRows, borrowedNeighborRows: branch.borrowedNeighborRows, longGaps: branch.longGaps.reduce((sum, row) => sum + row.length, 0), mirroredTexels: branch.mirroredTexels })) },
      extensions: { derivatives, textureLod: lod },
    };
  } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

async function main() {
  const settings = options(process.argv.slice(2));
  if (settings.help) {
    console.log('Usage: node scripts/bake-ink-material.mjs [--port 9243] [--site http://127.0.0.1:4173]\nRequires Node 22+ and separately started Chromium with remote debugging.\nReads assets/black-hole-ink-reference.png and current js/black-hole.js.\nWrites assets/black-hole-ink-material.png and assets/black-hole-ink-light.png after validating both; preserves an identical material file. Prints provenance/statistics as JSON.\nCreates and closes its own browser tab. No browser is launched.');
    return;
  }
  const [source, reference, previousRaw] = await Promise.all([readFile(resolve(ROOT, SHADER), 'utf8'), readFile(resolve(ROOT, INPUT)), readFile(resolve(ROOT, OUTPUT)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })]);
  const { vertex, fragment, camera } = bakeShader(source);
  const cdp = await CDP.connect(settings.port);
  let targetId;
  let result;
  let stage = 'create isolated browser tab';
  try {
    console.warn('Ink bake: opening an isolated reference-image tab.');
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    // A static image document provides the site's origin without starting a
    // second hero renderer or waiting for unrelated website fonts/scripts.
    const referencePage = new URL(INPUT, settings.site).href;
    stage = 'load reference-image document';
    const navigation = await cdp.send('Page.navigate', { url: referencePage }, sessionId);
    if (navigation.errorText) throw new Error(`Cannot load --site: ${navigation.errorText}`);
    const deadline = Date.now() + 15000;
    let loaded = false;
    while (Date.now() < deadline) {
      loaded = await cdp.evaluate(`document.readyState === 'complete' && location.origin === ${JSON.stringify(new URL(settings.site).origin)}`, sessionId);
      if (loaded) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (!loaded) throw new Error(`The site did not finish loading at ${settings.site} within 15 seconds.`);
    const payload = { vertex, fragment, imageURL: `data:image/png;base64,${reference.toString('base64')}`, config: CONFIG };
    stage = 'render G-buffer and reconstruct material';
    console.warn('Ink bake: tracing source pixels and reconstructing three material branches.');
    result = await cdp.evaluate(`(${browserBake.toString()})(${JSON.stringify(payload)})`, sessionId);
    console.warn('Ink bake: material returned; closing the isolated tab.');
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`);
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(error => console.warn(`Could not close the baker tab: ${error.message}`));
    cdp.close();
  }
  function decodePNG(dataURL, label) {
    if (!dataURL?.startsWith('data:image/png;base64,')) throw new Error(`Browser did not return an ${label} PNG. Existing assets were preserved.`);
    const png = Buffer.from(dataURL.slice('data:image/png;base64,'.length), 'base64');
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== CONFIG.atlasWidth || png.readUInt32BE(20) !== CONFIG.atlasHeight) throw new Error(`${label} PNG has an invalid signature or size. Existing assets were preserved.`);
    return png;
  }
  const png = decodePNG(result?.dataURL, 'material');
  const lightPNG = decodePNG(result?.lightDataURL, 'illumination');
  const rawUnchanged = previousRaw !== null && previousRaw.equals(png);
  // Validate both first, and replace each file atomically. Leave identical raw
  // bytes (including their modification time) untouched during light rebakes.
  for (const [path, bytes] of [[LIGHT_OUTPUT, lightPNG], ...(rawUnchanged ? [] : [[OUTPUT, png]])]) {
    const outputPath = resolve(ROOT, path);
    const temporary = `${outputPath}.tmp-${process.pid}`;
    try { await writeFile(temporary, bytes); await rename(temporary, outputPath); }
    finally { await rm(temporary, { force: true }); }
  }
  console.log(JSON.stringify({
    formatVersion: 5,
    method: 'Separate incoming/outgoing/secondary artist-reference luminance reprojection; short gaps interpolate, long gaps mirror nearby brushwork with a central crossfade. Not a physical measurement.',
    input: { path: INPUT, sha256: sha256(reference), width: CONFIG.width, height: CONFIG.height },
    renderer: { path: SHADER, sha256: sha256(source), cameraSha256: sha256(camera), camera: 'Current scene main() through its first traceRay; unchanged.', pointer: [0, 0], time: CONFIG.time, ink: 1 },
    output: { path: OUTPUT, sha256: sha256(png), bytes: png.length, width: CONFIG.atlasWidth, height: CONFIG.atlasHeight, innerRadius: INNER, outerRadius: OUTER, channels: { R: 'order 0 incoming/front-disk raw luminance', G: 'order 1 outgoing/rear-arc raw luminance', B: 'order >=2 secondary raw luminance', A: '255' }, colorSpace: 'Display-referred byte-space contrast, not scene-linear radiance.', orientation: 'First PNG row is inner radius; upload with UNPACK_FLIP_Y_WEBGL=false.', wrapping: 'REPEAT S; CLAMP_TO_EDGE T' },
    rawComparison: { unchanged: rawUnchanged, previousSha256: previousRaw === null ? null : sha256(previousRaw) },
    illumination: { path: LIGHT_OUTPUT, sha256: sha256(lightPNG), bytes: lightPNG.length, width: CONFIG.atlasWidth, height: CONFIG.atlasHeight, channels: 'Same RGB branch order, orientation and byte-space values as the material; A=255.', ...result.illumination },
    sampling: { material: 1, excludedSprayMaterial: 2, incomingOrder: 0, outgoingOrder: 1, secondaryOrder: '>=2', darkSamples: 'preserved', branchMixing: 'None; wholly empty rows may borrow from another branch.', ...result.statistics },
    browser: { site: settings.site, debuggingPort: settings.port, ...result.extensions },
  }, null, 2));
}

main().catch(error => { console.error(`Ink material bake failed: ${error.message}`); process.exitCode = 1; });
