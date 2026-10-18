import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from './dev-server.mjs';

try {
  // Enumerate files explicitly: Windows shells and older Node versions do not expand the same globs.
  const files = [];
  for (const directory of ['tests/unit', 'tests/tooling']) {
    const absolute = path.join(PROJECT_ROOT, directory);
    const entries = await readdir(absolute, { withFileTypes: true });
    const tests = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'));
    if (!tests.length) throw new Error(`测试目录没有 .test.mjs 文件：${directory}`);
    files.push(...tests.map(entry => path.join(absolute, entry.name)).sort());
  }
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`测试启动失败：${error.message}`);
  process.exitCode = 1;
}
