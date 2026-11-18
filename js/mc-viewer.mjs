import { Renderer, AssetProvider, BlockModelResolver, parseLitematica,
  extractSigns, extractPlayerHeads, extractBanners, extractStatues, extractDecoratedPots } from './vendor/mc-engine.mjs';
import { readPalette, replayBounds, renderData } from './mc-render-data.mjs';

const svgNS = 'http://www.w3.org/2000/svg';
const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

function createOutline(container, renderer) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('mc-focus');
  svg.setAttribute('aria-hidden', 'true');
  for (const [stroke, width] of [['#27221c', 4], ['#ffbd57', 2]]) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  container.append(svg);
  const vertex = renderer.camera.position.clone();
  function draw(pos) {
    let path = '';
    if (pos) {
      const width = container.clientWidth, height = container.clientHeight, camera = renderer.camera;
      camera.updateMatrixWorld();
      const points = Array.from({ length: 8 }, (_, i) => {
        vertex.set(pos[0] + (i & 1), pos[1] + ((i >> 1) & 1), pos[2] + ((i >> 2) & 1)).project(camera);
        return vertex.z < -1 || vertex.z > 1 ? null : [(vertex.x + 1) * width / 2, (1 - vertex.y) * height / 2];
      });
      path = edges.filter(([a,b]) => points[a] && points[b]).map(([a,b]) => 'M' + points[a] + 'L' + points[b]).join('');
    }
    for (const node of svg.children) node.setAttribute('d', path);
  }
  return { draw, remove: () => svg.remove() };
}

async function readSchematic(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('读取投影失败（HTTP ' + response.status + '）。');
  return parseLitematica(await response.arrayBuffer(), undefined, { signal, renderOnly: true });
}

function applyCamera(renderer, bounds, saved) {
  renderer.setProjectionMode(saved?.projection ?? 'perspective');
  renderer.fitToBounds(bounds);
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
  camera.zoom = saved?.zoom ?? 1;
  camera.updateProjectionMatrix();
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
  focus: initialFocus, theme = 'auto', onStatus, signal: parentSignal } = {}) {
  const lifecycle = new AbortController(), { signal } = lifecycle;
  parentSignal?.throwIfAborted();
  parentSignal?.addEventListener('abort', destroy, { once: true });
  const assets = new AssetProvider(), resolver = new BlockModelResolver(assets);
  let renderer, outline, resize, visibility, resetButton, bounds, palette;
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
    renderer?.dispose();
    renderer = null;
    assets.clearCaches();
  }

  function redraw() { outline?.draw(completed ? focus : null); }
  function setTheme(value) {
    if (!renderer) return;
    const dark = value === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : value === 'dark';
    // The stage of css/mc-article.css: close to the page, so the blocks stand out.
    renderer.setBackgroundColor(dark ? '#10151c' : '#dee1e6');
  }
  function resetView() {
    if (renderer && bounds) applyCamera(renderer, bounds, bookmarkCamera);
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
      if (!completed || camera) applyCamera(renderer, bounds, camera ?? bookmarkCamera);
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
    const canvas = renderer.renderer.domElement;
    canvas.classList.add('mc-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', name + '，可拖动旋转，滚轮缩放');
    renderer.onRenderError = reportError;
    renderer.setWireframesVisible(false);
    renderer.setDimensionsVisible(false);
    setTheme(theme);
    outline = createOutline(container, renderer);
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
      if (completed && options.revision !== undefined && revision === options.revision) {
        if (options.camera) applyCamera(renderer, bounds, options.camera);
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
  };
}
