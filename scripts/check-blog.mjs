import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildBlog } from './build-blog.mjs';

const homepage = '<!doctype html><html lang="zh-CN"><title>Fixture</title><main>\n<!-- posts:start --><!-- posts:end -->\n<!-- archive:start --><!-- archive:end -->\n</main></html>\n';
const fixturePost = (overrides = {}) => ({
  slug: 'first-note',
  title: '一篇仅供测试的记录',
  excerpt: '测试内容只写入临时目录。',
  date: '2026-10-14',
  category: '技术',
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
    const metadata = async () => {
      const window = {};
      runInNewContext(await read('js/posts-data.js'), { window }, { timeout: 1000 });
      return JSON.parse(JSON.stringify(window.BLOG_POSTS));
    };
    await run({ root, read, post, metadata });
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), parent, 'Cleanup must remain within the temporary directory.');
    assert.ok(basename(target).startsWith('gudu-blog-test-'), 'Cleanup must target this test fixture.');
    await rm(target, { recursive: true, force: true });
  }
}

await test('an empty blog builds usable pages and a valid empty feed without sample articles', async () => {
  await fixture(async ({ root, read, metadata }) => {
    await buildBlog({ root });
    assert.deepEqual(await metadata(), []);
    const html = await read('index.html');
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
    assert.equal(posts[0].categorySlug, 'tech');
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
