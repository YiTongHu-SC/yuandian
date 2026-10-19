import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspectMcpCall, inspectMcpGrant, inspectMcpResult } from './mcp-access.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, error) => ({ ok: false, code, error });
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));

async function readJson(request) {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    throw Object.assign(new Error('请发送 application/json。'), {
      status: 415
    });
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES)
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
  requestTimeoutMs = 15000,
  heartbeatMs = 10000,
  sessionTtlMs = 3600000,
  maxPending = 8,
  now = Date.now
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
  let closed = false;

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
    for (const item of session.pending.values()) settle(session, item, reason);
  }
  function sweep() {
    for (const session of sessions) {
      if (
        now() >= session.expiresAt ||
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
    const browserRoute = [
      '/api/mcp/session',
      '/api/mcp/poll',
      '/api/mcp/result',
      '/api/mcp/disconnect'
    ].includes(route);
    if (browserRoute && request.headers['x-yuandian-client'] !== 'canvas')
      return deny(403, 'invalid_client', '请从原点画布管理连接。');
    if (
      route === '/api/mcp/session' &&
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
      if (route === '/api/mcp/session') {
        const input = await readJson(request);
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
          expiresAt: now() + sessionTtlMs,
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
          config: {
            command: process.execPath,
            args: [path.resolve(root, 'scripts/mcp-server.mjs')],
            env: {
              YUANDIAN_URL: expectedOrigin,
              YUANDIAN_MCP_TOKEN: session.clientToken
            }
          }
        });
      }
      const token = /^Bearer ([a-f0-9]{64})$/u.exec(
        request.headers.authorization || ''
      )?.[1];
      const session = (browserRoute ? owners : clients).get(token);
      if (!session)
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
            session.expiresAt,
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
      if ((browserRoute ? owners : clients).get(token) !== session)
        return deny(
          401,
          'unauthorized',
          '连接未授权或已过期，请在原点重新授权。'
        );
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
      deny(
        error.status || 500,
        error.status ? 'invalid_request' : 'internal_error',
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
    }
  };
}
