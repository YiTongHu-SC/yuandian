import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspectMcpCall, inspectMcpGrant, inspectMcpResult, validMcpDuration } from './mcp-access.mjs';
import { createMemoryPairingAuthority } from './mcp-pairing-store.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, error) => ({ ok: false, code, error });
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

async function readJson(request, maximum = MAX_BODY_BYTES) {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    throw Object.assign(new Error('请发送 application/json。'), {
      status: 415
    });
  }
  if (Number(request.headers['content-length']) > maximum) {
    request.resume();
    throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum)
      throw Object.assign(new Error('请求内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式无效。'), { status: 400 });
  }
}

/** Ephemeral authorization and request relay. The browser remains the only data owner. */
export function createMcpBridge({
  origin,
  root,
  nodePath = process.execPath,
  requestTimeoutMs = 15000,
  heartbeatMs = 10000,
  sessionTtlMs = 3600000,
  maxPending = 8,
  now = Date.now,
  pairingAuthority = createMemoryPairingAuthority({ now })
} = {}) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('MCP 桥仅支持带端口的本机 127.0.0.1 HTTP 地址。');
  }
  const expectedOrigin = url.origin;
  const sessions = new Set();
  const owners = new Map();
  const clients = new Map();
  const pairedSessions = new Map();
  const pairedPages = new Map();
  const unpairing = new Set();
  let closed = false;

  function clientConfiguration(clientToken) {
    return {
      command: nodePath,
      args: [path.resolve(root, 'scripts/mcp-server.mjs')],
      env: { YUANDIAN_URL: expectedOrigin, YUANDIAN_MCP_TOKEN: clientToken }
    };
  }

  function settle(session, item, result) {
    if (!session.pending.delete(item.requestId)) return;
    clearTimeout(item.timer);
    item.resolve(result);
  }
  function revoke(
    session,
    reason = failure('disconnected', '画布连接已断开，请在原点重新授权。')
  ) {
    sessions.delete(session);
    owners.delete(session.ownerToken);
    clients.delete(session.clientToken);
    if (session.pairingId && pairedSessions.get(session.pairingId) === session) {
      pairedSessions.delete(session.pairingId);
      const page = pairedPages.get(session.pairingId);
      if (page) page.state = reason.code === 'session_expired' ? 'expired' : 'needs_authorization';
    }
    for (const item of session.pending.values()) settle(session, item, reason);
  }
  function sweep() {
    for (const session of sessions) {
      if (
        (session.expiresAt !== null && now() >= session.expiresAt) ||
        now() - session.heartbeat > heartbeatMs
      ) {
        revoke(
          session,
          failure(
            'session_expired',
            '画布连接已过期，请保持授权页面打开并重新授权。'
          )
        );
      }
    }
  }
  const timer = setInterval(sweep, Math.min(1000, heartbeatMs));
  timer.unref();

  function clientIdentity(token) {
    sweep();
    const pairing = pairingAuthority.authenticate(token);
    if (pairing) return { pairing, session: pairedSessions.get(pairing.pairingId) };
    const session = clients.get(token);
    return session ? { session } : null;
  }

  function authorizedOwner(token) {
    sweep();
    const session = owners.get(token);
    if (session?.pairingId && !pairingAuthority.get(session.pairingId)) {
      revoke(session);
      return null;
    }
    return session;
  }

  function pairingStatus(pairingId, pageId) {
    sweep();
    const session = pairedSessions.get(pairingId);
    const page = pairedPages.get(pairingId);
    if (session && (!pageId || session.pageId === pageId)) return {
      ok: true, paired: true, connected: true, state: 'authorized', scope: 'workspace',
      pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt, heartbeatAt: session.heartbeat,
      activeSessionId: session.sessionId
    };
    return {
      ok: true, paired: true, connected: false, scope: 'workspace',
      state: session ? 'page_in_use' : page?.state || 'needs_authorization',
      ...(session ? { activePage: true, activeSessionId: session.sessionId } : {})
    };
  }

  function validPairingAction(action, parameters) {
    if (!object(parameters)) return false;
    const page = () => uuid.test(parameters.pageId || '') && uuid.test(parameters.tabId || '');
    if (action === 'unpair') return exactKeys(parameters, []) && !Object.keys(parameters).length;
    if (action === 'status')
      return exactKeys(parameters, ['pageId', 'tabId']) && page();
    if (action === 'release') return page() && (
      exactKeys(parameters, ['pageId', 'tabId']) ||
      exactKeys(parameters, ['pageId', 'tabId', 'allPages', 'expectedSessionId']) &&
        parameters.allPages === true && uuid.test(parameters.expectedSessionId || '')
    );
    if (action === 'attach') return exactKeys(parameters, ['pageId', 'tabId', 'reload', 'takeover']) && page() &&
      typeof parameters.reload === 'boolean' && typeof parameters.takeover === 'boolean';
    if (action === 'authorize') return exactKeys(parameters, ['pageId', 'tabId', 'mode', 'durationMs', 'takeover']) && page() &&
      ['read', 'write'].includes(parameters.mode) && validMcpDuration(parameters.durationMs) &&
      typeof parameters.takeover === 'boolean';
    return false;
  }

  async function pairingRequest(route, request, reply, deny) {
    const input = await readJson(request, 8192);
    if (closed) return deny(503, 'unavailable', 'MCP 桥已停止。');
    if (route === '/api/mcp/pairings') {
      if (!exactKeys(input, ['publicKey', 'clientToken']) || !object(input.publicKey) ||
          (input.clientToken !== undefined && !/^[a-f0-9]{64}$/u.test(input.clientToken)))
        return deny(400, 'invalid_pairing', '配对公钥或客户端凭据无效。');
      const created = await pairingAuthority.create(input);
      if (closed) return deny(503, 'unavailable', 'MCP 桥已停止。');
      const previous = clients.get(created.clientToken);
      if (previous) revoke(previous);
      return reply(201, { ok: true, pairingId: created.pairingId, config: clientConfiguration(created.clientToken) });
    }
    if (route === '/api/mcp/pairing/challenge') {
      if (!exactKeys(input, ['pairingId', 'action', 'parameters']) || !uuid.test(input.pairingId || '') ||
          !validPairingAction(input.action, input.parameters))
        return deny(400, 'invalid_pairing_action', '配对操作参数无效。');
      if (unpairing.has(input.pairingId)) return deny(409, 'pairing_revoking', '正在取消此配对，请等待操作完成。');
      return reply(200, { ok: true, ...pairingAuthority.issue(input) });
    }
    if (!exactKeys(input, ['pairingId', 'challengeId', 'signature']) || !uuid.test(input.pairingId || '') ||
        !uuid.test(input.challengeId || '') || typeof input.signature !== 'string')
      return deny(400, 'invalid_pairing_proof', '配对证明无效。');
    const verified = pairingAuthority.verify(input);
    if (!pairingAuthority.get(verified.pairingId) || !validPairingAction(verified.action, verified.parameters))
      return deny(401, 'invalid_pairing_proof', '配对已失效，请重新配对。');
    const { pairingId, action, parameters } = verified;
    if (unpairing.has(pairingId)) return deny(409, 'pairing_revoking', '正在取消此配对，请等待操作完成。');
    sweep();
    if (action === 'status') return reply(200, pairingStatus(pairingId, parameters.pageId));
    if (action === 'unpair') {
      const previous = pairedSessions.get(pairingId);
      if (previous) revoke(previous);
      unpairing.add(pairingId);
      try { await pairingAuthority.revoke(pairingId); }
      finally { unpairing.delete(pairingId); }
      pairedPages.delete(pairingId);
      return reply(200, { ok: true, paired: false, connected: false, state: 'unpaired' });
    }
    const active = pairedSessions.get(pairingId);
    const samePage = active?.pageId === parameters.pageId && active?.tabId === parameters.tabId;
    if (action === 'release') {
      if (parameters.allPages === true && active && active.sessionId !== parameters.expectedSessionId)
        return deny(409, 'authorization_changed', '授权已变更，请重新检查后断开。');
      if (active && !samePage && parameters.allPages !== true) return deny(409, 'page_in_use', '此配对正在另一页面授权，不能从旧页面撤销。');
      if (active) revoke(active);
      return reply(200, pairingStatus(pairingId, parameters.pageId));
    }
    const permittedReload = action === 'attach' && parameters.reload && active?.tabId === parameters.tabId;
    if (active && !samePage && !permittedReload && !parameters.takeover)
      return deny(409, 'page_in_use', '此配对已由另一页面授权，请明确选择改由此页授权。');
    if (active) revoke(active);
    pairedPages.set(pairingId, { pageId: parameters.pageId, tabId: parameters.tabId, state: 'needs_authorization' });
    if (action === 'attach') return reply(200, pairingStatus(pairingId, parameters.pageId));
    if (sessions.size >= 16) return deny(429, 'session_limit', '连接过多，请先断开不用的连接。');
    const session = {
      scope: 'workspace', pairingId, sessionId: randomUUID(), pageId: parameters.pageId, tabId: parameters.tabId, mode: parameters.mode,
      ownerToken: randomBytes(32).toString('hex'),
      expiresAt: parameters.durationMs === null ? null : now() + Math.min(parameters.durationMs, sessionTtlMs),
      heartbeat: now(), pending: new Map()
    };
    sessions.add(session);
    owners.set(session.ownerToken, session);
    pairedSessions.set(pairingId, session);
    return reply(201, {
      ok: true, paired: true, connected: true, state: 'authorized', ownerToken: session.ownerToken,
      scope: session.scope, pageId: session.pageId, mode: session.mode, expiresAt: session.expiresAt,
      activeSessionId: session.sessionId
    });
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(
        status,
        value === undefined
          ? {}
          : { 'Content-Type': 'application/json; charset=utf-8' }
      );
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const deny = (status, code, error) => reply(status, failure(code, error));
    if (closed) return deny(503, 'unavailable', 'MCP 桥已停止。');
    if (request.headers.host !== url.host)
      return deny(403, 'invalid_host', '仅允许本机回环地址。');
    if (request.headers.origin && request.headers.origin !== expectedOrigin)
      return deny(403, 'invalid_origin', '请求来源与原点页面不一致。');
    const route = request.url;
    const pairingRoute = ['/api/mcp/pairings', '/api/mcp/pairing/challenge', '/api/mcp/pairing/complete'].includes(route);
    const browserRoute = [
      '/api/mcp/session',
      '/api/mcp/poll',
      '/api/mcp/result',
      '/api/mcp/disconnect'
    ].includes(route) || pairingRoute;
    if (browserRoute && request.headers['x-yuandian-client'] !== 'canvas')
      return deny(403, 'invalid_client', '请从原点画布管理连接。');
    if (
      (route === '/api/mcp/session' || pairingRoute) &&
      request.headers.origin !== expectedOrigin
    )
      return deny(403, 'invalid_origin', '授权必须由原点页面发起。');
    const expectedMethod = route === '/api/mcp/poll' ? 'GET' : 'POST';
    if (!browserRoute && route !== '/api/mcp/call')
      return deny(404, 'not_found', '未知 MCP 路径。');
    if (request.method !== expectedMethod) {
      response.setHeader('Allow', expectedMethod);
      return deny(405, 'invalid_method', '请求方法不支持。');
    }
    sweep();
    try {
      if (pairingRoute) return await pairingRequest(route, request, reply, deny);
      if (route === '/api/mcp/session') {
        const input = await readJson(request);
        if (closed) return deny(503, 'unavailable', 'MCP 桥已停止。');
        const grant = inspectMcpGrant(input);
        if (!grant) {
          return deny(
            400,
            'invalid_session',
            '请选择有效的页面授权范围与读取或编辑权限。'
          );
        }
        if (sessions.size >= 16)
          return deny(429, 'session_limit', '连接过多，请先断开不用的连接。');
        const session = {
          ...grant,
          ownerToken: randomBytes(32).toString('hex'),
          clientToken: randomBytes(32).toString('hex'),
          expiresAt: grant.durationMs === null ? null : now() + Math.min(grant.durationMs ?? sessionTtlMs, sessionTtlMs),
          heartbeat: now(),
          pending: new Map()
        };
        sessions.add(session);
        owners.set(session.ownerToken, session);
        clients.set(session.clientToken, session);
        return reply(201, {
          ownerToken: session.ownerToken,
          clientToken: session.clientToken,
          scope: session.scope,
          boardId: session.boardId,
          pageId: session.pageId,
          mode: session.mode,
          expiresAt: session.expiresAt,
          config: clientConfiguration(session.clientToken)
        });
      }
      const token = /^Bearer ([a-f0-9]{64})$/u.exec(
        request.headers.authorization || ''
      )?.[1];
      const identity = browserRoute ? null : clientIdentity(token);
      const session = browserRoute ? authorizedOwner(token) : identity?.session;
      if (browserRoute ? !session : !identity)
        return deny(
          401,
          'unauthorized',
          '连接未授权或已过期，请在原点重新授权。'
        );
      if (browserRoute) session.heartbeat = now();
      if (route === '/api/mcp/poll') {
        const item = [...session.pending.values()].find(
          (candidate) => !candidate.delivered
        );
        if (!item) return reply(204);
        item.delivered = true;
        return reply(200, {
          requestId: item.requestId,
          tool: item.tool,
          arguments: item.arguments,
          // Waiting for a browser lock cannot outlive this delivered authorization.
          expiresAt: Math.min(
            item.expiresAt,
            session.expiresAt ?? Infinity,
            session.heartbeat + heartbeatMs
          )
        });
      }
      if (route === '/api/mcp/disconnect') {
        revoke(session);
        return reply(200, { ok: true });
      }
      const input = await readJson(request);
      // A slow request body must not revive a session revoked while it was being read.
      sweep();
      const current = browserRoute ? null : clientIdentity(token);
      if (browserRoute ? authorizedOwner(token) !== session : !current)
        return deny(
          401,
          'unauthorized',
          '连接未授权或已过期，请在原点重新授权。'
        );
      if (!browserRoute && current.session !== session)
        return deny(409, 'authorization_changed', '请求期间网页授权已变更，请重新读取画布，不要重放编辑。');
      if (route === '/api/mcp/result') {
        if (
          !exactKeys(input, ['requestId', 'result']) ||
          typeof input.requestId !== 'string' ||
          !object(input.result) ||
          typeof input.result.ok !== 'boolean'
        )
          return deny(400, 'invalid_result', '无效的画布响应。');
        const item = session.pending.get(input.requestId);
        if (!item || !item.delivered)
          return deny(404, 'request_finished', '请求已结束或不属于此连接。');
        const resultError = inspectMcpResult(session, item, input.result);
        if (resultError) return reply(resultError.status, resultError.value);
        settle(session, item, input.result);
        return reply(200, { ok: true });
      }
      if (
        !exactKeys(input, ['tool', 'arguments']) ||
        !object(input.arguments)
      )
        return deny(400, 'invalid_tool', '无效的工具调用。');
      if (identity?.pairing && input.tool === 'connection_status') {
        const statusError = inspectMcpCall({ scope: 'workspace', mode: 'read' }, input.tool, input.arguments);
        return statusError ? reply(statusError.status, statusError.value) : reply(200, pairingStatus(identity.pairing.pairingId));
      }
      if (!session) return deny(403, 'needs_authorization', '配对已保留，请在原点网页授权后再操作画布。');
      const callError = inspectMcpCall(session, input.tool, input.arguments);
      if (callError) return reply(callError.status, callError.value);
      if (input.tool === 'connection_status')
        return reply(200, {
          ok: true,
          connected: true,
          scope: session.scope,
          boardId: session.boardId,
          pageId: session.pageId,
          mode: session.mode,
          expiresAt: session.expiresAt,
          heartbeatAt: session.heartbeat
        });
      if (session.pending.size >= maxPending)
        return deny(
          429,
          'queue_full',
          '等待中的请求过多，请等待已有请求完成。'
        );
      const result = await new Promise((resolve) => {
        const item = {
          requestId: randomUUID(),
          tool: input.tool,
          arguments: input.arguments,
          expiresAt: now() + requestTimeoutMs,
          delivered: false,
          resolve
        };
        item.timer = setTimeout(
          () =>
            settle(
              session,
              item,
              failure(
                'request_timeout',
                '画布响应超时；请重新读取最新画布，避免重复编辑。'
              )
            ),
          requestTimeoutMs
        );
        session.pending.set(item.requestId, item);
        response.once('close', () => {
          if (!response.writableEnded)
            settle(
              session,
              item,
              failure('client_closed', 'AI 客户端已断开。')
            );
        });
      });
      reply(200, result);
    } catch (error) {
      if (error.pairingStoreUncertain || error.status === 503 && error.code === 'unavailable') {
        closed = true;
        clearInterval(timer);
        for (const session of sessions) revoke(session, failure('unavailable', '配对状态暂不可用，请等待服务恢复。'));
      }
      deny(
        error.status || 500,
        error.status ? error.code || 'invalid_request' : 'internal_error',
        error.status ? error.message : 'MCP 请求失败，请重新连接。'
      );
    }
  }
  return {
    handle,
    close() {
      closed = true;
      clearInterval(timer);
      for (const session of sessions) revoke(session);
      pairedPages.clear();
      pairingAuthority.close();
    }
  };
}
