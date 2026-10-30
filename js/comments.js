(() => {
  'use strict';

  const section = document.querySelector('[data-comments]');
  if (!section || section.dataset.commentsController) return;
  const thread = section.querySelector('[data-comments-thread]');
  const status = section.querySelector('[data-comments-status]');
  const retry = section.querySelector('[data-comments-retry]');
  if (!thread || !status || !retry) return;
  section.dataset.commentsController = 'true';

  const showStatus = message => {
    status.textContent = message;
    status.hidden = !message;
  };
  let server;
  try {
    server = new URL(section.dataset.serverUrl);
    if (!['https:', 'http:'].includes(server.protocol)) throw new Error('Unsupported protocol');
  } catch {
    showStatus('评论地址配置有误，暂时无法加载评论。');
    return;
  }

  const isLoopback = server.hostname === 'localhost' || server.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(server.hostname);
  if (window.location.origin !== section.dataset.siteOrigin && !isLoopback) {
    showStatus('预览模式不连接线上评论。');
    return;
  }

  const scriptURL = document.currentScript?.src || new URL('/js/comments.js', window.location.href).href;
  const vendorURL = new URL('../assets/vendor/waline/', scriptURL);
  const assets = new Map();
  let state = 'idle';
  let instance = null;
  let clientScript = null;

  // Retain successful or pending resources; failed resources can be requested again.
  function loadAsset(filename, kind) {
    const url = new URL(filename, vendorURL).href;
    if (assets.has(url)) return assets.get(url);
    const element = document.createElement(kind);
    if (kind === 'link') {
      element.rel = 'stylesheet';
      element.href = url;
    } else {
      element.src = url;
      element.async = true;
      clientScript = element;
    }
    const promise = new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        window.clearTimeout(timer);
        element.removeEventListener('load', loaded);
        element.removeEventListener('error', failed);
        if (error) {
          element.remove();
          reject(error);
        } else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error(`Failed to load ${filename}`));
      element.addEventListener('load', loaded, { once: true });
      element.addEventListener('error', failed, { once: true });
      timer = window.setTimeout(failed, 15000);
      document.head.appendChild(element);
    });
    assets.set(url, promise);
    promise.catch(() => { if (assets.get(url) === promise) assets.delete(url); });
    return promise;
  }

  async function loadComments() {
    if (state === 'loading' || state === 'ready') return;
    state = 'loading';
    retry.hidden = true;
    retry.disabled = true;
    section.setAttribute('aria-busy', 'true');
    showStatus('正在加载评论…');
    try {
      await Promise.all([
        loadAsset('waline.css', 'link'),
        loadAsset('waline.umd.js', 'script'),
      ]);
      if (typeof window.Waline?.init !== 'function') {
        // A malformed or interrupted script can fire load without exposing its API.
        assets.delete(new URL('waline.umd.js', vendorURL).href);
        clientScript?.remove();
        throw new Error('Waline is unavailable');
      }
      thread.replaceChildren();
      instance = window.Waline.init({
        el: thread,
        serverURL: server.href.replace(/\/$/, ''),
        path: section.dataset.commentPath,
        login: 'disable',
        meta: ['nick', 'mail'],
        requiredMeta: ['nick'],
        lang: 'zh-CN',
        dark: true,
        pageSize: 10,
        wordLimit: 1000,
        emoji: false,
        search: false,
        imageUploader: false,
        highlighter: false,
        texRenderer: false,
        reaction: false,
        pageview: false,
        noCopyright: false,
        locale: {
          nick: '昵称',
          mail: '邮箱',
          optional: '选填',
          placeholder: '留下你的想法吧。昵称必填，邮箱选填，无需注册。',
          sofa: '还没有评论，欢迎留下第一条想法。',
        },
        ...(section.dataset.turnstileKey ? { turnstileKey: section.dataset.turnstileKey } : {}),
      });
      if (!instance) throw new Error('Waline did not initialize');
      state = 'ready';
      showStatus('');
    } catch {
      instance?.destroy?.();
      instance = null;
      thread.replaceChildren();
      state = 'error';
      showStatus('评论加载失败，请检查网络后重试。');
      retry.hidden = false;
      retry.disabled = false;
    } finally {
      section.setAttribute('aria-busy', 'false');
    }
  }

  retry.addEventListener('click', () => { void loadComments(); });
  if (typeof window.IntersectionObserver === 'function') {
    const observer = new window.IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void loadComments();
    }, { rootMargin: '300px 0px' });
    observer.observe(section);
  } else {
    void loadComments();
  }
})();
