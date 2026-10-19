import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from './dev-server.mjs';

const ENTRY_FILES = ['index.html', 'guided.html'];
// Preserve relative URLs so the same files work under a GitHub project subpath.
const SITE_BASE = new URL('https://pages.invalid/yuandian/');

function resourceReferences(source, extension) {
  if (extension === '.html') return [...source.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)].map(match => match[1]);
  if (extension === '.css') return [...source.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s"')]+)["']?\s*\)?/giu)].map(match => match[1]);
  if (extension === '.js') return [...source.matchAll(/(?:\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/gu)].map(match => match[1]);
  return [];
}

function isSiteFile(relative) {
  return ENTRY_FILES.includes(relative) || /^src\/(?:canvas|guided)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:js|css)$/iu.test(relative);
}

async function optionalStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readSiteFile(root, relative) {
  if (!isSiteFile(relative)) throw new Error(`不允许发布此运行资源：${relative}`);
  let filename = root;
  for (const segment of relative.split('/')) {
    filename = path.join(filename, segment);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error(`发布资源不得使用符号链接：${relative}`);
  }
  if (!(await lstat(filename)).isFile()) throw new Error(`运行资源不是普通文件：${relative}`);
  return readFile(filename);
}

export async function buildPages(projectRoot = PROJECT_ROOT) {
  const root = await realpath(projectRoot);
  const files = new Map();
  const pending = [...ENTRY_FILES];
  while (pending.length) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    const content = await readSiteFile(root, relative);
    files.set(relative, content);
    for (const reference of resourceReferences(content.toString('utf8'), path.extname(relative))) {
      if (/^(?:data:|#)/iu.test(reference)) continue;
      if (/[\\\0]/u.test(reference)) throw new Error(`运行资源路径无效：${reference}`);
      const target = new URL(reference, new URL(relative, SITE_BASE));
      if (target.origin !== SITE_BASE.origin || !target.pathname.startsWith(SITE_BASE.pathname)) {
        throw new Error(`运行资源必须使用项目内的相对路径：${reference}（来自 ${relative}）`);
      }
      pending.push(decodeURIComponent(target.pathname.slice(SITE_BASE.pathname.length)));
    }
  }

  // Only this fixed generated directory may be replaced. Refuse junctions or links
  // before recursive removal, even when an ignored dist directory already exists.
  const distribution = path.join(root, 'dist');
  const output = path.join(distribution, 'pages');
  if (path.relative(root, output) !== path.join('dist', 'pages')) throw new Error('发布目录超出项目。');
  for (const directory of [distribution, output]) {
    const info = await optionalStat(directory);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`发布目录不是独立目录：${directory}`);
    if (info && path.relative(root, await realpath(directory)) !== path.relative(root, directory)) throw new Error(`发布目录包含链接：${directory}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [relative, content] of files) {
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return { output, files: [...files.keys()].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await buildPages();
    console.log(`GitHub Pages 已生成：${path.relative(PROJECT_ROOT, result.output)}（${result.files.length} 个公开运行文件）。`);
  } catch (error) {
    console.error(`GitHub Pages 构建失败：${error.message}`);
    process.exitCode = 1;
  }
}
