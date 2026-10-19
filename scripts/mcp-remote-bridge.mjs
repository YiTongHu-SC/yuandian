import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createCanvasMcpServer } from './mcp-server.mjs';
import { inspectMcpCall, inspectMcpGrant, inspectMcpResult, validMcpDuration } from './mcp-access.mjs';
import { createMemoryPairingAuthority } from './mcp-pairing-store.mjs';

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
  const pairingStorePath = environment.YUANDIAN_PAIRING_STORE;
  if (pairingStorePath !== undefined && (!pairingStorePath || /[\r\n\0]/u.test(pairingStorePath)))
    throw new Error('YUANDIAN_PAIRING_STORE 必须为配对记录文件路径。');
  return {
    ...validateSettings({ publicUrl, allowedOrigin }), port: Number(rawPort),
    ...(pairingStorePath ? { pairingStorePath } : {})
  };
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

/** Content and grants are memory-only; the authority stores pairing metadata separately. */
export function createRemoteMcpBridge({
  publicUrl,
  allowedOrigin = 'https://yitonghu-sc.github.io',
  requestTimeoutMs = 30000,
  pollTimeoutMs = 20000,
  heartbeatMs = 90000,
  sessionTtlMs = HOUR,
  maxSessions = 16,
  maxPending = 8,
  now = Date.now,
  pairingAuthority = createMemoryPairingAuthority({ now })
} = {}) {
  ({ publicUrl, allowedOrigin } = validateSettings({ publicUrl, allowedOrigin }));
  for (const value of [requestTimeoutMs, pollTimeoutMs, heartbeatMs, sessionTtlMs, maxSessions, maxPending])
    if (!Number.isFinite(value) || value <= 0) throw new Error('MCP 限额必须为正数。');
  if (sessionTtlMs > HOUR || pollTimeoutMs >= heartbeatMs)
    throw new Error('有限授权的默认期限最多一小时，心跳期限必须长于长轮询。');
  const publicAddress = new URL(publicUrl);
  const owners = new Map();
  const clients = new Map();
  const pairedSessions = new Map();
  const pairedPages = new Map();
  const unpairing = new Set();
  const requestBindings = new WeakMap();
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
    if (session.pairingId && pairedSessions.get(session.pairingId) === session) {
      pairedSessions.delete(session.pairingId);
      const page = pairedPages.get(session.pairingId);
      if (page) page.state = reason.code === 'session_expired' ? 'expired' : 'needs_authorization';
    }
    finishPoll(session, json(401, reason));
    for (const item of session.pending.values()) settle(session, item, reason);
    session.acknowledged.clear();
  }

  function sweep() {
    for (const session of sessions) {
      if ((session.expiresAt !== null && now() >= session.expiresAt) || now() - session.heartbeat > heartbeatMs)
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
      expiresAt: Math.min(item.expiresAt, session.expiresAt ?? Infinity, session.heartbeat + heartbeatMs)
    });
  }

  function wake(session) {
    if (!session.poll) return;
    const item = [...session.pending.values()].find((candidate) => !candidate.delivered);
    if (item) finishPoll(session, delivered(session, item));
  }

  function authorized(token, owner = false) {
    sweep();
    const session = (owner ? owners : clients).get(token);
    if (session?.pairingId) {
      try {
        if (!pairingAuthority.get(session.pairingId)) { revoke(session); return null; }
      } catch (error) {
        revoke(session, failure('unavailable', '配对状态暂不可用，请重新检查网页接入。'));
        throw error;
      }
    }
    return session;
  }

  function clientIdentity(token) {
    sweep();
    const pairing = pairingAuthority.authenticate(token);
    if (pairing) return { pairing, session: pairedSessions.get(pairing.pairingId) };
    const session = clients.get(token);
    return session ? { session } : null;
  }

  function pairingStatus(pairingId, pageId) {
    sweep();
    const session = pairedSessions.get(pairingId);
    const page = pairedPages.get(pairingId);
    if (session && (!pageId || session.pageId === pageId)) return {
      ok: true, paired: true, connected: true, state: 'authorized', scope: 'workspace',
      pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt,
      activeSessionId: session.sessionId,
      heartbeatAt: session.heartbeat
    };
    return {
      ok: true, paired: true, connected: false, scope: 'workspace',
      state: session ? 'page_in_use' : page?.state || 'needs_authorization',
      ...(session ? { activePage: true, activeSessionId: session.sessionId, activeTabId: session.tabId, activeTabLock: session.tabLock === true } : {})
    };
  }

  async function call(token, tool, arguments_, signal, binding) {
    const identity = clientIdentity(token);
    if (!identity) return failure('unauthorized', '连接未授权或已过期，请在原点重新授权。');
    const { session, pairing } = identity;
    if (pairing && tool === 'connection_status') {
      const callError = inspectMcpCall({ scope: 'workspace', mode: 'read' }, tool, arguments_);
      return callError ? callError.value : pairingStatus(pairing.pairingId);
    }
    if (binding?.pairing && session !== binding.session)
      return failure('authorization_changed', '请求期间网页授权已变更，请重新读取画布，不要重放编辑。');
    if (!session) return failure('needs_authorization', '配对已保留，请在原点网页重新授权后再操作画布。');
    const callError = inspectMcpCall(session, tool, arguments_);
    if (callError) return callError.value;
    if (tool === 'connection_status') return {
      ok: true, connected: true, scope: session.scope, boardId: session.boardId, pageId: session.pageId,
      mode: session.mode, expiresAt: session.expiresAt, heartbeatAt: session.heartbeat
    };
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
    const binding = requestBindings.get(requestInfo);
    return createCanvasMcpServer({ relay: (tool, input) => call(token, tool, input, requestInfo.signal, binding) });
  }, { responseMode: 'auto', legacy: 'stateless', maxRequestBodySize: 1024 * 1024, maxSubscriptions: 0, onerror: () => {} });

  function validPairingAction(action, parameters) {
    if (!object(parameters)) return false;
    const page = () => uuid.test(parameters.pageId || '') && uuid.test(parameters.tabId || '');
    if (action === 'unpair') return exactKeys(parameters, []) && !Object.keys(parameters).length;
    if (action === 'release' && parameters.allPages === true)
      return exactKeys(parameters, ['pageId', 'tabId', 'allPages', 'expectedSessionId']) && page() &&
        uuid.test(parameters.expectedSessionId || '');
    if (action === 'status' || action === 'release')
      return exactKeys(parameters, ['pageId', 'tabId']) && page();
    if (action === 'attach') return exactKeys(parameters, ['pageId', 'tabId', 'reload', 'takeover']) && page() &&
      typeof parameters.reload === 'boolean' && typeof parameters.takeover === 'boolean';
    if (action === 'authorize') return exactKeys(parameters, ['pageId', 'tabId', 'mode', 'durationMs', 'takeover', 'tabLock']) && page() &&
      ['read', 'write'].includes(parameters.mode) && validMcpDuration(parameters.durationMs) &&
      typeof parameters.takeover === 'boolean' && (parameters.tabLock === undefined || parameters.tabLock === true);
    return false;
  }

  async function pairingRequest(route, request, clientAddress) {
    if (!limit(`pairing:${clientAddress}`, 60))
      return json(429, failure('rate_limit', '配对操作过于频繁，请稍后重试。'));
    const input = await boundedJson(request, 8192);
    if (closed) return json(503, failure('unavailable', 'MCP 中继已停止。'));
    if (route === '/api/mcp/pairings') {
      if (!exactKeys(input, ['publicKey', 'clientToken']) || !object(input.publicKey) ||
          (input.clientToken !== undefined && !/^[a-f0-9]{64}$/u.test(input.clientToken)))
        return json(400, failure('invalid_pairing', '配对公钥或客户端凭据无效。'));
      if (!limit(`pairing-create:${clientAddress}`, 8))
        return json(429, failure('rate_limit', '创建配对过于频繁，请稍后重试。'));
      const created = await pairingAuthority.create(input);
      // The supplied key can migrate a previously configured temporary client.
      // Its previous grant must not survive the new pairing identity.
      const previous = clients.get(created.clientToken);
      if (previous) revoke(previous);
      return json(201, {
        ok: true, pairingId: created.pairingId,
        config: { url: `${publicUrl}/mcp`, headers: { Authorization: `Bearer ${created.clientToken}` } }
      });
    }
    if (route === '/api/mcp/pairing/challenge') {
      if (!exactKeys(input, ['pairingId', 'action', 'parameters']) || !uuid.test(input.pairingId || '') ||
          !validPairingAction(input.action, input.parameters))
        return json(400, failure('invalid_pairing_action', '配对操作参数无效。'));
      if (unpairing.has(input.pairingId))
        return json(409, failure('pairing_revoking', '正在取消此配对，请等待操作完成。'));
      return json(200, { ok: true, ...pairingAuthority.issue(input) });
    }
    if (!exactKeys(input, ['pairingId', 'challengeId', 'signature']) || !uuid.test(input.pairingId || '') ||
        !uuid.test(input.challengeId || '') || typeof input.signature !== 'string')
      return json(400, failure('invalid_pairing_proof', '配对证明无效。'));
    const verified = pairingAuthority.verify(input);
    if (!pairingAuthority.get(verified.pairingId) || !validPairingAction(verified.action, verified.parameters))
      return json(401, failure('invalid_pairing_proof', '配对已失效，请重新配对。'));
    const { pairingId, action, parameters } = verified;
    if (unpairing.has(pairingId))
      return json(409, failure('pairing_revoking', '正在取消此配对，请等待操作完成。'));
    sweep();
    if (action === 'status') return json(200, pairingStatus(pairingId, parameters.pageId));
    if (action === 'unpair') {
      const previous = pairedSessions.get(pairingId);
      if (previous) revoke(previous);
      unpairing.add(pairingId);
      try { await pairingAuthority.revoke(pairingId); }
      finally { unpairing.delete(pairingId); }
      pairedPages.delete(pairingId);
      return json(200, { ok: true, paired: false, connected: false, state: 'unpaired' });
    }
    const active = pairedSessions.get(pairingId);
    const samePage = active?.pageId === parameters.pageId && active?.tabId === parameters.tabId;
    if (action === 'release') {
      if (active && parameters.allPages === true && active.sessionId !== parameters.expectedSessionId)
        return json(409, failure('authorization_changed', '授权已更新，请重新检查后再断开。'));
      if (active && !samePage && parameters.allPages !== true)
        return json(409, failure('page_in_use', '此配对正在另一页面授权，不能从旧页面撤销。'));
      if (active) revoke(active);
      return json(200, pairingStatus(pairingId, parameters.pageId));
    }
    const permittedReload = action === 'attach' && parameters.reload && active?.tabId === parameters.tabId;
    if (active && !samePage && !permittedReload && !parameters.takeover)
      return json(409, failure('page_in_use', '此配对已由另一页面授权，请明确选择改由此页授权。'));
    if (active) revoke(active);
    pairedPages.set(pairingId, { pageId: parameters.pageId, tabId: parameters.tabId, state: 'needs_authorization' });
    if (action === 'attach') return json(200, pairingStatus(pairingId, parameters.pageId));
    if (sessions.size >= maxSessions)
      return json(429, failure('session_limit', '连接过多，请先断开不用的连接。'));
    const session = {
      scope: 'workspace', pairingId, sessionId: randomUUID(), pageId: parameters.pageId, tabId: parameters.tabId, tabLock: parameters.tabLock === true, mode: parameters.mode,
      ownerToken: randomBytes(32).toString('hex'),
      expiresAt: parameters.durationMs === null ? null : now() + Math.min(parameters.durationMs, sessionTtlMs), heartbeat: now(),
      pending: new Map(), acknowledged: new Map(), poll: null
    };
    sessions.add(session);
    owners.set(session.ownerToken, session);
    pairedSessions.set(pairingId, session);
    return json(201, {
      ok: true, paired: true, connected: true, state: 'authorized', ownerToken: session.ownerToken,
      scope: session.scope, pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt
    });
  }

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
    if (!['/health', '/mcp', '/api/mcp/session', '/api/mcp/poll', '/api/mcp/result', '/api/mcp/disconnect',
      '/api/mcp/pairings', '/api/mcp/pairing/challenge', '/api/mcp/pairing/complete'].includes(route))
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
    if (route === '/api/mcp/pairings' || route.startsWith('/api/mcp/pairing/'))
      return await pairingRequest(route, request, clientAddress);
    if (route === '/api/mcp/session') {
      if (!limit(`create:${clientAddress}`, 8))
        return deny(429, 'rate_limit', '开启接入过于频繁，请稍后重试。');
      const input = await boundedJson(request, 8192);
      const grant = inspectMcpGrant(input, { requireLegacyPageId: true });
      if (!grant) return deny(400, 'invalid_session', '请选择有效的页面授权范围与读取或编辑权限。');
      // A body read can overlap expiration, shutdown or another authorization.
      sweep();
      if (closed) return deny(503, 'unavailable', 'MCP 中继已停止。');
      if (sessions.size >= maxSessions)
        return deny(429, 'session_limit', '连接过多，请先断开不用的连接。');
      const session = {
        ...grant,
        ownerToken: randomBytes(32).toString('hex'), clientToken: randomBytes(32).toString('hex'),
        expiresAt: grant.durationMs === null ? null : now() + Math.min(grant.durationMs ?? sessionTtlMs, sessionTtlMs),
        heartbeat: now(), pending: new Map(), acknowledged: new Map(), poll: null
      };
      sessions.add(session);
      owners.set(session.ownerToken, session);
      clients.set(session.clientToken, session);
      return json(201, {
        ownerToken: session.ownerToken, clientToken: session.clientToken,
        scope: session.scope, boardId: session.boardId, pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt,
        config: { url: `${publicUrl}/mcp`, headers: { Authorization: `Bearer ${session.clientToken}` } }
      });
    }
    const token = bearer(request);
    const identity = browserRoute ? null : clientIdentity(token);
    const session = browserRoute ? authorized(token, true) : identity?.session;
    if (browserRoute ? !session : !identity) {
      if (!limit(`invalid:${clientAddress}`, 120)) return deny(429, 'rate_limit', '请求过于频繁，请稍后重试。');
      return json(401, failure('unauthorized', '连接未授权或已过期，请在原点重新授权。'), { 'WWW-Authenticate': 'Bearer realm="yuandian-canvas"' });
    }
    if (!limit(`${browserRoute ? 'owner' : 'client'}:${token}`, 120))
      return deny(429, 'rate_limit', '请求过于频繁，请稍后重试。');
    if (!browserRoute) {
      const input = await boundedJson(request, 1024 * 1024);
      const current = clientIdentity(token);
      if (!current || (identity.pairing ? current.pairing?.pairingId !== identity.pairing.pairingId : current.session !== session))
        return deny(401, 'unauthorized', '配对或授权已失效，请在原点重新开启接入。');
      requestBindings.set(request, identity);
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
    const resultError = inspectMcpResult(session, item, input.result);
    if (resultError) return json(resultError.status, resultError.value);
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
        if (error.pairingStoreUncertain || error.status === 503 && error.code === 'unavailable') {
          // An uncertain durable identity state must not leave owner requests
          // or other paired grants alive while HTTP client auth fails closed.
          closed = true;
          clearInterval(timer);
          for (const session of sessions) revoke(session, failure('unavailable', '配对状态暂不可用，请等待服务恢复后重新授权。'));
        }
        response = json(error.status || 500, failure(error.status ? error.code || 'invalid_request' : 'internal_error', error.status ? error.message : 'MCP 请求未完成，请重新连接。'));
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
      pairedPages.clear();
      pairingAuthority.close();
      await mcp.close();
    }
  };
}
