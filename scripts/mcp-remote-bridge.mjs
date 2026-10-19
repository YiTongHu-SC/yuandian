import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createCanvasMcpServer } from './mcp-server.mjs';

const HOUR = 60 * 60 * 1000;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const failure = (code, error) => ({ ok: false, code, error });
const bearer = (request) =>
  /^Bearer ([a-f0-9]{64})$/u.exec(request.headers.get('authorization') || '')?.[1];
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function remoteSettings(environment = process.env) {
  const publicUrl = environment.YUANDIAN_PUBLIC_URL;
  const allowedOrigin =
    environment.YUANDIAN_ALLOWED_ORIGIN || 'https://yitonghu-sc.github.io';
  const rawPort = environment.YUANDIAN_PORT || '4177';
  if (!/^[1-9]\d{0,4}$/u.test(rawPort) || Number(rawPort) > 65535)
    throw new Error('YUANDIAN_PORT 必须为 1 到 65535 的端口。');
  return { ...validateSettings({ publicUrl, allowedOrigin }), port: Number(rawPort) };
}

function validateSettings({ publicUrl, allowedOrigin }) {
  let endpoint;
  let origin;
  try {
    endpoint = new URL(publicUrl);
    origin = new URL(allowedOrigin);
  } catch {
    throw new Error('YUANDIAN_PUBLIC_URL 和 YUANDIAN_ALLOWED_ORIGIN 必须为 HTTPS 地址。');
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.href !== publicUrl ||
    /%|\/\//u.test(endpoint.pathname) ||
    (endpoint.pathname !== '/' && endpoint.pathname.endsWith('/'))
  ) throw new Error('YUANDIAN_PUBLIC_URL 必须为无凭据、查询和尾斜杠的 HTTPS 服务地址。');
  if (
    origin.protocol !== 'https:' || origin.origin !== allowedOrigin ||
    origin.username || origin.password || origin.pathname !== '/' ||
    origin.search || origin.hash
  ) throw new Error('YUANDIAN_ALLOWED_ORIGIN 必须为不带路径的精确 HTTPS 页面来源。');
  return { publicUrl: endpoint.href.replace(/\/$/u, ''), allowedOrigin };
}

async function readJson(request, limit) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw Object.assign(new Error('请发送 application/json。'), { status: 415 });
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit))
    throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  const reader = request.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw Object.assign(new Error('请求内容过大。'), { status: 413 });
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式无效。'), { status: 400 });
  }
}

/** A single-process, memory-only relay. Caddy strips the public path prefix. */
export function createRemoteMcpBridge({
  publicUrl,
  allowedOrigin = 'https://yitonghu-sc.github.io',
  requestTimeoutMs = 30000,
  pollTimeoutMs = 20000,
  heartbeatMs = 90000,
  sessionTtlMs = HOUR,
  maxSessions = 16,
  maxPending = 8,
  now = Date.now
} = {}) {
  ({ publicUrl, allowedOrigin } = validateSettings({ publicUrl, allowedOrigin }));
  for (const value of [requestTimeoutMs, pollTimeoutMs, heartbeatMs, sessionTtlMs, maxSessions, maxPending])
    if (!Number.isFinite(value) || value <= 0) throw new Error('MCP 限额必须为正数。');
  if (sessionTtlMs > HOUR || pollTimeoutMs >= heartbeatMs)
    throw new Error('授权最多一小时，心跳期限必须长于长轮询。');
  const publicAddress = new URL(publicUrl);
  const owners = new Map();
  const clients = new Map();
  const sessions = new Set();
  const rates = new Map();
  let closed = false;
  let pendingTotal = 0;
  let reservedBodyBytes = 0;

  async function boundedJson(request, maximum) {
    if (reservedBodyBytes + maximum > 32 * 1024 * 1024)
      throw Object.assign(new Error('并发请求过多，请稍后重试。'), { status: 429 });
    reservedBodyBytes += maximum;
    try { return await readJson(request, maximum); }
    finally { reservedBodyBytes -= maximum; }
  }

  function limit(key, maximum, windowMs = 60000) {
    const current = now();
    for (const [entry, value] of rates)
      if (value.until <= current) rates.delete(entry);
    let bucket = rates.get(key);
    if (!bucket) {
      if (rates.size >= 1024) return false;
      bucket = { count: 0, until: current + windowMs };
      rates.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= maximum;
  }

  function settle(session, item, result) {
    if (!session.pending.delete(item.requestId)) return;
    pendingTotal -= 1;
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.onAbort);
    item.resolve(result);
  }

  function finishPoll(session, response) {
    const poll = session.poll;
    if (!poll) return;
    session.poll = null;
    clearTimeout(poll.timer);
    poll.signal?.removeEventListener('abort', poll.onAbort);
    poll.resolve(response);
  }

  function revoke(session, reason = failure('disconnected', '画布连接已断开，请在原点重新授权。')) {
    sessions.delete(session);
    owners.delete(session.ownerToken);
    clients.delete(session.clientToken);
    finishPoll(session, json(401, reason));
    for (const item of session.pending.values()) settle(session, item, reason);
    session.acknowledged.clear();
  }

  function sweep() {
    for (const session of sessions) {
      if (now() >= session.expiresAt || now() - session.heartbeat > heartbeatMs)
        revoke(session, failure('session_expired', '画布连接已过期，请保持页面打开并重新授权。'));
      else for (const [id, ack] of session.acknowledged)
        if (ack.until <= now()) session.acknowledged.delete(id);
    }
  }
  const timer = setInterval(sweep, Math.min(1000, heartbeatMs));
  timer.unref();

  function json(status, value, extraHeaders = {}) {
    return new Response(value === undefined ? null : JSON.stringify(value), {
      status,
      headers: {
        ...(value === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
        ...extraHeaders
      }
    });
  }

  function delivered(session, item) {
    item.delivered = true;
    // A delivered request is never put back on the queue, even if its HTTP response is lost.
    return json(200, {
      requestId: item.requestId,
      tool: item.tool,
      arguments: item.arguments,
      expiresAt: Math.min(item.expiresAt, session.expiresAt, session.heartbeat + heartbeatMs)
    });
  }

  function wake(session) {
    if (!session.poll) return;
    const item = [...session.pending.values()].find((candidate) => !candidate.delivered);
    if (item) finishPoll(session, delivered(session, item));
  }

  function authorized(token, owner = false) {
    sweep();
    return (owner ? owners : clients).get(token);
  }

  async function call(token, tool, arguments_, signal) {
    const session = authorized(token);
    if (!session) return failure('unauthorized', '连接未授权或已过期，请在原点重新授权。');
    if (!['connection_status', 'get_canvas', 'edit_canvas'].includes(tool) || !object(arguments_))
      return failure('invalid_tool', '无效的工具调用。');
    if (tool !== 'edit_canvas' && Object.keys(arguments_).length)
      return failure('invalid_arguments', '此工具不接受参数。');
    if (tool === 'connection_status') return {
      ok: true, connected: true, boardId: session.boardId, pageId: session.pageId,
      mode: session.mode, expiresAt: session.expiresAt, heartbeatAt: session.heartbeat
    };
    if (tool === 'edit_canvas' && session.mode !== 'write')
      return failure('read_only', '当前连接只允许读取，编辑需在原点重新授权。');
    if (session.pending.size >= maxPending || pendingTotal >= 64)
      return failure('queue_full', '等待中的请求过多，请等待已有请求完成。');
    if (signal?.aborted) return failure('client_closed', 'AI 客户端已断开，请重新读取最新画布。');
    return await new Promise((resolve) => {
      const item = {
        requestId: randomUUID(), tool, arguments: arguments_,
        expiresAt: now() + requestTimeoutMs, delivered: false, resolve, signal
      };
      item.timer = setTimeout(() => settle(session, item,
        failure('request_timeout', '画布响应超时；请重新读取最新画布，避免重复编辑。')), requestTimeoutMs);
      item.onAbort = () => settle(session, item,
        failure('client_closed', 'AI 客户端已断开；请重新读取最新画布，避免重复编辑。'));
      session.pending.set(item.requestId, item);
      pendingTotal += 1;
      signal?.addEventListener('abort', item.onAbort, { once: true });
      wake(session);
    });
  }

  const mcp = createMcpHandler(({ requestInfo }) => {
    const token = bearer(requestInfo);
    return createCanvasMcpServer({ relay: (tool, input) => call(token, tool, input, requestInfo.signal) });
  }, { responseMode: 'auto', legacy: 'stateless', maxRequestBodySize: 1024 * 1024, maxSubscriptions: 0, onerror: () => {} });

  async function dispatch(request, { clientAddress = 'unknown' } = {}) {
    const address = new URL(request.url);
    const route = address.pathname;
    const origin = request.headers.get('origin');
    const deny = (status, code, error) => json(status, failure(code, error));
    if (closed) return deny(503, 'unavailable', 'MCP 中继已停止。');
    if (request.headers.get('host') !== publicAddress.host)
      return deny(403, 'invalid_host', '请求主机与中继服务不一致。');
    if (origin && origin !== allowedOrigin)
      return deny(403, 'invalid_origin', '请求来源与原点页面不一致。');
    if (address.search)
      return deny(400, 'invalid_url', '此接口不接受 URL 查询参数。');
    if (!['/health', '/mcp', '/api/mcp/session', '/api/mcp/poll', '/api/mcp/result', '/api/mcp/disconnect'].includes(route))
      return deny(404, 'not_found', '未知 MCP 路径。');
    const allowedMethods = route === '/health' || route === '/api/mcp/poll' ? ['GET'] : ['POST'];
    if (request.method === 'OPTIONS') {
      const permittedHeaders = ['authorization', 'content-type', 'x-yuandian-client', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id'];
      const requestedHeaders = (request.headers.get('access-control-request-headers') || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
      if (origin !== allowedOrigin || !allowedMethods.includes(request.headers.get('access-control-request-method')) || requestedHeaders.some((name) => !permittedHeaders.includes(name)))
        return deny(403, 'invalid_preflight', '跨源请求未获允许。');
      return json(204, undefined, {
        'Access-Control-Allow-Methods': allowedMethods.join(', '),
        'Access-Control-Allow-Headers': permittedHeaders.join(', '),
        'Access-Control-Max-Age': '300'
      });
    }
    if (!allowedMethods.includes(request.method))
      return json(405, failure('invalid_method', '请求方法不支持。'), { Allow: allowedMethods.join(', ') });
    if (route === '/health') return json(200, { ok: true, service: 'yuandian-mcp', version: '0.1.0' });
    const browserRoute = route.startsWith('/api/mcp/');
    if (browserRoute && (origin !== allowedOrigin || request.headers.get('x-yuandian-client') !== 'canvas'))
      return deny(403, 'invalid_client', '授权与画布通信必须由原点页面发起。');
    sweep();
    if (route === '/api/mcp/session') {
      if (!limit(`create:${clientAddress}`, 8))
        return deny(429, 'rate_limit', '开启接入过于频繁，请稍后重试。');
      const input = await boundedJson(request, 8192);
      if (!exactKeys(input, ['boardId', 'pageId', 'mode']) || typeof input.boardId !== 'string' || !input.boardId.length || input.boardId.length > 100 || !uuid.test(input.pageId || '') || (input.mode !== undefined && !['read', 'write'].includes(input.mode)))
        return deny(400, 'invalid_session', '请选择当前单张画布、页面和读取或编辑权限。');
      // A body read can overlap expiration, shutdown or another authorization.
      sweep();
      if (closed) return deny(503, 'unavailable', 'MCP 中继已停止。');
      if (sessions.size >= maxSessions)
        return deny(429, 'session_limit', '连接过多，请先断开不用的连接。');
      const session = {
        boardId: input.boardId, pageId: input.pageId, mode: input.mode || 'read',
        ownerToken: randomBytes(32).toString('hex'), clientToken: randomBytes(32).toString('hex'),
        expiresAt: now() + sessionTtlMs, heartbeat: now(), pending: new Map(), acknowledged: new Map(), poll: null
      };
      sessions.add(session);
      owners.set(session.ownerToken, session);
      clients.set(session.clientToken, session);
      return json(201, {
        ownerToken: session.ownerToken, clientToken: session.clientToken,
        boardId: session.boardId, pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt,
        config: { url: `${publicUrl}/mcp`, headers: { Authorization: `Bearer ${session.clientToken}` } }
      });
    }
    const token = bearer(request);
    const session = authorized(token, browserRoute);
    if (!session) {
      if (!limit(`invalid:${clientAddress}`, 120)) return deny(429, 'rate_limit', '请求过于频繁，请稍后重试。');
      return json(401, failure('unauthorized', '连接未授权或已过期，请在原点重新授权。'), { 'WWW-Authenticate': 'Bearer realm="yuandian-canvas"' });
    }
    if (!limit(`${browserRoute ? 'owner' : 'client'}:${token}`, 120))
      return deny(429, 'rate_limit', '请求过于频繁，请稍后重试。');
    if (!browserRoute) {
      const input = await boundedJson(request, 1024 * 1024);
      if (authorized(token) !== session) return deny(401, 'unauthorized', '授权已过期，请重新开启接入。');
      return await mcp.fetch(request, { parsedBody: input });
    }
    session.heartbeat = now();
    if (route === '/api/mcp/poll') {
      if (session.poll) return deny(409, 'poll_in_progress', '此页面已有等待中的轮询。');
      const item = [...session.pending.values()].find((candidate) => !candidate.delivered);
      if (item) return delivered(session, item);
      if (request.signal.aborted) return json(204);
      return await new Promise((resolve) => {
        const poll = { resolve, signal: request.signal };
        poll.timer = setTimeout(() => {
          if (authorized(token, true) !== session) return;
          session.heartbeat = now();
          finishPoll(session, json(204));
        }, pollTimeoutMs);
        poll.onAbort = () => finishPoll(session, json(204));
        session.poll = poll;
        request.signal.addEventListener('abort', poll.onAbort, { once: true });
      });
    }
    const input = await boundedJson(request, route === '/api/mcp/result' ? 8 * 1024 * 1024 : 1024);
    if (authorized(token, true) !== session) return deny(401, 'unauthorized', '授权已过期，请重新开启接入。');
    session.heartbeat = now();
    if (route === '/api/mcp/disconnect') {
      if (!exactKeys(input, []) || Object.keys(input).length)
        return deny(400, 'invalid_request', '断开操作不接受参数。');
      revoke(session);
      return json(200, { ok: true });
    }
    if (!exactKeys(input, ['requestId', 'result']) || !uuid.test(input.requestId || '') || !object(input.result) || typeof input.result.ok !== 'boolean')
      return deny(400, 'invalid_result', '无效的画布响应。');
    const signature = digest(input.result);
    const previous = session.acknowledged.get(input.requestId);
    if (previous) return previous.signature === signature ? json(200, { ok: true }) : deny(409, 'result_conflict', '此请求已经完成，不能替换结果。');
    const item = session.pending.get(input.requestId);
    if (!item || !item.delivered || now() >= item.expiresAt)
      return deny(404, 'request_finished', '请求已结束或不属于此连接；请重新读取画布。');
    if (input.result.ok && item.tool === 'get_canvas' && input.result.board?.id !== session.boardId)
      return deny(400, 'scope_mismatch', '响应不属于已授权的画布。');
    session.acknowledged.set(input.requestId, { signature, until: now() + 60000 });
    if (session.acknowledged.size > 32) session.acknowledged.delete(session.acknowledged.keys().next().value);
    settle(session, item, input.result);
    return json(200, { ok: true });
  }

  return {
    async fetch(request, metadata) {
      let response;
      try { response = await dispatch(request, metadata); }
      catch (error) {
        response = json(error.status || 500, failure(error.status ? 'invalid_request' : 'internal_error', error.status ? error.message : 'MCP 请求未完成，请重新连接。'));
      }
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Vary', 'Origin');
      if (request.headers.get('origin') === allowedOrigin) {
        response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
        response.headers.set('Access-Control-Expose-Headers', 'MCP-Protocol-Version');
      }
      return response;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const session of sessions) revoke(session);
      rates.clear();
      await mcp.close();
    }
  };
}
