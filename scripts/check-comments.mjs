import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildBlog } from './build-blog.mjs';
import { readCommentsConfig } from './comments.mjs';

const homepage = '<main><!-- posts:start --><!-- posts:end --><!-- archive:start --><!-- archive:end --></main>';
const article = (meta = '', body = '正文。') => `---\ntitle: 测试文章\nslug: test-note\ndate: 2026-10-30\ncategory: 白日梦话\n${meta}\n---\n\n${body}\n`;

async function fixture(run) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'gudu-comments-test-'));
  try {
    await mkdir(join(root, 'content/posts'), { recursive: true });
    await writeFile(join(root, 'index.html'), homepage);
    const read = file => readFile(join(root, file), 'utf8');
    const post = source => writeFile(join(root, 'content/posts/test-note.md'), source);
    const config = value => writeFile(join(root, 'content/comments.json'), JSON.stringify(value));
    await run({ root, read, post, config });
  } finally {
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith('gudu-comments-test-'));
    await rm(root, { recursive: true, force: true });
  }
}

await test('missing or blank service URL produces no comment UI or browser requests', async () => {
  await fixture(async ({ root, read, post, config }) => {
    await post(article());
    for (const settings of [null, { serverURL: '', turnstileKey: '' }]) {
      if (settings) await config(settings);
      await buildBlog({ root });
      assert.doesNotMatch(await read('posts/test-note.html'), /data-comments|js\/comments|css\/comments|id="waline"/);
      assert.doesNotMatch(await read('index.html'), /waline|js\/comments|css\/comments/);
      assert.match(await read('assets/vendor/waline/LICENSE.txt'), /MIT License/);
      await buildBlog({ root, checkOnly: true });
    }
  });
});

await test('enabled comments have a stable per-post path, unique IDs and remain outside reading progress', async () => {
  await fixture(async ({ root, read, post, config }) => {
    await config({ serverURL: 'https://comments.example.test/', turnstileKey: '' });
    await post(article('', '## comments\n\n正文。\n\n## comments-title\n\n## waline'));
    await buildBlog({ root });
    const html = await read('posts/test-note.html');
    assert.match(html, /data-server-url="https:\/\/comments\.example\.test"/);
    assert.match(html, /data-comment-path="\/posts\/test-note\.html"/);
    assert.match(html, /data-site-origin="https:\/\/gudu\.blog"/);
    assert.match(html, /昵称必填，邮箱选填/);
    assert.match(html, /<noscript>/);
    assert.match(html, /js\/comments\.js[^" ]*" defer/);
    assert.ok(html.indexOf('data-comments ') > html.indexOf('</article>'));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['comments-2', 'comments-title-2', 'waline-2']) assert.ok(ids.includes(id));
    assert.doesNotMatch(await read('js/posts-data.js'), /serverURL|turnstile|"comments"/);
    assert.doesNotMatch(await read('404.html'), /js\/comments|data-comments/);
    await post(article().replace('测试文章', '更新后的标题'));
    await buildBlog({ root });
    assert.match(await read('posts/test-note.html'), /data-comment-path="\/posts\/test-note\.html"/);
    await writeFile(join(root, 'assets/vendor/waline/waline.umd.js'), 'outdated');
    await assert.rejects(buildBlog({ root, checkOnly: true }), /assets\/vendor\/waline\/waline\.umd\.js/);
  });
});

await test('individual opt-out and demo articles do not load comments; drafts remain unpublished', async () => {
  await fixture(async ({ root, read, post, config }) => {
    await config({ serverURL: 'https://comments.example.test' });
    for (const meta of ['comments: false', 'demo: true']) {
      await post(article(meta));
      await buildBlog({ root });
      assert.doesNotMatch(await read('posts/test-note.html'), /data-comments|js\/comments|css\/comments/);
    }
    await post(article('draft: true'));
    await buildBlog({ root });
    await assert.rejects(read('posts/test-note.html'), { code: 'ENOENT' });
    await post(article('comments: "false"'));
    await assert.rejects(buildBlog({ root }), /comments 必须是布尔值/);
  });
});

await test('service config rejects unsafe URLs, credentials and misplaced secret fields', async () => {
  await fixture(async ({ root, config }) => {
    for (const value of [null, [], { serverURL: 1 }, { serverURL: 'javascript:alert(1)' },
      { serverURL: 'http://comments.example.test' }, { serverURL: '/api' },
      { serverURL: 'https://user:password@comments.example.test' },
      { serverURL: 'https://comments.example.test?token=secret' },
      { serverURL: 'https://comments.example.test#fragment' },
      { serverURL: '', TURNSTILE_SECRET: 'not-for-the-browser' }]) {
      await config(value);
      await assert.rejects(readCommentsConfig(root));
    }
    await config({ serverURL: 'http://127.0.0.1:4175/', turnstileKey: '' });
    assert.equal((await readCommentsConfig(root)).serverURL, 'http://127.0.0.1:4175');
    await config({ serverURL: ' https://comments.example.test/prefix/ ' });
    assert.equal((await readCommentsConfig(root)).serverURL, 'https://comments.example.test/prefix');
  });
});

await test('legacy JSON sections cannot shadow comment anchors', async () => {
  await fixture(async ({ root }) => {
    for (const id of ['comments', 'comments-title', 'waline']) {
      await writeFile(join(root, 'content/posts/legacy.json'), JSON.stringify({
        title: '旧文章', slug: 'legacy', date: '2026-10-30', category: '其他', excerpt: '旧格式。',
        sections: [{ id, title: '章节', blocks: [{ type: 'paragraph', text: '正文。' }] }],
      }));
      await assert.rejects(buildBlog({ root }), /页面保留锚点/);
    }
  });
});
