import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpBridge } from '../../scripts/mcp-bridge.mjs';
import { PROJECT_ROOT, localPairingStorePath, startDevServer } from '../../scripts/dev-server.mjs';
import { createMemoryPairingAuthority } from '../../scripts/mcp-pairing-store.mjs';

async function fixture(t, options = {}) {
  let bridge;
  const server = http.createServer((request, response) =>
    bridge.handle(request, response)
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  bridge = createMcpBridge({ origin, root: PROJECT_ROOT, ...options });
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  });
  async function api(
    route,
    {
      token,
      body,
      method = route === 'poll' ? 'GET' : 'POST',
      headers = {},
      browser = true
    } = {}
  ) {
    return await new Promise((resolve, reject) => {
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/mcp/${route}`,
          method,
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            ...(browser
              ? { Origin: origin, 'X-Yuandian-Client': 'canvas' }
              : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers
          }
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode,
              headers: response.headers,
              value: text ? JSON.parse(text) : undefined
            });
          });
        }
      );
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const authorize = async (mode = 'write', boardId = 'fictional-board') =>
    (await api('session', { body: { boardId, mode } })).value;
  async function poll(token) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await api('poll', { token });
      if (response.status !== 204) return response;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Expected browser request was not delivered');
  }
  return { api, authorize, poll, origin };
}

async function device(api) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const created = await api('pairings', { body: { publicKey: keys.publicKey.export({ format: 'jwk' }) } });
  assert.equal(created.status, 201);
  const { pairingId, config } = created.value;
  async function proof(action, parameters) {
    const challenge = await api('pairing/challenge', { body: { pairingId, action, parameters } });
    if (challenge.status !== 200) return { challenge };
    return { body: {
      pairingId, challengeId: challenge.value.challengeId,
      signature: sign('sha256', Buffer.from(challenge.value.message), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    } };
  }
  return {
    pairingId, config,
    proof,
    async signed(action, parameters) {
      const prepared = await proof(action, parameters);
      return prepared.challenge || api('pairing/complete', { body: prepared.body });
    }
  };
}

test('授权仅可从本源画布发起，Host/Origin/自定义头缺失均拒绝且无 CORS', async (t) => {
  const { api, origin } = await fixture(t);
  const body = { boardId: 'fictional-board', mode: 'write' };
  for (const headers of [
    { Origin: 'https://outside.example' },
    { Origin: '' },
    { Host: 'evil.example' },
    { 'X-Yuandian-Client': '' }
  ]) {
    const response = await api('session', { body, headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await api('session', { method: 'GET' })).status, 405);
  const response = await api('session', { body });
  assert.equal(response.status, 201);
  const session = response.value;
  assert.match(session.ownerToken, /^[a-f0-9]{64}$/u);
  assert.notEqual(session.ownerToken, session.clientToken);
  assert.equal(session.config.command, process.execPath);
  assert.equal(session.config.env.YUANDIAN_URL, origin);
  assert.equal(session.config.env.YUANDIAN_MCP_TOKEN, session.clientToken);
});

test('owner/client 不能越权或替代认证，读取权限拒绝编辑，status 不排队', async (t) => {
  const { api, authorize } = await fixture(t);
  const session = await authorize('read');
  const body = { tool: 'get_canvas', arguments: {} };
  assert.equal((await api('call', { body, browser: false })).status, 401);
  assert.equal(
    (await api('call', { token: session.ownerToken, body, browser: false }))
      .status,
    401
  );
  assert.equal((await api('poll', { token: session.clientToken })).status, 401);
  assert.equal(
    (await api('disconnect', { token: session.clientToken })).status,
    401
  );
  const denied = await api('call', {
    token: session.clientToken,
    body: { tool: 'edit_canvas', arguments: {} },
    browser: false
  });
  assert.equal(denied.value.code, 'read_only');
  assert.equal(
    (
      await api('call', {
        token: session.clientToken,
        body: { tool: 'unknown', arguments: {} },
        browser: false
      })
    ).status,
    400
  );
  assert.equal(
    (
      await api('call', {
        token: session.clientToken,
        body: { ...body, boardId: 'another-board' },
        browser: false
      })
    ).status,
    400
  );
  assert.equal(
    (
      await api('call', {
        token: session.clientToken,
        body: { tool: 'get_canvas', arguments: { boardId: 'another-board' } },
        browser: false
      })
    ).status,
    403
  );
  const status = await api('call', {
    token: session.clientToken,
    body: { tool: 'connection_status', arguments: {} },
    browser: false
  });
  assert.equal(status.value.mode, 'read');
  assert.equal(status.value.boardId, 'fictional-board');
  assert.equal(status.value.connected, true);
  assert.equal('ownerToken' in status.value, false);
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
});

test('请求仅交付一次，结果匹配本会话并原样传递，已结束结果不能重放', async (t) => {
  const { api, authorize, poll } = await fixture(t);
  const session = await authorize();
  const other = await authorize('read', 'other-board');
  const pending = api('call', {
    token: session.clientToken,
    body: { tool: 'get_canvas', arguments: {} },
    browser: false
  });
  const delivered = (await poll(session.ownerToken)).value;
  assert.equal(delivered.tool, 'get_canvas');
  assert.ok(delivered.expiresAt > Date.now());
  assert.ok(delivered.expiresAt <= Date.now() + 15000);
  assert.deepEqual(delivered.arguments, {});
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  const result = {
    ok: true,
    board: { id: session.boardId, title: '虚构测试内容', nodes: [], edges: [] },
    revision: 'a'.repeat(64)
  };
  const body = { requestId: delivered.requestId, result };
  assert.equal(
    (await api('result', { token: other.ownerToken, body })).status,
    404
  );
  assert.equal(
    (await api('result', { token: session.ownerToken, body })).status,
    200
  );
  assert.deepEqual((await pending).value, result);
  assert.equal(
    (await api('result', { token: session.ownerToken, body })).status,
    404
  );
});

test('断连立即清理排队请求和双方凭据，新的授权不能复用旧结果', async (t) => {
  const { api, authorize, poll } = await fixture(t);
  const session = await authorize();
  const pending = api('call', {
    token: session.clientToken,
    body: { tool: 'get_canvas', arguments: {} },
    browser: false
  });
  const delivered = (await poll(session.ownerToken)).value;
  assert.equal(
    (await api('disconnect', { token: session.ownerToken })).value.ok,
    true
  );
  assert.equal((await pending).value.code, 'disconnected');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 401);
  assert.equal(
    (
      await api('call', {
        token: session.clientToken,
        body: { tool: 'connection_status', arguments: {} },
        browser: false
      })
    ).status,
    401
  );
  const next = await authorize();
  assert.equal(
    (
      await api('result', {
        token: next.ownerToken,
        body: { requestId: delivered.requestId, result: { ok: true } }
      })
    ).status,
    404
  );
});

test('心跳与绝对会话到期均撤销，AI 查询不能延长浏览器心跳', async (t) => {
  let clock = 10000;
  const { api, authorize } = await fixture(t, {
    now: () => clock,
    heartbeatMs: 100,
    sessionTtlMs: 250
  });
  const idle = await authorize();
  clock += 101;
  assert.equal(
    (
      await api('call', {
        token: idle.clientToken,
        body: { tool: 'connection_status', arguments: {} },
        browser: false
      })
    ).status,
    401
  );
  const active = await authorize();
  clock += 90;
  assert.equal((await api('poll', { token: active.ownerToken })).status, 204);
  clock += 90;
  assert.equal((await api('poll', { token: active.ownerToken })).status, 204);
  clock += 71;
  assert.equal((await api('poll', { token: active.ownerToken })).status, 401);
});

test('临时授权接受明确期限与永久，省略仍沿用默认，非法期限不扩大旧画布范围', async (t) => {
  let clock = 10000;
  const { api } = await fixture(t, { now: () => clock, heartbeatMs: 3600001 });
  const grant = { scope: 'workspace', pageId: randomUUID() };
  for (const durationMs of [60000, 900000, 3600000]) {
    const response = await api('session', { body: { ...grant, durationMs } });
    assert.equal(response.status, 201);
    assert.equal(response.value.expiresAt, clock + durationMs);
    const token = response.value.ownerToken;
    clock += durationMs;
    assert.equal((await api('poll', { token })).status, 401);
  }
  assert.equal((await api('session', { body: grant })).value.expiresAt, clock + 3600000);
  const permanent = (await api('session', { body: { boardId: 'legacy', durationMs: null } })).value;
  assert.equal(permanent.scope, 'canvas');
  assert.equal(permanent.expiresAt, null);
  const wider = await api('call', { browser: false, token: permanent.clientToken, body: { tool: 'list_canvases', arguments: {} } });
  assert.equal(wider.value.code, 'scope_mismatch');
  for (const durationMs of [false, true, 0, 59999, 3600001, 900000.5, '900000', {}, []]) {
    assert.equal((await api('session', { body: { ...grant, durationMs } })).status, 400);
    assert.equal((await api('session', { body: { boardId: 'legacy', durationMs } })).status, 400);
  }
  assert.equal((await api('session', { body: { ...grant, durationMs: null, boardId: 'legacy' } })).status, 400);
});

test('真实 stdio 永久授权超过一小时仍有效，请求有截止时间，只读、断开和失联照常生效', { timeout: 15000 }, async (t) => {
  let clock = 10000;
  const heartbeatMs = 10000;
  const { api, poll } = await fixture(t, { now: () => clock, heartbeatMs });
  async function connect() {
    const response = await api('session', { body: { scope: 'workspace', pageId: randomUUID(), durationMs: null } });
    assert.equal(response.status, 201);
    assert.equal(response.value.expiresAt, null);
    const session = response.value;
    const client = new Client({ name: 'permanent-stdio-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...session.config, stderr: 'pipe' });
    await client.connect(transport);
    t.after(() => client.close());
    return { session, client };
  }
  const { session, client } = await connect();
  const startedAt = clock;
  while (clock <= startedAt + 3600000) {
    clock += 9000;
    assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  }
  const status = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(status.connected, true);
  assert.equal(status.expiresAt, null);
  assert.equal(status.mode, 'read');
  const denied = await client.callTool({ name: 'edit_canvas', arguments: {
    boardId: 'fictional', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '不可写入' }]
  } });
  assert.equal(denied.structuredContent.code, 'read_only');
  const reading = client.callTool({ name: 'get_canvas', arguments: { boardId: 'fictional' } });
  const request = (await poll(session.ownerToken)).value;
  assert.equal(Number.isFinite(request.expiresAt), true);
  assert.ok(request.expiresAt > clock);
  assert.ok(request.expiresAt <= clock + Math.min(15000, heartbeatMs));
  await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result: { ok: true, board: { id: 'fictional' } } } });
  assert.equal((await reading).structuredContent.board.id, 'fictional');
  await api('disconnect', { token: session.ownerToken });
  assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.code, 'unauthorized');
  const idle = await connect();
  clock += heartbeatMs + 1;
  assert.equal((await idle.client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.code, 'unauthorized');
  assert.equal((await api('poll', { token: idle.session.ownerToken })).status, 401);
});

test('交付截止时间不跨越浏览器心跳与绝对会话有效期', async (t) => {
  let clock = 10000;
  const { api, authorize, poll } = await fixture(t, {
    now: () => clock,
    heartbeatMs: 1000,
    sessionTtlMs: 5000
  });
  const session = await authorize();
  const call = () =>
    api('call', {
      token: session.clientToken,
      body: { tool: 'get_canvas', arguments: {} },
      browser: false
    });
  const first = call();
  clock = 10900;
  const heartbeatBound = (await poll(session.ownerToken)).value;
  assert.equal(heartbeatBound.expiresAt, clock + 1000);
  assert.ok(heartbeatBound.expiresAt < session.expiresAt);
  await api('result', {
    token: session.ownerToken,
    body: { requestId: heartbeatBound.requestId, result: { ok: true, board: { id: session.boardId } } }
  });
  assert.equal((await first).value.ok, true);
  for (const heartbeatAt of [11800, 12700, 13600, 14500]) {
    clock = heartbeatAt;
    assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  }
  clock = 14950;
  const second = call();
  const ttlBound = (await poll(session.ownerToken)).value;
  assert.equal(ttlBound.expiresAt, session.expiresAt);
  assert.equal(ttlBound.expiresAt, 15000);
  assert.ok(ttlBound.expiresAt < clock + 1000);
  await api('result', {
    token: session.ownerToken,
    body: { requestId: ttlBound.requestId, result: { ok: true, board: { id: session.boardId } } }
  });
  assert.equal((await second).value.ok, true);
});

test('请求超时清理交付与排队，错误提示要求重读防止重复编辑', async (t) => {
  const { api, authorize, poll } = await fixture(t, { requestTimeoutMs: 70 });
  const session = await authorize();
  const pending = api('call', {
    token: session.clientToken,
    body: {
      tool: 'edit_canvas',
      arguments: { expectedRevision: 'a'.repeat(64), operations: [] }
    },
    browser: false
  });
  const delivered = (await poll(session.ownerToken)).value;
  assert.equal((await pending).value.code, 'request_timeout');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  assert.equal(
    (
      await api('result', {
        token: session.ownerToken,
        body: { requestId: delivered.requestId, result: { ok: true } }
      })
    ).status,
    404
  );
});

test('排队数量包含已交付请求，满额拒绝而不会静默丢请求', async (t) => {
  const { api, authorize, poll } = await fixture(t, { maxPending: 2 });
  const session = await authorize();
  const call = () =>
    api('call', {
      token: session.clientToken,
      body: { tool: 'get_canvas', arguments: {} },
      browser: false
    });
  const first = call();
  await poll(session.ownerToken);
  const second = call();
  await poll(session.ownerToken);
  const third = await call();
  assert.equal(third.status, 429);
  assert.equal(third.value.code, 'queue_full');
  await api('disconnect', { token: session.ownerToken });
  assert.equal((await first).value.code, 'disconnected');
  assert.equal((await second).value.code, 'disconnected');
});

test('dev-server 实际提供 MCP API，同时原私有静态访问边界不变', async (t) => {
  const server = await startDevServer({ port: 0, pairingAuthority: createMemoryPairingAuthority() });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Node's HTTP client accepts any OS-assigned loopback port, including Fetch-forbidden ones.
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = http.request(
        new URL(pathname, origin),
        { method, headers, agent: false },
        (response) => {
          const chunks = [];
          response.on('error', reject);
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode,
            text: Buffer.concat(chunks).toString('utf8')
          }));
        }
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  const response = await request('/api/mcp/session', {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-Yuandian-Client': 'canvas',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ boardId: 'fictional-board', mode: 'read' })
  });
  assert.equal(response.status, 201);
  const session = JSON.parse(response.text);
  assert.equal(session.mode, 'read');
  for (const file of [
    '/package-lock.json',
    '/scripts/mcp-server.mjs',
    '/node_modules/@modelcontextprotocol/server/package.json',
    '/private/test.json'
  ])
    assert.equal((await request(file)).status, 404);
});

test('workspace 授权需要明确 scope 与页面，默认只读；旧配置不会自动扩大', async (t) => {
  const { api, authorize } = await fixture(t);
  const pageId = randomUUID();
  for (const body of [
    { scope: 'workspace', mode: 'read' },
    { scope: 'workspace', pageId: 'invalid', mode: 'write' },
    { scope: 'workspace', pageId, boardId: 'fictional-board' },
    { scope: 'all', pageId },
    { scope: 'canvas', pageId, boardId: 'fictional-board' }
  ]) assert.equal((await api('session', { body })).status, 400);
  const session = (await api('session', { body: { scope: 'workspace', pageId } })).value;
  assert.equal(session.scope, 'workspace');
  assert.equal(session.mode, 'read');
  assert.equal(session.pageId, pageId);
  assert.equal('boardId' in session, false);
  const call = (tool, arguments_ = {}) => api('call', {
    token: session.clientToken, browser: false, body: { tool, arguments: arguments_ }
  });
  const status = (await call('connection_status')).value;
  assert.equal(status.scope, 'workspace');
  assert.equal(status.pageId, pageId);
  for (const [tool, arguments_] of [
    ['edit_canvas', { boardId: 'first', expectedRevision: 'a'.repeat(64), operations: [] }],
    ['create_canvas', { expectedWorkspaceRevision: 'b'.repeat(64) }]
  ]) assert.equal((await call(tool, arguments_)).value.code, 'read_only');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  const legacy = await authorize('write');
  assert.equal(legacy.scope, 'canvas');
  for (const [tool, arguments_] of [['list_canvases', {}], ['create_canvas', { expectedWorkspaceRevision: 'a'.repeat(64) }], ['export_canvas', { all: true }]]) {
    const response = await api('call', { token: legacy.clientToken, browser: false, body: { tool, arguments: arguments_ } });
    assert.equal(response.value.code, 'scope_mismatch');
  }
});

test('workspace 同一临时连接可请求不同画布、新建及全部 JSON 导出；写入必须指定目标', async (t) => {
  const { api, poll } = await fixture(t);
  const session = (await api('session', { body: { scope: 'workspace', pageId: randomUUID(), mode: 'write' } })).value;
  const call = (tool, arguments_ = {}) => api('call', { token: session.clientToken, browser: false, body: { tool, arguments: arguments_ } });
  assert.equal((await call('edit_canvas', { expectedRevision: 'a'.repeat(64), operations: [] })).value.code, 'invalid_arguments');
  assert.equal((await call('create_canvas', { title: '新画布' })).value.code, 'invalid_arguments');
  assert.equal((await call('export_canvas', { boardId: 'first', all: true })).value.code, 'invalid_arguments');
  const jobs = [
    ['list_canvases', {}, { ok: true, activeId: 'first', workspaceRevision: 'a'.repeat(64), boards: [{ id: 'first', title: '第一张' }, { id: 'second', title: '第二张' }] }],
    ['get_canvas', { boardId: 'second' }, { ok: true, board: { id: 'second', nodes: [], edges: [] }, revision: 'b'.repeat(64) }],
    ['edit_canvas', { boardId: 'first', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '虚构编辑' }] }, { ok: true, revision: 'c'.repeat(64) }],
    ['create_canvas', { title: '第三张', expectedWorkspaceRevision: 'a'.repeat(64) }, { ok: true, board: { id: 'third' }, revision: 'd'.repeat(64), workspaceRevision: 'e'.repeat(64) }],
    ['export_canvas', { all: true }, { ok: true, json: JSON.stringify({ version: 1, activeId: 'first', boards: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] }), filename: '原点备份.json', mimeType: 'application/json' }]
  ];
  for (const [tool, arguments_, result] of jobs) {
    const pending = call(tool, arguments_);
    const delivered = (await poll(session.ownerToken)).value;
    assert.equal(delivered.tool, tool);
    assert.deepEqual(delivered.arguments, arguments_);
    assert.equal((await api('result', { token: session.ownerToken, body: { requestId: delivered.requestId, result } })).status, 200);
    assert.deepEqual((await pending).value, result);
  }
  assert.equal((await call('connection_status')).value.scope, 'workspace');
});

test('旧单画布授权的读取与 JSON 导出拒绝其他画布和全部备份响应', async (t) => {
  const { api, authorize, poll } = await fixture(t);
  const session = await authorize('read');
  for (const tool of ['get_canvas', 'export_canvas']) {
    const pending = api('call', { token: session.clientToken, browser: false, body: { tool, arguments: {} } });
    const request = (await poll(session.ownerToken)).value;
    const payload = (boards) => ({ ok: true, json: JSON.stringify({ version: 1, activeId: boards[0].id, boards }), filename: 'test.json', mimeType: 'application/json' });
    const wrong = tool === 'get_canvas' ? { ok: true, board: { id: 'other' } } : payload([{ id: session.boardId }, { id: 'other' }]);
    assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result: wrong } })).value.code, 'scope_mismatch');
    const correct = tool === 'get_canvas' ? { ok: true, board: { id: session.boardId } } : payload([{ id: session.boardId }]);
    assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result: correct } })).status, 200);
    assert.deepEqual((await pending).value, correct);
  }
});

test('本机配对严格校验来源与挑战，另一页面不能静默接管，旧 owner 与旧请求不能复活', async t => {
  const { api, poll } = await fixture(t);
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  for (const headers of [{ Origin: '' }, { Origin: 'https://outside.example' }, { 'X-Yuandian-Client': '' }])
    assert.equal((await api('pairings', { body: { publicKey }, headers })).status, 403);
  const paired = await device(api);
  const clientToken = paired.config.env.YUANDIAN_MCP_TOKEN;
  const call = (tool, arguments_ = {}) => api('call', { token: clientToken, browser: false, body: { tool, arguments: arguments_ } });
  assert.equal((await call('connection_status')).value.state, 'needs_authorization');
  assert.equal((await call('get_canvas')).value.code, 'needs_authorization');
  const firstPage = { pageId: randomUUID(), tabId: randomUUID() };
  const first = await paired.signed('authorize', { ...firstPage, mode: 'write', durationMs: null, takeover: false });
  assert.equal(first.status, 201);
  assert.equal(first.value.expiresAt, null);
  assert.match(first.value.activeSessionId, /^[a-f0-9-]{36}$/u);
  assert.equal((await call('connection_status')).value.activeSessionId, first.value.activeSessionId);
  const pendingCall = call('edit_canvas', { boardId: 'fictional', expectedRevision: 'a'.repeat(64), operations: [] });
  const pending = (await poll(first.value.ownerToken)).value;
  const otherPage = { pageId: randomUUID(), tabId: randomUUID() };
  assert.equal((await paired.signed('attach', { ...otherPage, reload: false, takeover: false })).value.code, 'page_in_use');
  const otherStatus = await paired.signed('status', otherPage);
  assert.equal(otherStatus.value.state, 'page_in_use');
  assert.equal(otherStatus.value.activeSessionId, first.value.activeSessionId);
  const sameTabReload = { pageId: randomUUID(), tabId: firstPage.tabId };
  const attached = await paired.signed('attach', { ...sameTabReload, reload: true, takeover: false });
  assert.equal(attached.status, 200);
  assert.equal(attached.value.state, 'needs_authorization');
  assert.equal((await pendingCall).value.code, 'disconnected');
  assert.equal((await api('poll', { token: first.value.ownerToken })).status, 401);
  const resumed = await paired.signed('authorize', { ...sameTabReload, mode: 'write', durationMs: null, takeover: false });
  assert.notEqual(resumed.value.ownerToken, first.value.ownerToken);
  assert.notEqual(resumed.value.activeSessionId, first.value.activeSessionId);
  assert.equal((await api('result', { token: resumed.value.ownerToken, body: { requestId: pending.requestId, result: { ok: true } } })).status, 404);
  assert.equal((await paired.signed('release', firstPage)).value.code, 'page_in_use');
  for (const invalid of [
    null,
    { ...otherPage, allPages: true },
    { ...otherPage, allPages: false, expectedSessionId: resumed.value.activeSessionId },
    { ...otherPage, allPages: true, expectedSessionId: 'invalid' }
  ]) assert.equal((await paired.signed('release', invalid)).status, 400);
  assert.equal((await paired.signed('release', { ...otherPage, allPages: true, expectedSessionId: first.value.activeSessionId })).value.code, 'authorization_changed');
  assert.equal((await call('connection_status')).value.connected, true);
  const proof = await paired.proof('release', { ...otherPage, allPages: true, expectedSessionId: resumed.value.activeSessionId });
  assert.equal((await api('pairing/complete', { body: proof.body })).status, 200);
  assert.equal((await api('pairing/complete', { body: proof.body })).status, 401);
  assert.equal((await call('connection_status')).value.connected, false);
  const later = await paired.signed('authorize', { ...sameTabReload, mode: 'read', durationMs: null, takeover: false });
  assert.equal((await paired.signed('release', { ...otherPage, allPages: true, expectedSessionId: resumed.value.activeSessionId })).status, 409);
  assert.equal((await call('connection_status')).value.activeSessionId, later.value.activeSessionId);
});

test('真实 stdio 固定配对跨刷新、关闭重开及本机服务重启恢复，有限授权和主动断开均仅清除 owner', { timeout: 20000 }, async t => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yuandian-local-pairing-test-')));
  const pairingStorePath = path.join(temporary, 'pairings.json');
  let server = await startDevServer({ port: 0, pairingStorePath });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  let client;
  t.after(async () => {
    await client?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('yuandian-local-pairing-test-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function api(route, { body, token, browser = true } = {}) {
    const response = await fetch(`${origin}/api/mcp/${route}`, {
      method: route === 'poll' ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(browser ? { Origin: origin, 'X-Yuandian-Client': 'canvas' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, value: response.status === 204 ? undefined : await response.json() };
  }
  const paired = await device(api);
  assert.equal(paired.config.env.YUANDIAN_URL, origin);
  assert.equal(paired.config.command, await realpath(process.execPath));
  client = new Client({ name: 'persistent-local-pairing-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ ...paired.config, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 6);
  const status = async () => (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal((await status()).state, 'needs_authorization');
  const firstPage = { pageId: randomUUID(), tabId: randomUUID() };
  const first = (await paired.signed('authorize', { ...firstPage, mode: 'write', durationMs: null, takeover: false })).value;
  assert.equal((await status()).mode, 'write');
  await api('disconnect', { token: first.ownerToken, body: {} });
  assert.equal((await status()).connected, false);
  const reopened = { pageId: randomUUID(), tabId: randomUUID() };
  await paired.signed('attach', { ...reopened, reload: false, takeover: false });
  const restored = (await paired.signed('authorize', { ...reopened, mode: 'write', durationMs: null, takeover: false })).value;
  assert.notEqual(restored.ownerToken, first.ownerToken);
  assert.equal((await status()).mode, 'write');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  server = await startDevServer({ port, pairingStorePath });
  assert.equal((await status()).state, 'needs_authorization');
  assert.equal((await api('poll', { token: restored.ownerToken })).status, 401);
  const afterRestart = { pageId: randomUUID(), tabId: randomUUID() };
  assert.equal((await paired.signed('attach', { ...afterRestart, reload: false, takeover: false })).status, 200);
  const readOnly = (await paired.signed('authorize', { ...afterRestart, mode: 'read', durationMs: null, takeover: false })).value;
  assert.equal((await status()).expiresAt, null);
  assert.equal((await status()).mode, 'read');
  const denied = await client.callTool({ name: 'edit_canvas', arguments: {
    boardId: 'fictional', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '不应写入' }]
  } });
  assert.equal(denied.structuredContent.code, 'read_only');
  const reading = client.callTool({ name: 'get_canvas', arguments: {} });
  let pending;
  for (let attempt = 0; attempt < 100 && !pending; attempt++) {
    pending = (await api('poll', { token: readOnly.ownerToken })).value;
    if (!pending) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(pending.tool, 'get_canvas');
  await api('result', { token: readOnly.ownerToken, body: { requestId: pending.requestId, result: { ok: true, board: { id: 'fictional' } } } });
  assert.equal((await reading).structuredContent.board.id, 'fictional');
  await paired.signed('release', afterRestart);
  assert.equal((await status()).connected, false);
  const finite = (await paired.signed('authorize', { ...afterRestart, mode: 'read', durationMs: 900000, takeover: false })).value;
  assert.ok(Number.isFinite(finite.expiresAt));
  await api('disconnect', { token: finite.ownerToken, body: {} });
  assert.equal((await status()).state, 'needs_authorization');
  const stored = JSON.parse(await readFile(pairingStorePath, 'utf8'));
  assert.deepEqual(Object.keys(stored.pairings[0]).sort(), ['clientHash', 'createdAt', 'pairingId', 'publicKey', 'revokedAt']);
  assert.equal(JSON.stringify(stored).includes(paired.config.env.YUANDIAN_MCP_TOKEN), false);
  assert.equal((await paired.signed('unpair', {})).status, 200);
  assert.equal((await status()).code, 'unauthorized');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  server = await startDevServer({ port, pairingStorePath });
  assert.equal((await status()).code, 'unauthorized');
});

test('本机固定配对的有限期限与心跳只撤销会话，不使身份失效', async t => {
  let clock = 1000;
  const { api } = await fixture(t, { now: () => clock, heartbeatMs: 10000 });
  const paired = await device(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const callStatus = () => api('call', { browser: false, token: paired.config.env.YUANDIAN_MCP_TOKEN, body: { tool: 'connection_status', arguments: {} } });
  const finite = await paired.signed('authorize', { ...page, mode: 'read', durationMs: 900000, takeover: false });
  assert.equal(finite.value.expiresAt, clock + 900000);
  clock += 900000;
  assert.equal((await callStatus()).value.state, 'expired');
  const permanent = await paired.signed('authorize', { ...page, mode: 'write', durationMs: null, takeover: false });
  clock += 10001;
  assert.equal((await callStatus()).value.connected, false);
  assert.equal((await api('poll', { token: permanent.value.ownerToken })).status, 401);
  assert.equal((await paired.signed('authorize', { ...page, mode: 'write', durationMs: null, takeover: false })).status, 201);
});

test('本机配对状态默认放在用户应用目录，测试可注入独立私有目录', () => {
  const scope = { root: 'F:\\FakeProject', origin: 'http://127.0.0.1:4176' };
  const environment = { LOCALAPPDATA: 'C:\\FakeUser\\AppData\\Local' };
  const filename = localPairingStorePath(scope, environment, 'win32', 'C:\\FakeUser');
  assert.equal(path.dirname(filename), path.join(environment.LOCALAPPDATA, 'Yuandian', 'Mcp'));
  assert.match(path.basename(filename), /^pairings-[a-f0-9]{64}\.json$/u);
  assert.equal(localPairingStorePath({ ...scope, root: scope.root.toLowerCase() }, environment, 'win32'), filename);
  assert.notEqual(localPairingStorePath({ ...scope, origin: 'http://127.0.0.1:4198' }, environment, 'win32'), filename);
  assert.notEqual(localPairingStorePath({ ...scope, root: 'F:\\OtherProject' }, environment, 'win32'), filename);
  assert.equal(path.dirname(localPairingStorePath(scope, { XDG_STATE_HOME: '/fake/state' }, 'linux', '/fake/home')), path.join('/fake/state', 'yuandian', 'mcp'));
});
