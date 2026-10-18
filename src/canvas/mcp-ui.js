const API = '/api/mcp';
const POLL_DELAY = 750;

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
export function createMcpPanel({
  getCanvas,
  readCanvas,
  editCanvas,
  canConnect
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
    '让 AI 通过 MCP 查看或编辑这张画布。'
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
  const notice = element(
    'p',
    { class: 'mcp-notice' },
    '仅授权此画布，切换画布会断开。AI 的修改可以撤销。'
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
  const summary = element('summary', {}, 'AI 客户端配置');
  const configurationNote = element(
    'p',
    {},
    '将配置添加到支持 MCP 的 AI 客户端。仅在本页保持打开时有效，断开后失效。'
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
  let failedPolls = 0;
  const completedRequests = new Map();
  let message = '尚未开启接入';
  let isError = false;

  function update() {
    const current = getCanvas();
    scope.textContent = `当前画布：${current?.title || '未命名画布'}`;
    mode.disabled = starting || Boolean(session);
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
    const response = await fetch(`${API}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
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
          ? '当前服务尚不支持 AI 接入，请重启原点项目服务后重试。'
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
  }

  async function revoke(ownerToken, keepalive = false) {
    try {
      await request('disconnect', { ownerToken, body: {}, keepalive });
    } catch {
      // Losing the page heartbeat also expires the local bridge session.
    }
  }

  async function start() {
    if (starting || session) return;
    const reason = allowed();
    if (reason) return feedback(reason, true);
    const current = getCanvas();
    if (!current?.id) return feedback('请先打开一张画布。', true);
    const focusStartedOnConnect = document.activeElement === connectButton;
    const ticket = ++generation;
    const boardId = current.id;
    const permission = mode.value;
    starting = true;
    feedback('正在开启接入…');
    try {
      const opened = await request('session', {
        body: { boardId, mode: permission }
      });
      if (ticket !== generation || getCanvas()?.id !== boardId || allowed()) {
        if (opened?.ownerToken) await revoke(opened.ownerToken);
        if (ticket === generation)
          feedback('画布状态已改变，请重新开启接入。', true);
        return;
      }
      if (
        !opened?.ownerToken ||
        !opened?.clientToken ||
        !opened?.config ||
        !Number.isFinite(opened.expiresAt) ||
        opened.expiresAt <= Date.now()
      ) {
        if (opened?.ownerToken) await revoke(opened.ownerToken);
        throw new Error('接入配置不完整，请重试。');
      }
      session = {
        ownerToken: opened.ownerToken,
        boardId,
        mode: permission,
        expiresAt: opened.expiresAt
      };
      configText.value = JSON.stringify(
        { mcpServers: { yuandian: opened.config } },
        null,
        2
      );
      configuration.open = true;
      failedPolls = 0;
      const focusCanReturn =
        document.activeElement === connectButton ||
        document.activeElement === document.body;
      feedback(`接入已开启 · ${permission === 'write' ? '读写' : '只读'}`);
      if (focusStartedOnConnect && focusCanReturn && !root.hidden)
        disconnectButton.focus();
      schedulePoll(ticket, 0);
    } catch (error) {
      if (ticket === generation)
        feedback(
          error instanceof TypeError
            ? '无法连接本机服务，请确认原点项目服务正在运行。'
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

  function schedulePoll(ticket, delay = POLL_DELAY) {
    clearTimeout(pollTimer);
    if (session && ticket === generation) {
      pollTimer = setTimeout(() => poll(ticket), delay);
    }
  }

  async function poll(ticket) {
    const active = session;
    if (!active || ticket !== generation) return;
    if (getCanvas()?.id !== active.boardId) {
      await disconnect('已切换画布，接入已断开。');
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
        if (getCanvas()?.id !== active.boardId) {
          await disconnect('已切换画布，接入已断开。');
          return;
        }
        if (!result) {
          try {
            const refusal = allowed();
            if (refusal)
              result = { ok: false, code: 'UNAVAILABLE', error: refusal };
            else if (pending.tool === 'get_canvas') result = await readCanvas();
            else if (
              pending.tool === 'edit_canvas' &&
              active.mode === 'write'
            ) {
              result = await editCanvas(pending.arguments, {
                isAuthorized: () =>
                  ticket === generation &&
                  session === active &&
                  active.mode === 'write' &&
                  Date.now() < active.expiresAt &&
                  typeof pending.expiresAt === 'number' &&
                  Date.now() < pending.expiresAt &&
                  getCanvas()?.id === active.boardId
              });
            } else if (pending.tool === 'edit_canvas') {
              result = {
                ok: false,
                code: 'READ_ONLY',
                error: '本次接入仅允许读取画布。'
              };
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
          // Retry a lost acknowledgement with its original result. Never apply
          // the same edit again when the bridge repeats a pending request.
          completedRequests.set(pending.requestId, result);
          if (completedRequests.size > 32) {
            completedRequests.delete(completedRequests.keys().next().value);
          }
        }
        if (ticket !== generation || !session) return;
        await request('result', {
          ownerToken: active.ownerToken,
          body: { requestId: pending.requestId, result }
        });
      }
      failedPolls = 0;
      if (recovered)
        feedback(`接入已开启 · ${active.mode === 'write' ? '读写' : '只读'}`);
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
    schedulePoll(ticket);
  }

  async function disconnect(text = '接入已断开', { keepalive = false } = {}) {
    const previous = session;
    const focusInside = root.contains(document.activeElement);
    generation += 1;
    clearTimeout(pollTimer);
    session = null;
    starting = false;
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
    try {
      await navigator.clipboard.writeText(configText.value);
      feedback('配置已复制，请添加到你的 AI 客户端。');
    } catch {
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
    get boardId() {
      return session?.boardId;
    },
    get connected() {
      return Boolean(session);
    },
    get root() {
      return root;
    }
  };
}
