import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildBlog } from './build-blog.mjs';
import { articleFontDirectory, syncArticleFonts } from './article-fonts.mjs';

const expectedCategories = [
  { name: 'Minecraft', slug: 'minecraft', code: 'GAME JOURNAL', description: '关于 Minecraft 游戏的文章。' },
  { name: '白日梦话', slug: 'daydreams', code: 'DAYDREAMS', description: '离奇的小故事，像做梦一样。' },
  { name: '神秘文案', slug: 'collected', code: 'COLLECTED WORDS', description: '从互联网上收集的有趣文案。' },
  { name: '其他', slug: 'other', code: 'MISCELLANY', description: '其他一些东西。' },
];
const homepage = `<!doctype html><html lang="zh-CN"><title>Fixture</title><main>
${expectedCategories.map(({ slug, name }) => `<div class="category-column" data-category-slug="${slug}">
  <div class="category-display"><!-- catalog-${slug}:start --><!-- catalog-${slug}:end --></div>
  <strong class="category-name">${name}</strong><p class="category-description">手写的分类说明。</p>
  <span data-category-count="${slug}">0</span>
</div>`).join('\n')}
<!-- posts:start --><!-- posts:end -->
<!-- archive:start --><!-- archive:end -->
</main></html>\n`;
const catalogBlock = (html, slug) => html.split(`<!-- catalog-${slug}:start -->`)[1].split(`<!-- catalog-${slug}:end -->`)[0];
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
    for (const { slug } of expectedCategories) {
      assert.match(html, new RegExp(`data-category-count="${slug}">00<`));
      const block = catalogBlock(html, slug);
      assert.match(block, /<div class="catalog-block" hidden inert>/);
      assert.match(block, /<p class="catalog-empty"><span class="catalog-empty-count" aria-hidden="true">00<\/span><span class="catalog-empty-code" aria-hidden="true">NO ENTRIES<\/span><span class="catalog-empty-text">这个分类还没有文章<br \/>写好的文章会归到这里。<\/span><\/p>/);
      assert.doesNotMatch(block, /<ol|class="catalog-group"/);
    }
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
    assert.equal(posts[0].subcategory, '<tag>');
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
    assert.ok(article.includes('<a class="article-category" href="../index.html#catalog-minecraft">Minecraft</a>'));
    assert.ok(article.includes('<dt>子分类 <span aria-hidden="true">/ SUBCATEGORY</span></dt><dd>&lt;tag&gt;</dd>'));
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

await test('each article lists every published article by category and series beside it, opening its own category, in a cut shared by every page', async () => {
  await fixture(async ({ read, post, root }) => {
    await post('a.json', fixturePost({ slug: 'mine-new', title: '新的红石', date: '2026-10-20', subcategory: '红石' }));
    await post('b.json', fixturePost({ slug: 'mine-old', title: '旧的红石', date: '2026-09-01', subcategory: '红石' }));
    await post('f.json', fixturePost({ slug: 'mine-house', title: '一座房子', date: '2026-09-15', subcategory: '建筑' }));
    await post('g.json', fixturePost({ slug: 'mine-loose', title: '随手一记', date: '2026-10-25', tags: [] }));
    await post('c.json', fixturePost({ slug: 'dream', title: '一个梦', date: '2026-10-30', category: '白日梦话' }));
    await post('d.json', fixturePost({ slug: 'odd', title: '<随手>', date: '2026-08-08', category: '随笔' }));
    await post('e.json', fixturePost({ slug: 'hidden', title: '草稿', draft: true }));
    await buildBlog({ root });
    const page = await read('posts/mine-old.html');
    const index = page.match(/<nav class="article-index" aria-label="文章目录">([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(index, 'the article index is a labelled navigation');
    assert.ok(index.startsWith('<div class="index-scroll"><div class="index-groups"><details'), 'the categories name themselves; the list shows no heading');
    // Categories in the catalog's order without empty ones, unknown labels under 其他;
    // only this article's category is open.
    assert.deepEqual([...index.matchAll(/<details class="index-group"( open)?><summary class="index-group-label">([^<]*) <span aria-hidden="true">\/ ([^<]*)<\/span><\/summary>/g)].map(match => `${match[2]} ${match[3]}${match[1] ? ' open' : ''}`),
      ['Minecraft GAME JOURNAL · 04 open', '白日梦话 DAYDREAMS · 01', '其他 MISCELLANY · 01']);
    // Series in the order of their newest article, each newest first; articles of no
    // series after them, straight under the category; drafts left out.
    const minecraft = index.split('<details')[1];
    assert.deepEqual([...minecraft.matchAll(/<p class="index-series-label"><span aria-hidden="true">\/\/<\/span> ([^<]*) <span aria-hidden="true">· (\d+)<\/span><\/p>/g)].map(match => `${match[1]} ${match[2]}`), ['红石 02', '建筑 01']);
    assert.deepEqual([...index.matchAll(/href="\.\/([^"]+)\.html"/g)].map(match => match[1]), ['mine-new', 'mine-old', 'mine-house', 'mine-loose', 'dream', 'odd']);
    assert.ok(minecraft.includes('</ol></li><li><a href="./mine-loose.html">随手一记</a></li></ol></details>'), 'an article of no series hangs from the category itself');
    assert.doesNotMatch(index, /未分组/);
    assert.ok(index.includes('<a href="./mine-old.html" aria-current="page">旧的红石</a>'));
    assert.ok(index.includes('<a href="./odd.html">&lt;随手&gt;</a>'));
    assert.doesNotMatch(index, /<time/, 'entries name their titles alone');
    assert.equal(index.match(/aria-current/g).length, 1, 'only this article is marked');
    assert.doesNotMatch(index, /\.\/hidden\.html|草稿/);
    assert.match((await read('posts/dream.html')).match(/<nav class="article-index"[\s\S]*?<\/nav>/)[0], /<details class="index-group"><summary class="index-group-label">Minecraft[\s\S]*<details class="index-group" open><summary class="index-group-label">白日梦话/,
      'another article opens its own category instead');
    // The contents keep their own name, so the two navigations differ.
    assert.ok(page.includes('<aside class="article-toc" aria-label="本文目录">'));
    // Every page names the same index cut, and the article's own cuts leave the list out.
    const cut = html => html.match(/assets\/fonts\/articles\/site-index-[0-9a-f]{10}\.woff2/g);
    assert.equal(new Set([...cut(page), ...cut(await read('posts/dream.html'))]).size, 1);
    assert.ok(page.includes('@font-face { font-family: "Gudu Index"; src: url("../assets/fonts/articles/site-index-'));
  });
});

await test('each catalog block groups cards by effective subcategory, newest first and ungrouped last', async () => {
  await fixture(async ({ root, read, post, metadata }) => {
    // A blank YAML value uses the same fallback as omitting the field.
    await writeFile(join(root, 'content/posts/newest.md'), '---\ntitle: 最新文章\ndate: 2026-11-21\ncategory: Minecraft\nsubcategory:\n---\n正文。\n');
    await post('rail.json', fixturePost({ slug: 'rail', date: '2026-11-10', subcategory: '  线路 & 车站  ' }));
    await post('tower.json', fixturePost({ slug: 'tower', date: '2026-11-09', subcategory: ' ', tags: [' 建筑 ', '城堡'] }));
    await post('bridge.json', fixturePost({ slug: 'bridge', date: '2026-10-06', tags: ['线路 & 车站'] }));
    await buildBlog({ root });
    assert.deepEqual((await metadata()).map(p => p.subcategory), ['未分组', '线路 & 车站', '建筑', '线路 & 车站']);
    const html = await read('index.html');
    const catalog = catalogBlock(html, 'minecraft');
    const groups = [...catalog.matchAll(/<section class="catalog-group" aria-label="([^"]+)">([\s\S]*?)<\/section>/g)];
    assert.deepEqual(groups.map(match => match[1]), ['线路 &amp; 车站', '建筑', '未分组']);
    const cards = groups.map(match => [...match[2].matchAll(/<li><a class="catalog-card" href="\.\/posts\/([^"]+)\.html">/g)].map(card => card[1]));
    assert.deepEqual(cards, [['rail', 'bridge'], ['tower'], ['newest']]);
    assert.ok(groups.every(match => match[2].includes('<ol class="catalog-cards">')));
    assert.ok(groups[0][2].includes('<span class="catalog-group-count"><span class="sr-only">共</span>02<span class="sr-only">篇</span></span>'));
    assert.equal(html.match(/class="catalog-empty"/g)?.length, 3);
    assert.doesNotMatch(catalog, /class="catalog-empty"/);
    await writeFile(join(root, 'index.html'), html.replace(catalog, catalog.replace('线路 &amp; 车站', '过期')));
    await assert.rejects(buildBlog({ root, checkOnly: true }), /index\.html/);
    await buildBlog({ root });
    assert.equal(await read('index.html'), html);
  });
});

await test('the builder preserves the owner’s category markup outside the counts and display blocks', async () => {
  await fixture(async ({ root, read, post }) => {
    const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const columns = page.slice(page.indexOf('<div class="category-columns">'), page.indexOf('<section class="journal-section'));
    const edited = columns.replace(/(<span class="category-description">)[\s\S]*?(<\/span>)/, '$1作者新写的 <em>Minecraft</em> 说明。$2');
    assert.notEqual(edited, columns);
    const normalize = html => html
      .replace(/(<!-- catalog-([a-z-]+):start -->)[\s\S]*?(<!-- catalog-\2:end -->)/g, '$1$3')
      .replace(/(data-category-count="[^"]+">)\d+(<)/g, '$1$2');
    await writeFile(join(root, 'index.html'), `${edited}<!-- posts:start --><!-- posts:end --><!-- archive:start --><!-- archive:end -->`);
    await post('note.json', fixturePost({ category: '白日梦话' }));
    await buildBlog({ root });
    const built = await read('index.html');
    assert.equal(normalize(built.split('<!-- posts:start -->')[0]), normalize(edited));
    assert.match(catalogBlock(built, 'daydreams'), /href="\.\/posts\/first-note\.html"/);
    assert.match(catalogBlock(built, 'minecraft'), /class="catalog-empty"/);
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

await test('each article loads Noto Sans SC cuts of its own words: the title in Black, the prose in Regular and SemiBold', async () => {
  await fixture(async ({ root, read }) => {
    const made = [];
    const cut = async (characters, weight) => { made.push(`${weight}:${characters}`); return Buffer.from(`${weight}:${characters}`); };
    const sorted = text => [...new Set(text)].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('');
    const directory = join(root, articleFontDirectory);
    const note = title => writeFile(join(root, 'content', 'posts', 'note.md'), `---\ntitle: ${title}\ndate: 2026-10-14\ncategory: Minecraft\n---\n\n正文 Text 一段，**加粗**。\n\n## 小节\n\n\`\`\`js\n// 代码里的字\n\`\`\`\n`, 'utf8');
    const named = fonts => Object.fromEntries(fonts.map(font => [font.path.match(/-(title|body|bold|index)-/)[1], font.path]));

    await note('红石 Red 红石');
    let { fonts } = await buildBlog({ root });
    let paths = named(fonts);
    assert.deepEqual(Object.keys(paths), ['title', 'body', 'bold', 'index']);
    for (const path of Object.values(paths)) assert.match(path, /^assets\/fonts\/articles\/(note-(title|body|bold)|site-index)-[0-9a-f]{10}\.woff2$/);
    const html = await read('posts/note.html');
    for (const path of Object.values(paths)) assert.ok(html.includes(`<link rel="preload" href="../${path}" as="font" type="font/woff2" crossorigin />`));
    assert.ok(html.includes(`@font-face { font-family: "Gudu Title"; src: url("../${paths.title}") format("woff2"); font-weight: 900; font-display: block; }`));
    assert.ok(html.includes(`@font-face { font-family: "Gudu Body"; src: url("../${paths.body}") format("woff2"); font-weight: 400; font-display: swap; }`));
    assert.ok(html.includes(`@font-face { font-family: "Gudu Body"; src: url("../${paths.bold}") format("woff2"); font-weight: 600 700; font-display: swap; }`));
    assert.ok(html.includes(`@font-face { font-family: "Gudu Index"; src: url("../${paths.index}") format("woff2"); font-weight: 400; font-display: swap; }`));

    await assert.rejects(syncArticleFonts({ root, fonts, checkOnly: true, cut }), /note-title-/);
    await syncArticleFonts({ root, fonts, cut });
    // The title keeps every character. The prose keeps Han and CJK punctuation
    // from the text, headings and closing line, and from the page's own chrome
    // (back link, facts, contents, neighbours, foot bar), but nothing from code.
    // The article index has a cut of its own: its categories, series and titles.
    const prose = '正文一段，加粗。小节' + '本文完。谢谢你的阅读。';
    const chrome = '返回文章列表' + '分类子分类未分组发布阅读标签' + '约分钟' + '本文目录' + '上一篇下一篇已到达这一端' + '在自己的轨道上，保持好奇。' + '订阅';
    assert.deepEqual(made, ['900: Rde石红', `400:${sorted(prose + chrome)}`, `600:${sorted('加粗小节' + '已到达这一端')}`, `400:${sorted('红石')}`]);
    assert.ok(!made[1].includes('代'), 'code stays out of the cut');
    assert.equal(await readFile(join(root, paths.body), 'utf8'), made[1]);
    await syncArticleFonts({ root, fonts, checkOnly: true, cut });
    await syncArticleFonts({ root, fonts, cut });
    assert.equal(made.length, 4, 'Unchanged words keep their cuts.');

    await writeFile(join(directory, 'hand-made.woff2'), 'keep', 'utf8');
    await note('红石矿车');
    ({ fonts } = await buildBlog({ root }));
    const renamed = named(fonts);
    assert.notEqual(renamed.title, paths.title);
    assert.equal(renamed.body, paths.body, 'A new title leaves the prose cuts alone.');
    assert.notEqual(renamed.index, paths.index, 'The index cut follows the titles.');
    await assert.rejects(syncArticleFonts({ root, fonts, checkOnly: true, cut }), /note-title-/);
    await syncArticleFonts({ root, fonts, cut });
    assert.deepEqual(made.slice(4), ['900: 石矿红车', `400:${sorted('红石矿车')}`]);
    assert.deepEqual((await readdir(directory)).sort(), ['hand-made.woff2', ...Object.values(renamed).map(path => path.split('/').pop())].sort());
  });
});

await test('invalid or ambiguous content fails before generating published files', async t => {
  const cases = [
    ['path traversal slug', { slug: '../escape' }, /slug/],
    ['impossible calendar date', { date: '2026-02-30' }, /date/],
    ['empty title', { title: ' ' }, /title/],
    ['non-string subcategory', { subcategory: ['红石'] }, /subcategory/],
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
    link.className = 'category-column';
    link.dataset.catalogLink = slug;
    link.href = `#catalog-${slug}`;
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

await test('catalog columns leave journal query, filters and navigation to their respective controls', () => {
  for (const options of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { target: '_blank' }]) {
    const page = blogBrowser({ url: 'https://gudu.blog/?category=other&q=红石#series' });
    const link = page.links.get('minecraft');
    if (options.target) link.target = options.target;
    const { target: _target, ...eventOptions } = options;
    const event = page.click(link.children[0], eventOptions);
    assert.equal(event.defaultPrevented, false, JSON.stringify(options));
    assert.deepEqual(page.history, []);
    assert.equal(page.scrolls.length, 0);
    assert.equal(page.searchInput.value, '红石');
    assert.deepEqual(page.selected(), ['other']);
    assert.deepEqual(page.titles(), ['红石生活']);
  }
});

await test('selecting a category with no articles stays selected and renders a real empty result', () => {
  const page = blogBrowser();
  page.click(page.filters().find(button => button.dataset.category === 'daydreams'));
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
  page.click(page.filters().find(button => button.dataset.category === 'other'));
  page.click(page.clearSearch);
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
