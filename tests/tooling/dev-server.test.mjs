import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HOST, IDENTITY_PATH, PROJECT_ROOT, parsePort, startDevServer } from '../../scripts/dev-server.mjs';

async function fixture(t, { cleanup = async () => {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thinking-canvas-test-'));
  t.after(async () => {
    await cleanup();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('thinking-canvas-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const files = {
    'index.html': '<!doctype html><meta name="thinking-canvas-project" content="standalone"><h1>canvas</h1>',
    'guided.html': '<!doctype html><h1>guided</h1>',
    'src/canvas/app.js': 'export const canvas = true;',
    'src/canvas/styles.css': 'body { color: green; }',
    'src/guided/app.js': 'export const guided = true;',
    'src/guided/styles.css': 'body { color: blue; }',
    'assets/example.png': 'example image',
    '.git/config': 'private git information',
    '.env': 'private environment',
    'private/secret.js': 'private secret',
    'backups/export.json': 'private export',
    'docs/example.md': 'documentation',
    'tests/example.js': '// test implementation',
    'scripts/example.js': '// tool implementation',
    'src/canvas/private.json': 'private JSON',
    'src/canvas/.hidden.js': '// hidden source',
  };
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return await realpath(root);
}

async function serve(t, root) {
  const server = await startDevServer({ root, port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

function request(port, requestPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: HOST, port, path: requestPath, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('只绑定 IPv4 回环，身份信息包含当前目录和进程', async t => {
  const root = await fixture(t);
  const server = await serve(t, root);
  assert.equal(server.address().address, '127.0.0.1');
  const response = await request(server.address().port, IDENTITY_PATH);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { application: 'yuandian-thinking-canvas', protocol: 1, root, pid: process.pid });
});

test('提供两个页面和运行资源，使用正确类型且不缓存', async t => {
  const server = await serve(t, await fixture(t));
  for (const [url, type, content] of [
    ['/', 'text/html', 'canvas'], ['/guided.html', 'text/html', 'guided'],
    ['/src/canvas/app.js?v=1', 'text/javascript', 'export'],
    ['/src/guided/styles.css', 'text/css', 'blue'], ['/assets/example.png', 'image/png', 'example image'],
  ]) {
    const response = await request(server.address().port, url);
    assert.equal(response.status, 200, url);
    assert.ok(response.headers['content-type'].startsWith(type), url);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.body.includes(content), url);
  }
});

test('私有数据、仓库、文档、测试、脚本与目录均不通过 HTTP 公开', async t => {
  const server = await serve(t, await fixture(t));
  for (const url of ['/.git/config', '/.env', '/private/secret.js', '/backups/export.json', '/docs/example.md', '/tests/example.js', '/scripts/example.js', '/src/canvas/private.json', '/src/canvas/.hidden.js', '/src/', '/assets/', '/missing.html']) {
    const response = await request(server.address().port, url);
    assert.equal(response.status, 404, url);
    assert.equal(response.body, 'Not found', url);
  }
});

test('拒绝原始及编码的路径遍历、反斜杠和无效编码', async t => {
  const server = await serve(t, await fixture(t));
  for (const url of ['/src/../private/secret.js', '/src/%2e%2e/private/secret.js', '/src/%2e%2e%2fprivate/secret.js', '/src/..%5cprivate%5csecret.js', '/src/%00secret.js', '/src/%ZZ.js', '/src/\\private\\secret.js']) {
    assert.equal((await request(server.address().port, url)).status, 404, url);
  }
});

test('不能通过运行目录中的符号链接或 junction 读取私有文件', async t => {
  const root = await fixture(t);
  await symlink(path.join(root, 'private'), path.join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await serve(t, root);
  assert.equal((await request(server.address().port, '/src/linked/secret.js')).status, 404);
});

test('支持 HEAD，拒绝写入方法与外部 Host', async t => {
  const server = await serve(t, await fixture(t));
  const port = server.address().port;
  const head = await request(port, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const post = await request(port, '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal((await request(port, '/', { headers: { Host: `example.test:${port}` } })).status, 403);
});

test('端口占用报错，已有服务保持可用', async t => {
  const root = await fixture(t);
  const server = await serve(t, root);
  await assert.rejects(startDevServer({ root, port: server.address().port }), { code: 'EADDRINUSE' });
  assert.equal((await request(server.address().port, '/')).status, 200);
});

test('命令行端口只接受 1–65535 的整数', () => {
  assert.equal(parsePort('4176'), 4176);
  for (const value of ['0', '65536', '-1', '4176.1', 'abc', '', ' 4176', '1e3']) assert.throws(() => parsePort(value));
});

test('静态检查沿多行 import 发现缺失资源，并在补齐后通过', async t => {
  const root = await fixture(t);
  for (const script of ['dev-server.mjs', 'check.mjs']) {
    await copyFile(path.join(PROJECT_ROOT, 'scripts', script), path.join(root, 'scripts', script));
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="src/canvas/app.js"></script>');
  await writeFile(path.join(root, 'src/canvas/app.js'), "import {\n  value\n} from './missing.js';\nconsole.log(value);\n");
  const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { encoding: 'utf8', windowsHide: true });
  const missing = check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /missing\.js/u);
  await writeFile(path.join(root, 'src/canvas/missing.js'), 'export const value = true;');
  const complete = check();
  assert.equal(complete.status, 0, complete.stderr);
});

async function launch(script, port) {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoBrowser', '-Port', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      // Windows Start-Process can leave inherited pipe handles in its background helper.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output });
    });
  });
}

async function unusedPort() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, HOST, resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

test('Windows launcher 隐藏启动并复用当前目录的服务（含空格路径）', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  let startedPid;
  const fixtureRoot = await fixture(t, { cleanup: async () => {
    if (!startedPid) return;
    process.kill(startedPid);
    // Wait for the test's own helper to release files before removing its fixture.
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(startedPid, 0); }
      catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } });
  const root = path.join(fixtureRoot, 'project with spaces');
  await mkdir(root);
  for (const relative of ['index.html', 'guided.html', 'src/canvas/app.js', 'src/canvas/styles.css', 'src/guided/app.js', 'src/guided/styles.css']) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await copyFile(path.join(fixtureRoot, relative), path.join(root, relative));
  }
  await mkdir(path.join(root, 'scripts'));
  await copyFile(path.join(PROJECT_ROOT, 'scripts/dev-server.mjs'), path.join(root, 'scripts/dev-server.mjs'));
  await copyFile(path.join(PROJECT_ROOT, 'start.ps1'), path.join(root, 'start.ps1'));
  const port = await unusedPort();
  const first = await launch(path.join(root, 'start.ps1'), port);
  // Read identity before assertions so a successful helper is cleaned up even if output assertions fail.
  let identity;
  try { identity = JSON.parse((await request(port, IDENTITY_PATH)).body); startedPid = identity.pid; }
  catch { /* An unsuccessful launch has no helper process to stop. */ }
  assert.equal(first.code, 0, first.output);
  assert.equal(identity.root.toLowerCase(), (await realpath(root)).toLowerCase());
  assert.ok(Number.isInteger(startedPid) && startedPid !== process.pid);
  const second = await launch(path.join(root, 'start.ps1'), port);
  assert.equal(second.code, 0, second.output);
  assert.equal(JSON.parse((await request(port, IDENTITY_PATH)).body).pid, startedPid);
});

test('Windows launcher 拒绝其他目录的同类服务，且不会停止该服务', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const server = await serve(t, await fixture(t));
  const result = await launch(path.join(PROJECT_ROOT, 'start.ps1'), server.address().port);
  assert.equal(result.code, 1, result.output);
  assert.equal((await request(server.address().port, '/')).status, 200);
});
