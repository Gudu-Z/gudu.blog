import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { applyDefaults, preSave } = require('../services/comments/policy.cjs');
const service = new URL('../services/comments/', import.meta.url);

await test('comment policy rejects missing, non-text and whitespace-only nicknames', () => {
  for (const comment of [null, undefined, {}, { nick: null }, { nick: 123 }, { nick: '' }, { nick: ' \t\n\u3000' }]) {
    assert.equal(preSave(comment)?.errmsg, '请填写昵称。');
  }
});

await test('readers can comment without an email or account; a valid nickname is trimmed', () => {
  for (const mail of [undefined, '']) {
    const comment = { nick: '  读者 🌙  ', comment: '<p>谢谢分享。</p>', mail };
    assert.equal(preSave(comment), undefined);
    assert.equal(comment.nick, '读者 🌙');
    assert.equal(comment.mail, mail);
    assert.equal(comment.comment, '<p>谢谢分享。</p>');
  }
});

await test('service defaults require review and rate limit without inventing database credentials', () => {
  const env = {};
  applyDefaults(env);
  assert.equal(env.COMMENT_AUDIT, 'true');
  assert.equal(env.IPQPS, '60');
  assert.equal(env.LOGIN, 'disable');
  assert.equal(env.DISABLE_REGION, 'true');
  assert.equal(env.DISABLE_USERAGENT, 'true');
  assert.equal(env.SECURE_DOMAINS, 'gudu.blog');
  assert.equal(env.AKISMET_KEY, 'false');
  assert.ok(!Object.keys(env).some(key => /POSTGRES|DATABASE|PASSWORD|TOKEN|SECRET/.test(key)));
});

await test('explicit hosting configuration is preserved while empty defaults are repaired', () => {
  const env = { COMMENT_AUDIT: 'false', IPQPS: '90', SECURE_DOMAINS: 'gudu.blog,comments.example.test', SITE_NAME: '' };
  applyDefaults(env);
  assert.equal(env.COMMENT_AUDIT, 'false');
  assert.equal(env.IPQPS, '90');
  assert.equal(env.SECURE_DOMAINS, 'gudu.blog,comments.example.test');
  assert.equal(env.SITE_NAME, 'Gudu 的个人博客');
});

await test('entry configures defaults before loading Waline and registers the policy hook', async () => {
  const env = {};
  const module = { exports: {} };
  const handler = () => {};
  runInNewContext(await readFile(new URL('index.cjs', service), 'utf8'), {
    process: { env }, module,
    require(name) {
      if (name === './policy.cjs') return { applyDefaults, preSave };
      assert.equal(name, '@waline/vercel');
      assert.equal(env.COMMENT_AUDIT, 'true');
      assert.equal(env.IPQPS, '60');
      return options => {
        assert.equal(options.preSave, preSave);
        return handler;
      };
    },
  }, { timeout: 1000 });
  assert.equal(module.exports, handler);
});

await test('Vercel routes serve the prepared entry and use an exact server version', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', service), 'utf8'));
  assert.equal(manifest.dependencies['@waline/vercel'], '1.43.4');
  assert.equal(manifest.engines.node, '24.x');
  const config = JSON.parse(await readFile(new URL('vercel.json', service), 'utf8'));
  assert.ok(config.builds.some(build => build.src === 'index.cjs' && build.use === '@vercel/node'));
  assert.ok(config.rewrites.some(route => route.destination === 'index.cjs'));
  assert.match(await readFile(new URL('.gitignore', service), 'utf8'), /^\.env$/m);
  assert.match(await readFile(new URL('robots.txt', service), 'utf8'), /^Disallow: \/$/m);
});
