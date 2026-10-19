import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexMcpConfiguration,
  getMcpConnection,
  REMOTE_MCP_URL
} from '../../src/canvas/mcp-connection.js';

test('本机接入路径和轮询频率保持兼容，只有指定 Pages 页面启用固定远程中继', () => {
  const local = getMcpConnection(new URL('http://127.0.0.1:4176/'));
  assert.equal(local.available, true);
  assert.equal(local.remote, false);
  assert.equal(local.apiBase, '/api/mcp');
  assert.equal(local.pollDelayMs, 750);
  const online = getMcpConnection(new URL('https://yitonghu-sc.github.io/yuandian/'));
  assert.equal(online.available, true);
  assert.equal(online.remote, true);
  assert.equal(online.apiBase, 'https://stellarcore.games/yuandian-mcp/api/mcp');
  assert.equal(online.pollDelayMs, 0);
  assert.equal(getMcpConnection(new URL('https://yitonghu-sc.github.io/yuandian/index.html')).remote, true);
  for (const address of [
    'https://yitonghu-sc.github.io/yuandian-other/',
    'https://yitonghu-sc.github.io/other/',
    'https://yitonghu-sc.github.io.evil.test/yuandian/',
    'http://yitonghu-sc.github.io/yuandian/',
    'https://other.test/yuandian/',
    'http://localhost:4176/'
  ]) assert.equal(getMcpConnection(new URL(address)).available, false, address);
  const redirected = getMcpConnection(new URL('https://yitonghu-sc.github.io/yuandian/?relay=https://evil.test'));
  assert.equal(redirected.apiBase, online.apiBase);
});

test('Codex 配置只包含固定 MCP URL 与临时 Bearer，不接受其他服务或附加头', () => {
  const token = 'a'.repeat(64);
  const config = { url: REMOTE_MCP_URL, headers: { Authorization: `Bearer ${token}` } };
  assert.equal(codexMcpConfiguration(config), [
    '[mcp_servers.yuandian]',
    'url = "https://stellarcore.games/yuandian-mcp/mcp"',
    `http_headers = { Authorization = "Bearer ${token}" }`
  ].join('\n'));
  for (const invalid of [
    null,
    { ...config, url: 'https://evil.test/mcp' },
    { ...config, url: `${REMOTE_MCP_URL}?token=${token}` },
    { ...config, headers: { Authorization: 'Bearer invalid' } },
    { ...config, headers: { ...config.headers, 'Other-Secret': token } }
  ]) assert.throws(() => codexMcpConfiguration(invalid), /配置无效/u);
});
