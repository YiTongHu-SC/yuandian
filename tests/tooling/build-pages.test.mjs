import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPages } from '../../scripts/build-pages.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuandian-pages-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('yuandian-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'index.html': '<link rel="stylesheet" href="src/canvas/styles.css"><script type="module" src="src/canvas/app.js"></script>',
    'guided.html': '<script type="module" src="src/guided/app.js"></script>',
    'src/canvas/app.js': "import {\n  value\n} from './model.js';\nconsole.log(value);",
    'src/canvas/model.js': 'export const value = true;',
    'src/canvas/styles.css': 'body { color: black; }',
    'src/guided/app.js': 'export const guided = true;',
    'src/canvas/unreferenced.js': 'not part of the site',
    'private/credentials.json': 'private fixture',
    'backups/export.json': 'fictional backup',
    'docs/notes.md': 'not a site resource',
    'assets/screenshots/example.png': 'not a site resource',
    'scripts/admin.js': 'not a site resource',
    'node_modules/example/index.js': 'not a site resource'
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

test('Pages 仅发布两个入口可达的前端资源，并保留项目子路径中的相对链接', async t => {
  const root = await fixture(t);
  const result = await buildPages(root);
  assert.deepEqual(result.files, [
    'guided.html', 'index.html', 'src/canvas/app.js', 'src/canvas/model.js',
    'src/canvas/styles.css', 'src/guided/app.js'
  ]);
  assert.deepEqual((await readdir(result.output)).sort(), ['guided.html', 'index.html', 'src']);
  assert.equal(await readFile(path.join(result.output, 'index.html'), 'utf8'), await readFile(path.join(root, 'index.html'), 'utf8'));
  const base = new URL('https://example.github.io/thinking-canvas/index.html');
  assert.equal(new URL('src/canvas/app.js', base).pathname, '/thinking-canvas/src/canvas/app.js');
  assert.equal(new URL('./model.js', new URL('src/canvas/app.js', base)).pathname, '/thinking-canvas/src/canvas/model.js');
  await writeFile(path.join(result.output, 'outdated.json'), 'must not survive rebuilding');
  const rebuilt = await buildPages(root);
  assert.deepEqual((await readdir(rebuilt.output)).sort(), ['guided.html', 'index.html', 'src']);
});

test('Pages 拒绝私有、目录越界、站点绝对和远程运行依赖，并保留上次产物', async t => {
  const root = await fixture(t);
  const { output } = await buildPages(root);
  for (const reference of ['../../private/credentials.json', '../../scripts/admin.js', '/src/canvas/model.js', 'https://example.com/model.js']) {
    await writeFile(path.join(root, 'src/canvas/app.js'), `import '${reference}';`);
    await assert.rejects(buildPages(root), /不允许发布|项目内的相对路径/u);
    assert.equal(await readFile(path.join(output, 'src/canvas/app.js'), 'utf8'), "import {\n  value\n} from './model.js';\nconsole.log(value);");
  }
});

test('Pages 缺失运行依赖时失败，不发布残缺站点', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'src/canvas/model.js'));
  await assert.rejects(buildPages(root), { code: 'ENOENT' });
});

test('Pages 不跟随源码符号链接或覆盖链接的输出目录', async t => {
  const root = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), 'yuandian-pages-external-'));
  assert.equal(path.dirname(external), path.resolve(os.tmpdir()));
  assert.ok(path.basename(external).startsWith('yuandian-pages-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'keep.txt'), 'must stay');
  await mkdir(path.join(root, 'dist'));
  try { await symlink(external, path.join(root, 'dist/pages'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('当前环境不支持创建测试链接。'); return; }
    throw error;
  }
  await assert.rejects(buildPages(root), /发布目录/u);
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'must stay');
  await rm(path.join(root, 'dist/pages'));
  await rm(path.join(root, 'src/canvas'), { recursive: true });
  await symlink(path.join(root, 'src/guided'), path.join(root, 'src/canvas'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPages(root), /符号链接/u);
});
