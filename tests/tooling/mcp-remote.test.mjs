import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRemoteMcpBridge, remoteSettings } from '../../scripts/mcp-remote-bridge.mjs';
import { startRemoteMcpServer } from '../../scripts/mcp-remote-server.mjs';
import { LIMITS, connect, createBoard, createNode, createWorkspace, exportJSON, parseImport } from '../../src/canvas/model.js';

const publicUrl = 'https://relay.example/yuandian-mcp';
const allowedOrigin = 'https://yitonghu-sc.github.io';
const hostname = 'relay.example';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('心跳和最长一小时均撤销；AI 请求不会续期浏览器心跳', async (t) => {
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
