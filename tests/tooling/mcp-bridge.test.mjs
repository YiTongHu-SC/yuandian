import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createMcpBridge } from '../../scripts/mcp-bridge.mjs';
import { PROJECT_ROOT, startDevServer } from '../../scripts/dev-server.mjs';

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
    400
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
    board: { title: '虚构测试内容', nodes: [], edges: [] },
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
    body: { requestId: heartbeatBound.requestId, result: { ok: true } }
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
    body: { requestId: ttlBound.requestId, result: { ok: true } }
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
  const server = await startDevServer({ port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/mcp/session`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-Yuandian-Client': 'canvas',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ boardId: 'fictional-board', mode: 'read' })
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal(session.mode, 'read');
  for (const file of [
    '/package-lock.json',
    '/scripts/mcp-server.mjs',
    '/node_modules/@modelcontextprotocol/server/package.json',
    '/private/test.json'
  ])
    assert.equal((await fetch(`${origin}${file}`)).status, 404);
});
