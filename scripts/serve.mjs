import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sceneTypes = { '.json': 'application/json; charset=utf-8', '.litematic': 'application/octet-stream', '.litematica': 'application/octet-stream', '.nbt': 'application/octet-stream' };
const port = Number(process.env.PORT || 4173);
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const preview = pathname.match(/^\/preview\/minecraft\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
    if (preview) {
      try {
        const { previewScene } = await import('./mc-article-preview.mjs');
        const html = previewScene(root, preview[1], url.searchParams.get('bookmark'));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : html);
      } catch (error) {
        response.writeHead(422, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : `无法预览场景。\n${error.message}`);
      }
      return;
    }
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relativePath = relative(root, file);
    const parts = relativePath.split(/[\\/]/);
    if (isAbsolute(relativePath) || parts.some(part => part.startsWith('.'))) throw new Error('Not found');
    const extension = extname(file).toLowerCase();
    let contentType = types[extension];
    if (parts[0] === 'js' && extension === '.mjs') contentType = types['.js'];
    if (parts[0] === 'assets' && parts[1] === 'minecraft') contentType ??= sceneTypes[extension];
    if (parts[0] === 'assets' && parts[1] === 'minecraft' && parts[2] === 'resource-packs' && extension === '.zip') contentType = 'application/zip';
    if (!contentType) throw new Error('Not found');
    if (relativePath === 'feed.xml') contentType = 'application/rss+xml; charset=utf-8';
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    const body = await readFile(resolve(root, '404.html')).catch(() => null);
    response.writeHead(404, { 'Content-Type': body ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body || 'Not found');
  }
});
// When the port is taken, say by what instead of crashing: often it is this
// site already being served, by another terminal or by the Claude app's preview.
const titleOf = html => html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() ?? null;
server.on('error', async error => {
  if (error.code !== 'EADDRINUSE') throw error;
  const address = `http://localhost:${port}`;
  const ours = titleOf(await readFile(resolve(root, 'index.html'), 'utf8').catch(() => ''));
  const theirs = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
    .then(response => response.text()).then(titleOf).catch(() => null);
  if (ours && theirs === ours) {
    console.log(`网站已经在运行了，直接打开：${address}`);
    console.log('（可能是另一个终端或 Claude 应用的预览开的，不用再启动一次。）');
    return;
  }
  console.error(`端口 ${port} 被别的程序占用了。换个端口启动：`);
  console.error(process.platform === 'win32' ? '  $env:PORT=4174; npm run dev' : '  PORT=4174 npm run dev');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Gudu's universe: http://localhost:${server.address().port}`));
