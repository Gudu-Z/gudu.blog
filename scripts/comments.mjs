import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDirectory = dirname(fileURLToPath(import.meta.resolve('@waline/client/package.json')));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export async function readCommentsConfig(root) {
  const source = await readFile(resolve(root, 'content/comments.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  let config;
  try { config = JSON.parse(source); }
  catch { throw new Error('content/comments.json 必须是有效的 JSON。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('content/comments.json 必须是配置对象。');
  for (const key of Object.keys(config)) {
    if (!['serverURL', 'turnstileKey'].includes(key)) throw new Error(`content/comments.json 不支持 ${key}；此文件只能放公开的服务地址与 Turnstile site key。`);
    if (typeof config[key] !== 'string') throw new Error(`content/comments.json 的 ${key} 必须是字符串。`);
  }
  const serverURL = (config.serverURL ?? '').trim();
  const turnstileKey = (config.turnstileKey ?? '').trim();
  if (!serverURL) return { serverURL: '', turnstileKey };
  let url;
  try { url = new URL(serverURL); }
  catch { throw new Error('评论 serverURL 需要完整的 HTTPS 服务地址。'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) || url.username || url.password || url.search || url.hash) {
    throw new Error('评论 serverURL 需要不含账号、密码、查询参数或锚点的 HTTPS 地址；仅本机测试允许 HTTP。');
  }
  return { serverURL: url.href.replace(/\/+$/, ''), turnstileKey };
}

export function renderComments(post, config, site) {
  if (!config.serverURL || post.demo || !post.comments) return { head: '', body: '' };
  return {
    head: '<link rel="stylesheet" href="../css/comments.css?v=20261030-comments" />\n    <script src="../js/comments.js?v=20261030-comments" defer></script>',
    body: `<section class="article-comments" id="comments" aria-labelledby="comments-title" data-comments data-server-url="${escape(config.serverURL)}" data-comment-path="/posts/${post.slug}.html" data-site-origin="${escape(site)}" data-turnstile-key="${escape(config.turnstileKey)}">
        <h2 id="comments-title">读者评论</h2>
        <p class="article-comments-intro">留下你的想法。昵称必填，邮箱选填，无需注册；评论审核后显示。邮箱不会公开显示。</p>
        <p class="article-comments-status" data-comments-status role="status" aria-live="polite" hidden></p>
        <button class="article-comments-retry" data-comments-retry type="button" hidden>重新加载评论</button>
        <div id="waline" data-comments-thread></div>
        <noscript><p class="article-comments-status">启用 JavaScript 后即可查看和发表评论。</p></noscript>
      </section>`,
  };
}

// Keep the exact installed browser bundles on the site. Readers do not depend on a CDN.
export async function commentsAssets() {
  const files = [
    ['dist/waline.umd.js', 'waline.umd.js'],
    ['dist/waline.css', 'waline.css'],
    ['LICENSE', 'LICENSE.txt'],
  ];
  const artifacts = await Promise.all(files.map(async ([source, target]) => {
    const content = await readFile(resolve(clientDirectory, source), 'utf8');
    return [`assets/vendor/waline/${target}`, content.replace(/\n?\/\/[#@] sourceMappingURL=[^\r\n]*/g, '').replace(/\/\*[#@] sourceMappingURL=[\s\S]*?\*\//g, '')];
  }));
  const { version } = JSON.parse(await readFile(resolve(clientDirectory, 'package.json'), 'utf8'));
  artifacts.push(['assets/vendor/waline/README.txt', `Waline client ${version}\nSource: https://github.com/walinejs/waline/tree/main/packages/client\nLicense: MIT (see LICENSE.txt)\nGenerated from the locked @waline/client dependency by npm run build.\nOnly source map references are removed; do not edit these files manually.\n`]);
  return artifacts;
}
