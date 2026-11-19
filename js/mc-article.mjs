import { createReplay, validateScene } from './mc-replay.mjs';
import { mountTimeline } from './mc-timeline.mjs';
import { mountCallout } from './mc-callout.mjs';

// Each illustration keeps its own cursor and camera, even when it cites a shared recording.
const scenes = new Map();

function sharedStep(id) {
  const url = new URL(location.href);
  const value = url.searchParams.get('mcstep');
  return url.hash === '#' + id && value !== null && /^\d+$/.test(value)
    && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function sharedTick() {
  const value = new URL(location.href).searchParams.get('mctick');
  return value !== null && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

// The first times a pointer comes over a 3D view, a hint fades in beside its
// label; once the reader has dragged or zoomed a view, it never shows again.
// Touch screens show it once when the view comes into sight.
const hintKey = 'gudu-mc-hint';
function mountViewHint(stage, signal) {
  let seen = false;
  try { seen = localStorage.getItem(hintKey) === '1'; } catch {}
  if (seen) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  const hint = document.createElement('span');
  hint.className = 'mc-stage-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = touch ? '拖动旋转 · 双指缩放' : '拖动旋转 · 滚轮缩放';
  stage.append(hint);
  let timer = 0;
  const show = () => {
    if (seen) return;
    hint.classList.add('is-shown');
    clearTimeout(timer);
    timer = setTimeout(() => hint.classList.remove('is-shown'), 4000);
  };
  const done = () => {
    if (seen) return;
    seen = true;
    clearTimeout(timer);
    hint.classList.remove('is-shown');
    try { localStorage.setItem(hintKey, '1'); } catch {}
  };
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  stage.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') show(); }, { signal });
  stage.addEventListener('pointerdown', event => { if (event.target.closest?.('.mc-canvas')) done(); }, { signal });
  stage.addEventListener('wheel', done, { signal, passive: true });
  if (touch && 'IntersectionObserver' in window) {
    const sight = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      sight.disconnect();
      show();
    }, { threshold: 0.6 });
    sight.observe(stage);
    signal.addEventListener('abort', () => sight.disconnect(), { once: true });
  }
}

function mountFigure(figure) {
  const toggle = figure.querySelector('[data-mc-open]');
  const view = figure.querySelector('[data-mc-view]');
  const status = figure.querySelector('[data-mc-status]');
  const poster = figure.querySelector('[data-mc-poster]');
  const sceneURL = new URL(figure.dataset.src, document.baseURI);
  const reopenLabel = toggle.textContent;
  const stage = document.createElement('div');
  stage.className = 'mc-stage';
  // The view takes focus (by Tab, or a press on the model), so the replay's
  // keys work after looking around.
  stage.tabIndex = 0;
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', '3D 视图');
  stage.setAttribute('aria-keyshortcuts', 'Space ArrowLeft ArrowRight');
  stage.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.mc-canvas')) stage.focus({ preventScroll: true });
  });
  const linkedStep = sharedStep(figure.id);
  let session, observer, viewer, playback, callout, resumeStep, resumeTick;
  let failed = false;

  function release() {
    observer?.disconnect();
    session?.abort();
    if (playback) {
      resumeTick = playback.getTick();
      playback.destroy();
    }
    viewer?.destroy();
    callout?.destroy();
    session = playback = viewer = callout = null;
  }

  function showStage() {
    stage.replaceChildren();
    if (poster) { stage.append(poster); poster.hidden = false; }
    view.replaceChildren(stage);
    view.hidden = false;
    toggle.textContent = '收起场景';
    toggle.setAttribute('aria-expanded', 'true');
  }

  function collapse() {
    release();
    failed = false;
    if (poster) { view.before(poster); poster.hidden = false; }
    view.replaceChildren();
    view.hidden = true;
    status.textContent = '';
    toggle.textContent = reopenLabel;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function showFailure(message) {
    failed = true;
    playback?.setReady(false);
    playback?.stop();
    if (poster) poster.hidden = false;
    toggle.textContent = '重试加载场景';
    status.textContent = message;
  }

  async function activate(requestedStep, requestedTick) {
    release();
    failed = false;
    showStage();
    session = new AbortController();
    const { signal } = session;
    status.textContent = '正在读取场景…';
    try {
      let scene = scenes.get(sceneURL.href);
      if (!scene) {
        const response = await fetch(sceneURL, { signal });
        if (!response.ok) throw new Error(`读取场景失败（HTTP ${response.status}）`);
        scene = validateScene(await response.json());
        if (signal.aborted) return;
        scenes.set(sceneURL.href, scene);
      }
      const bookmark = scene.bookmarks?.[figure.dataset.bookmark] ?? {};
      const replay = scene.schematic ? null : createReplay(scene);
      let framePending = false, frameLoading = false, resetPending = false, focus;
      // Keep at most one geometry build in flight. The clock may pass several
      // ticks during a build; submit the latest block and piston state when it finishes.
      function submitLatest() {
        if (!viewer || !framePending || frameLoading || signal.aborted) return;
        framePending = false;
        const reset = resetPending;
        resetPending = false;
        if (reset && !bookmark.camera) viewer.resetView();
        viewer.render(replay.blocks, {
          revision: replay.revision, focus, pistons: replay.pistons,
          camera: reset ? bookmark.camera : undefined,
        });
      }
      if (replay) {
        playback = mountTimeline(view, figure, scene, replay, bookmark, (step, resetCamera, position) => {
          resumeStep = step;
          resumeTick = position.tick;
          const eventPos = position.gap ? undefined : replay.event?.pos;
          const atBookmark = step === (bookmark.step ?? 0) && (bookmark.tick === undefined
            ? !position.gap || (step === 0 && position.tick === scene.tickRange?.[0])
            : position.tick === bookmark.tick);
          focus = atBookmark ? bookmark.focus ?? eventPos : eventPos;
          framePending = true;
          resetPending ||= resetCamera;
          submitLatest();
        }, () => viewer?.getCamera(), {
          ticksPerSecond: figure.hasAttribute('data-speed') ? Number(figure.dataset.speed) : scene.playbackSpeed,
          onPlaying: value => callout?.setPlaying(value),
        });
        callout = mountCallout(stage, playback.details);
        const preferred = requestedStep ?? bookmark.step ?? 0;
        const useRequest = requestedStep != null && preferred <= scene.events.length;
        playback.seek(useRequest ? preferred : bookmark.step ?? 0, false, useRequest ? requestedTick : bookmark.tick);
      }
      status.textContent = '正在载入 3D 预览…';
      const onStatus = event => {
        if (signal.aborted) return;
        if (['waiting', 'loading', 'inactive', 'loaded', 'error'].includes(event.type)) {
          playback?.setReady(event.type === 'loaded');
        }
        if (event.type === 'error') {
          frameLoading = false;
          showFailure(event.message || '3D 预览加载失败。');
        } else if (event.type === 'loaded') {
          frameLoading = false;
          failed = false;
          toggle.textContent = '收起场景';
          if (poster) poster.hidden = true;
          status.textContent = '';
          submitLatest();
        } else if (event.type === 'loading') {
          frameLoading = true;
          status.textContent = '正在更新 3D 预览…';
        } else if (event.type === 'inactive') {
          frameLoading = false;
          playback?.stop();
          status.textContent = '回到视图后将恢复 3D 预览。';
        }
      };
      const { createSceneViewer } = await import('./mc-viewer.mjs');
      if (signal.aborted) return;
      const instance = await createSceneViewer(stage, scene, {
        sceneURL, camera: bookmark.camera, focus: bookmark.focus, signal,
        name: figure.querySelector('figcaption')?.textContent || '红石结构',
        theme: document.documentElement.dataset.theme || 'dark', onStatus,
        onFocusBox: (box, model) => callout?.place(box, model),
      });
      if (signal.aborted) { instance.destroy(); return; }
      viewer = instance;
      mountViewHint(stage, signal);
      window.addEventListener('site:theme', event => viewer?.setTheme(event.detail.theme), { signal });
      submitLatest();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) playback?.stop();
      }, { signal });
    } catch (error) {
      if (!signal.aborted) showFailure('无法载入 3D 场景。' + error.message);
    }
  }

  showStage();
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    if (view.hidden || failed) activate(resumeStep ?? linkedStep, resumeStep == null ? sharedTick() : resumeTick);
    else collapse();
  });

  // Reserve the model's space immediately. Start nearby illustrations automatically
  // and honour explicit time links without waiting for the first scroll event.
  if (linkedStep !== null || !('IntersectionObserver' in window)) {
    activate(linkedStep, linkedStep == null ? undefined : sharedTick());
  } else {
    observer = new IntersectionObserver(entries => {
      if (!view.hidden && !session && entries.some(entry => entry.isIntersecting)) activate();
    }, { rootMargin: '320px 0px' });
    observer.observe(figure);
  }
}

document.querySelectorAll('figure.mc-scene').forEach(mountFigure);
