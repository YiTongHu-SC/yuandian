import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPages } from '../../scripts/build-pages.mjs';
import { HOST, PROJECT_ROOT, startDevServer } from '../../scripts/dev-server.mjs';

const CONFIG_DIRECTORY = 'deploy/remote-mcp/config';
const PUBLIC_TEMPLATES = [
  'README.md', 'server.example.json', 'ssh_config.example',
  'runtime.env.example', 'credentials.env.example',
];
const LOCAL_FILES = [
  'server.local.json', 'ssh_config.local', 'runtime.local.env', 'credentials.local.env',
  'known_hosts.local', 'unlisted.example', 'operator-notes.md', 'connection.json', 'operator-helper.js',
  'keys/id_ed25519', 'keys/another-key', 'keys/fixture-key.js', 'backups/previous-config.json',
  'nested/credentials.env.example',
];

async function writeFixtureFile(root, relative, content = 'fictional test data') {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'yuandian-server-config-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('yuandian-server-config-'));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (const relative of [...PUBLIC_TEMPLATES, ...LOCAL_FILES]) {
    await writeFixtureFile(root, `${CONFIG_DIRECTORY}/${relative}`);
  }
  return { root, cleanups };
}

function git(root, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[variable];
  const result = spawnSync('git', ['-C', root, '-c', 'core.excludesFile=', ...args], { encoding: 'utf8', windowsHide: true, env });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('服务器示例可暂存，真实配置、未列明文件、密钥和备份默认不进入 Git', async t => {
  const { root } = await fixture(t);
  await copyFile(path.join(PROJECT_ROOT, '.gitignore'), path.join(root, '.gitignore'));
  for (const relative of ['outside.pem', 'outside.key', 'outside.p12', 'outside.pfx', 'outside.ppk', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'other/id_rsa', 'other/id_ed25519']) {
    await writeFixtureFile(root, relative);
  }
  git(root, ['init', '--quiet']);
  git(root, ['add', '-A']);
  const staged = git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort();
  assert.deepEqual(staged, ['.gitignore', ...PUBLIC_TEMPLATES.map(relative => `${CONFIG_DIRECTORY}/${relative}`)].sort());
});

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get({ host: HOST, port, path: requestPath, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
  });
}

test('服务器配置目录及示例不通过本机静态服务公开', async t => {
  const { root, cleanups } = await fixture(t);
  await writeFixtureFile(root, 'index.html', '<!doctype html><h1>fictional canvas</h1>');
  const server = await startDevServer({ root, port: 0 });
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await request(port, '/')).status, 200);
  for (const relative of [...PUBLIC_TEMPLATES, ...LOCAL_FILES]) {
    const response = await request(port, `/${CONFIG_DIRECTORY}/${relative}`);
    assert.equal(response.status, 404, relative);
    assert.equal(response.body, 'Not found', relative);
  }
});

test('Pages 构建的实际产物不包含服务器配置、示例或部署目录', async t => {
  const { root } = await fixture(t);
  await writeFixtureFile(root, 'index.html', '<script type="module" src="src/canvas/app.js"></script>');
  await writeFixtureFile(root, 'guided.html', '<!doctype html><h1>fictional guided</h1>');
  await writeFixtureFile(root, 'src/canvas/app.js', 'export const fictional = true;');
  const result = await buildPages(root);
  assert.deepEqual(result.files, ['guided.html', 'index.html', 'src/canvas/app.js']);
  assert.deepEqual((await readdir(result.output)).sort(), ['guided.html', 'index.html', 'src']);
  assert.deepEqual(await readdir(path.join(result.output, 'src/canvas')), ['app.js']);
});
