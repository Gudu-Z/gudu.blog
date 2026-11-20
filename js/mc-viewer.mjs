import { Renderer, AssetProvider, BlockModelResolver, Box3, parseLitematica,
  extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from './vendor/mc-engine.mjs';
import { readPalette, replayBounds, renderData } from './mc-render-data.mjs';
import { mountAxisGizmo } from './mc-axes.mjs';
import { createMarkerLayer, markerCells } from './mc-markers.mjs';

import { createReplayHitboxes, replayEntityBounds } from './mc-entity-hitboxes.mjs';
import { createPlayerLayer, playerVisibility } from './mc-player-layer.mjs';
import { createReplayEntityLayer } from './mc-entity-layer.mjs';

const svgNS = 'http://www.w3.org/2000/svg';
const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

export function lockOnFrame(elapsed) {
  const close = Math.max(0, Math.min(1, elapsed / 220));
  const fade = Math.max(0, Math.min(1, (elapsed - 670) / 250));
  return { offset: 4 + 26 * (1 - close) ** 3, opacity: 1 - fade };
}

export function lockOnPath(box, offset) {
  const arm = Math.min(10, .35 * Math.min(box.right - box.left, box.bottom - box.top));
  const left = box.left - offset, right = box.right + offset;
  const top = box.top - offset, bottom = box.bottom + offset;
  return `M${left + arm},${top}H${left}V${top + arm}`
    + `M${right - arm},${top}H${right}V${top + arm}`
    + `M${right - arm},${bottom}H${right}V${bottom - arm}`
    + `M${left + arm},${bottom}H${left}V${bottom - arm}`;
}

// Directions as Minecraft numbers them: down, up, north, south, west, east.
const directions = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

// Which of a box's edges the camera sees, split the way a technical drawing
// splits them. A face is in view when the camera stands outside it (for an
// orthographic camera, when it looks against the face), and an edge shows
// when either of its two faces does; the rest are hidden behind the box.
export function boxEdgeSides(min, max, eye, look) {
  const faces = [0, 1, 2].map(n => eye ? [eye[n] < min[n], eye[n] > max[n]] : [look[n] > 0, look[n] < 0]);
  const visible = [], hidden = [];
  for (const [a, b] of edges) {
    const along = Math.log2(a ^ b);
    const shown = [0, 1, 2].some(n => n !== along && faces[n][(a >> n) & 1]);
    (shown ? visible : hidden).push([a, b]);
  }
  return { visible, hidden };
}

// Where the line from a point toward a box's centre enters the box, so a
// cause's arrow ends on the face it comes in through.
export function entryPoint(from, min, max) {
  const centre = [0, 1, 2].map(n => (min[n] + max[n]) / 2);
  let t = 0;
  for (let n = 0; n < 3; n++) {
    const d = centre[n] - from[n];
    if (Math.abs(d) > 1e-9) t = Math.max(t, ((d > 0 ? min[n] : max[n]) - from[n]) / d);
  }
  t = Math.min(1, t);
  return [0, 1, 2].map(n => from[n] + (centre[n] - from[n]) * t);
}

// The marks over the 3D view, from what js/mc-article.mjs says to mark.
// - The current event's target, drawn like a technical drawing in its
//   kind's colour: the edges in view solid, the hidden ones dotted. It is
//   dashed while the event is only queued (a scheduled tick or a block event
//   being added). A moving piston's block carries chevrons the way it moves,
//   a game event rings out from its spot, and a failed write is crossed out.
// - Its source, the nearest cause somewhere else, faint in its own kind's
//   colour and joined to the target. A neighbour update comes in as an arrow
//   through the face the two blocks share, a shape update lights that face,
//   and any other cause draws a thin arrow from box to box, dashed when the
//   two are not neighbours.
// - A lock-on: four brackets closing in on the target when it changes.
// Colours come from the stylesheet by data-kind (css/mc-article.css). Each
// draw reports the target's rectangle in the stage (or null when none is in
// view), so the event card (js/mc-callout.mjs) can stand beside it.
function createOutline(container, renderer, onBox, getBounds) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('mc-focus');
  svg.setAttribute('aria-hidden', 'true');
  function node(tag, className, parent) {
    const element = document.createElementNS(svgNS, tag);
    element.setAttribute('class', className);
    parent.append(element);
    return element;
  }
  const sourceGroup = node('g', 'mc-mark mc-mark-source', svg);
  const sourceEdges = node('path', 'mc-mark-edges', sourceGroup);
  const linkGroup = node('g', 'mc-mark mc-mark-link', svg);
  const plate = node('path', 'mc-mark-plate', linkGroup);
  const linkHalo = node('path', 'mc-mark-halo', linkGroup);
  const link = node('path', 'mc-mark-line', linkGroup);
  const linkHead = node('path', 'mc-mark-line mc-mark-head', linkGroup);
  const currentGroup = node('g', 'mc-mark mc-mark-current', svg);
  const hiddenEdges = node('path', 'mc-mark-hidden', currentGroup);
  const currentHalo = node('path', 'mc-mark-halo', currentGroup);
  const currentEdges = node('path', 'mc-mark-edges', currentGroup);
  const glyphHalo = node('path', 'mc-mark-halo', currentGroup);
  const glyph = node('path', 'mc-mark-glyph', currentGroup);
  const brackets = node('g', 'mc-mark mc-mark-lock', svg);
  brackets.setAttribute('display', 'none');
  const lockPaths = [node('path', 'mc-mark-halo', brackets), node('path', 'mc-mark-edges', brackets)];
  container.append(svg);
  const vertex = renderer.camera.position.clone();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let targetKey = null, targetBox = null, awaitingProjection = false, playing = false;
  let delay = 0, frame = 0, started = null;

  function cancelLock() {
    if (delay) clearTimeout(delay);
    if (frame) cancelAnimationFrame(frame);
    if (started !== null) brackets.setAttribute('display', 'none');
    delay = frame = 0;
    started = null;
  }
  function paintLock(now) {
    const { offset, opacity } = lockOnFrame(now - started);
    if (opacity === 0) {
      cancelLock();
      return;
    }
    const path = lockOnPath(targetBox, offset);
    for (const node of lockPaths) node.setAttribute('d', path);
    brackets.setAttribute('opacity', String(opacity));
  }
  function animate(now) {
    paintLock(now);
    if (started !== null) frame = requestAnimationFrame(animate);
  }
  function scheduleLock() {
    if (playing || motion.matches || !targetBox) return;
    delay = setTimeout(() => {
      delay = 0;
      if (motion.matches) return;
      started = performance.now();
      brackets.removeAttribute('display');
      animate(started);
    }, 120);
  }
  // A build can take time. Drop the old brackets as soon as its replacement
  // target is known, then wait for the new box's first on-screen projection.
  function setTarget(pos, actorId) {
    const next = pos ? 'block:' + pos.join(',') : actorId ? 'actor:' + actorId : null;
    if (next === targetKey) return;
    cancelLock();
    targetKey = next;
    targetBox = null;
    awaitingProjection = next !== null;
  }
  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    cancelLock();
    if (!playing) scheduleLock();
  }
  function onMotionChange() {
    if (motion.matches) cancelLock();
  }
  motion.addEventListener('change', onMotionChange);

  // The whole recording's box on screen, which the event card tries to keep clear of.
  function modelBox() {
    const bounds = getBounds?.();
    if (!bounds) return null;
    const width = container.clientWidth, height = container.clientHeight;
    const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (let i = 0; i < 8; i++) {
      vertex.set(i & 1 ? bounds.maxX + 1 : bounds.minX, i & 2 ? bounds.maxY + 1 : bounds.minY, i & 4 ? bounds.maxZ + 1 : bounds.minZ).project(renderer.camera);
      const x = (vertex.x + 1) * width / 2, y = (1 - vertex.y) * height / 2;
      box.left = Math.min(box.left, x); box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y);
    }
    return box;
  }
  // A world point in stage pixels, or null behind the camera.
  function project([x, y, z]) {
    vertex.set(x, y, z).project(renderer.camera);
    if (vertex.z < -1 || vertex.z > 1) return null;
    return [(vertex.x + 1) * container.clientWidth / 2, (1 - vertex.y) * container.clientHeight / 2];
  }
  const corner = (box, i) => [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
  const centre = box => box.min.map((n, axis) => (n + box.max[axis]) / 2);
  const point = p => Math.round(p[0] * 10) / 10 + ',' + Math.round(p[1] * 10) / 10;
  function edgePath(points, list) {
    return list.filter(([a, b]) => points[a] && points[b]).map(([a, b]) => 'M' + point(points[a]) + 'L' + point(points[b])).join('');
  }
  // The edges in view and the hidden ones, for the camera as it stands.
  function sides(box) {
    const camera = renderer.camera;
    if (!camera.isOrthographicCamera) return boxEdgeSides(box.min, box.max, camera.position.toArray(), null);
    camera.getWorldDirection(vertex);
    return boxEdgeSides(box.min, box.max, null, vertex.toArray());
  }
  // An open arrowhead (or, wider, a chevron) at `to`, pointing away from `from`.
  function head(from, to, size = 6, spread = .5) {
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
    if (length < 3) return '';
    const ux = dx / length, uy = dy / length, c = Math.cos(spread), s = Math.sin(spread);
    const wing = sign => [to[0] - size * (ux * c - sign * uy * s), to[1] - size * (uy * c + sign * ux * s)];
    return 'M' + point(wing(1)) + 'L' + point(to) + 'L' + point(wing(-1));
  }
  const ring = ([x, y], r) => `M${point([x - r, y])}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  // A kind's own sign on the target: chevrons the way a moving piston's
  // block goes, rings spreading from a game event, a cross over a failed write.
  function signOf(box, mark) {
    const middle = centre(box), at = project(middle);
    if (!at || !mark) return '';
    if (mark.kind === 'game') return ring(at, 3) + ring(at, 8) + ring(at, 13);
    if (mark.failed) return `M${point([at[0] - 5, at[1] - 5])}L${point([at[0] + 5, at[1] + 5])}M${point([at[0] + 5, at[1] - 5])}L${point([at[0] - 5, at[1] + 5])}`;
    const step = directions[mark.piston?.direction];
    if (mark.kind !== 'piston' || !step) return '';
    const way = mark.piston.extending === false ? step.map(n => -n) : step;
    const along = t => project(middle.map((n, axis) => n + way[axis] * t));
    const back = along(-.3), front = along(.3), tail = along(-.05);
    return back && front && tail ? head(back, tail, 6, .8) + head(back, front, 6, .8) : '';
  }
  // How the source joins the target. Neighbours share a face: a shape update
  // lights it, any other update comes in through it as an arrow from the
  // source's centre. Farther apart, a dashed arrow runs from box to box.
  function joint(from, to, kind) {
    const a = centre(from), b = centre(to);
    const gap = a.map((n, axis) => b[axis] - n);
    const neighbours = gap.filter(n => Math.abs(n) >= .999).length === 1 && gap.every(n => Math.abs(n) < .001 || Math.abs(Math.abs(n) - 1) < .001);
    if (neighbours && kind === 'shape') {
      const axis = gap.findIndex(n => Math.abs(n) > .5), side = gap[axis] > 0 ? 0 : 1;
      const [u, v] = [0, 1, 2].filter(n => n !== axis);
      const face = [0, 1 << u, (1 << u) | (1 << v), 1 << v].map(bits => project(corner(to, bits | (side << axis))));
      return { plate: face.every(Boolean) ? 'M' + face.map(point).join('L') + 'Z' : '', line: '', head: '', far: false };
    }
    const start = neighbours ? a : entryPoint(b, from.min, from.max), end = entryPoint(a, to.min, to.max);
    const p = project(start), q = project(end);
    if (!p || !q) return { plate: '', line: '', head: '', far: !neighbours };
    return { plate: '', line: 'M' + point(p) + 'L' + point(q), head: head(p, q), far: !neighbours };
  }
  function screenBox(points) {
    const seen = points.filter(Boolean);
    if (!seen.length) return null;
    const box = { left: Math.min(...seen.map(p => p[0])), right: Math.max(...seen.map(p => p[0])),
      top: Math.min(...seen.map(p => p[1])), bottom: Math.max(...seen.map(p => p[1])) };
    if (box.right < 0 || box.bottom < 0 || box.left > container.clientWidth || box.top > container.clientHeight) return null;
    return box;
  }
  // The target is a block (`pos`) or an actor (`actorBounds`). `mark` says
  // how to draw it (null for a bookmark's own focus); `source` is
  // { pos | bounds, kind } or null.
  function draw({ pos, actorBounds, actorId, mark, source }, boxesVisible) {
    renderer.camera.updateMatrixWorld();
    const kind = mark?.kind ?? 'set';
    const boxOf = (at, bounds) => at ? { min: at, max: at.map(n => n + 1) } : bounds ? { min: bounds.min, max: bounds.max } : null;
    const target = boxOf(pos, actorBounds), from = target && boxOf(source?.pos, source?.bounds);
    const points = target ? Array.from({ length: 8 }, (_, i) => project(corner(target, i))) : [];
    currentGroup.dataset.kind = brackets.dataset.kind = kind;
    currentGroup.toggleAttribute('data-pending', Boolean(mark?.pending));
    // An actor's own hitbox is drawn in the scene, and a game event only rings
    // out from its spot; every other block target gets a box.
    const { visible = [], hidden = [] } = pos && kind !== 'game' ? sides(target) : {};
    const solid = edgePath(points, visible);
    currentEdges.setAttribute('d', solid);
    currentHalo.setAttribute('d', solid);
    hiddenEdges.setAttribute('d', edgePath(points, hidden));
    const sign = target ? signOf(target, mark) : '';
    glyph.setAttribute('d', sign);
    glyphHalo.setAttribute('d', sign);
    const joined = from ? joint(from, target, kind) : { plate: '', line: '', head: '', far: false };
    sourceGroup.dataset.kind = source?.kind ?? 'other';
    sourceEdges.setAttribute('d', from ? edgePath(Array.from({ length: 8 }, (_, i) => project(corner(from, i))), sides(from).visible) : '');
    linkGroup.dataset.kind = kind;
    linkGroup.toggleAttribute('data-far', joined.far);
    plate.setAttribute('d', joined.plate);
    link.setAttribute('d', joined.line);
    linkHead.setAttribute('d', joined.head);
    // A dashed far line keeps no halo; its head does, like a near arrow.
    linkHalo.setAttribute('d', (joined.far ? '' : joined.line) + joined.head);
    setTarget(pos, actorId);
    targetBox = screenBox(points);
    if (!targetBox) cancelLock();
    else if (awaitingProjection) scheduleLock();
    else if (started !== null) paintLock(performance.now());
    awaitingProjection = false;
    const box = pos || boxesVisible ? targetBox : null;
    onBox?.(box, box && modelBox());
  }
  function remove() {
    cancelLock();
    targetBox = null;
    motion.removeEventListener('change', onMotionChange);
    svg.remove();
  }
  return { draw, setTarget, setPlaying, remove };
}

async function readSchematic(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('读取投影失败（HTTP ' + response.status + '）。');
  // markerBlocks lists the barrier, light, structure void and moving piston
  // cells the parser otherwise drops or keeps unmarked (js/mc-markers.mjs).
  return parseLitematica(await response.arrayBuffer(), undefined, { signal, renderOnly: true, markerBlocks: true });
}

// Fit the initial figures with the machine. Camera bounds may include players
// well outside the recorded blocks and must not change the blocks' packed keys.
function replayFraming(scene, bounds, palette, onlyActors) {
  let players = scene.players ?? [];
  if (!players.length && !scene.blocks.length) {
    const spawn = scene.events.find(event => event.player?.pos);
    if (spawn) players = [spawn.player];
  }
  const playerBoxes = players.map(({ pos: [x, y, z] }) => [x - .68, y - .04, z - .68, 1.36, 2.08, 1.36]);
  let entities = scene.entities ?? [];
  if (!entities.length && !players.length && !scene.blocks.length) {
    const spawn = scene.events.find(event => event.entity?.pos);
    if (spawn) entities = [spawn.entity];
  }
  const actorBoxes = [...playerBoxes];
  for (const entity of entities) {
    const box = replayEntityBounds(entity);
    if (box) actorBoxes.push([...box.min, ...box.max.map((n, axis) => n - box.min[axis])]);
  }
  return { bounds: framingBounds(bounds, actorBoxes, onlyActors), blocks: scene.blocks, players, actorBoxes, geometryBounds: bounds, palette };
}

function framingBounds(bounds, actorBoxes, onlyActors) {
  const view = { ...bounds };
  if (actorBoxes.length && onlyActors) {
    view.minX = view.minY = view.minZ = Infinity;
    view.maxX = view.maxY = view.maxZ = -Infinity;
  }
  for (const [x, y, z, w, h, d] of actorBoxes) {
    view.minX = Math.min(view.minX, Math.floor(x)); view.maxX = Math.max(view.maxX, Math.floor(x), Math.ceil(x + w) - 1);
    view.minY = Math.min(view.minY, Math.floor(y)); view.maxY = Math.max(view.maxY, Math.floor(y), Math.ceil(y + h) - 1);
    view.minZ = Math.min(view.minZ, Math.floor(z)); view.maxZ = Math.max(view.maxZ, Math.floor(z), Math.ceil(z + d) - 1);
  }
  view.width = view.maxX - view.minX + 1;
  view.height = view.maxY - view.minY + 1;
  view.depth = view.maxZ - view.minZ + 1;
  return view;
}

// Display entities can have a zero-sized physics box and draw their block/item
// far away from Pos. An entity-only scene should frame the pixels it actually draws.
function entityModelFraming(renderer, bounds, fallback) {
  const local = new Box3(), world = new Box3();
  for (const root of renderer.scene.children) {
    if (root !== renderer.entitiesGroup && root.name !== 'replay-entities' && !root.name.startsWith('replay-player:')) continue;
    root.updateWorldMatrix(true, true);
    root.traverseVisible(part => {
      if ((!part.isMesh && !part.isSprite) || !part.geometry) return;
      const shape = 'boundingBox' in part ? part : part.geometry;
      if (!shape.boundingBox) shape.computeBoundingBox();
      if (shape.boundingBox) world.union(local.copy(shape.boundingBox).applyMatrix4(part.matrixWorld));
    });
  }
  if (world.isEmpty()) return fallback;
  const min = world.min.toArray(), size = world.max.toArray().map((n, i) => n - min[i]);
  if (![...min, ...size].every(Number.isFinite)) return fallback;
  const boxes = [[...min, ...size]];
  return { bounds: framingBounds(bounds, boxes, true), blocks: [], players: [], actorBoxes: boxes };
}

// `free` is the share of the view's width left clear of the floating timeline
// (see setInset), which the recording should fill like the whole height.
function frameBlocks(renderer, { blocks, actorBoxes }, free = 1) {
  const { camera, controls } = renderer;
  const point = camera.position.clone();
  function extent() {
    camera.updateMatrixWorld();
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    function project(x, y, z, w, h, d) {
      for (let i = 0; i < 8; i++) {
        point.set(x + ((i & 1) ? w : 0), y + ((i & 2) ? h : 0), z + ((i & 4) ? d : 0)).project(camera);
        if (point.z < -1 || point.z > 1) continue;
        box.minX = Math.min(box.minX, point.x); box.maxX = Math.max(box.maxX, point.x);
        box.minY = Math.min(box.minY, point.y); box.maxY = Math.max(box.maxY, point.y);
      }
    }
    for (const [x, y, z] of blocks) project(x, y, z, 1, 1, 1);
    for (const actor of actorBoxes) project(...actor);
    return Number.isFinite(box.minX) ? box : null;
  }
  let box = extent();
  if (!box) return;
  const depth = point.copy(controls.target).project(camera).z;
  const centre = point.set((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, depth).unproject(camera).sub(controls.target);
  camera.position.add(centre);
  controls.target.add(centre);
  controls.update();
  box = extent();
  if (!box) return;
  const half = Math.max((box.maxX - box.minX) / free, box.maxY - box.minY) / 2;
  camera.zoom = Math.min(3, Math.max(1, 0.7 / half));
  camera.updateProjectionMatrix();
}

// On a wide figure the timeline floats over the right of the view, covering
// `right` pixels. Render the view as the left part of a wider one, so the
// orbit centre, and with it the default framing, sits in the middle of the
// free part. The scale stays the same; only the centre moves.
function setInset(renderer, right) {
  const { camera, container } = renderer;
  const width = container.clientWidth || 1, height = container.clientHeight || 1;
  const full = width + right;
  if (camera.isOrthographicCamera) {
    const half = (camera.top - camera.bottom) / 2;
    camera.left = -half * full / height;
    camera.right = half * full / height;
  } else camera.aspect = full / height;
  if (right > 0) camera.setViewOffset(full, height, right, 0, width, height);
  else if (camera.view?.enabled) camera.clearViewOffset();
  else camera.updateProjectionMatrix();
}

// The default view faces the structure's long side: that side shows the most
// area and the short side runs away from the reader into the view. It looks
// from 25° off the side's normal, moved to the reader's left, so the long
// side's right half runs away into the view, at the engine's own 26°
// elevation. Of the two long sides it takes the one from which the recorded
// players show, else the south side (for a build longer north–south, the
// east side).
const BROADSIDE_TURN = 25 * Math.PI / 180;
const DEFAULT_ELEVATION = Math.atan2(.55, Math.hypot(.8, .8));
const isAir = entry => /(^|:)(cave_|void_)?air$/.test(entry?.name ?? '');

// A structure's horizontal size, [east–west, north–south], from the blocks it
// starts with (air left out), else from its bounds.
function blockFootprint(blocks, palette, bounds) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z, state] of blocks) {
    if (isAir(palette[state])) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minX) ? [maxX - minX + 1, maxZ - minZ + 1] : [bounds.width, bounds.depth];
}

// A schematic's: a large one is kept in paged regions, which give its extent;
// a small one's occupied cells are keyed x + width·(z + depth·y) in its bounds.
function structureFootprint({ blocks, bounds, palette }) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  if (blocks.isPagedBlockStore) {
    for (const region of blocks.regions) {
      minX = Math.min(minX, region.minX); maxX = Math.max(maxX, region.maxX);
      minZ = Math.min(minZ, region.minZ); maxZ = Math.max(maxZ, region.maxZ);
    }
  } else {
    for (const [key, state] of blocks) {
      if (isAir(palette[state])) continue;
      const x = key % bounds.width, z = Math.floor(key / bounds.width) % bounds.depth;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  return Number.isFinite(minX) ? [maxX - minX + 1, maxZ - minZ + 1] : [bounds.width, bounds.depth];
}

// The default view as an azimuth (0 looks from the south, +Z; π/2 from the
// east, +X) and an elevation, for the camera that fitToBounds just placed.
// Subtracting the turn from a side's own azimuth moves the camera to the
// reader's left on every side.
function defaultView(renderer, framing) {
  const [width, depth] = framing.footprint ?? blockFootprint(framing.blocks ?? [], framing.palette ?? [], framing.bounds);
  const sides = (width >= depth ? [0, Math.PI] : [Math.PI / 2, -Math.PI / 2]).map(normal => normal - BROADSIDE_TURN);
  const view = { azimuth: sides[0], elevation: DEFAULT_ELEVATION };
  if (framing.players?.length) {
    const target = renderer.controls.target, distance = renderer.camera.position.distanceTo(target);
    const eyes = sides.map(azimuth => [
      target.x + distance * Math.cos(view.elevation) * Math.sin(azimuth),
      target.y + distance * Math.sin(view.elevation),
      target.z + distance * Math.cos(view.elevation) * Math.cos(azimuth),
    ]);
    const [first, second] = playerVisibility(framing, eyes, distance) ?? [];
    // The far side only when the near one hides the players and it shows them better.
    if (first && first.visible < .85 && second.score > first.score + .001) view.azimuth = sides[1];
  }
  return view;
}

function applyCamera(renderer, bounds, saved, framing, inset = 0) {
  renderer.setProjectionMode(saved?.projection ?? 'perspective');
  renderer.fitToBounds(framing?.bounds ?? bounds);
  const camera = renderer.camera;
  if (saved?.position && saved.target) {
    camera.position.fromArray(saved.position);
    renderer.controls.target.fromArray(saved.target);
  }
  if (camera.isOrthographicCamera && saved?.height) {
    const aspect = renderer.container.clientWidth / Math.max(1, renderer.container.clientHeight);
    camera.top = saved.height / 2;
    camera.bottom = -camera.top;
    camera.right = camera.top * aspect;
    camera.left = -camera.right;
  }
  setInset(renderer, inset);
  camera.zoom = saved?.zoom ?? 1;
  camera.updateProjectionMatrix();
  if (!saved && framing) {
    // Chosen once per framing, so a reset or a resize keeps the same side.
    framing.view ??= defaultView(renderer, framing);
    const target = renderer.controls.target;
    camera.position.setFromSphericalCoords(camera.position.distanceTo(target),
      Math.PI / 2 - framing.view.elevation, framing.view.azimuth).add(target);
    renderer.controls.update();
    // A schematic keeps the engine's whole-bounds fit.
    if (framing.blocks) frameBlocks(renderer, framing, 1 - inset / Math.max(1, renderer.container.clientWidth));
  }
  renderer.controls.update();
  renderer.requestRender();
}

async function staticDetails(renderer, data, assets, signal) {
  const tiles = data.tileEntities ?? [];
  await renderer.renderSigns(extractSigns(tiles, data), assets, { signal });
  const heads = extractPlayerHeads(tiles, data);
  for (const head of heads) {
    const url = typeof head.skinUrl === 'string' ? URL.parse(head.skinUrl, location.href) : null;
    head.skinUrl = url?.origin === location.origin ? url.href : null;
  }
  await renderer.renderPlayerHeads(heads, assets, { signal });
  await renderer.renderBanners(extractBanners(tiles, data), assets, { signal });
  await renderer.renderStatues(extractStatues(data), assets, { signal });
  await renderer.renderDecoratedPots(extractDecoratedPots(tiles, data), assets, { signal });
  await renderer.renderEntities(data.entities ?? [], assets, data, undefined, { signal });
}

export async function createSceneViewer(container, scene, { sceneURL, name = '红石结构', camera: bookmarkCamera,
  focus: initialFocus, theme = 'auto', onStatus, onFocusBox, inset, signal: parentSignal } = {}) {
  const lifecycle = new AbortController(), { signal } = lifecycle;
  parentSignal?.throwIfAborted();
  parentSignal?.addEventListener('abort', destroy, { once: true });
  const assets = new AssetProvider(), resolver = new BlockModelResolver(assets);
  let renderer, axes, markers, outline, resize, visibility, resetButton, bounds, palette, playerLayer, framing, playerRevision;
  let entityLayer, blockData, fitFirstEntity = false;
  let hitboxes, focusActor, mark = null, sourceFocus, sourceActor, sourceKind, entityRevision, boxesVisible = true, hasBoxes = false, boxesListener;
  let completed = false, busy = false, active = true, readyFrame = 0, revision, focus = initialFocus;

  function destroy() {
    if (signal.aborted) return;
    lifecycle.abort();
    cancelAnimationFrame(readyFrame);
    parentSignal?.removeEventListener('abort', destroy);
    resize?.disconnect();
    visibility?.disconnect();
    outline?.remove();
    resetButton?.remove();
    if (renderer) {
      renderer.controls.removeEventListener('change', redraw);
      renderer.controls.removeEventListener('start', keepCamera);
      renderer.setActive(false);
      renderer.renderer.domElement.remove();
    }
    if (!busy) disposeResources();
  }

  function disposeResources() {
    markers?.destroy();
    markers = null;
    entityLayer?.destroy();
    entityLayer = null;
    hitboxes?.destroy();
    hitboxes = null;
    playerLayer?.destroy();
    playerLayer = null;
    renderer?.dispose();
    renderer = null;
    assets.clearCaches();
  }

  function redraw() {
    if (!completed) {
      outline?.draw({}, boxesVisible);
      return;
    }
    const actorBounds = focusActor ? hitboxes?.boundsFor(focusActor) : null;
    const sourceBounds = sourceActor ? hitboxes?.boundsFor(sourceActor) : null;
    const source = sourceFocus || sourceBounds ? { pos: sourceFocus, bounds: sourceBounds, kind: sourceKind } : null;
    outline?.draw({ pos: focus, actorBounds, actorId: focusActor, mark, source }, boxesVisible);
  }
  // Showing the entity hitboxes is a switch in the replay's settings card
  // (js/mc-article.mjs), offered through `entityBoxes` below; F3+B, as in the
  // game, flips it from the keyboard and the card follows.
  function setBoxesVisible(value) {
    boxesVisible = value;
    if (hitboxes) hitboxes.setVisible(boxesVisible);
    else renderer.setEntityHitboxesVisible(boxesVisible);
    redraw();
    boxesListener?.(boxesVisible);
  }
  function mountHitboxToggle() {
    hasBoxes = true;
    const toggle = () => setBoxesVisible(!boxesVisible);
    let f3Down = false;
    container.addEventListener('keydown', event => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target.closest('.mc-axes-label, input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'F3') {
        f3Down = true;
        event.preventDefault();
      } else if (f3Down && event.code === 'KeyB') {
        event.preventDefault();
        if (!event.repeat) toggle();
      }
    }, { signal });
    container.addEventListener('keyup', event => { if (event.key === 'F3') f3Down = false; }, { signal });
    container.addEventListener('focusout', () => { f3Down = false; }, { signal });
    window.addEventListener('blur', () => { f3Down = false; }, { signal });
  }
  // The view is clear in either theme: the article's star sky shows behind
  // the model, as on the stage of css/mc-article.css.
  function setTheme() {
    renderer?.setBackgroundColor('transparent');
    markers?.setTheme();
  }
  // The pixels the host covers on the right of the view (its floating timeline).
  const coveredRight = () => Math.max(0, Math.min((container.clientWidth || 1) / 2, inset?.() ?? 0));
  function setCamera(saved, viewFraming) {
    axes.cancel();
    applyCamera(renderer, bounds, saved, viewFraming, coveredRight());
    // A projection switch can replace the camera without firing a controls change.
    axes.update();
  }
  function keepCamera() { fitFirstEntity = false; }
  function resetView() {
    if (renderer && bounds) setCamera(bookmarkCamera, framing);
  }
  function reportError(error) {
    revision = undefined;
    if (!signal.aborted) onStatus?.({ type: 'error', message: error.message || String(error) });
  }

  function reportAvailability() {
    cancelAnimationFrame(readyFrame);
    if (!active || document.hidden) {
      readyFrame = 0;
      onStatus?.({ type: active ? 'loaded' : 'inactive' });
      return;
    }
    // The renderer queued its own RAF first. Let it draw the new mesh before
    // the host is allowed to start building the next pending playback frame.
    readyFrame = requestAnimationFrame(() => {
      readyFrame = 0;
      if (!signal.aborted) onStatus?.({ type: active ? 'loaded' : 'inactive' });
    });
  }

  async function drawModel(data, camera, actors) {
    busy = true;
    onStatus?.({ type: 'loading' });
    const finish = renderer.beginSceneUpdate();
    try {
      if (data) await renderer.render(data, assets, undefined, undefined, false, { signal });
      signal.throwIfAborted();
      if (actors) await entityLayer.sync(actors, blockData);
      if (scene.schematic) await staticDetails(renderer, data, assets, signal);
      signal.throwIfAborted();
      // A recording can start empty and spawn its first display later. Fit the
      // first visible model once, unless the reader already moved the camera.
      const fitted = fitFirstEntity && !camera ? entityModelFraming(renderer, bounds, framing) : framing;
      const newFraming = fitted !== framing;
      if (newFraming || camera) keepCamera();
      framing = fitted;
      if (!completed || camera || newFraming) setCamera(camera ?? bookmarkCamera, framing);
      completed = true;
    } finally {
      finish();
      busy = false;
      if (signal.aborted) disposeResources();
    }
    redraw();
    reportAvailability();
  }

  try {
    const [, structure] = await Promise.all([
      assets.ready(),
      scene.schematic ? readSchematic(new URL(scene.schematic, sceneURL), signal) : null,
    ]);
    signal.throwIfAborted();
    palette = structure?.palette ?? readPalette(scene.palette);
    bounds = structure?.bounds ?? replayBounds(scene);
    const onlyActors = structure ? !structure.blocks.size : !scene.blocks.length && !scene.events.some(e => e.after !== undefined);
    fitFirstEntity = onlyActors && !bookmarkCamera;
    await Promise.all(palette.map(async entry => { entry.baked = await resolver.resolve(entry.name, entry.properties); }));
    signal.throwIfAborted();

    renderer = new Renderer(container, { orbitOnly: true, alpha: true, pixelRatio: 1.5 });
    // Whatever resizes the view (the engine on a window resize, the observer
    // below), the floating timeline's inset is put back straight after.
    const engineResize = renderer._resize.bind(renderer);
    renderer._resize = () => {
      engineResize();
      setInset(renderer, coveredRight());
    };
    // A schematic's framing only turns the default view to its long side.
    if (structure) framing = { bounds, footprint: structureFootprint(structure) };
    else {
      framing = replayFraming(scene, bounds, palette, onlyActors);
      playerLayer = await createPlayerLayer(scene, renderer, assets, signal);
      if (scene.entities?.length || scene.events.some(e => e.entity)) entityLayer = createReplayEntityLayer(renderer, assets, signal);
      signal.throwIfAborted();
    }
    markers = createMarkerLayer(renderer, assets, container);
    if (structure?.entities?.length) {
      renderer.setEntityHitboxesVisible(true);
      mountHitboxToggle();
    } else if (!structure && (scene.players?.length || scene.entities?.length || scene.events.some(e => e.player || e.entity))) {
      hitboxes = createReplayHitboxes(renderer);
      mountHitboxToggle();
    }
    const canvas = renderer.renderer.domElement;
    canvas.classList.add('mc-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', name + '，可拖动旋转，滚轮缩放');
    renderer.onRenderError = reportError;
    renderer.setWireframesVisible(false);
    renderer.setDimensionsVisible(false);
    setTheme(theme);
    outline = createOutline(container, renderer, onFocusBox, () => bounds);
    axes = mountAxisGizmo(container, renderer, { signal });
    renderer.controls.addEventListener('change', redraw);
    renderer.controls.addEventListener('start', keepCamera);
    resize = new ResizeObserver(() => {
      if (!signal.aborted && container.clientWidth && container.clientHeight) { renderer._resize(); redraw(); }
    });
    resize.observe(container);
    if ('IntersectionObserver' in window) {
      visibility = new IntersectionObserver(([entry]) => {
        if (signal.aborted || active === entry.isIntersecting) return;
        active = entry.isIntersecting;
        renderer.setActive(active);
        if (completed && !busy) reportAvailability();
      }, { rootMargin: '320px 0px' });
      visibility.observe(container);
    }
    if (structure) {
      resetButton = document.createElement('button');
      resetButton.type = 'button';
      resetButton.className = 'mc-view-reset';
      resetButton.textContent = '复位视角';
      resetButton.addEventListener('click', resetView, { signal });
      container.append(resetButton);
      await drawModel(structure);
      // A schematic's marker cells, and its moving pistons that carry a saved
      // block entity (the engine draws those blocks mid-move).
      const key = cell => cell.x + ',' + cell.y + ',' + cell.z;
      const carried = new Set(structure.tileEntities.filter(entity => /(^|:)piston$/.test(entity.id)).map(key));
      markers.sync(markerCells(palette, (structure.markerBlocks ?? []).map(cell => [key(cell), cell.state]), carried)).catch(reportError);
    }
  } catch (error) {
    destroy();
    throw error;
  }

  return {
    render(blocks, options = {}) {
      if (signal.aborted || scene.schematic) return false;
      focus = options.focus;
      focusActor = options.focusActor;
      mark = options.mark ?? null;
      sourceFocus = options.sourceFocus;
      sourceActor = options.sourceActor;
      sourceKind = options.sourceKind;
      if (completed) outline.setTarget(focus, focusActor);
      const playersChanged = options.playerRevision === undefined || playerRevision !== options.playerRevision;
      const entitiesChanged = options.entityRevision === undefined || entityRevision !== options.entityRevision;
      if (playersChanged) playerLayer?.sync(options.players);
      if (playersChanged || entitiesChanged) hitboxes?.sync(options.players, options.entities);
      playerRevision = options.playerRevision;
      entityRevision = options.entityRevision;
      const blocksChanged = !completed || options.revision === undefined || revision !== options.revision;
      const actors = entityLayer && (blocksChanged || entitiesChanged) ? new Map(options.entities) : null;
      if (!blocksChanged && !actors) {
        if (options.camera) setCamera(options.camera);
        redraw();
        return false;
      }
      // Copy the live recording state before an asynchronous model build yields.
      if (blocksChanged) {
        blockData = renderData(palette, bounds, blocks, options.pistons);
        blockData.skins = scene.skins;
        markers?.sync(markerCells(palette, blocks, options.pistons)).catch(reportError);
      }
      revision = options.revision;
      drawModel(blocksChanged ? blockData : null, options.camera, actors).catch(reportError);
      return true;
    },
    getCamera() {
      if (!renderer || !completed) return undefined;
      const { camera, controls } = renderer;
      return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom,
        projection: renderer.getProjectionMode(), ...(camera.isOrthographicCamera ? { height: camera.top - camera.bottom } : {}) };
    },
    resetView, setTheme, setPlaying: outline.setPlaying, destroy,
    // Whether the entity hitboxes show, for the settings card; null without entities.
    entityBoxes: hasBoxes ? {
      get visible() { return boxesVisible; },
      set: setBoxesVisible,
      onChange(listener) { boxesListener = listener; },
    } : null,
  };
}
