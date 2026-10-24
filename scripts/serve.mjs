import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const port = Number(process.env.PORT || 4173);
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relativePath = relative(root, file);
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => part.startsWith('.')) || !types[extname(file)]) throw new Error('Not found');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(file);
    const contentType = relativePath === 'feed.xml' ? 'application/rss+xml; charset=utf-8' : types[extname(file)];
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    const body = await readFile(resolve(root, '404.html')).catch(() => null);
    response.writeHead(404, { 'Content-Type': body ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body || 'Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Gudu's universe: http://localhost:${port}`));
