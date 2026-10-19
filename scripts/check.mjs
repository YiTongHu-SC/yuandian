import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, resolvePublicFile } from './dev-server.mjs';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'private', 'backups', 'coverage', '.vscode', '.idea']);

async function projectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) files.push(...await projectFiles(filename));
    if (entry.isFile()) files.push(filename);
  }
  return files;
}

function references(source, extension) {
  if (extension === '.html') return [...source.matchAll(/<(?:script|link|img|source)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)].map(match => match[1]);
  if (extension === '.css') return [...source.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s"')]+)["']?\s*\)?/giu)].map(match => match[1]);
  if (extension === '.js') return [...source.matchAll(/(?:\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/gu)].map(match => match[1]);
  return [];
}

async function checkResources(root) {
  const visited = new Set();
  const pending = ['/index.html', '/guided.html'];
  while (pending.length) {
    const urlPath = pending.pop();
    if (visited.has(urlPath)) continue;
    visited.add(urlPath);
    const file = await resolvePublicFile(root, urlPath);
    if (!file) throw new Error(`入口引用的本地资源不存在或不允许公开：${urlPath}`);
    const extension = path.extname(file);
    if (!['.html', '.js', '.css'].includes(extension)) continue;
    for (const reference of references(await readFile(file, 'utf8'), extension)) {
      if (/^(?:data:|#)/u.test(reference)) continue;
      const target = new URL(reference, `http://127.0.0.1:4176${urlPath}`);
      if (target.origin !== 'http://127.0.0.1:4176') throw new Error(`运行资源应保持本地可用：${reference}（来自 ${urlPath}）`);
      pending.push(target.pathname);
    }
  }
  return visited.size;
}

async function checkMarkdownLinks(root, files) {
  let links = 0;
  for (const file of files.filter(filename => filename.endsWith('.md'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/gu)) {
      const target = match[1].replace(/^<|>$/gu, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(target)) continue;
      const localPath = decodeURIComponent(target.split(/[?#]/u)[0]);
      if (!localPath) continue;
      const resolved = path.resolve(path.dirname(file), localPath);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`文档链接超出项目：${target}（来自 ${path.relative(root, file)}）`);
      try { await stat(resolved); }
      catch { throw new Error(`文档本地链接不存在：${target}（来自 ${path.relative(root, file)}）`); }
      links++;
    }
  }
  return links;
}

try {
  const root = await realpath(PROJECT_ROOT);
  const files = await projectFiles(root);
  const javascript = files.filter(file => /\.(?:[cm]?js)$/u.test(file));
  for (const file of javascript) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.relative(root, file)} 语法检查失败：\n${result.stderr}`);
  }
  const resources = await checkResources(root);
  const links = await checkMarkdownLinks(root, files);
  console.log(`检查通过：${javascript.length} 个 JavaScript 文件语法，${resources} 个入口及本地运行资源，${links} 个文档本地链接。`);
} catch (error) {
  console.error(`检查失败：${error.message}`);
  process.exitCode = 1;
}
