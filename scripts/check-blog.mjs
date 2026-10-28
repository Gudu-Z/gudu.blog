import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildBlog } from './build-blog.mjs';

const expectedCategories = [
  { name: 'Minecraft', slug: 'minecraft' },
  { name: '白日梦话', slug: 'daydreams' },
  { name: '神秘文案', slug: 'collected' },
  { name: '其他', slug: 'other' },
];
const homepage = `<!doctype html><html lang="zh-CN"><title>Fixture</title><main>
${expectedCategories.map(({ slug }) => `<span data-category-count="${slug}">0</span>`).join('\n')}
<!-- posts:start --><!-- posts:end -->
<!-- archive:start --><!-- archive:end -->
</main></html>\n`;
const fixturePost = (overrides = {}) => ({
  slug: 'first-note',
  title: '一篇仅供测试的记录',
  excerpt: '测试内容只写入临时目录。',
  date: '2026-10-14',
  category: 'Minecraft',
  tags: ['测试'],
  sections: [{ title: '开始', blocks: [{ type: 'paragraph', text: '这是隔离的测试正文。' }] }],
  ...overrides,
});

async function fixture(run) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'gudu-blog-test-'));
  try {
    await mkdir(join(root, 'content', 'posts'), { recursive: true });
    await writeFile(join(root, 'index.html'), homepage, 'utf8');
    const read = filename => readFile(join(root, filename), 'utf8');
    const post = (filename, value) => writeFile(join(root, 'content', 'posts', filename), JSON.stringify(value), 'utf8');
    const data = async () => {
      const window = {};
      runInNewContext(await read('js/posts-data.js'), { window }, { timeout: 1000 });
      return JSON.parse(JSON.stringify({ posts: window.BLOG_POSTS, categories: window.BLOG_CATEGORIES }));
    };
    const metadata = async () => (await data()).posts;
    await run({ root, read, post, metadata, data });
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), parent, 'Cleanup must remain within the temporary directory.');
    assert.ok(basename(target).startsWith('gudu-blog-test-'), 'Cleanup must target this test fixture.');
    await rm(target, { recursive: true, force: true });
  }
}

await test('an empty blog builds usable pages and a valid empty feed without sample articles', async () => {
  await fixture(async ({ root, read, metadata, data }) => {
    await buildBlog({ root });
    assert.deepEqual(await metadata(), []);
    assert.deepEqual((await data()).categories, expectedCategories);
    const html = await read('index.html');
    for (const { slug } of expectedCategories) assert.match(html, new RegExp(`data-category-count="${slug}">00<`));
    assert.match(html, /class="journal-empty"/);
    assert.match(html, /class="archive-empty"/);
    assert.doesNotMatch(html, /class="post-card"/);
    const feed = await read('feed.xml');
    assert.match(feed, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(feed, /<rss version="2\.0"/);
    assert.match(feed, /<atom:link href="https:\/\/gudu\.blog\/feed\.xml"/);
    assert.doesNotMatch(feed, /<item>/);
    assert.equal((await read('sitemap.xml')).match(/<loc>/g)?.length, 1);
    assert.match(await read('robots.txt'), /Sitemap: https:\/\/gudu\.blog\/sitemap\.xml/);
    assert.match(await read('404.html'), /name="robots" content="noindex, follow"/);
    await buildBlog({ root, checkOnly: true });
  });
});

await test('published routes, escaping, archive order, and feeds agree with the article source', async () => {
  await fixture(async ({ root, read, post, metadata }) => {
    const hostile = '引号 " & <script>alert(1)</script>';
    const escaped = '引号 &quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;';
    await post('latest.json', fixturePost({
      slug: 'latest-note', title: hostile, excerpt: hostile, tags: ['<tag>', '<tag>'],
      sections: [{ id: 'details', title: hostile, blocks: [
        { type: 'paragraph', text: hostile },
        { type: 'quote', text: hostile },
        { type: 'callout', text: hostile },
        { type: 'list', ordered: true, items: [hostile] },
        { type: 'code', language: 'html', code: '  <img src=x onerror=alert(1)>\n  const n = 1;\n' },
      ] }],
    }));
    await post('older.json', fixturePost({ slug: 'older-note', date: '2025-12-31' }));
    await post('draft.json', fixturePost({ slug: 'private-draft', draft: true }));
    await post('demo.json', fixturePost({ slug: 'layout-preview', demo: true, date: '2026-01-01' }));
    await buildBlog({ root });
    const posts = await metadata();
    assert.deepEqual(posts.map(item => item.slug), ['latest-note', 'layout-preview', 'older-note']);
    assert.equal(posts[0].url, './posts/latest-note.html');
    assert.equal(posts[0].categorySlug, 'minecraft');
    assert.deepEqual(posts[0].tags, ['<tag>']);
    assert.ok(posts[0].readingMinutes >= 1);
    assert.doesNotMatch(await read('js/posts-data.js'), /<script>/);

    const article = await read('posts/latest-note.html');
    assert.ok(article.includes(`<h1 class="article-title">${escaped}</h1>`));
    assert.ok(article.includes(`<p>${escaped}</p>`));
    assert.match(article, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(article, /<code>  &lt;img src=x onerror=alert\(1\)&gt;\n  const n = 1;\n<\/code>/);
    assert.doesNotMatch(article, /<img src=x|<script>alert/);
    assert.match(article, /rel="canonical" href="https:\/\/gudu\.blog\/posts\/latest-note\.html"/);
    assert.match(article, /data-toc-link href="#details"/);
    assert.match(article, /href="\.\/layout-preview\.html"/);
    const schema = JSON.parse(article.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(schema.headline, hostile);
    assert.equal(schema.mainEntityOfPage, 'https://gudu.blog/posts/latest-note.html');

    const html = await read('index.html');
    assert.ok(html.includes(escaped));
    assert.ok(html.indexOf('<h3>2026</h3>') < html.indexOf('<h3>2025</h3>'));
    assert.doesNotMatch(html, /private-draft/);
    const feed = await read('feed.xml');
    assert.equal(feed.match(/<item>/g)?.length, 2);
    assert.ok(feed.includes(`<title>${escaped}</title>`));
    assert.match(feed, /Wed, 14 Oct 2026 00:00:00 GMT/);
    assert.doesNotMatch(feed, /private-draft|layout-preview/);
    assert.doesNotMatch(await read('sitemap.xml'), /private-draft|layout-preview/);
    assert.match(await read('posts/layout-preview.html'), /name="robots" content="noindex, follow"/);
    assert.doesNotMatch(await read('posts/layout-preview.html'), /application\/ld\+json/);
    assert.equal((await readdir(join(root, 'posts'))).includes('private-draft.html'), false);
    await buildBlog({ root, checkOnly: true });
  });
});

await test('canonical category metadata and homepage counts include published posts, preserving unknown labels under other', async () => {
  await fixture(async ({ root, read, post, data }) => {
    for (const { name, slug } of expectedCategories) {
      await post(`${slug}.json`, fixturePost({ slug: `${slug}-note`, category: name }));
    }
    await post('legacy.json', fixturePost({ slug: 'legacy-note', category: '旧日随笔' }));
    await post('draft.json', fixturePost({ slug: 'private-dream', category: '白日梦话', draft: true }));
    await post('unknown-draft.json', fixturePost({ slug: 'private-legacy', category: '未公开分类', draft: true }));
    await buildBlog({ root });
    const generated = await data();
    assert.deepEqual(generated.categories, expectedCategories);
    assert.equal(generated.posts.length, 5);
    for (const { name, slug } of expectedCategories) {
      const item = generated.posts.find(candidate => candidate.slug === `${slug}-note`);
      assert.equal(item.category, name);
      assert.equal(item.categorySlug, slug);
    }
    const legacy = generated.posts.find(item => item.slug === 'legacy-note');
    assert.equal(legacy.category, '旧日随笔');
    assert.equal(legacy.categorySlug, 'other');
    assert.match(await read('posts/legacy-note.html'), /旧日随笔/);
    const html = await read('index.html');
    for (const { slug } of expectedCategories) {
      assert.match(html, new RegExp(`data-category-count="${slug}">${String(slug === 'other' ? 2 : 1).padStart(2, '0')}<`));
    }
    assert.doesNotMatch(html, /private-dream|private-legacy/);
    await buildBlog({ root, checkOnly: true });
  });
});

await test('check mode is read-only, and rebuilding removes stale generated pages while preserving manual pages', async () => {
  await fixture(async ({ root, read, post, metadata }) => {
    await post('note.json', fixturePost());
    await buildBlog({ root });
    await writeFile(join(root, 'posts', 'manual.html'), '<h1>Keep this hand-written page</h1>', 'utf8');
    await writeFile(join(root, 'feed.xml'), 'changed by hand', 'utf8');
    await assert.rejects(buildBlog({ root, checkOnly: true }), /feed\.xml/);
    assert.equal(await read('feed.xml'), 'changed by hand');
    await rm(join(root, 'content', 'posts', 'note.json'));
    await assert.rejects(buildBlog({ root, checkOnly: true }), /first-note\.html/);
    assert.match(await read('posts/first-note.html'), /article-title/);
    await buildBlog({ root });
    assert.deepEqual(await metadata(), []);
    assert.equal(await read('posts/manual.html'), '<h1>Keep this hand-written page</h1>');
    assert.deepEqual(await readdir(join(root, 'posts')), ['manual.html']);
    await buildBlog({ root, checkOnly: true });
  });
});

await test('invalid or ambiguous content fails before generating published files', async t => {
  const cases = [
    ['path traversal slug', { slug: '../escape' }, /slug/],
    ['impossible calendar date', { date: '2026-02-30' }, /date/],
    ['empty title', { title: ' ' }, /title/],
    ['string draft flag', { draft: 'true' }, /draft/],
    ['unsafe section anchor', { sections: [{ id: 'x" onclick="run()', title: 'Section', blocks: [{ type: 'paragraph', text: 'Text' }] }] }, /\.id/],
    ['reserved section anchor', { sections: [{ id: 'main-content', title: 'Section', blocks: [{ type: 'paragraph', text: 'Text' }] }] }, /\.id/],
    ['duplicate anchors', { sections: [1, 2].map(() => ({ id: 'same', title: 'Section', blocks: [{ type: 'paragraph', text: 'Text' }] })) }, /\.id/],
    ['unsupported raw HTML block', { sections: [{ title: 'Section', blocks: [{ type: 'html', text: '<script>run()</script>' }] }] }, /type/],
  ];
  for (const [name, value, error] of cases) {
    await t.test(name, async () => {
      await fixture(async ({ root, read, post }) => {
        await post('bad.json', fixturePost(value));
        await assert.rejects(buildBlog({ root }), error);
        assert.equal(await read('index.html'), homepage);
        assert.equal((await readdir(root)).includes('feed.xml'), false);
      });
    });
  }
  await t.test('duplicate article URLs', async () => {
    await fixture(async ({ root, read, post }) => {
      await post('one.json', fixturePost());
      await post('two.json', fixturePost({ title: 'Duplicate URL' }));
      await assert.rejects(buildBlog({ root }), /slug/);
      assert.equal(await read('index.html'), homepage);
    });
  });
});

const browserSource = await readFile(new URL('../js/blog.js', import.meta.url), 'utf8');

class BrowserEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: false, defaultPrevented: false }, options);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      event.target ??= this;
      event.currentTarget = this;
      for (const callback of [...(listeners.get(event.type) || [])]) callback.call(this, event);
      if (event.bubbles && !event.propagationStopped) this.parentNode?.dispatchEvent(event);
      return !event.defaultPrevented;
    },
  };
}

const browserPosts = [
  ['redstone-rail', '红石矿车', 'Minecraft', 'minecraft'],
  ['floating-island', '浮岛建筑', 'Minecraft', 'minecraft'],
  ['moon-note', '月亮收集', '神秘文案', 'collected'],
  ['legacy-note', '红石生活', '旧日随笔', 'other'],
].map(([slug, title, category, categorySlug]) => ({
  slug, title, category, categorySlug, url: `./posts/${slug}.html`,
  date: '2026-10-26', excerpt: '一段可搜索的记录', tags: ['记录'], readingMinutes: 1,
}));

// This small DOM implements the surfaces used by blog.js, including bubbling
// clicks and fragments. Filtering and history behavior always run real code.
function blogBrowser({ posts = browserPosts, url = 'https://gudu.blog/#journal' } = {}) {
  let location = new URL(url);
  const history = [];
  const scrolls = [];
  const document = eventTarget({ activeElement: null });
  const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

  class Element {
    constructor(tag) {
      Object.assign(this, eventTarget());
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = new Map();
      this.hidden = false;
      this.value = '';
      this.text = '';
      this.className = '';
      this.style = { setProperty() {} };
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force = !this.classList.contains(name)) => {
          this.classList[force ? 'add' : 'remove'](name);
          return force;
        },
      };
    }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    get href() { return new URL(this.getAttribute('href') || '', location).href; }
    set href(value) { this.setAttribute('href', value); }
    get target() { return this.getAttribute('target') || ''; }
    set target(value) { this.setAttribute('target', value); }
    setAttribute(name, value) {
      if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
      else if (name === 'class') this.className = String(value);
      else this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
      if (name === 'class') return this.className;
      return this.attributes.get(name) ?? null;
    }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    removeAttribute(name) {
      if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
      else this.attributes.delete(name);
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === '#FRAGMENT') { this.append(...node.children); node.children = []; continue; }
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children.forEach(child => { child.parentNode = null; });
      this.children = [];
      this.text = '';
      this.append(...nodes);
    }
    matches(selector) {
      return selector.split(',').some(part => {
        const simple = part.trim();
        const tag = simple.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        for (const [, id] of simple.matchAll(/#([\w-]+)/g)) if (this.getAttribute('id') !== id) return false;
        for (const [, name] of simple.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
        for (const [, name, value] of simple.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
        }
        return true;
      });
    }
    closest(selector) {
      for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node;
      return null;
    }
    contains(other) {
      for (let node = other; node; node = node.parentNode) if (node === this) return true;
      return false;
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      const parts = selector.trim().split(/\s+/);
      return descendants.filter(node => {
        if (!node.matches(parts.at(-1))) return false;
        for (let i = parts.length - 2, ancestor = node.parentElement; i >= 0; i -= 1) {
          while (ancestor && !ancestor.matches(parts[i])) ancestor = ancestor.parentElement;
          if (!ancestor) return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    scrollIntoView(options) { scrolls.push({ element: this, options }); }
  }

  const body = new Element('body');
  body.parentNode = document;
  document.body = body;
  document.documentElement = body;
  document.activeElement = body;
  document.createElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element('#fragment');
  document.querySelectorAll = selector => body.querySelectorAll(selector);
  document.querySelector = selector => body.querySelector(selector);
  document.getElementById = id => body.querySelector(`#${id}`);
  const element = (tag, id, parent = body, className = '') => {
    const node = new Element(tag);
    if (id) node.setAttribute('id', id);
    node.className = className;
    parent.append(node);
    return node;
  };
  const journal = element('section', 'journal');
  const searchForm = element('form', 'post-search');
  const searchInput = element('input', 'search-input', searchForm);
  const clearSearch = element('button', 'clear-search', searchForm);
  const filterList = element('div', 'filter-list', journal);
  const resultsCount = element('p', 'results-count', journal);
  const postsList = element('div', 'posts-list', journal);
  const welcome = element('div', '', postsList, 'journal-empty');
  welcome.textContent = '文章正在酝酿';
  const emptyState = element('div', 'empty-state', journal);
  emptyState.hidden = true;
  element('h3', '', emptyState).textContent = '还没有找到这篇记录';
  element('p', '', emptyState).textContent = '试试其他关键词';
  const resetFilters = element('button', 'reset-filters', emptyState);
  const loadMore = element('button', 'load-more', journal);
  const links = new Map();
  const counts = new Map();
  for (const { name, slug } of expectedCategories) {
    const link = element('a');
    link.dataset.categoryLink = slug;
    link.href = `?category=${slug}#journal`;
    element('span', '', link).textContent = name;
    const count = element('span', '', link);
    count.dataset.categoryCount = slug;
    count.textContent = '0';
    links.set(slug, link);
    counts.set(slug, count);
  }
  const window = eventTarget({
    BLOG_POSTS: structuredClone(posts),
    BLOG_CATEGORIES: structuredClone(expectedCategories),
    get location() { return location; },
    history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state, _title, next) => {
      location = new URL(next, location);
      history.push({ method, url: location.href });
    }])),
    matchMedia: () => eventTarget({ matches: false }),
  });
  // eventTarget copies values, so preserve a live location getter across history.
  Object.defineProperty(window, 'location', { get: () => location });
  runInNewContext(browserSource, { document, window, Element, HTMLElement: Element, URL, Event: BrowserEvent, CustomEvent: BrowserEvent, queueMicrotask }, { timeout: 1000, filename: 'js/blog.js' });
  const click = (node, options = {}) => {
    const event = new BrowserEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
    node.dispatchEvent(event);
    return event;
  };
  return {
    window, document, history, scrolls, postsList, welcome, filterList, resultsCount, emptyState,
    searchInput, clearSearch, resetFilters, links, counts, click,
    filters: () => filterList.querySelectorAll('button[data-category]'),
    selected: () => filterList.querySelectorAll('button[data-category]').filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.category),
    titles: () => postsList.querySelectorAll('.post-title a').map(link => link.textContent),
    input(value) {
      searchInput.value = value;
      searchInput.dispatchEvent(new BrowserEvent('input', { bubbles: true }));
    },
    popstate(next) {
      location = new URL(next, location);
      window.dispatchEvent(new BrowserEvent('popstate'));
    },
  };
}

await test('all four category filters remain available with accurate counts, including an entirely empty blog', () => {
  for (const posts of [[], browserPosts]) {
    const page = blogBrowser({ posts });
    assert.equal(page.filterList.hidden, false);
    assert.deepEqual(page.filters().map(button => button.dataset.category), ['', ...expectedCategories.map(item => item.slug)]);
    assert.deepEqual(page.filters().map(button => button.querySelector('.filter-label').textContent), ['全部', ...expectedCategories.map(item => item.name)]);
    assert.deepEqual(page.selected(), ['']);
    if (!posts.length) {
      assert.equal(page.postsList.querySelector('.journal-empty'), page.welcome, 'the unfiltered empty site keeps its authored welcome');
      assert.equal(page.emptyState.hidden, true);
    }
    for (const button of page.filters()) {
      const count = button.dataset.category ? posts.filter(post => post.categorySlug === button.dataset.category).length : posts.length;
      assert.equal(button.querySelector('.filter-count').textContent, String(count));
      if (button.dataset.category) assert.equal(page.counts.get(button.dataset.category).textContent, String(count).padStart(2, '0'));
    }
  }
  const empty = blogBrowser({ posts: [], url: 'https://gudu.blog/?category=daydreams#journal' });
  assert.deepEqual(empty.selected(), ['daydreams']);
  assert.equal(empty.postsList.children.length, 0, 'a selected empty category must not show the generic welcome');
  assert.equal(empty.emptyState.hidden, false);
  assert.match(empty.emptyState.textContent, /这个分类还没有文章/);
  assert.match(empty.emptyState.textContent, /白日梦话/, 'the empty result names the selected category');
  assert.match(empty.resultsCount.textContent, /共 0 篇文章/);
  assert.equal(empty.emptyState.contains(empty.resetFilters), true);
  assert.equal(empty.resetFilters.hidden, false);
  empty.input('找不到的记录');
  empty.click(empty.resetFilters);
  assert.deepEqual(empty.selected(), ['']);
  assert.equal(empty.searchInput.value, '');
  assert.equal(empty.window.location.searchParams.has('category'), false);
  assert.equal(empty.window.location.searchParams.has('q'), false);
  assert.equal(empty.postsList.querySelector('.journal-empty'), empty.welcome, 'reset restores the same authored welcome node');
  assert.equal(empty.emptyState.hidden, true);
  empty.input('月亮');
  assert.equal(empty.postsList.children.length, 0, 'an empty search must show its result state instead of the welcome');
  assert.equal(empty.emptyState.hidden, false);
  assert.match(empty.emptyState.textContent, /还没有找到这篇记录/);
  assert.match(empty.resultsCount.textContent, /共 0 篇文章/);
  empty.click(empty.clearSearch);
  assert.equal(empty.window.location.searchParams.has('q'), false);
  assert.equal(empty.postsList.querySelector('.journal-empty'), empty.welcome, 'clearing search restores the same authored welcome node');
  assert.equal(empty.emptyState.hidden, true);
});

await test('a category link clears search, pushes one canonical URL and lets chapters take over navigation', () => {
  const page = blogBrowser({ url: 'https://gudu.blog/?q=红石#about' });
  const notifications = [];
  page.window.addEventListener('site:category', event => {
    notifications.push({ category: event.detail.category, cancelable: event.cancelable, titles: page.titles() });
    event.preventDefault();
  });
  const event = page.click(page.links.get('minecraft').children[0]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.searchInput.value, '');
  assert.deepEqual(page.selected(), ['minecraft']);
  assert.deepEqual(page.titles(), ['红石矿车', '浮岛建筑']);
  assert.deepEqual(page.history, [{ method: 'pushState', url: 'https://gudu.blog/?category=minecraft#journal' }]);
  assert.deepEqual(notifications, [{ category: 'minecraft', cancelable: true, titles: ['红石矿车', '浮岛建筑'] }]);
  assert.equal(page.scrolls.length, 0, 'a canceled site:category event delegates scrolling to chapters');
});

await test('modified, middle-button and new-tab category clicks retain native link behavior', () => {
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { target: '_blank' }]) {
    const page = blogBrowser({ url: 'https://gudu.blog/?q=红石#about' });
    const link = page.links.get('minecraft');
    if (options.target) link.target = options.target;
    const { target: _target, ...eventOptions } = options;
    let notifications = 0;
    page.window.addEventListener('site:category', () => { notifications += 1; });
    const event = page.click(link.children[0], eventOptions);
    assert.equal(event.defaultPrevented, false, JSON.stringify(options));
    assert.deepEqual(page.history, []);
    assert.equal(notifications, 0);
    assert.equal(page.searchInput.value, '红石');
    assert.deepEqual(page.selected(), ['']);
    assert.deepEqual(page.titles(), ['红石矿车', '红石生活']);
  }
});

await test('selecting a category with no articles stays selected and renders a real empty result', () => {
  const page = blogBrowser();
  page.window.addEventListener('site:category', event => event.preventDefault());
  page.click(page.links.get('daydreams'));
  assert.deepEqual(page.selected(), ['daydreams']);
  assert.deepEqual(page.titles(), []);
  assert.equal(page.emptyState.hidden, false);
  assert.match(page.emptyState.textContent, /这个分类还没有文章/);
  assert.match(page.resultsCount.textContent, /共 0 篇文章/);
  assert.equal(new URL(page.history[0].url).searchParams.get('category'), 'daydreams');
});

await test('refreshing canonical or display-name category URLs restores the same filters and search', () => {
  for (const { name, slug } of expectedCategories) {
    for (const category of [slug, name]) {
      const url = new URL('https://gudu.blog/#journal');
      url.searchParams.set('category', category);
      const page = blogBrowser({ url: url.href });
      assert.deepEqual(page.selected(), [slug]);
      assert.deepEqual(page.titles(), browserPosts.filter(post => post.categorySlug === slug).map(post => post.title));
      assert.deepEqual(page.history, [], 'restoring the URL must not add history');
    }
  }
  const searched = blogBrowser({ url: 'https://gudu.blog/?category=神秘文案&q=月亮#journal' });
  assert.deepEqual(searched.selected(), ['collected']);
  assert.equal(searched.searchInput.value, '月亮');
  assert.deepEqual(searched.titles(), ['月亮收集']);
});

await test('popstate restores category and query together without writing another history entry', () => {
  const page = blogBrowser();
  page.click(page.filters().find(button => button.dataset.category === 'minecraft'));
  page.input('矿车');
  const earlierUrl = page.window.location.href;
  page.window.addEventListener('site:category', event => event.preventDefault());
  page.click(page.links.get('other'));
  assert.deepEqual(page.titles(), ['红石生活']);
  const writes = page.history.length;
  page.popstate(earlierUrl);
  assert.deepEqual(page.selected(), ['minecraft']);
  assert.equal(page.searchInput.value, '矿车');
  assert.deepEqual(page.titles(), ['红石矿车']);
  assert.equal(page.history.length, writes);
  page.popstate('https://gudu.blog/#journal');
  assert.deepEqual(page.selected(), ['']);
  assert.equal(page.searchInput.value, '');
  assert.deepEqual(page.titles(), browserPosts.map(post => post.title));
  assert.equal(page.history.length, writes);
});

await test('search combines with category selection, coalesces typing history and keeps category totals stable', () => {
  const page = blogBrowser();
  page.click(page.filters().find(button => button.dataset.category === 'minecraft'));
  page.input('红石');
  page.input('红石 矿车');
  assert.deepEqual(page.titles(), ['红石矿车']);
  assert.deepEqual(page.history.map(entry => entry.method), ['pushState', 'pushState', 'replaceState']);
  assert.equal(page.window.location.searchParams.get('category'), 'minecraft');
  assert.equal(page.window.location.searchParams.get('q'), '红石 矿车');
  assert.equal(page.counts.get('minecraft').textContent, '02');
  assert.equal(page.filters().find(button => button.dataset.category === 'minecraft').querySelector('.filter-count').textContent, '2');
  page.click(page.clearSearch);
  assert.deepEqual(page.selected(), ['minecraft']);
  assert.deepEqual(page.titles(), ['红石矿车', '浮岛建筑']);
  page.click(page.filters().find(button => button.dataset.category === 'collected'));
  page.input('红石');
  assert.deepEqual(page.selected(), ['collected']);
  assert.deepEqual(page.titles(), []);
  assert.equal(page.emptyState.hidden, false);
  page.click(page.resetFilters);
  assert.deepEqual(page.selected(), ['']);
  assert.equal(page.searchInput.value, '');
  assert.deepEqual(page.titles(), browserPosts.map(post => post.title));
});
