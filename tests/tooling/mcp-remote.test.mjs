import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRemoteMcpBridge, remoteSettings } from '../../scripts/mcp-remote-bridge.mjs';
import { startRemoteMcpServer } from '../../scripts/mcp-remote-server.mjs';
import { createMemoryPairingAuthority } from '../../scripts/mcp-pairing-store.mjs';
import { LIMITS, connect, createBoard, createNode, createWorkspace, exportJSON, parseImport } from '../../src/canvas/model.js';

const publicUrl = 'https://relay.example/yuandian-mcp';
const allowedOrigin = 'https://yitonghu-sc.github.io';
const hostname = 'relay.example';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pair(api, { clientToken } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const response = await api('pairings', { body: {
    publicKey: publicKey.export({ format: 'jwk' }), ...(clientToken ? { clientToken } : {})
  } });
  assert.equal(response.status, 201);
  const pairingId = response.value.pairingId;
  async function proof(action, parameters) {
    const challenge = await api('pairing/challenge', { body: { pairingId, action, parameters } });
    assert.equal(challenge.status, 200);
    return {
      pairingId, challengeId: challenge.value.challengeId,
      signature: sign('sha256', Buffer.from(challenge.value.message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    };
  }
  async function complete(action, parameters) {
    return await api('pairing/complete', { body: await proof(action, parameters) });
  }
  return {
    pairingId, clientToken: response.value.config.headers.Authorization.slice(7),
    config: response.value.config, proof, complete
  };
}

test('CLI 从 current 目录符号链接或 junction 启动后实际监听并通过健康检查', { timeout: 15000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuandian-remote-cli-'));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('yuandian-remote-cli-'));
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const current = path.join(temporary, 'current');
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
    // This exact mkdtemp path is checked above; rm removes the link itself.
    await rm(temporary, { recursive: true, force: true });
  });
  try { await symlink(project, current, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('当前环境不能创建目录链接。');
      return;
    }
    throw error;
  }
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(current, 'scripts/mcp-remote-server.mjs')], {
    cwd: current,
    env: { ...process.env, YUANDIAN_PUBLIC_URL: publicUrl, YUANDIAN_ALLOWED_ORIGIN: allowedOrigin, YUANDIAN_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let startupError;
  child.once('error', (error) => { startupError = error; });
  exited = new Promise((resolve) => child.once('close', resolve));
  async function health() {
    return await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, headers: { Host: hostname }, timeout: 200 }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Health probe timed out')));
    });
  }
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, `CLI 提前退出：${output}`);
    try { ready = await health(); break; } catch {}
    await pause(50);
  }
  assert.equal(ready?.status, 200, `CLI 未启动监听：${output}`);
  assert.deepEqual(ready.value, { ok: true, service: 'yuandian-mcp', version: '0.1.0' });
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`, 'u'));
});

async function fixture(t, options = {}) {
  const server = await startRemoteMcpServer({ publicUrl, allowedOrigin, port: 0, pollTimeoutMs: 40, ...options });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  async function nodeFetch(input, init = {}) {
    const url = new URL(input);
    return await new Promise((resolve, reject) => {
      let received = false;
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, path: `${url.pathname}${url.search}`, method: init.method || 'GET', agent: false,
        headers: { ...Object.fromEntries(new Headers(init.headers)), host: new Headers(init.headers).get('host') || hostname }
      }, (incoming) => {
        received = true;
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
      });
      outgoing.on('error', (error) => { if (!received) reject(error); });
      const aborted = () => outgoing.destroy(new Error('Aborted'));
      init.signal?.addEventListener('abort', aborted, { once: true });
      outgoing.once('close', () => init.signal?.removeEventListener('abort', aborted));
      outgoing.end(init.body);
    });
  }
  async function api(route, { token, body, method = route === 'poll' ? 'GET' : 'POST', headers = {}, browser = true, rawBody } = {}) {
    const response = await nodeFetch(`${origin}${route.startsWith('/') ? route : `/api/mcp/${route}`}`, {
      method,
      headers: {
        Host: hostname,
        'Content-Type': 'application/json',
        ...(browser ? { Origin: allowedOrigin, 'X-Yuandian-Client': 'canvas' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(rawBody === undefined && body === undefined ? {} : { body: rawBody ?? JSON.stringify(body) })
    });
    const text = await response.text();
    const payload = response.headers.get('content-type')?.startsWith('text/event-stream') ? /^data: (.+)$/mu.exec(text)?.[1] : text;
    return { status: response.status, headers: response.headers, value: payload ? JSON.parse(payload) : undefined };
  }
  async function authorize(mode, boardId = 'fictional-board', pageId = randomUUID()) {
    const response = await api('session', { body: { boardId, pageId, ...(mode ? { mode } : {}) } });
    assert.equal(response.status, 201);
    return response.value;
  }
  async function connect(session) {
    const client = new Client({ name: 'remote-relay-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Host: hostname, Authorization: `Bearer ${session.clientToken}` } },
      fetch: nodeFetch
    });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  }
  async function poll(token) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await api('poll', { token });
      if (response.status !== 204) return response;
    }
    assert.fail('Expected MCP request was not delivered');
  }
  return { server, origin, api, authorize, connect, poll, nodeFetch };
}

test('远程配置只允许明确 HTTPS 服务与精确来源，Node 只监听回环', async (t) => {
  const env = { YUANDIAN_PUBLIC_URL: publicUrl, YUANDIAN_ALLOWED_ORIGIN: allowedOrigin, YUANDIAN_PORT: '4177' };
  assert.deepEqual(remoteSettings(env), { publicUrl, allowedOrigin, port: 4177 });
  for (const value of ['http://relay.example/yuandian-mcp', `${publicUrl}/`, `${publicUrl}?token=secret`, 'https://user:pass@relay.example/yuandian-mcp', `${publicUrl}/%2e%2e/private`])
    assert.throws(() => remoteSettings({ ...env, YUANDIAN_PUBLIC_URL: value }));
  for (const value of [`${allowedOrigin}/yuandian/`, 'http://yitonghu-sc.github.io', `${allowedOrigin}/`])
    assert.throws(() => remoteSettings({ ...env, YUANDIAN_ALLOWED_ORIGIN: value }));
  for (const value of ['0', '65536', '04177', 'invalid'])
    assert.throws(() => remoteSettings({ ...env, YUANDIAN_PORT: value }));
  const { server, api } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const health = await api('/health', { method: 'GET', browser: false });
  assert.deepEqual(health.value, { ok: true, service: 'yuandian-mcp', version: '0.1.0' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('CORS 精确来源和预检，自定义头与 Host 均不替代授权', async (t) => {
  const { api } = await fixture(t);
  const body = { boardId: 'fictional-board', pageId: randomUUID() };
  for (const headers of [
    { Origin: 'https://outside.example' }, { Origin: '' }, { Host: 'outside.example' }, { 'X-Yuandian-Client': '' }
  ]) assert.equal((await api('session', { body, headers })).status, 403);
  const outside = await api('session', { body, headers: { Origin: 'https://outside.example' } });
  assert.equal(outside.headers.get('access-control-allow-origin'), null);
  const preflight = await api('session', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-yuandian-client'
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await api('session', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-unapproved-header'
  } })).status, 403);
  assert.equal((await api('session?token=secret', { body })).status, 400);
  assert.equal((await api('/mcp', { method: 'GET', browser: false })).status, 405);
  assert.equal((await api('/mcp', { body: {}, browser: false })).status, 401);
});

test('授权默认只读并绑定单页单画布，返回独立临时客户端凭据和 HTTPS 配置', async (t) => {
  const { api, authorize } = await fixture(t);
  const pageId = randomUUID();
  const session = await authorize(undefined, 'fictional-board', pageId);
  assert.equal(session.mode, 'read');
  assert.equal(session.boardId, 'fictional-board');
  assert.equal(session.pageId, pageId);
  assert.match(session.ownerToken, /^[a-f0-9]{64}$/u);
  assert.notEqual(session.ownerToken, session.clientToken);
  assert.ok(session.expiresAt > Date.now() + 3590000 && session.expiresAt <= Date.now() + 3600000);
  assert.deepEqual(session.config, { url: `${publicUrl}/mcp`, headers: { Authorization: `Bearer ${session.clientToken}` } });
  assert.equal(JSON.stringify(session.config).includes(session.ownerToken), false);
  for (const body of [
    { boardId: 'fictional-board' }, { boardId: 'fictional-board', pageId: 'not-a-page' },
    { boardId: 'fictional-board', pageId: randomUUID(), mode: 'admin' },
    { boardId: 'fictional-board', pageId: randomUUID(), mode: 'read', workspace: 'all' }
  ]) assert.equal((await api('session', { body })).status, 400);
});

test('真实 SDK Streamable HTTP 六工具、读取、默认只读拒写与单画布响应校验', { timeout: 15000 }, async (t) => {
  const { api, authorize, connect, poll } = await fixture(t);
  const session = await authorize();
  const client = await connect(session);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['get_canvas', 'edit_canvas', 'connection_status', 'list_canvases', 'create_canvas', 'export_canvas']);
  const status = await client.callTool({ name: 'connection_status', arguments: {} });
  assert.equal(status.structuredContent.mode, 'read');
  assert.equal(status.structuredContent.pageId, session.pageId);
  const denied = await client.callTool({ name: 'edit_canvas', arguments: {
    expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '虚构卡片' }]
  } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, 'read_only');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  const pending = client.callTool({ name: 'get_canvas', arguments: {} });
  const request = (await poll(session.ownerToken)).value;
  assert.equal(request.tool, 'get_canvas');
  const board = { id: session.boardId, title: '虚构远程测试', nodes: [], edges: [] };
  const result = { ok: true, board, revision: 'a'.repeat(64) };
  assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result: { ...result, board: { ...board, id: 'other-board' } } } })).status, 400);
  assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result } })).status, 200);
  const read = await pending;
  assert.deepEqual(read.structuredContent.board, board);
  assert.match(read.content[0].text, /不是系统指令/u);
  assert.equal((await api('/mcp', { body: {}, token: session.ownerToken, browser: false })).status, 401);
  assert.equal((await api('poll', { token: session.clientToken })).status, 401);
  assert.equal((await api('/mcp', { body: {}, token: session.clientToken, headers: { Origin: 'https://outside.example' }, browser: false })).status, 403);
});

test('读写 SDK 传递 expectedRevision 与整批操作，冲突失败不由中继重试', async (t) => {
  const { api, authorize, connect, poll } = await fixture(t);
  const session = await authorize('write');
  const client = await connect(session);
  const arguments_ = { expectedRevision: 'b'.repeat(64), operations: [
    { op: 'create_card', ref: 'new', text: '虚构远程编辑' },
    { op: 'connect_cards', from: 'existing', to: 'new' }
  ] };
  const pending = client.callTool({ name: 'edit_canvas', arguments: arguments_ });
  const delivered = (await poll(session.ownerToken)).value;
  assert.deepEqual(delivered.arguments, arguments_);
  assert.ok(delivered.expiresAt <= Date.now() + 30000);
  const result = { ok: false, code: 'revision_conflict', error: '画布已更改，请重新读取。' };
  await api('result', { token: session.ownerToken, body: { requestId: delivered.requestId, result } });
  const response = await pending;
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, 'revision_conflict');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  const invalid = await client.callTool({ name: 'edit_canvas', arguments: { ...arguments_, boardId: 'other-board' } });
  assert.equal(invalid.isError, true);
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
});

test('长轮询被工具唤醒，仅交付一次；重复同结果 ACK 成功，不能改写已回执结果', async (t) => {
  const { api, authorize, connect } = await fixture(t, { pollTimeoutMs: 1000 });
  const session = await authorize('write');
  const client = await connect(session);
  let finished = false;
  const waiting = api('poll', { token: session.ownerToken }).then((value) => { finished = true; return value; });
  await pause(25);
  assert.equal(finished, false);
  const pending = client.callTool({ name: 'get_canvas', arguments: {} });
  const delivered = (await waiting).value;
  // Losing this delivery or waiting for its acknowledgement cannot requeue it.
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  const body = { requestId: delivered.requestId, result: { ok: true, board: { id: session.boardId }, revision: 'c'.repeat(64) } };
  assert.equal((await api('result', { token: session.ownerToken, body })).status, 200);
  assert.equal((await pending).structuredContent.ok, true);
  assert.equal((await api('result', { token: session.ownerToken, body })).status, 200);
  assert.equal((await api('result', { token: session.ownerToken, body: { ...body, result: { ok: false } } })).status, 409);
  const next = await api('poll', { token: session.ownerToken });
  assert.equal(next.status, 204);
});

test('不同授权不能消费或回执其他画布请求；断开清理双方令牌和等待请求', async (t) => {
  const { api, authorize, connect, poll } = await fixture(t);
  const session = await authorize('write');
  const other = await authorize('read', 'another-fictional-board');
  const client = await connect(session);
  const pending = client.callTool({ name: 'get_canvas', arguments: {} });
  const delivered = (await poll(session.ownerToken)).value;
  assert.equal((await api('poll', { token: other.ownerToken })).status, 204);
  assert.equal((await api('result', { token: other.ownerToken, body: { requestId: delivered.requestId, result: { ok: false } } })).status, 404);
  assert.equal((await api('disconnect', { token: session.ownerToken, body: {} })).status, 200);
  assert.equal((await pending).structuredContent.code, 'disconnected');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 401);
  assert.equal((await api('/mcp', { token: session.clientToken, body: {}, browser: false })).status, 401);
});

test('心跳和有限期限均撤销；AI 请求不会续期浏览器心跳', async (t) => {
  let clock = 10000;
  const { api, authorize } = await fixture(t, { now: () => clock, heartbeatMs: 100, sessionTtlMs: 250, pollTimeoutMs: 5 });
  const idle = await authorize();
  clock += 101;
  assert.equal((await api('/mcp', { token: idle.clientToken, body: {}, browser: false })).status, 401);
  const active = await authorize();
  for (const increment of [90, 90]) {
    clock += increment;
    assert.equal((await api('poll', { token: active.ownerToken })).status, 204);
  }
  clock += 71;
  assert.equal((await api('poll', { token: active.ownerToken })).status, 401);
  assert.throws(() => createRemoteMcpBridge({ publicUrl, allowedOrigin, sessionTtlMs: 3600001 }));
});

test('远程临时授权兼容省略期限和一分钟，十五分钟与一小时按所选期限到期，永久不扩大旧范围', async (t) => {
  let clock = 10000;
  const { api, connect } = await fixture(t, { now: () => clock, heartbeatMs: 3600001, pollTimeoutMs: 1 });
  const grant = { scope: 'workspace', pageId: randomUUID() };
  for (const durationMs of [60000, 900000, 3600000]) {
    const response = await api('session', { body: { ...grant, durationMs } });
    assert.equal(response.status, 201);
    assert.equal(response.value.expiresAt, clock + durationMs);
    clock += durationMs;
    assert.equal((await api('poll', { token: response.value.ownerToken })).status, 401);
  }
  assert.equal((await api('session', { body: grant })).value.expiresAt, clock + 3600000);
  const legacy = (await api('session', { body: { boardId: 'legacy', pageId: randomUUID(), durationMs: null } })).value;
  assert.equal(legacy.expiresAt, null);
  const client = await connect(legacy);
  assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.scope, 'canvas');
  assert.equal((await client.callTool({ name: 'list_canvases', arguments: {} })).structuredContent.code, 'scope_mismatch');
  assert.equal((await api('session', { body: { ...grant, durationMs: '900000' } })).status, 400);
  assert.equal((await api('session', { body: { ...grant, durationMs: null, boardId: 'legacy' } })).status, 400);
});

test('真实 HTTP SDK 永久配对授权超过一小时仍有效，读写权限、有限请求期限与撤销条件继续生效', { timeout: 15000 }, async (t) => {
  let clock = 10000;
  const heartbeatMs = 90000;
  const { api, connect, poll } = await fixture(t, { now: () => clock, heartbeatMs, pollTimeoutMs: 1 });
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const client = await connect(paired);
  const authorize = async (target, mode) => {
    const response = await paired.complete('authorize', { ...target, mode, durationMs: null, takeover: false });
    assert.equal(response.status, 201);
    assert.equal(response.value.expiresAt, null);
    return response.value;
  };
  const status = async () => (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  const first = await authorize(page, 'read');
  const startedAt = clock;
  while (clock <= startedAt + 3600000) {
    clock += 60000;
    assert.equal((await api('poll', { token: first.ownerToken })).status, 204);
  }
  assert.equal((await status()).connected, true);
  assert.equal((await status()).expiresAt, null);
  const edit = { boardId: 'fictional', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '虚构编辑' }] };
  assert.equal((await client.callTool({ name: 'edit_canvas', arguments: edit })).structuredContent.code, 'read_only');
  assert.equal((await client.callTool({ name: 'create_canvas', arguments: { expectedWorkspaceRevision: 'b'.repeat(64) } })).structuredContent.code, 'read_only');
  const reading = client.callTool({ name: 'get_canvas', arguments: { boardId: 'fictional' } });
  const request = (await poll(first.ownerToken)).value;
  assert.equal(Number.isFinite(request.expiresAt), true);
  assert.ok(request.expiresAt > clock && request.expiresAt <= clock + 30000);
  await api('result', { token: first.ownerToken, body: { requestId: request.requestId, result: { ok: true, board: { id: 'fictional' } } } });
  assert.equal((await reading).structuredContent.board.id, 'fictional');
  await api('disconnect', { token: first.ownerToken, body: {} });
  assert.equal((await status()).state, 'needs_authorization');
  assert.equal((await api('poll', { token: first.ownerToken })).status, 401);
  const second = await authorize(page, 'write');
  const editing = client.callTool({ name: 'edit_canvas', arguments: edit });
  const writeRequest = (await poll(second.ownerToken)).value;
  assert.equal(Number.isFinite(writeRequest.expiresAt), true);
  assert.ok(writeRequest.expiresAt > clock && writeRequest.expiresAt <= clock + 30000);
  const refreshed = { pageId: randomUUID(), tabId: page.tabId };
  assert.equal((await paired.complete('attach', { ...refreshed, reload: true, takeover: false })).status, 200);
  assert.equal((await editing).structuredContent.code, 'disconnected');
  assert.equal((await api('result', { token: second.ownerToken, body: { requestId: writeRequest.requestId, result: { ok: true } } })).status, 401);
  const closed = await authorize(refreshed, 'read');
  assert.equal((await paired.complete('release', refreshed)).status, 200);
  assert.equal((await api('poll', { token: closed.ownerToken })).status, 401);
  const idle = await authorize(refreshed, 'read');
  clock += heartbeatMs + 1;
  assert.equal((await status()).connected, false);
  assert.equal((await status()).state, 'expired');
  assert.equal((await client.callTool({ name: 'get_canvas', arguments: {} })).structuredContent.code, 'needs_authorization');
  assert.equal((await api('poll', { token: idle.ownerToken })).status, 401);
});

test('交付超时不重排编辑、旧结果拒收；排队数量有上限', async (t) => {
  const { api, authorize, connect, poll } = await fixture(t, { requestTimeoutMs: 120, maxPending: 1 });
  const session = await authorize('write');
  const client = await connect(session);
  const pending = client.callTool({ name: 'edit_canvas', arguments: {
    expectedRevision: 'd'.repeat(64), operations: [{ op: 'create_card', text: '不重放' }]
  } });
  const delivered = (await poll(session.ownerToken)).value;
  const overflow = await client.callTool({ name: 'get_canvas', arguments: {} });
  assert.equal(overflow.structuredContent.code, 'queue_full');
  assert.equal((await pending).structuredContent.code, 'request_timeout');
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
  assert.equal((await api('result', { token: session.ownerToken, body: { requestId: delivered.requestId, result: { ok: true } } })).status, 404);
});

test('旧版 initialize / tools/list 可通过官方 stateless fallback 接入，所有请求仍须 Bearer', async (t) => {
  const { api, authorize } = await fixture(t);
  const session = await authorize();
  const headers = { Accept: 'application/json, text/event-stream' };
  const init = await api('/mcp', { token: session.clientToken, browser: false, headers, body: {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' }
    }
  } });
  assert.equal(init.status, 200);
  assert.equal(init.value.result.protocolVersion, '2025-11-25');
  assert.equal(init.headers.get('mcp-session-id'), null);
  const listed = await api('/mcp', { token: session.clientToken, browser: false, headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25' }, body: {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
  } });
  assert.equal(listed.value.result.tools.length, 6);
  assert.equal((await api('/mcp', { browser: false, headers, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })).status, 401);
});

test('匿名创建频率、会话上限、请求大小、JSON 与内容类型限制', async (t) => {
  const { api, authorize } = await fixture(t, { maxSessions: 1 });
  async function expectStatus(label, route, options, status) {
    let response;
    try { response = await api(route, options); }
    catch (error) { throw new Error(`${label} 未收到完整 HTTP 响应`, { cause: error }); }
    assert.equal(response.status, status, label);
  }
  const session = await authorize();
  assert.equal((await api('session', { body: { boardId: 'other', pageId: randomUUID() } })).value.code, 'session_limit');
  await expectStatus('session 正文超过 8 KB', 'session', { rawBody: 'x'.repeat(8193) }, 413);
  assert.equal((await api('session', { rawBody: '{bad' })).status, 400);
  assert.equal((await api('session', { body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  await expectStatus('MCP Content-Length 正文超过 1 MB', '/mcp', { token: session.clientToken, browser: false, rawBody: 'x'.repeat(1024 * 1024 + 1) }, 413);
  await expectStatus('MCP chunked 正文超过 1 MB', '/mcp', { token: session.clientToken, browser: false, headers: { 'Transfer-Encoding': 'chunked' }, rawBody: 'x'.repeat(1024 * 1024 + 1) }, 413);
  for (let i = 0; i < 4; i++) await api('session', { body: {} });
  assert.equal((await api('session', { body: {} })).status, 429);
});

test('并发超限上传均收到完整 413，包括 Content-Length 早拒和 chunked 流式拒绝', async (t) => {
  const { api, authorize } = await fixture(t);
  const session = await authorize();
  await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const chunked = index % 2 === 1;
    const label = `并发 ${index + 1} · ${chunked ? 'chunked' : 'Content-Length'}`;
    let response;
    try {
      response = await api('/mcp', {
        token: session.clientToken, browser: false,
        ...(chunked ? { headers: { 'Transfer-Encoding': 'chunked' } } : {}),
        rawBody: 'x'.repeat(1024 * 1024 + 1)
      });
    } catch (error) {
      throw new Error(`${label} 未收到完整 HTTP 响应`, { cause: error });
    }
    assert.equal(response.status, 413, label);
    assert.equal(response.value.code, 'invalid_request', label);
    assert.match(response.value.error, /过大/u, label);
  }));
});

test('已交付的 HTTP 请求取消后不重投；迟到回执提示重读画布', async (t) => {
  const { origin, api, authorize, poll, nodeFetch } = await fixture(t);
  const session = await authorize('write');
  const abort = new AbortController();
  const pending = nodeFetch(`${origin}/mcp`, {
    method: 'POST', signal: abort.signal,
    headers: { Host: hostname, Authorization: `Bearer ${session.clientToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edit_canvas', arguments: {
      expectedRevision: 'e'.repeat(64), operations: [{ op: 'create_card', text: '不自动重投' }]
    } } })
  });
  const rejected = assert.rejects(pending, /Aborted/u);
  const delivered = (await poll(session.ownerToken)).value;
  abort.abort();
  await rejected;
  // The server observes its socket close asynchronously.
  await pause(10);
  assert.equal((await api('result', { token: session.ownerToken, body: { requestId: delivered.requestId, result: { ok: true } } })).status, 404);
  assert.equal((await api('poll', { token: session.ownerToken })).status, 204);
});

test('异步读取期间撤销的令牌不能提交结果或调用；中继重建不恢复会话', async () => {
  const options = { publicUrl, allowedOrigin, pollTimeoutMs: 10 };
  const bridge = createRemoteMcpBridge(options);
  const headers = { Host: hostname, Origin: allowedOrigin, 'X-Yuandian-Client': 'canvas', 'Content-Type': 'application/json' };
  const create = await bridge.fetch(new Request('https://relay.example/api/mcp/session', { method: 'POST', headers, body: JSON.stringify({ boardId: 'fictional-board', pageId: randomUUID() }) }));
  assert.equal(create.status, 201);
  const session = await create.json();
  assert.match(session.ownerToken, /^[a-f0-9]{64}$/u);
  assert.match(session.clientToken, /^[a-f0-9]{64}$/u);
  let release;
  const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }; } });
  const pending = bridge.fetch(new Request('https://relay.example/mcp', {
    method: 'POST', headers: { Host: hostname, Authorization: `Bearer ${session.clientToken}`, 'Content-Type': 'application/json' }, body, duplex: 'half'
  }));
  await bridge.fetch(new Request('https://relay.example/api/mcp/disconnect', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${session.ownerToken}` }, body: '{}' }));
  release();
  assert.equal((await pending).status, 401);
  await bridge.close();
  const next = createRemoteMcpBridge(options);
  const status = await next.fetch(new Request('https://relay.example/mcp', { method: 'POST', headers: { Host: hostname, Authorization: `Bearer ${session.clientToken}`, 'Content-Type': 'application/json' }, body: '{}' }));
  assert.equal(status.status, 401);
  await next.close();
});

test('owner 结果读取期间授权到期不能回执，已交付请求同步失效', async () => {
  let clock = 10000;
  const bridge = createRemoteMcpBridge({ publicUrl, allowedOrigin, now: () => clock, heartbeatMs: 200, sessionTtlMs: 250, pollTimeoutMs: 10 });
  const headers = { Host: hostname, Origin: allowedOrigin, 'X-Yuandian-Client': 'canvas', 'Content-Type': 'application/json' };
  const create = await bridge.fetch(new Request('https://relay.example/api/mcp/session', { method: 'POST', headers, body: JSON.stringify({ boardId: 'fictional-board', pageId: randomUUID() }) }));
  assert.equal(create.status, 201);
  const session = await create.json();
  const pending = bridge.fetch(new Request('https://relay.example/mcp', {
    method: 'POST', headers: { Host: hostname, Authorization: `Bearer ${session.clientToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_canvas', arguments: {} } })
  }));
  let request;
  for (let attempt = 0; attempt < 10 && !request; attempt++) {
    const response = await bridge.fetch(new Request('https://relay.example/api/mcp/poll', { headers: { ...headers, Authorization: `Bearer ${session.ownerToken}` } }));
    if (response.status !== 204) request = await response.json();
  }
  assert.equal(request.tool, 'get_canvas');
  let release;
  const stream = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ requestId: request.requestId, result: { ok: true, board: { id: session.boardId } } }))); controller.close(); }; } });
  const resultPending = bridge.fetch(new Request('https://relay.example/api/mcp/result', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${session.ownerToken}` }, body: stream, duplex: 'half' }));
  clock += 251;
  release();
  assert.equal((await resultPending).status, 401);
  const resultText = await (await pending).text();
  assert.match(resultText, /session_expired/u);
  await bridge.close();
});

test('慢结果正文受全局内存预算限制，中止流后释放预算', async () => {
  const bridge = createRemoteMcpBridge({ publicUrl, allowedOrigin, pollTimeoutMs: 10 });
  const headers = { Host: hostname, Origin: allowedOrigin, 'X-Yuandian-Client': 'canvas', 'Content-Type': 'application/json' };
  const response = await bridge.fetch(new Request('https://relay.example/api/mcp/session', { method: 'POST', headers, body: JSON.stringify({ boardId: 'fictional-board', pageId: randomUUID() }) }));
  assert.equal(response.status, 201);
  const session = await response.json();
  headers.Authorization = `Bearer ${session.ownerToken}`;
  const streams = [];
  const pending = Array.from({ length: 4 }, () => bridge.fetch(new Request('https://relay.example/api/mcp/result', {
    method: 'POST', headers, duplex: 'half', body: new ReadableStream({ start(controller) { streams.push(controller); } })
  })));
  const validShape = () => new Request('https://relay.example/api/mcp/result', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), result: { ok: false } }) });
  assert.equal((await bridge.fetch(validShape())).status, 429);
  for (const controller of streams) controller.error(new Error('Fictional request body aborted'));
  for (const response of await Promise.all(pending)) assert.equal(response.status, 500);
  // A missing request is a normal 404, proving a freed body budget can be read again.
  assert.equal((await bridge.fetch(validShape())).status, 404);
  await bridge.close();
});

test('真实 HTTP SDK workspace 授权默认只读，旧单画布令牌不会获得新范围', async (t) => {
  const { api, authorize, connect, poll } = await fixture(t);
  const pageId = randomUUID();
  const created = await api('session', { body: { scope: 'workspace', pageId } });
  assert.equal(created.status, 201);
  const session = created.value;
  assert.equal(session.scope, 'workspace');
  assert.equal(session.mode, 'read');
  assert.equal('boardId' in session, false);
  const client = await connect(session);
  const status = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(status.scope, 'workspace');
  assert.equal(status.pageId, pageId);
  for (const [name, arguments_] of [
    ['edit_canvas', { boardId: 'first', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '拒写' }] }],
    ['create_canvas', { expectedWorkspaceRevision: 'b'.repeat(64) }]
  ]) assert.equal((await client.callTool({ name, arguments: arguments_ })).structuredContent.code, 'read_only');
  const pending = client.callTool({ name: 'export_canvas', arguments: { all: true } });
  const request = (await poll(session.ownerToken)).value;
  const result = { ok: true, json: JSON.stringify({ version: 1, activeId: 'first', boards: [{ id: 'first' }, { id: 'second' }] }), filename: '全部画布.json', mimeType: 'application/json' };
  await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result } });
  assert.deepEqual((await pending).structuredContent, result);
  const old = await authorize('write');
  const oldClient = await connect(old);
  assert.equal((await oldClient.callTool({ name: 'connection_status', arguments: {} })).structuredContent.scope, 'canvas');
  for (const [name, arguments_] of [['list_canvases', {}], ['create_canvas', { expectedWorkspaceRevision: 'a'.repeat(64) }], ['export_canvas', { all: true }]])
    assert.equal((await oldClient.callTool({ name, arguments: arguments_ })).structuredContent.code, 'scope_mismatch');
  const invalid = await api('session', { body: { scope: 'workspace', pageId, boardId: 'first' } });
  assert.equal(invalid.status, 400);
});

test('真实 HTTP SDK 同一 workspace 会话跨画布读写、新建和导出，显式目标响应不能错配', async (t) => {
  const { api, connect, poll } = await fixture(t);
  const session = (await api('session', { body: { scope: 'workspace', pageId: randomUUID(), mode: 'write' } })).value;
  const client = await connect(session);
  assert.equal((await client.callTool({ name: 'edit_canvas', arguments: { expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card' }] } })).structuredContent.code, 'invalid_arguments');
  const jobs = [
    ['list_canvases', {}, { ok: true, activeId: 'first', workspaceRevision: 'a'.repeat(64), boards: [{ id: 'first', title: '第一张' }, { id: 'second', title: '第二张' }] }],
    ['get_canvas', { boardId: 'second' }, { ok: true, board: { id: 'second', nodes: [], edges: [] }, revision: 'b'.repeat(64) }],
    ['edit_canvas', { boardId: 'first', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '跨画布虚构编辑' }] }, { ok: true, revision: 'c'.repeat(64) }],
    ['create_canvas', { title: '新建画布', expectedWorkspaceRevision: 'a'.repeat(64) }, { ok: true, board: { id: 'third' }, revision: 'd'.repeat(64), workspaceRevision: 'e'.repeat(64) }],
    ['export_canvas', { boardId: 'third' }, { ok: true, json: JSON.stringify({ version: 1, activeId: 'third', boards: [{ id: 'third' }] }), filename: '新建画布.json', mimeType: 'application/json' }]
  ];
  for (const [name, arguments_, result] of jobs) {
    const pending = client.callTool({ name, arguments: arguments_ });
    const request = (await poll(session.ownerToken)).value;
    assert.equal(request.tool, name);
    assert.deepEqual(request.arguments, arguments_);
    if (name === 'get_canvas')
      assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result: { ...result, board: { id: 'first' } } } })).value.code, 'scope_mismatch');
    assert.equal((await api('result', { token: session.ownerToken, body: { requestId: request.requestId, result } })).status, 200);
    assert.deepEqual((await pending).structuredContent, result);
  }
  await api('disconnect', { token: session.ownerToken, body: {} });
  await assert.rejects(() => client.callTool({ name: 'list_canvases', arguments: {} }), /unauthorized/u);
});

test('接近二百万字符的有效中文 v1 全部导出经真实 HTTP SDK 完整传输并回导', { timeout: 15000 }, async (t) => {
  const { api, connect: connectClient, poll } = await fixture(t);
  const workspace = createWorkspace();
  workspace.boards.push(createBoard('中文导出第二张画布'));
  for (const board of workspace.boards) {
    board.nodes = Array.from({ length: 100 }, (_, index) =>
      createNode(`第${index + 1}张卡片\n"引号"\\尾行${'思'.repeat(9780)}`, index * 10, index * 5));
    for (let index = 1; index < 10; index++) connect(board, board.nodes[index - 1].id, board.nodes[index].id);
  }
  const targetLength = LIMITS.chars - 128;
  let remaining = targetLength - exportJSON(workspace).length;
  assert.ok(remaining > 0);
  for (const node of workspace.boards.flatMap((board) => board.nodes)) {
    const added = Math.min(remaining, LIMITS.text - node.text.length);
    node.text += '生'.repeat(added);
    remaining -= added;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const json = exportJSON(workspace);
  assert.equal(json.length, targetLength);
  assert.equal(parseImport(json).ok, true);
  const result = { ok: true, json, filename: '原点全部画布.json', mimeType: 'application/json' };
  const sampleBody = JSON.stringify({ requestId: randomUUID(), result });
  assert.ok(Buffer.byteLength(sampleBody) > 5.6 * 1024 * 1024, '中文正文确实超过 5.6 MiB');
  assert.ok(Buffer.byteLength(sampleBody) < 8 * 1024 * 1024, '包括嵌套 JSON 转义后仍在现有 8 MiB 限额内');
  const session = (await api('session', { body: { scope: 'workspace', pageId: randomUUID() } })).value;
  const client = await connectClient(session);
  const pending = client.callTool({ name: 'export_canvas', arguments: { all: true } });
  const request = (await poll(session.ownerToken)).value;
  assert.equal(request.tool, 'export_canvas');
  const body = JSON.stringify({ requestId: request.requestId, result });
  const acknowledged = await api('result', { token: session.ownerToken, rawBody: body });
  assert.equal(acknowledged.status, 200);
  const received = await pending;
  assert.equal(received.isError, undefined);
  assert.equal(received.structuredContent.json, json);
  const imported = parseImport(received.structuredContent.json);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.value, workspace);
  // MCP carries both structured content and a text representation; neither is truncated by the transport.
  const textCopy = JSON.parse(received.content[0].text.slice(received.content[0].text.indexOf('\n') + 1));
  assert.equal(textCopy.json, json);
});

test('固定配对凭据无授权时仍可初始化与发现六工具，同一 SDK 连接在重新授权后立即恢复', async (t) => {
  const { api, connect, poll } = await fixture(t);
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const client = await connect(paired);
  assert.equal((await client.listTools()).tools.length, 6);
  const state = async () => (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.deepEqual(await state(), { ok: true, paired: true, connected: false, scope: 'workspace', state: 'needs_authorization' });
  assert.equal((await client.callTool({ name: 'list_canvases', arguments: {} })).structuredContent.code, 'needs_authorization');
  const granted = await paired.complete('authorize', { ...page, mode: 'read', durationMs: 3600000, takeover: false });
  assert.equal(granted.status, 201);
  assert.equal(granted.value.mode, 'read');
  assert.equal('config' in granted.value, false);
  assert.equal((await state()).connected, true);
  assert.equal((await client.callTool({ name: 'create_canvas', arguments: { expectedWorkspaceRevision: 'a'.repeat(64) } })).structuredContent.code, 'read_only');
  const reading = client.callTool({ name: 'list_canvases', arguments: {} });
  const request = (await poll(granted.value.ownerToken)).value;
  const result = { ok: true, activeId: 'fictional-board', workspaceRevision: 'b'.repeat(64), boards: [{ id: 'fictional-board' }] };
  assert.equal((await api('result', { token: granted.value.ownerToken, body: { requestId: request.requestId, result } })).status, 200);
  assert.deepEqual((await reading).structuredContent, result);
  assert.equal((await api('disconnect', { token: granted.value.ownerToken, body: {} })).status, 200);
  assert.equal((await state()).state, 'needs_authorization');
  assert.equal((await client.listTools()).tools.length, 6);
  const renewed = await paired.complete('authorize', { ...page, mode: 'write', durationMs: 60000, takeover: false });
  assert.equal(renewed.status, 201);
  assert.notEqual(renewed.value.ownerToken, granted.value.ownerToken);
  assert.equal((await state()).mode, 'write');
  const exporting = client.callTool({ name: 'export_canvas', arguments: { all: true } });
  const exportRequest = (await poll(renewed.value.ownerToken)).value;
  const exported = { ok: true, json: JSON.stringify({ version: 1, activeId: 'fictional-board', boards: [{ id: 'fictional-board' }] }), filename: '全部画布.json', mimeType: 'application/json' };
  await api('result', { token: renewed.value.ownerToken, body: { requestId: exportRequest.requestId, result: exported } });
  assert.deepEqual((await exporting).structuredContent, exported);
});

test('刷新、跨页接管和自然期限只撤销临时授权，已交付编辑不重放，取消配对才使固定凭据 401', async (t) => {
  let clock = 10000;
  const { api, connect, poll } = await fixture(t, { now: () => clock, heartbeatMs: 90000 });
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const client = await connect(paired);
  const first = (await paired.complete('authorize', { ...page, mode: 'write', durationMs: 60000, takeover: false })).value;
  const editing = client.callTool({ name: 'edit_canvas', arguments: { boardId: 'fictional', expectedRevision: 'c'.repeat(64), operations: [{ op: 'create_card', text: '不重放' }] } });
  const delivered = (await poll(first.ownerToken)).value;
  const otherPage = { pageId: randomUUID(), tabId: randomUUID() };
  assert.equal((await paired.complete('attach', { ...otherPage, reload: false, takeover: false })).value.code, 'page_in_use');
  const legacyStatus = (await paired.complete('status', otherPage)).value;
  assert.equal(legacyStatus.activeTabId, page.tabId);
  assert.equal(legacyStatus.activeTabLock, false);
  assert.equal((await paired.complete('authorize', { ...otherPage, mode: 'read', durationMs: 60000, takeover: false })).status, 409);
  assert.equal((await paired.complete('release', otherPage)).status, 409);
  const refresh = { pageId: randomUUID(), tabId: page.tabId };
  assert.equal((await paired.complete('attach', { ...refresh, reload: true, takeover: false })).status, 200);
  assert.equal((await editing).structuredContent.code, 'disconnected');
  assert.equal((await api('result', { token: first.ownerToken, body: { requestId: delivered.requestId, result: { ok: true } } })).status, 401);
  assert.equal((await client.callTool({ name: 'get_canvas', arguments: {} })).structuredContent.code, 'needs_authorization');
  const second = (await paired.complete('authorize', { ...refresh, mode: 'read', durationMs: 60000, takeover: false })).value;
  assert.equal((await api('poll', { token: second.ownerToken })).status, 204);
  clock += 60001;
  const expired = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(expired.state, 'expired');
  assert.equal(expired.connected, false);
  assert.equal((await client.listTools()).tools.length, 6);
  assert.equal((await api('poll', { token: second.ownerToken })).status, 401);
  const third = (await paired.complete('authorize', { ...refresh, mode: 'read', durationMs: 60000, takeover: false })).value;
  assert.equal(third.mode, 'read');
  const takeover = (await paired.complete('authorize', { ...otherPage, mode: 'read', durationMs: 60000, takeover: true })).value;
  assert.equal((await api('poll', { token: third.ownerToken })).status, 401);
  assert.equal((await api('poll', { token: takeover.ownerToken })).status, 204);
  assert.equal((await paired.complete('unpair', {})).value.paired, false);
  await assert.rejects(() => client.callTool({ name: 'connection_status', arguments: {} }), /unauthorized/u);
  assert.equal((await api('poll', { token: takeover.ownerToken })).status, 401);
});

test('跨页释放关闭后遗留的会话立即恢复原 SDK，旧 owner、请求和延迟释放不能影响新授权', async (t) => {
  const { api, connect, poll } = await fixture(t);
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const other = { pageId: randomUUID(), tabId: randomUUID() };
  const client = await connect(paired);
  const first = (await paired.complete('authorize', { ...page, mode: 'write', durationMs: null, takeover: false, tabLock: true })).value;
  const observed = await paired.complete('status', other);
  assert.equal(observed.value.state, 'page_in_use');
  assert.match(observed.value.activeSessionId, /^[a-f0-9-]{36}$/u);
  assert.equal(observed.value.activeTabId, page.tabId);
  assert.equal(observed.value.activeTabLock, true);
  const parameters = { ...other, allPages: true, expectedSessionId: observed.value.activeSessionId };
  const delayed = await paired.proof('release', parameters);
  const next = (await paired.complete('authorize', { ...page, mode: 'write', durationMs: null, takeover: false, tabLock: true })).value;
  assert.notEqual(next.ownerToken, first.ownerToken);
  assert.equal((await api('pairing/complete', { body: delayed })).value.code, 'authorization_changed');
  assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.connected, true);
  const current = (await paired.complete('status', other)).value;
  assert.equal(current.activeTabId, page.tabId);
  assert.equal(current.activeTabLock, true);
  const pending = client.callTool({ name: 'edit_canvas', arguments: {
    boardId: 'fictional', expectedRevision: 'c'.repeat(64), operations: [{ op: 'create_card', text: '不能继续旧请求' }]
  } });
  const request = (await poll(next.ownerToken)).value;
  assert.equal((await paired.complete('release', { ...parameters, expectedSessionId: current.activeSessionId })).status, 200);
  assert.equal((await pending).structuredContent.code, 'disconnected');
  assert.equal((await api('poll', { token: next.ownerToken })).status, 401);
  assert.equal((await api('result', { token: next.ownerToken, body: { requestId: request.requestId, result: { ok: true } } })).status, 401);
  assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.connected, false);
  assert.equal((await paired.complete('release', { ...parameters, expectedSessionId: current.activeSessionId })).status, 200);
  assert.equal((await paired.complete('attach', { ...other, reload: false, takeover: false })).status, 200);
  const restored = (await paired.complete('authorize', { ...other, mode: 'write', durationMs: null, takeover: false, tabLock: true })).value;
  const restoredStatus = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(restoredStatus.mode, 'write');
  assert.equal(restoredStatus.expiresAt, null);
  assert.notEqual(restoredStatus.activeSessionId, current.activeSessionId);
  assert.equal((await paired.complete('release', { ...parameters, expectedSessionId: current.activeSessionId })).value.code, 'authorization_changed');
  assert.equal((await api('result', { token: restored.ownerToken, body: { requestId: request.requestId, result: { ok: true } } })).status, 404);
  const reading = client.callTool({ name: 'get_canvas', arguments: {} });
  const readRequest = (await poll(restored.ownerToken)).value;
  assert.equal(readRequest.tool, 'get_canvas');
  await api('result', { token: restored.ownerToken, body: { requestId: readRequest.requestId, result: { ok: true, board: { id: 'fictional' } } } });
  assert.equal((await reading).structuredContent.board.id, 'fictional');
  for (const invalid of [
    null, [], 'all',
    { ...other, allPages: true }, { ...other, allPages: false, expectedSessionId: current.activeSessionId },
    { ...other, allPages: true, expectedSessionId: 'not-a-session' }
  ]) assert.equal((await api('pairing/challenge', { body: { pairingId: paired.pairingId, action: 'release', parameters: invalid } })).status, 400);
});

test('配对证明不可重放或跨操作替换，权限、期限与来源都需明确校验', async (t) => {
  const { api, connect } = await fixture(t);
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const proof = await paired.proof('authorize', { ...page, mode: 'read', durationMs: 60000, takeover: false });
  assert.equal((await api('pairing/complete', { body: { ...proof, mode: 'write' } })).status, 400);
  assert.equal((await api('pairing/complete', { body: proof, headers: { Origin: 'https://outside.example' } })).status, 403);
  assert.equal((await api('pairing/complete', { body: proof })).status, 201);
  assert.equal((await api('pairing/complete', { body: proof })).status, 401);
  assert.equal((await connect(paired).then(client => client.callTool({ name: 'connection_status', arguments: {} }))).structuredContent.mode, 'read');
  for (const parameters of [
    { ...page, mode: 'write', durationMs: 59999, takeover: false },
    { ...page, mode: 'write', durationMs: 3600001, takeover: false },
    ...[undefined, false, true, 0, 900000.5, '900000', {}, []].map((durationMs) => ({ ...page, mode: 'read', durationMs, takeover: false })),
    { ...page, mode: 'admin', durationMs: 60000, takeover: false },
    { ...page, mode: 'write', durationMs: 60000 },
    ...[false, null, 0, 1, 'true', {}, []].map(tabLock => ({ ...page, mode: 'read', durationMs: 60000, takeover: false, tabLock })),
    { ...page, mode: 'write', durationMs: 60000, takeover: false, extra: 'unexpected' }
  ]) assert.equal((await api('pairing/challenge', { body: { pairingId: paired.pairingId, action: 'authorize', parameters } })).status, 400);
  const malformed = await paired.proof('release', page);
  assert.equal((await api('pairing/complete', { body: { ...malformed, signature: 'A'.repeat(86) } })).status, 401);
  assert.equal((await api('pairing/complete', { body: malformed })).status, 401);
});

test('已有客户端凭据可一次迁移为配对身份，沿用现有 SDK，无需修改配置或建立新传输', async (t) => {
  const { api, authorize, connect } = await fixture(t);
  const legacy = await authorize('write');
  const client = await connect(legacy);
  const paired = await pair(api, { clientToken: legacy.clientToken });
  assert.equal(paired.clientToken, legacy.clientToken);
  assert.deepEqual(paired.config, legacy.config);
  assert.equal((await api('poll', { token: legacy.ownerToken })).status, 401);
  const status = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(status.paired, true);
  assert.equal(status.connected, false);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  await paired.complete('authorize', { ...page, mode: 'read', durationMs: 60000, takeover: false });
  assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.mode, 'read');
});

test('服务重启只恢复配对身份，不恢复永久授权、令牌、请求或内容，固定 SDK 凭据可继续连接', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuandian-pairing-http-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('yuandian-pairing-http-'));
  await chmod(directory, 0o700);
  const pairingStorePath = path.join(directory, 'pairings.json');
  const first = await fixture(t, { pairingStorePath });
  const paired = await pair(first.api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const granted = (await paired.complete('authorize', { ...page, mode: 'write', durationMs: null, takeover: false })).value;
  assert.equal(granted.expiresAt, null);
  const persisted = await readFile(pairingStorePath, 'utf8');
  for (const secret of [paired.clientToken, granted.ownerToken, page.pageId, 'expiresAt', 'mode', 'nodes', 'edges', 'pending'])
    assert.equal(persisted.includes(secret), false);
  first.server.closeAllConnections();
  await new Promise(resolve => first.server.close(resolve));
  const second = await fixture(t, { pairingStorePath });
  const client = await second.connect(paired);
  assert.equal((await client.listTools()).tools.length, 6);
  const state = (await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent;
  assert.equal(state.paired, true);
  assert.equal(state.connected, false);
  assert.equal(state.state, 'needs_authorization');
  assert.equal((await second.api('poll', { token: granted.ownerToken })).status, 401);
  // This exact generated directory is checked above; registered after server cleanup.
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('读取慢 MCP 正文期间的重新授权不能把旧请求交给新授权，固定身份仍保持有效', async () => {
  const bridge = createRemoteMcpBridge({ publicUrl, allowedOrigin, pollTimeoutMs: 10 });
  const headers = { Host: hostname, Origin: allowedOrigin, 'X-Yuandian-Client': 'canvas', 'Content-Type': 'application/json' };
  async function api(route, { body } = {}) {
    const response = await bridge.fetch(new Request(`https://${hostname}/api/mcp/${route}`, { method: 'POST', headers, body: JSON.stringify(body) }));
    return { status: response.status, value: await response.json() };
  }
  try {
    const paired = await pair(api);
    const page = { pageId: randomUUID(), tabId: randomUUID() };
    await paired.complete('authorize', { ...page, mode: 'write', durationMs: 60000, takeover: false });
    let release;
    const stream = new ReadableStream({ start(controller) { release = () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'edit_canvas', arguments: { boardId: 'fictional', expectedRevision: 'a'.repeat(64), operations: [{ op: 'create_card', text: '旧请求' }] }
      } })));
      controller.close();
    }; } });
    const pending = bridge.fetch(new Request(`https://${hostname}/mcp`, {
      method: 'POST', headers: { Host: hostname, Authorization: `Bearer ${paired.clientToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: stream, duplex: 'half'
    }));
    const renewed = (await paired.complete('authorize', { ...page, mode: 'write', durationMs: 60000, takeover: false })).value;
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /authorization_changed/u);
    const queued = await bridge.fetch(new Request(`https://${hostname}/api/mcp/poll`, { headers: { ...headers, Authorization: `Bearer ${renewed.ownerToken}` } }));
    assert.equal(queued.status, 204);
  } finally { await bridge.close(); }
});

test('取消配对先立即撤销授权再等待持久化，并阻止并发证明在落盘期间重新授权', async (t) => {
  const authority = createMemoryPairingAuthority();
  let beginRevoke;
  let finishRevoke;
  const begun = new Promise(resolve => { beginRevoke = resolve; });
  const gate = new Promise(resolve => { finishRevoke = resolve; });
  const pairingAuthority = { ...authority, async revoke(pairingId) { beginRevoke(); await gate; return await authority.revoke(pairingId); } };
  const { api, connect, poll } = await fixture(t, { pairingAuthority });
  const paired = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const grant = (await paired.complete('authorize', { ...page, mode: 'read', durationMs: 60000, takeover: false })).value;
  const client = await connect(paired);
  const reading = client.callTool({ name: 'get_canvas', arguments: {} });
  await poll(grant.ownerToken);
  const nextProof = await paired.proof('authorize', { ...page, mode: 'write', durationMs: 60000, takeover: false });
  const unpairing = paired.complete('unpair', {});
  await begun;
  try {
    assert.equal((await reading).structuredContent.code, 'disconnected');
    assert.equal((await api('poll', { token: grant.ownerToken })).status, 401);
    assert.equal((await api('pairing/complete', { body: nextProof })).value.code, 'pairing_revoking');
    assert.equal((await client.callTool({ name: 'connection_status', arguments: {} })).structuredContent.connected, false);
  } finally { finishRevoke(); }
  assert.equal((await unpairing).status, 200);
  await assert.rejects(() => client.listTools(), /unauthorized/u);
});

test('身份状态落盘后不确定时整个中继停止转发，其他配对的 owner 和等待请求也同步失效', async (t) => {
  const authority = createMemoryPairingAuthority();
  const pairingAuthority = { ...authority, async revoke() { throw Object.assign(new Error('Fictional directory sync failure'), { pairingStoreUncertain: true }); } };
  const { api, connect, poll } = await fixture(t, { pairingAuthority });
  const first = await pair(api);
  const second = await pair(api);
  const page = { pageId: randomUUID(), tabId: randomUUID() };
  const grant = (await second.complete('authorize', { ...page, mode: 'read', durationMs: 60000, takeover: false })).value;
  const client = await connect(second);
  const reading = client.callTool({ name: 'get_canvas', arguments: {} });
  await poll(grant.ownerToken);
  assert.equal((await first.complete('unpair', {})).status, 500);
  assert.equal((await reading).structuredContent.code, 'unavailable');
  assert.equal((await api('poll', { token: grant.ownerToken })).status, 503);
  assert.equal((await api('/health', { method: 'GET', browser: false })).status, 503);
});
