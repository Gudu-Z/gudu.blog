(() => {
  'use strict';

  const menuToggle = document.querySelector('#menu-toggle');
  const navigation = document.querySelector('#site-nav');

  if (menuToggle && navigation) {
    document.body.classList.add('menu-enhanced');
    menuToggle.hidden = false;

    function setMenuOpen(open, restoreFocus = false) {
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? '关闭导航' : '展开导航');
      navigation.classList.toggle('is-open', open);
      if (open) document.body.dataset.menuOpen = 'true';
      else delete document.body.dataset.menuOpen;
      if (restoreFocus) menuToggle.focus();
    }

    menuToggle.addEventListener('click', () => {
      setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
    });
    navigation.addEventListener('click', event => {
      if (event.target.closest('a')) setMenuOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        setMenuOpen(false, true);
      }
    });
    document.addEventListener('click', event => {
      if (!navigation.contains(event.target) && !menuToggle.contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('focusin', event => {
      if (!navigation.contains(event.target) && !menuToggle.contains(event.target)) setMenuOpen(false);
    });
    window.matchMedia('(min-width: 721px)').addEventListener('change', event => {
      if (event.matches) setMenuOpen(false);
    });
    setMenuOpen(false);
  }

  const postsList = document.querySelector('#posts-list');
  const searchForm = document.querySelector('#post-search');
  const searchInput = document.querySelector('#search-input');
  const clearSearch = document.querySelector('#clear-search');
  const filterList = document.querySelector('#filter-list');
  const resultsCount = document.querySelector('#results-count');
  const emptyState = document.querySelector('#empty-state');
  const resetFilters = document.querySelector('#reset-filters');
  const loadMore = document.querySelector('#load-more');

  // The generated HTML remains readable when JavaScript or the data file is unavailable.
  if (!postsList || !Array.isArray(window.BLOG_POSTS)) return;

  const posts = window.BLOG_POSTS.filter(post => post && typeof post.title === 'string');
  if (!searchForm || !searchInput || !filterList) return;

  searchForm.hidden = false;
  filterList.hidden = posts.length === 0;
  if (resultsCount) resultsCount.hidden = false;

  const searchToggle = searchForm.querySelector('.header-search-toggle');
  const searchFields = searchForm.querySelector('.header-search-fields');
  if (searchToggle && searchFields) {
    let hovering = false;
    let revealOnClick = false;
    function setSearchExpanded(expanded) {
      // Keep the flex layout intact while the text fades and the form contracts.
      searchFields.hidden = false;
      searchFields.inert = !expanded;
      searchFields.setAttribute('aria-hidden', String(!expanded));
      searchForm.classList.toggle('is-expanded', expanded);
      searchToggle.setAttribute('aria-expanded', String(expanded));
    }
    searchForm.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      hovering = true;
      setSearchExpanded(true);
    });
    searchForm.addEventListener('pointerleave', event => {
      if (event.pointerType === 'touch') return;
      hovering = false;
      if (!searchForm.contains(document.activeElement)) setSearchExpanded(false);
    });
    searchForm.addEventListener('focusin', () => setSearchExpanded(true));
    searchForm.addEventListener('focusout', () => {
      // Clearing a query can hide the focused clear button before returning to the input.
      queueMicrotask(() => {
        if (!hovering && !searchForm.contains(document.activeElement)) setSearchExpanded(false);
      });
    });
    searchToggle.addEventListener('pointerdown', () => {
      revealOnClick = searchFields.inert;
    });
    searchToggle.addEventListener('click', event => {
      const firstTap = event.detail > 0 && revealOnClick;
      const emptyButton = document.activeElement !== searchInput && !searchInput.value.trim();
      if (firstTap || emptyButton) event.preventDefault();
      revealOnClick = false;
      setSearchExpanded(true);
      searchInput.focus({ preventScroll: true });
    });
    searchForm.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hovering = false;
      searchToggle.focus({ preventScroll: true });
      setSearchExpanded(false);
    });
    setSearchExpanded(false);
  }

  const pageSize = 6;
  const categories = [...new Set(posts.map(post => post.category).filter(Boolean))];
  const searchablePosts = posts.map(post => ({
    post,
    text: [post.title, post.summary || post.excerpt, post.category, ...(Array.isArray(post.tags) ? post.tags : []), post.searchText]
      .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN'),
  }));
  const state = { query: '', category: '', limit: pageSize };
  let searchSession = false;
  let displayedCount = 0;

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function postUrl(post) {
    const fallback = `./posts/${encodeURIComponent(post.slug || post.id || '')}.html`;
    try {
      const url = new URL(post.url || fallback, window.location.href);
      if (['https:', 'http:', 'file:'].includes(url.protocol)) return url.href;
    } catch { /* Fall back to the generated local article path. */ }
    return fallback;
  }

  function createPostCard(post, index) {
    const card = createElement('article', 'post-card');
    card.dataset.category = post.category || '';
    card.style.setProperty('--card-index', String(index));

    const number = createElement('span', 'post-number', String(posts.indexOf(post) + 1).padStart(2, '0'));
    number.setAttribute('aria-hidden', 'true');
    const body = createElement('div', 'post-card-body');
    const meta = createElement('div', 'post-card-meta');
    if (post.category) meta.append(createElement('span', 'post-category', post.category));
    // Calendar dates are displayed literally, avoiding UTC/local-time day shifts.
    if (typeof post.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(post.date)) {
      const date = createElement('time', '', post.date.replaceAll('-', '.'));
      date.dateTime = post.date;
      meta.append(date);
    }
    if (Number.isFinite(post.readingMinutes) && post.readingMinutes > 0) {
      meta.append(createElement('span', 'post-reading-time', `${post.readingMinutes} 分钟阅读`));
    }
    if (post.demo) meta.append(createElement('span', 'demo-label', '示例'));

    const title = createElement('h3', 'post-title');
    const titleLink = createElement('a', '', post.title);
    titleLink.href = postUrl(post);
    title.append(titleLink);
    const summary = createElement('p', 'post-summary', post.summary || post.excerpt || '');
    const footer = createElement('div', 'post-card-footer');
    const tags = createElement('ul', 'post-tags');
    for (const tag of Array.isArray(post.tags) ? post.tags : []) {
      tags.append(createElement('li', '', `#${tag}`));
    }
    const link = createElement('a', 'post-link', '阅读全文 ');
    link.href = titleLink.href;
    link.setAttribute('aria-label', `阅读全文：${post.title}`);
    const arrow = createElement('span', '', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    link.append(arrow);
    footer.append(tags, link);
    body.append(meta, title, summary, footer);
    card.append(number, body);
    return card;
  }

  function createFilters() {
    const fragment = document.createDocumentFragment();
    for (const category of ['', ...categories]) {
      const button = createElement('button', 'filter-button');
      button.type = 'button';
      button.dataset.category = category;
      button.setAttribute('aria-controls', 'posts-list');
      button.setAttribute('aria-pressed', 'false');
      const count = category ? posts.filter(post => post.category === category).length : posts.length;
      button.append(
        createElement('span', 'filter-label', category || '全部'),
        createElement('span', 'filter-count', String(count)),
      );
      fragment.append(button);
    }
    filterList.replaceChildren(fragment);
  }

  function matchingPosts() {
    const terms = state.query.normalize('NFKC').toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
    return searchablePosts.filter(({ post, text }) => (
      (!state.category || post.category === state.category) && terms.every(term => text.includes(term))
    )).map(({ post }) => post);
  }

  function render(append = false) {
    // Keep the authored welcome panel while the first article is still pending.
    if (!posts.length) {
      if (clearSearch) clearSearch.hidden = searchInput.value.length === 0;
      if (resultsCount) resultsCount.textContent = '暂无已发布的文章';
      if (emptyState) emptyState.hidden = true;
      if (loadMore) loadMore.hidden = true;
      return;
    }
    const matches = matchingPosts();
    const start = append ? displayedCount : 0;
    const visiblePosts = matches.slice(start, state.limit);
    const fragment = document.createDocumentFragment();
    for (const [index, post] of visiblePosts.entries()) fragment.append(createPostCard(post, start + index));
    if (append) postsList.append(fragment);
    else postsList.replaceChildren(fragment);
    displayedCount = Math.min(state.limit, matches.length);

    for (const button of filterList.querySelectorAll('button[data-category]')) {
      button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    }
    if (emptyState) emptyState.hidden = matches.length > 0;
    if (clearSearch) clearSearch.hidden = searchInput.value.length === 0;
    if (resultsCount) {
      resultsCount.textContent = matches.length > displayedCount
        ? `共 ${matches.length} 篇文章，已显示 ${displayedCount} 篇`
        : `共 ${matches.length} 篇文章`;
    }
    if (loadMore) {
      loadMore.hidden = displayedCount >= matches.length;
      loadMore.textContent = `再看 ${Math.min(pageSize, matches.length - displayedCount)} 篇`;
    }
  }

  function updateUrl(mode) {
    const url = new URL(window.location.href);
    if (state.query) url.searchParams.set('q', state.query);
    else url.searchParams.delete('q');
    if (state.category) url.searchParams.set('category', state.category);
    else url.searchParams.delete('category');
    if (url.href === window.location.href) return false;
    // History can be unavailable in a sandboxed embed; filtering still works there.
    try {
      window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url.href);
      return true;
    } catch { return false; /* Keep the in-page results usable. */ }
  }

  function restoreFromUrl() {
    const params = new URL(window.location.href).searchParams;
    state.query = (params.get('q') || '').trim();
    const requestedCategory = params.get('category') || '';
    state.category = categories.includes(requestedCategory)
      ? requestedCategory
      : posts.find(post => post.categorySlug === requestedCategory)?.category || '';
    state.limit = pageSize;
    searchSession = false;
    searchInput.value = state.query;
    render();
  }

  function resetAll() {
    state.query = '';
    state.category = '';
    state.limit = pageSize;
    searchSession = false;
    searchInput.value = '';
    updateUrl('push');
    render();
    searchInput.focus();
  }

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    state.limit = pageSize;
    // One history entry per editing session makes Back useful without one entry per key.
    searchSession = updateUrl(searchSession ? 'replace' : 'push') || searchSession;
    render();
  });
  searchInput.addEventListener('blur', () => { searchSession = false; });
  searchForm.addEventListener('submit', event => {
    event.preventDefault();
    state.query = searchInput.value.trim();
    state.limit = pageSize;
    updateUrl(searchSession ? 'replace' : 'push');
    searchSession = false;
    render();
  });
  clearSearch?.addEventListener('click', () => {
    state.query = '';
    state.limit = pageSize;
    searchSession = false;
    searchInput.value = '';
    updateUrl('push');
    render();
    searchInput.focus();
  });
  filterList.addEventListener('click', event => {
    const button = event.target.closest('button[data-category]');
    if (!button || !filterList.contains(button)) return;
    state.category = button.dataset.category;
    state.limit = pageSize;
    searchSession = false;
    updateUrl('push');
    render();
  });
  resetFilters?.addEventListener('click', resetAll);
  loadMore?.addEventListener('click', () => {
    const firstNewIndex = displayedCount;
    const hadFocus = document.activeElement === loadMore;
    state.limit += pageSize;
    render(true);
    if (loadMore.hidden && hadFocus) {
      postsList.children[firstNewIndex]?.querySelector('.post-title a')?.focus();
    }
  });
  window.addEventListener('popstate', restoreFromUrl);

  if (posts.length) createFilters();
  restoreFromUrl();
})();
