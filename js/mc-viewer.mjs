import { Renderer, AssetProvider, BlockModelResolver, parseLitematica,
  extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from './vendor/mc-engine.mjs';
import { readPalette, replayBounds, renderData } from './mc-render-data.mjs';

import { createReplayHitboxes, replayEntityBounds } from './mc-entity-hitboxes.mjs';
import { createPlayerLayer, playerViewAngle } from './mc-player-layer.mjs';

const svgNS = 'http://www.w3.org/2000/svg';
const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

// The marks over the 3D view: the current event's block as an orange box, and
// beneath it its parent's target (the event that caused it) as a dashed grey
// one. Each draw reports the current target's rectangle in the stage (or null
// when there is none in view), so the event card (js/mc-callout.mjs) can
// stand beside it.
function createOutline(container, renderer, onBox, getBounds) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('mc-focus');
  svg.setAttribute('aria-hidden', 'true');
  function addPath(stroke, width, dash) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linejoin', 'round');
    if (dash) path.setAttribute('stroke-dasharray', dash);
    svg.append(path);
    return path;
  }
  const parentPaths = [addPath('#29343e', 2.75, '4 3'), addPath('#c4d2df', 1.25, '4 3')];
  const currentPaths = [addPath('#27221c', 4), addPath('#ffbd57', 2)];
  container.append(svg);
  const vertex = renderer.camera.position.clone();
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
  function projectCorners(pos, actorBounds) {
    if (!pos && !actorBounds) return [];
    const min = pos ?? actorBounds.min, max = pos ? pos.map(n => n + 1) : actorBounds.max;
    const width = container.clientWidth, height = container.clientHeight;
    return Array.from({ length: 8 }, (_, i) => {
      vertex.set(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]).project(renderer.camera);
      return vertex.z < -1 || vertex.z > 1 ? null : [(vertex.x + 1) * width / 2, (1 - vertex.y) * height / 2];
    });
  }
  function drawEdges(paths, points) {
    const path = edges.filter(([a,b]) => points[a] && points[b]).map(([a,b]) => 'M' + points[a] + 'L' + points[b]).join('');
    for (const node of paths) node.setAttribute('d', path);
  }
  function screenBox(points) {
    const seen = points.filter(Boolean);
    if (!seen.length) return null;
    const box = { left: Math.min(...seen.map(p => p[0])), right: Math.max(...seen.map(p => p[0])),
      top: Math.min(...seen.map(p => p[1])), bottom: Math.max(...seen.map(p => p[1])) };
    if (box.right < 0 || box.bottom < 0 || box.left > container.clientWidth || box.top > container.clientHeight) return null;
    return box;
  }
  function draw(pos, actorBounds, parentPos, parentBounds) {
    renderer.camera.updateMatrixWorld();
    const current = projectCorners(pos, actorBounds);
    const sameBlock = pos && parentPos?.every((n, i) => n === pos[i]);
    drawEdges(parentPaths, sameBlock ? [] : projectCorners(parentPos, parentBounds));
    drawEdges(currentPaths, pos ? current : []);
    const box = screenBox(current);
    onBox?.(box, box && modelBox());
  }
  return { draw, remove: () => svg.remove() };
}

async function readSchematic(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('读取投影失败（HTTP ' + response.status + '）。');
  return parseLitematica(await response.arrayBuffer(), undefined, { signal, renderOnly: true });
}

// Fit the initial figures with the machine. Camera bounds may include players
// well outside the recorded blocks and must not change the blocks' packed keys.
function replayFraming(scene, bounds, palette) {
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
  const view = { ...bounds };
  if (actorBoxes.length && !scene.blocks.length && !scene.events.some(event => event.after !== undefined)) {
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
  return { bounds: view, blocks: scene.blocks, players, actorBoxes, geometryBounds: bounds, palette };
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
    if (framing.azimuth === undefined) framing.azimuth = playerViewAngle(renderer, framing);
    if (framing.azimuth) {
      const target = renderer.controls.target;
      camera.position.sub(target).applyAxisAngle(camera.up, framing.azimuth).add(target);
      renderer.controls.update();
    }
    frameBlocks(renderer, framing, 1 - inset / Math.max(1, renderer.container.clientWidth));
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
  let renderer, outline, resize, visibility, resetButton, bounds, palette, playerLayer, framing, playerRevision;
  let hitboxes, focusActor, parentFocus, parentActor, entityRevision, boxesVisible = true, hasBoxes = false, boxesListener;
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
      renderer.setActive(false);
      renderer.renderer.domElement.remove();
    }
    if (!busy) disposeResources();
  }

  function disposeResources() {
    hitboxes?.destroy();
    hitboxes = null;
    playerLayer?.destroy();
    playerLayer = null;
    renderer?.dispose();
    renderer = null;
    assets.clearCaches();
  }

  function redraw() {
    const actorBounds = completed && boxesVisible && focusActor ? hitboxes?.boundsFor(focusActor) : null;
    // A parent on the current event's own actor adds nothing to its hitbox.
    const parentBounds = completed && parentActor && parentActor !== focusActor ? hitboxes?.boundsFor(parentActor) : null;
    outline?.draw(completed ? focus : null, actorBounds, completed ? parentFocus : null, parentBounds);
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
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
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
  }
  // The pixels the host covers on the right of the view (its floating timeline).
  const coveredRight = () => Math.max(0, Math.min((container.clientWidth || 1) / 2, inset?.() ?? 0));
  function resetView() {
    if (renderer && bounds) applyCamera(renderer, bounds, bookmarkCamera, framing, coveredRight());
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

  async function drawModel(data, camera) {
    busy = true;
    onStatus?.({ type: 'loading' });
    const finish = renderer.beginSceneUpdate();
    try {
      await renderer.render(data, assets, undefined, undefined, false, { signal });
      if (scene.schematic) await staticDetails(renderer, data, assets, signal);
      signal.throwIfAborted();
      if (!completed || camera) applyCamera(renderer, bounds, camera ?? bookmarkCamera, framing, coveredRight());
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
    if (!structure) {
      framing = replayFraming(scene, bounds, palette);
      playerLayer = await createPlayerLayer(scene, renderer, assets, signal);
      signal.throwIfAborted();
    }
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
    renderer.controls.addEventListener('change', redraw);
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
      parentFocus = options.parentFocus;
      parentActor = options.parentActor;
      const playersChanged = options.playerRevision === undefined || playerRevision !== options.playerRevision;
      const entitiesChanged = options.entityRevision === undefined || entityRevision !== options.entityRevision;
      if (playersChanged) playerLayer?.sync(options.players);
      if (playersChanged || entitiesChanged) hitboxes?.sync(options.players, options.entities);
      playerRevision = options.playerRevision;
      entityRevision = options.entityRevision;
      if (completed && options.revision !== undefined && revision === options.revision) {
        if (options.camera) applyCamera(renderer, bounds, options.camera, undefined, coveredRight());
        redraw();
        return false;
      }
      // Copy the two live replay maps before yielding to texture/geometry work.
      const data = renderData(palette, bounds, blocks, options.pistons);
      revision = options.revision;
      drawModel(data, options.camera).catch(reportError);
      return true;
    },
    getCamera() {
      if (!renderer || !completed) return undefined;
      const { camera, controls } = renderer;
      return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom,
        projection: renderer.getProjectionMode(), ...(camera.isOrthographicCamera ? { height: camera.top - camera.bottom } : {}) };
    },
    resetView, setTheme, destroy,
    // Whether the entity hitboxes show, for the settings card; null without entities.
    entityBoxes: hasBoxes ? {
      get visible() { return boxesVisible; },
      set: setBoxesVisible,
      onChange(listener) { boxesListener = listener; },
    } : null,
  };
}
