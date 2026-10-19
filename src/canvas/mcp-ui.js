import { codexMcpConfiguration, getMcpConnection } from './mcp-connection.js';
import { createPairedMcpPanel } from './mcp-paired-ui.js';

export function createMcpPanel(options) {
  const connection = options.connection || getMcpConnection(window.location);
  return connection.remote && options.pairing !== false
    ? createPairedMcpPanel({ ...options, connection })
    : createLegacyMcpPanel({ ...options, connection });
}

function element(tag, attributes = {}, text = '') {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  if (text) node.textContent = text;
  return node;
}

function action(text, callback, className = '') {
  const node = element('button', { type: 'button', class: className }, text);
  node.addEventListener('click', callback);
  return node;
}

// Session credentials live only in this closure and its visible configuration.
// They never become part of a board, browser storage or an exported backup.
function createLegacyMcpPanel({
  listCanvases,
  readCanvas,
  editCanvas,
  createCanvas,
  exportCanvas,
  canConnect,
  connection = getMcpConnection(window.location)
}) {
  const root = element('aside', {
    id: 'mcp-panel',
    class: 'mcp-panel floating',
    'aria-label': 'AI 接入 · MCP'
  });
  root.hidden = true;
  const heading = element('div', { class: 'mcp-panel-heading' });
  const title = element('h2', {}, 'AI 接入 · MCP');
  const closeButton = action('×', close, 'ghost mcp-panel-close');
  closeButton.setAttribute('aria-label', '收起 AI 接入');
  heading.append(title, closeButton);

  const description = element(
    'p',
    { class: 'mcp-description' },
    '让 AI 通过 MCP 查看、编辑和导出画布。'
  );
  const scope = element('p', { class: 'mcp-scope' });
  const modeLabel = element('label', { class: 'mcp-permission' }, '允许 AI');
  const mode = element('select', {
    id: 'mcp-permission',
    'aria-label': 'AI 接入权限'
  });
  mode.append(
    element('option', { value: 'read' }, '只读'),
    element('option', { value: 'write' }, '读写')
  );
  modeLabel.append(mode);
  const durationLabel = element('label', { class: 'mcp-permission' }, '本次授权');
  const duration = element('select', { id: 'mcp-duration', 'aria-label': '本次授权时长' });
  duration.append(
    element('option', { value: '900000' }, '15 分钟'),
    element('option', { value: '3600000' }, '1 小时'),
    element('option', { value: 'null' }, '永久（直到断开）')
  );
  duration.value = '3600000';
  durationLabel.append(duration);
  const notice = element(
    'p',
    { class: 'mcp-notice' },
    connection.remote
      ? '临时授权当前浏览器、当前站点的全部画布，默认只读。切换或新增画布后继续有效。内容经临时中继发送给 AI，持久数据仍在当前浏览器。AI 的修改可以撤销。'
      : '临时授权当前浏览器、当前站点的全部画布，默认只读。切换或新增画布后继续有效。AI 的修改可以撤销。'
  );
  const status = element('p', {
    class: 'mcp-status',
    role: 'status',
    'aria-live': 'polite'
  });
  const actions = element('div', { class: 'mcp-actions' });
  const connectButton = action('开启接入', start, 'primary');
  const disconnectButton = action('断开接入', () => disconnect('接入已断开'));
  actions.append(connectButton, disconnectButton);

  const configuration = element('details', { class: 'mcp-configuration' });
  const summary = element(
    'summary',
    {},
    connection.remote ? 'Codex 配置' : 'AI 客户端配置'
  );
  const configurationNote = element(
    'p',
    {},
    connection.remote
      ? '将此段添加或替换到 Codex 的 config.toml 中的 yuandian 服务，保留其他服务，再重新加载 MCP。配置按所选时长有效，需保持本页打开；刷新、关闭、断开、失联或服务重启后失效。'
      : '将配置添加到支持 MCP 的 AI 客户端。配置按所选时长有效，需保持本页打开；刷新、关闭、断开、失联或服务重启后失效。'
  );
  const configText = element('textarea', {
    class: 'mcp-config-text',
    'aria-label': 'MCP 客户端配置',
    readonly: '',
    rows: '9',
    spellcheck: 'false'
  });
  const copyButton = action('复制配置', copyConfiguration);
  const configWarning = element(
    'p',
    { class: 'mcp-config-warning' },
    '配置包含本次接入凭据，请只交给你信任的 AI 客户端。'
  );
  configuration.append(
    summary,
    configurationNote,
    configText,
    copyButton,
    configWarning
  );
  root.append(
    heading,
    description,
    scope,
    modeLabel,
    durationLabel,
    notice,
    status,
    actions,
    configuration
  );
  document.querySelector('.stage-wrap').append(root);

  let session = null;
  let starting = false;
  let generation = 0;
  let pollTimer;
  let expiryTimer;
  let failedPolls = 0;
  const pageId = connection.available ? crypto.randomUUID() : null;
  const requests = new Set();
  const completedRequests = new Map();
  let message = '尚未开启接入';
  let isError = false;
  const handlers = {
    list_canvases: listCanvases,
    get_canvas: readCanvas,
    edit_canvas: editCanvas,
    create_canvas: createCanvas,
    export_canvas: exportCanvas
  };

  function update() {
    scope.textContent = '授权范围：当前浏览器、当前站点的全部画布';
    mode.disabled = starting || Boolean(session);
    duration.disabled = starting || Boolean(session);
    connectButton.disabled = starting;
    connectButton.hidden = Boolean(session);
    connectButton.textContent = starting ? '正在开启…' : '开启接入';
    disconnectButton.hidden = !session;
    configuration.hidden = !session;
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', isError);
    const trigger = document.querySelector('#ai-menu-toggle');
    trigger?.setAttribute('aria-expanded', String(!root.hidden));
    trigger?.classList.toggle('mcp-connected', Boolean(session));
    trigger?.setAttribute(
      'title',
      session
        ? `AI 接入已开启 · ${session.mode === 'write' ? '读写' : '只读'}`
        : 'AI 接入'
    );
  }

  function feedback(text, error = false) {
    message = text;
    isError = error;
    update();
  }

  function allowed() {
    if (!connection.available) return '当前页面未配置 AI 接入服务。';
    const result = canConnect();
    return result === true
      ? ''
      : typeof result === 'string'
        ? result
        : '当前无法开启 AI 接入';
  }

  function headers(ownerToken) {
    return {
      'X-Yuandian-Client': 'canvas',
      ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {})
    };
  }

  async function request(path, { ownerToken, body, keepalive = false } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      connection.requestTimeoutMs
    );
    try {
      const response = await fetch(`${connection.apiBase}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        mode: connection.remote ? 'cors' : 'same-origin',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: {
          ...headers(ownerToken),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        keepalive
      });
      if (response.status === 204) return null;
      let data;
      try {
        data = await response.json();
      } catch {
        const error = new Error(
          response.status === 404
            ? connection.remote
              ? '远程接入服务暂不可用，请稍后重试。'
              : '当前服务尚不支持 AI 接入，请重启原点项目服务后重试。'
            : '服务未返回有效结果，请重试。'
        );
        error.status = response.status;
        throw error;
      }
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error || '接入请求未完成，请重试。');
        error.status = response.status;
        error.code = data?.code;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  async function revoke(ownerToken, keepalive = false) {
    try {
      await request('disconnect', { ownerToken, body: {}, keepalive });
    } catch {
      // Losing the page heartbeat also expires the bridge session.
    }
  }

  async function start() {
    if (starting || session) return;
    const reason = allowed();
    if (reason) return feedback(reason, true);
    const focusStartedOnConnect = document.activeElement === connectButton;
    const ticket = ++generation;
    const permission = mode.value;
    const durationMs = duration.value === 'null' ? null : Number(duration.value);
    if (!['read', 'write'].includes(permission) || ![null, 900000, 3600000].includes(durationMs))
      return feedback('请选择有效的权限和授权时长。', true);
    starting = true;
    feedback('正在开启接入…');
    try {
      const opened = await request('session', {
        body: {
          scope: 'workspace',
          pageId,
          mode: permission,
          durationMs
        }
      });
      if (ticket !== generation || allowed()) {
        if (opened?.ownerToken) await revoke(opened.ownerToken);
        if (ticket === generation)
          feedback('当前无法接入，请处理保存状态后重新开启。', true);
        return;
      }
      if (
        !opened?.ownerToken ||
        !opened?.clientToken ||
        !opened?.config ||
        opened.scope !== 'workspace' ||
        opened.mode !== permission ||
        opened.pageId !== pageId ||
        (durationMs === null ? opened.expiresAt !== null :
          !Number.isFinite(opened.expiresAt) || opened.expiresAt <= Date.now() ||
          opened.expiresAt > Date.now() + durationMs + 1000)
      ) {
        if (opened?.ownerToken) await revoke(opened.ownerToken);
        throw new Error('接入配置不完整，请重试。');
      }
      let configurationText;
      try {
        if (
          connection.remote &&
          opened.config?.headers?.Authorization !== `Bearer ${opened.clientToken}`
        )
          throw new Error('远程接入配置无效，请重新开启接入。');
        configurationText = connection.remote
          ? codexMcpConfiguration(opened.config)
          : JSON.stringify({ mcpServers: { yuandian: opened.config } }, null, 2);
      } catch (error) {
        await revoke(opened.ownerToken);
        throw error;
      }
      session = {
        ownerToken: opened.ownerToken,
        scope: 'workspace',
        pageId,
        mode: permission,
        expiresAt: opened.expiresAt
      };
      configText.value = configurationText;
      configuration.open = !connection.remote;
      clearTimeout(expiryTimer);
      if (session.expiresAt !== null) {
        expiryTimer = setTimeout(() => {
          if (ticket === generation) void disconnect('接入已过期，请重新开启。');
        }, session.expiresAt - Date.now());
      }
      failedPolls = 0;
      const focusCanReturn =
        document.activeElement === connectButton ||
        document.activeElement === document.body;
      feedback(`接入已开启 · ${permission === 'write' ? '读写' : '只读'}${session.expiresAt === null ? ' · 永久（直到断开）' : ''}`);
      if (focusStartedOnConnect && focusCanReturn && !root.hidden)
        disconnectButton.focus();
      schedulePoll(ticket, 0);
    } catch (error) {
      if (ticket === generation)
        feedback(
          error instanceof TypeError
            ? connection.remote
              ? '无法连接远程接入服务，请检查网络后重试。'
              : '无法连接本机服务，请确认原点项目服务正在运行。'
            : error.name === 'AbortError'
              ? '接入服务响应超时，请稍后重试。'
              : error.message || '无法开启接入，请检查项目服务。',
          true
        );
    } finally {
      if (ticket === generation) {
        starting = false;
        update();
      }
    }
  }

  function schedulePoll(ticket, delay = connection.pollDelayMs) {
    clearTimeout(pollTimer);
    if (session && ticket === generation) {
      pollTimer = setTimeout(() => poll(ticket), delay);
    }
  }

  async function poll(ticket) {
    const active = session;
    if (!active || ticket !== generation) return;
    if (active.expiresAt !== null && Date.now() >= active.expiresAt) {
      await disconnect('接入已过期，请重新开启。');
      return;
    }
    const reason = allowed();
    if (reason) {
      await disconnect(`${reason}，接入已断开。`);
      return;
    }
    try {
      const pending = await request('poll', { ownerToken: active.ownerToken });
      if (ticket !== generation || !session) return;
      const recovered = failedPolls > 0;
      if (pending) {
        let result = completedRequests.get(pending.requestId);
        if (!result) {
          try {
            const refusal = allowed();
            const writes =
              pending.tool === 'edit_canvas' || pending.tool === 'create_canvas';
            const handler = Object.hasOwn(handlers, pending.tool)
              ? handlers[pending.tool]
              : null;
            if (
              !Number.isFinite(pending.expiresAt) ||
              Date.now() >= pending.expiresAt
            )
              result = {
                ok: false,
                code: 'REQUEST_EXPIRED',
                error: '请求已过期，请重新读取画布。'
              };
            else if (refusal)
              result = { ok: false, code: 'UNAVAILABLE', error: refusal };
            else if (writes && active.mode !== 'write') {
              result = {
                ok: false,
                code: 'READ_ONLY',
                error: '本次接入仅允许读取和导出画布。'
              };
            } else if (typeof handler === 'function') {
              result = await handler(pending.arguments, {
                isAuthorized: () =>
                  ticket === generation &&
                  session === active &&
                  active.scope === 'workspace' &&
                  active.pageId === pageId &&
                  (!writes || active.mode === 'write') &&
                  (active.expiresAt === null || Date.now() < active.expiresAt) &&
                  Number.isFinite(pending.expiresAt) &&
                  Date.now() < pending.expiresAt
              });
            } else {
              result = {
                ok: false,
                code: 'UNKNOWN_TOOL',
                error: '不支持此操作。'
              };
            }
          } catch {
            result = {
              ok: false,
              code: 'CANVAS_ERROR',
              error: '画布操作未完成，请重新读取后重试。'
            };
          }
          if (ticket !== generation || session !== active) return;
          if (active.expiresAt !== null && Date.now() >= active.expiresAt) {
            await disconnect('接入已过期，请重新开启。');
            return;
          }
          if (Date.now() >= pending.expiresAt)
            result = {
              ok: false,
              code: 'REQUEST_EXPIRED',
              error: '请求已过期，请重新读取画布。'
            };
          // Retry a lost acknowledgement with its original result. Never apply
          // the same edit again when the bridge repeats a pending request.
          completedRequests.set(pending.requestId, result);
          if (completedRequests.size > 32) {
            completedRequests.delete(completedRequests.keys().next().value);
          }
        }
        if (ticket !== generation || session !== active) return;
        if (active.expiresAt !== null && Date.now() >= active.expiresAt) {
          await disconnect('接入已过期，请重新开启。');
          return;
        }
        const refusal = allowed();
        if (refusal) {
          await disconnect(`${refusal}，接入已断开。`);
          return;
        }
        if (!Number.isFinite(pending.expiresAt) || Date.now() >= pending.expiresAt)
          result = {
            ok: false,
            code: 'REQUEST_EXPIRED',
            error: '请求已过期，请重新读取画布。'
          };
        await request('result', {
          ownerToken: active.ownerToken,
          body: { requestId: pending.requestId, result }
        });
      }
      if (ticket !== generation || session !== active) return;
      failedPolls = 0;
      if (recovered)
        feedback(`接入已开启 · ${active.mode === 'write' ? '读写' : '只读'}${active.expiresAt === null ? ' · 永久（直到断开）' : ''}`);
      else update();
    } catch (error) {
      if (ticket !== generation || !session) return;
      failedPolls += 1;
      if (
        error.status === 401 ||
        error.status === 404 ||
        error.status === 410 ||
        failedPolls >= 3
      ) {
        await disconnect('接入已中断，请重新开启。');
        return;
      }
      feedback('接入暂时中断，正在重试…', true);
    }
    schedulePoll(ticket, failedPolls ? 750 : connection.pollDelayMs);
  }

  async function disconnect(text = '接入已断开', { keepalive = false } = {}) {
    const previous = session;
    const focusInside = root.contains(document.activeElement);
    generation += 1;
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
    for (const controller of requests) controller.abort();
    session = null;
    starting = false;
    mode.value = 'read';
    failedPolls = 0;
    completedRequests.clear();
    configText.value = '';
    configuration.open = false;
    feedback(text);
    if (focusInside && !root.hidden) mode.focus();
    if (previous) await revoke(previous.ownerToken, keepalive);
  }

  async function copyConfiguration() {
    if (!session || !configText.value) return;
    const active = session;
    try {
      await navigator.clipboard.writeText(configText.value);
      if (session !== active) return;
      feedback('配置已复制，请添加到你的 AI 客户端。');
    } catch {
      if (session !== active) return;
      configuration.open = true;
      configText.focus();
      configText.select();
      feedback('请复制已选中的配置。');
    }
  }

  function close() {
    const focusInside = root.contains(document.activeElement);
    root.hidden = true;
    update();
    if (focusInside) document.querySelector('#ai-menu-toggle')?.focus();
  }

  function toggle() {
    root.hidden = !root.hidden;
    update();
    if (!root.hidden) (session ? disconnectButton : mode).focus();
  }

  window.addEventListener('pagehide', () => {
    void disconnect('接入已断开', { keepalive: true });
  });
  update();
  return {
    toggle,
    close,
    disconnect,
    get authorized() {
      return starting || Boolean(session);
    },
    get connected() {
      return Boolean(session);
    },
    get root() {
      return root;
    }
  };
}
