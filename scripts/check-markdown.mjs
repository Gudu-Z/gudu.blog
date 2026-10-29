import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildBlog } from './build-blog.mjs';

const categories = ['minecraft', 'daydreams', 'collected', 'other'];
const homepage = `<!doctype html><html lang="zh-CN"><title>Markdown fixture</title><main>
${categories.map(slug => `<span data-category-count="${slug}">0</span>`).join('\n')}
<!-- posts:start --><!-- posts:end -->
<!-- archive:start --><!-- archive:end -->
</main></html>\n`;
const frontmatter = (attributes = {}, body = '只存在于临时目录中的测试正文。') => `---
${Object.entries({ title: 'Markdown 测试文章', date: '2026-10-29', category: '白日梦话', ...attributes })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}
---

${body}
`;
const legacy = (overrides = {}) => ({
  slug: 'legacy-note', title: '原有 JSON 文章', excerpt: '旧格式也能继续构建。',
  date: '2026-10-01', category: 'Minecraft', tags: [],
  sections: [{ title: '旧章节', blocks: [{ type: 'paragraph', text: '旧正文。' }] }],
  ...overrides,
});

async function fixture(run) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'gudu-markdown-test-'));
  try {
    await mkdir(join(root, 'content', 'posts'), { recursive: true });
    await writeFile(join(root, 'index.html'), homepage, 'utf8');
    const read = filename => readFile(join(root, filename), 'utf8');
    const post = (filename, content) => writeFile(join(root, 'content', 'posts', filename), content, 'utf8');
    const metadata = async () => {
      const window = {};
      runInNewContext(await read('js/posts-data.js'), { window }, { timeout: 1000 });
      return JSON.parse(JSON.stringify(window.BLOG_POSTS));
    };
    await run({ root, read, post, metadata });
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), parent, 'Cleanup must stay in the temporary directory.');
    assert.ok(basename(target).startsWith('gudu-markdown-test-'), 'Cleanup must target this fixture.');
    await rm(target, { recursive: true, force: true });
  }
}

const articleBody = html => html.match(/<article\b[^>]*class="article-body"[^>]*>([\s\S]*?)<div class="article-end">/)?.[1] ?? '';

await test('Markdown and legacy JSON share published ordering, category counts, feeds and draft handling', async () => {
  await fixture(async ({ root, post, read, metadata }) => {
    await post('legacy.json', JSON.stringify(legacy()));
    await post('dream.md', frontmatter({ tags: ['梦', '梦'], featured: true }, '这是 **一场梦**，正文无需 JSON 包装。\n\n## 途中\n\n接着发生的事情。'));
    await post('quotes.markdown', frontmatter({ slug: 'collected-note', date: '2026-10-28', category: '神秘文案', excerpt: '指定摘要。' }, '> 一句有趣的话。'));
    await post('draft.md', frontmatter({ slug: 'private-draft', draft: true }));
    await post('demo.md', frontmatter({ slug: 'demo-preview', demo: true, date: '2026-10-20', category: '其他' }));
    await buildBlog({ root });

    const posts = await metadata();
    assert.deepEqual(posts.map(post => post.slug), ['dream', 'collected-note', 'demo-preview', 'legacy-note']);
    assert.equal(posts[0].categorySlug, 'daydreams');
    assert.equal(posts[0].url, './posts/dream.html');
    assert.equal(posts[0].featured, true);
    assert.deepEqual(posts[0].tags, ['梦']);
    assert.equal(posts[0].excerpt, '这是 一场梦，正文无需 JSON 包装。');
    assert.equal(posts[1].excerpt, '指定摘要。');
    assert.ok(posts.every(post => post.readingMinutes >= 1));
    const home = await read('index.html');
    for (const slug of categories) assert.match(home, new RegExp(`data-category-count="${slug}">01<`));
    assert.doesNotMatch(home, /private-draft/);
    assert.match(await read('posts/dream.html'), /href="\.\/collected-note\.html"/);
    assert.match(await read('posts/legacy-note.html'), /旧正文。/);
    const feed = await read('feed.xml');
    assert.equal(feed.match(/<item>/g)?.length, 3);
    assert.match(feed, /Thu, 29 Oct 2026 00:00:00 GMT/);
    assert.doesNotMatch(feed, /private-draft|demo-preview/);
    assert.doesNotMatch(await read('sitemap.xml'), /private-draft|demo-preview/);
    assert.equal((await readdir(join(root, 'posts'))).includes('private-draft.html'), false);
    assert.match(await read('posts/demo-preview.html'), /name="robots" content="noindex, follow"/);
    await buildBlog({ root, checkOnly: true });
  });
});

await test('ordinary Markdown renders paragraphs, nesting, links, media, code and scrollable tables at build time', async () => {
  await fixture(async ({ root, post, read }) => {
    const code = '  <tag> & "quoted"\n  const answer = 42;\n';
    const body = [
      '开场段落有 **加粗**、*强调*、~~删除~~ 和 `inline <code>`。',
      '', '# 正文大标题', '', '## 章节', '',
      '[外部链接](https://example.com/?a=1&b=2 "链接标题") 与 [站内链接](../index.html#journal)。',
      '', '![示意图](/assets/posts/test.png "图片说明")', '',
      '- 第一项', '  - 嵌套项目', '- 第二项', '', '1. 顺序项目', '2. 下一个项目', '',
      '> 引用 **里面** 的文字。', '', '```html', code.trimEnd(), '```', '',
      '| 标题 | 数值 |', '| :--- | ---: |', '| 测试 | 42 |', '',
      '---', '', '结束。',
    ].join('\n');
    await post('features.md', frontmatter({}, body));
    await buildBlog({ root });
    const html = await read('posts/features.html');
    const rendered = articleBody(html);
    assert.match(rendered, /<strong>加粗<\/strong>/);
    assert.match(rendered, /<em>强调<\/em>/);
    assert.match(rendered, /<s>删除<\/s>/);
    assert.match(rendered, /<code>inline &lt;code&gt;<\/code>/);
    assert.match(rendered, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
    assert.match(rendered, /href="\.\.\/index\.html#journal"/);
    const image = rendered.match(/<img\b[^>]*>/)?.[0];
    assert.ok(image, 'Markdown image must render.');
    assert.match(image, /src="\/assets\/posts\/test\.png"/);
    assert.match(image, /alt="示意图"/);
    assert.match(image, /loading="lazy"/);
    assert.match(image, /decoding="async"/);
    assert.match(rendered, /<ul>[\s\S]*<li>第一项[\s\S]*<ul>[\s\S]*嵌套项目/);
    assert.match(rendered, /<ol>/);
    assert.match(rendered, /<blockquote>[\s\S]*引用 <strong>里面<\/strong>/);
    assert.match(rendered, /class="code-block"/);
    assert.match(rendered, /class="code-language">html<\/span>/);
    assert.ok(rendered.includes('  &lt;tag&gt; &amp; &quot;quoted&quot;\n  const answer = 42;\n</code>'));
    assert.match(rendered, /class="markdown-table"/);
    assert.match(rendered, /<div class="markdown-table"[^>]*tabindex="0"/);
    assert.match(rendered, /<table>/);
    assert.match(rendered, /<th[^>]*>标题<\/th>/);
    assert.match(rendered, /<hr\s*\/?>/);
    assert.equal(html.match(/<h1\b/g)?.length, 1, 'Article title is the sole h1.');
    assert.doesNotMatch(html, /<script[^>]+(?:markdown-it|yaml|markdown\.mjs)/);
    const metadataSource = await read('js/posts-data.js');
    assert.doesNotMatch(metadataSource, /"(?:html|bodyHTML|contentHTML|headings|sections)"\s*:/);
    assert.doesNotMatch(metadataSource, /code-block|markdown-table|&lt;tag&gt;/);
  });
});

await test('Chinese and repeated headings have unique matching TOC anchors, while opening prose remains intact', async () => {
  await fixture(async ({ root, post, read }) => {
    const body = '开始时先写一段正文。\n\n## 同一个标题\n\n第一节。\n\n### 小节\n\n小节内容。\n\n## 同一个标题\n\n第二节。\n\n## 同一个标题-2\n\n第三节。\n\n## main-content\n\n第四节。';
    await post('headings.md', frontmatter({}, body));
    await buildBlog({ root });
    const html = await read('posts/headings.html');
    const rendered = articleBody(html);
    assert.ok(rendered.indexOf('开始时先写一段正文。') < rendered.indexOf('<h2'));
    const ids = [...rendered.matchAll(/<h[2-6]\b[^>]*id="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes('main-content'));
    const anchors = [...html.matchAll(/data-toc-link\b[^>]*href="#([^"]+)"/g)].map(match => decodeURIComponent(match[1]));
    assert.deepEqual(anchors, ids);
    const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(allIds).size, allIds.length, 'Heading ids must not collide with page chrome.');
  });
});

await test('heading-free posts, first-paragraph excerpts and explicit summaries work without fabricated sections', async () => {
  await fixture(async ({ root, post, read, metadata }) => {
    await post('plain.md', '\uFEFF' + frontmatter({}, '一个 **简单** 的开头。\n\n不应该进入摘要的第二段。').replaceAll('\n', '\r\n'));
    await post('summary.md', frontmatter({ summary: '作者提供的摘要。' }, '正文不同。'));
    await post('excerpt.md', frontmatter({ excerpt: '首选摘要。', summary: '备选摘要。' }, '正文不同。'));
    await post('long.md', frontmatter({}, '长'.repeat(900)));
    await buildBlog({ root });
    const posts = await metadata();
    assert.equal(posts.find(post => post.slug === 'plain').excerpt, '一个 简单 的开头。');
    assert.equal(posts.find(post => post.slug === 'summary').excerpt, '作者提供的摘要。');
    assert.equal(posts.find(post => post.slug === 'excerpt').excerpt, '首选摘要。');
    assert.ok([...posts.find(post => post.slug === 'long').excerpt].length <= 161);
    assert.ok(posts.find(post => post.slug === 'long').readingMinutes >= 3, 'Reading time includes the Markdown body.');
    const html = await read('posts/plain.html');
    const rendered = articleBody(html);
    assert.match(rendered, /<p>一个 <strong>简单<\/strong> 的开头。<\/p>/);
    assert.doesNotMatch(rendered, /<h[1-6]\b/);
    assert.doesNotMatch(html, /data-toc-link/);
  });
});

await test('ordinary unquoted YAML dates, multiline tags and uppercase Markdown extensions are accepted', async () => {
  await fixture(async ({ root, post, metadata }) => {
    await post('yaml-note.MD', '---\ntitle: 无引号的标题\ndate: 2026-10-29\ncategory: Minecraft\ntags:\n  - 建筑\n  - 探索\ndraft: false\n---\n\n直接书写的正文。\n');
    await buildBlog({ root });
    const [article] = await metadata();
    assert.equal(article.slug, 'yaml-note');
    assert.equal(article.date, '2026-10-29');
    assert.equal(article.title, '无引号的标题');
    assert.equal(article.categorySlug, 'minecraft');
    assert.deepEqual(article.tags, ['建筑', '探索']);
  });
});

await test('raw HTML and unsafe URL protocols cannot become active article markup', async () => {
  await fixture(async ({ root, post, read }) => {
    const payload = [
      '<script>alert("raw")</script>', '', '<img src=x onerror="alert(1)">', '',
      '[unsafe](javascript:alert%281%29)', '', '[encoded](jav&#x61;script:alert%281%29)', '',
      '[file](file:///secret.txt)', '', '![data](data:text/html;base64,PHNjcmlwdD4=)', '',
      '[safe](https://example.com/) 与 [邮件](mailto:test@example.com)', '',
      '```html', '<svg onload="alert(1)"></svg>', '```',
    ].join('\n');
    await post('safe.md', frontmatter({ title: '<script>metadata</script>', excerpt: '" & <b>摘要</b>' }, payload));
    await buildBlog({ root });
    const html = await read('posts/safe.html');
    const rendered = articleBody(html);
    assert.doesNotMatch(rendered, /<(?:script|iframe|svg)\b/i);
    assert.doesNotMatch(rendered, /<[^>]+\bon(?:error|load)\s*=/i);
    assert.doesNotMatch(rendered, /\b(?:href|src)="(?:javascript|data|file|vbscript):/i);
    assert.match(rendered, /&lt;script&gt;/);
    assert.match(rendered, /href="https:\/\/example\.com\/"/);
    assert.match(rendered, /href="mailto:test@example\.com"/);
    assert.doesNotMatch(html, /<script>metadata/);
    assert.match(html, /&lt;script&gt;metadata&lt;\/script&gt;/);
    assert.doesNotMatch(await read('js/posts-data.js'), /<script>/);
  });
});

await test('malformed Markdown metadata fails with source context before writing any generated file', async t => {
  const cases = [
    ['missing front matter', '正文，没有头部。'],
    ['unterminated front matter', '---\ntitle: example\n正文。'],
    ['duplicate YAML keys', frontmatter().replace('title: "Markdown 测试文章"', 'title: first\ntitle: second')],
    ['custom YAML tag', frontmatter().replace('title: "Markdown 测试文章"', 'title: !unknown title')],
    ['sequence front matter', '---\n- title\n- date\n---\n正文。'],
    ['malformed YAML', '---\ntitle: [missing\n---\n正文。'],
    ['empty Markdown body', frontmatter({}, '')],
    ['invalid date', frontmatter({ date: '2026-02-30' })],
    ['empty title', frontmatter({ title: '' })],
    ['missing category', frontmatter().replace('category: "白日梦话"\n', '')],
    ['string draft', frontmatter({ draft: 'false' })],
    ['invalid tags', frontmatter({ tags: 'story' })],
    ['unsafe slug', frontmatter({ slug: '../escape' })],
  ];
  for (const [name, source] of cases) {
    await t.test(name, async () => {
      await fixture(async ({ root, post, read }) => {
        await post('broken.md', source);
        await assert.rejects(buildBlog({ root }), /broken\.md/);
        assert.equal(await read('index.html'), homepage);
        assert.equal((await readdir(root)).includes('feed.xml'), false);
      });
    });
  }
  await t.test('duplicate routes across Markdown and JSON', async () => {
    await fixture(async ({ root, post, read }) => {
      await post('first.md', frontmatter({ slug: 'same-route' }));
      await post('legacy.json', JSON.stringify(legacy({ slug: 'same-route' })));
      await assert.rejects(buildBlog({ root }), /slug.*same-route/);
      assert.equal(await read('index.html'), homepage);
      assert.equal((await readdir(root)).includes('feed.xml'), false);
    });
  });
});

await test('editing, drafting and deleting Markdown keeps generated pages current without changing manual pages', async () => {
  await fixture(async ({ root, post, read, metadata }) => {
    await post('note.md', frontmatter({}, '原来正文。'));
    await buildBlog({ root });
    const before = await read('posts/note.html');
    await writeFile(join(root, 'posts', 'manual.html'), '<p>手工页面。</p>', 'utf8');
    await post('note.md', frontmatter({}, '修改后的正文。'));
    await assert.rejects(buildBlog({ root, checkOnly: true }), /note\.html/);
    assert.equal(await read('posts/note.html'), before, 'Check-only must not update stale output.');
    await buildBlog({ root });
    assert.match(await read('posts/note.html'), /修改后的正文。/);
    await post('note.md', frontmatter({ draft: true }));
    await buildBlog({ root });
    assert.deepEqual(await metadata(), []);
    assert.deepEqual(await readdir(join(root, 'posts')), ['manual.html']);
    await post('note.md', frontmatter());
    await buildBlog({ root });
    await rm(join(root, 'content', 'posts', 'note.md'));
    await assert.rejects(buildBlog({ root, checkOnly: true }), /note\.html/);
    await buildBlog({ root });
    assert.deepEqual(await readdir(join(root, 'posts')), ['manual.html']);
    assert.equal(await read('posts/manual.html'), '<p>手工页面。</p>');
    await buildBlog({ root, checkOnly: true });
  });
});
