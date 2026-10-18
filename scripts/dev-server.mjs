import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4176;
export const IDENTITY_PATH = '/__thinking_canvas_server__';
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);
const ASSET_EXTENSIONS = new Set([...MIME_TYPES.keys()].filter(extension => !['.html', '.js', '.css'].includes(extension)));

// Inspect the raw request path before URL normalization can remove traversal segments.
export function publicRelativePath(requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath.split('?')[0]); }
  catch { return null; }
  if (!decoded.startsWith('/') || /[\\\0]/u.test(decoded)) return null;
  if (decoded.split('/').some(segment => segment === '..' || segment.startsWith('.'))) return null;
  if (decoded === '/') return 'index.html';
  if (decoded === '/index.html' || decoded === '/guided.html') return decoded.slice(1);
  const extension = path.posix.extname(decoded).toLowerCase();
  if (decoded.startsWith('/src/') && ['.js', '.css'].includes(extension)) return decoded.slice(1);
  if (decoded.startsWith('/assets/') && ASSET_EXTENSIONS.has(extension)) return decoded.slice(1);
  return null;
}

export async function resolvePublicFile(root, requestPath) {
  const relative = publicRelativePath(requestPath);
  if (!relative) return null;
  const expected = path.join(root, relative);
  try {
    const actual = await realpath(expected);
    const samePath = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
    // Refuse symlinks and junctions, including ones pointing into private project folders.
    if (!samePath || !(await stat(actual)).isFile()) return null;
    return actual;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code)) return null;
    throw error;
  }
}

export function parsePort(value) {
  if (!/^\d+$/u.test(String(value))) throw new Error('端口必须为 1–65535 的整数。');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数。');
  return port;
}

export async function startDevServer({ root = PROJECT_ROOT, port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口。');
  const canonicalRoot = await realpath(root);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      if (request.headers.host !== `${HOST}:${server.address().port}`) {
        reply(403, '仅允许通过本机 127.0.0.1 访问。');
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        reply(405, 'Method not allowed');
        return;
      }
      if (request.url === IDENTITY_PATH) {
        reply(200, JSON.stringify({ application: 'yuandian-thinking-canvas', protocol: 1, root: canonicalRoot, pid: process.pid }), 'application/json; charset=utf-8');
        return;
      }
      const file = await resolvePublicFile(canonicalRoot, request.url);
      if (!file) { reply(404, 'Not found'); return; }
      reply(200, await readFile(file), MIME_TYPES.get(path.extname(file).toLowerCase()));
    } catch {
      // Never expose local paths or file contents in an HTTP error response.
      reply(500, 'Internal server error');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help')) {
    console.log('用法：node scripts/dev-server.mjs [--port 4176]\n服务固定绑定 127.0.0.1；Ctrl+C 停止前台服务。');
    return;
  }
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--port')) {
    throw new Error('仅支持 --port 参数；使用 --help 查看说明。');
  }
  const port = arguments_.length ? parsePort(arguments_[1]) : DEFAULT_PORT;
  for (const entry of ['/index.html', '/guided.html', '/src/canvas/app.js', '/src/canvas/styles.css', '/src/guided/app.js', '/src/guided/styles.css']) {
    if (!await resolvePublicFile(await realpath(PROJECT_ROOT), entry)) throw new Error(`缺少运行资源：${entry}`);
  }
  const server = await startDevServer({ port });
  console.log(`原点 · 自由思考画布：http://${HOST}:${server.address().port}/`);
  console.log(`目录：${PROJECT_ROOT}\n仅在本机提供页面和运行资源。Ctrl+C 停止服务。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = error.code === 'EADDRINUSE'
      ? '端口已被占用，未停止任何进程。可运行 start.ps1 安全检查并复用同目录服务。'
      : error.message;
    console.error(`启动失败：${message}`);
    process.exitCode = 1;
  });
}
