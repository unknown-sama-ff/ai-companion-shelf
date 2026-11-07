import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = process.argv.includes('--dist');
const servingRoot = distribution ? path.join(projectRoot, 'dist', 'full') : projectRoot;
const port = Number(process.env.PORT || 4173);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || (distribution ? 'index.html' : 'preview.html');
    const allowed = distribution ? ['index.html', 'companion-shelf.js'].includes(relativePath) : relativePath === 'preview.html' || relativePath === 'preview.css' ||
      relativePath === 'src/companions.js' || relativePath === 'assets/companions.json' ||
      /^assets\/sprites\/[a-z0-9-]+\.png$/.test(relativePath);
    if (!allowed || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readFile(path.join(servingRoot, relativePath));
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(relativePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': bytes.length,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Preview available at http://127.0.0.1:${port}/${distribution ? 'index.html' : 'preview.html'}`);
});
