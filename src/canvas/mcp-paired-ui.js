import { codexMcpConfiguration } from './mcp-connection.js';
import {
  createBrowserPairingStore,
  pairingPageIdentity,
  parseExistingCodexToken,
  signPairingChallenge
} from './mcp-pairing.js';

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

function localMcpConfiguration(config, apiBase) {
  const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if (keys(config) !== 'args,command,env' || typeof config.command !== 'string' ||
      !/(?:^|[\\/])node(?:\.exe)?$/iu.test(config.command) || /[\r\n\0]/u.test(config.command) ||
      !Array.isArray(config.args) || config.args.length !== 1 || typeof config.args[0] !== 'string' ||
      !/(?:^|[\\/])scripts[\\/]mcp-server\.mjs$/u.test(config.args[0]) || /[\r\n\0]/u.test(config.args[0]) ||
      keys(config.env) !== 'YUANDIAN_MCP_TOKEN,YUANDIAN_URL' ||
      !/^[a-f0-9]{64}$/u.test(config.env.YUANDIAN_MCP_TOKEN || '') ||
      config.env.YUANDIAN_URL !== new URL(apiBase, window.location?.href).origin ||
      !/^http:\/\/127\.0\.0\.1:\d+$/u.test(config.env.YUANDIAN_URL))
    throw new Error('本机客户端配置无效，请确认连接的是原点服务后重试。');
  return JSON.stringify({ mcpServers: { yuandian: config } }, null, 2);
}

// Permanent consent survives refreshes; owner tokens and canvas results do not.
export function createPairedMcpPanel({
  listCanvases, readCanvas, editCanvas, createCanvas, exportCanvas, canConnect,
  connection,
  pairingStore = createBrowserPairingStore(),
  identity: suppliedIdentity,
  signChallenge = signPairingChallenge
}) {
  const root = element('aside', {
    id: 'mcp-panel', class: 'mcp-panel floating', 'aria-label': 'AI 接入 · MCP'
  });
  root.hidden = true;
  const heading = element('div', { class: 'mcp-panel-heading' });
  const closeButton = action('×', close, 'ghost mcp-panel-close');
  closeButton.setAttribute('aria-label', '收起 AI 接入');
  heading.append(element('h2', {}, 'AI 接入 · MCP'), closeButton);
  const description = element('p', { class: 'mcp-description' }, '一次配对，可选择临时或永久授权。');
  const scope = element('p', { class: 'mcp-scope' }, '授权范围：当前浏览器、当前站点的全部画布');
  const permission = element('label', { class: 'mcp-permission' }, '允许 AI');
  const mode = element('select', { id: 'mcp-permission', 'aria-label': 'AI 接入权限' });
  mode.append(element('option', { value: 'read' }, '只读'), element('option', { value: 'write' }, '读写'));
  permission.append(mode);
  const notice = element('p', { class: 'mcp-notice' },
    `默认只读。永久授权会在刷新、重开网页或服务恢复后自动恢复原权限，直到主动断开；网页关闭时暂停访问。画布仍保存在浏览器${connection.remote ? '；授权内容经中继发送给 AI' : ''}，修改可撤销。`);
  const status = element('p', { class: 'mcp-status', role: 'status', 'aria-live': 'polite' });
  const actions = element('div', { class: 'mcp-actions' });
  const authorizeButton = action('配对并授权', () => authorize(), 'primary');
  const disconnectButton = action('断开授权', () => disconnect('授权已断开，配对仍保留。'));
  const takeoverButton = action('改由此页授权', () => authorize(true));
  actions.append(authorizeButton, disconnectButton, takeoverButton);

  const options = element('details', { class: 'mcp-options' });
  options.append(element('summary', {}, '更多选项'));
  const durationLabel = element('label', { class: 'mcp-permission' }, '本次授权');
  const duration = element('select', { id: 'mcp-duration', 'aria-label': '本次授权时长' });
  duration.append(
    element('option', { value: '900000' }, '15 分钟'),
    element('option', { value: '3600000' }, '1 小时'),
    element('option', { value: 'null' }, '永久（直到断开）')
  );
  duration.value = '3600000';
  durationLabel.append(duration);
  const existing = element('details', { class: 'mcp-existing' });
  existing.append(element('summary', {}, '沿用已有 Codex 配置'));
  existing.append(element('p', {}, '只需首次配对时使用。粘贴当前 yuandian 配置可保留已加载的客户端身份；输入会在提交前清除，不在浏览器保存。'));
  const existingConfig = element('textarea', {
    class: 'mcp-config-text', 'aria-label': '沿用已有 Codex 配置', rows: '4', spellcheck: 'false', autocomplete: 'off'
  });
  existing.append(existingConfig);
  const unpairButton = action('取消配对', unpair, 'ghost');
  const unpairNote = element('p', {}, '取消配对会立即使此客户端凭据失效；再次使用需重新配置。');
  options.append(durationLabel, existing, unpairButton, unpairNote);

  const configuration = element('details', { class: 'mcp-configuration' });
  configuration.append(element('summary', {}, '首次 Codex 配置'));
  configuration.append(element('p', {}, connection.remote
    ? '仅首次将此段添加或替换到 config.toml 的 yuandian 服务，保留其他服务并加载 MCP。此凭据有效至取消配对，请妥善保管。'
    : '仅首次复制此通用 mcpServers JSON 并配置客户端。Codex 请按接入指南转换为 TOML；保留其他服务。此凭据有效至取消配对，请妥善保管。'));
  const configText = element('textarea', {
    class: 'mcp-config-text', 'aria-label': 'MCP 客户端配置', readonly: '', rows: '4', spellcheck: 'false'
  });
  configuration.append(configText, action('复制配置', copyConfiguration),
    element('p', { class: 'mcp-config-warning' }, '凭据只在首次配对的本页显示，不写入画布或备份。'));
  root.append(heading, description, scope, permission, notice, status, actions, options, configuration);
  document.querySelector('.stage-wrap').append(root);

  let pairing = null;
  let identity = suppliedIdentity;
  let identityReady = identity ? Promise.resolve(identity) : pairingPageIdentity();
  let session = null;
  let consent = null;
  let consentReadFailed = false;
  let pageHidden = false;
  let busy = true;
  let generation = 0;
  let message = '正在检查浏览器配对…';
  let isError = false;
  let pageInUse = false;
  let failedPolls = 0;
  let pollTimer;
  let expiryTimer;
  let resumeTimer;
  let resumeDelay = connection.resumeDelayMs ?? 1500;
  const requests = new Set();
  const completedRequests = new Map();
  let coordinationChannel;
  const handlers = {
    list_canvases: listCanvases, get_canvas: readCanvas, edit_canvas: editCanvas,
    create_canvas: createCanvas, export_canvas: exportCanvas
  };

  function update() {
    const paired = Boolean(pairing?.pairingId);
    mode.disabled = busy || Boolean(session);
    duration.disabled = busy || Boolean(session);
    existing.hidden = paired || !connection.remote;
    existingConfig.disabled = busy;
    authorizeButton.hidden = Boolean(session) || pageInUse;
    authorizeButton.disabled = busy;
    authorizeButton.textContent = busy ? '请稍候…' : paired ? '重新授权' : '配对并授权';
    disconnectButton.hidden = !session && !consent && !consentReadFailed;
    takeoverButton.hidden = !pageInUse;
    takeoverButton.disabled = busy;
    unpairButton.hidden = !paired;
    unpairNote.hidden = !paired;
    unpairButton.disabled = busy;
    configuration.hidden = !configText.value;
    status.textContent = message;
    status.classList.toggle('error', isError);
    const trigger = document.querySelector('#ai-menu-toggle');
    trigger?.setAttribute('aria-expanded', String(!root.hidden));
    trigger?.classList.toggle('mcp-connected', Boolean(session));
    trigger?.setAttribute('title', session ? `AI 接入已开启 · ${session.mode === 'write' ? '读写' : '只读'}` : 'AI 接入');
  }

  function feedback(text, error = false) { message = text; isError = error; update(); }
  function allowed() {
    const result = canConnect();
    return result === true ? '' : typeof result === 'string' ? result : '当前无法开启 AI 接入。';
  }

  async function request(path, { body, ownerToken, keepalive = false } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), connection.requestTimeoutMs);
    try {
      const response = await fetch(`${connection.apiBase}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
        redirect: 'error', mode: 'cors', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: {
          'X-Yuandian-Client': 'canvas',
          ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), keepalive
      });
      if (response.status === 204) return null;
      let data;
      try { data = await response.json(); }
      catch { throw new Error('接入服务未返回有效结果，请稍后重试。'); }
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

  function withGrantLock(operation, record = pairing) {
    return navigator.locks?.request && record?.pairingId
      ? navigator.locks.request(`yuandian.mcp-grant:${record.pairingId}`, operation)
      : operation();
  }

  function openCoordinationChannel() {
    if (coordinationChannel || !window.BroadcastChannel) return;
    coordinationChannel = new window.BroadcastChannel('yuandian.mcp-authorization.v1');
    coordinationChannel.addEventListener('message', event => {
      const message = event.data;
      if (!['revoke', 'takeover'].includes(message?.type) || message.pairingId !== pairing?.pairingId ||
          message.pageId === identity?.pageId) return;
      void stopSession(message.type === 'revoke' ? '授权已由另一页面断开。' : '已改由另一页面授权。');
      if (message.type === 'revoke') consent = null;
      else scheduleResume();
      update();
    });
  }

  function notifyOtherPages(type = 'revoke') {
    coordinationChannel?.postMessage({
      type, pairingId: pairing?.pairingId, pageId: identity?.pageId
    });
  }

  async function signed(action, parameters = {}, record = pairing, locked = false) {
    if (!record?.pairingId) throw new Error('请先完成配对。');
    const ticket = generation;
    const operation = async () => {
      if (ticket !== generation) throw new DOMException('Aborted', 'AbortError');
      const challenge = await request('pairing/challenge', {
        body: { pairingId: record.pairingId, action, parameters }
      });
      if (ticket !== generation) throw new DOMException('Aborted', 'AbortError');
      if (!challenge?.challengeId || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now())
        throw new Error('配对验证已过期，请重试。');
      let proof;
      try { proof = JSON.parse(challenge.message); } catch { /* Refuse arbitrary signing payloads. */ }
      if (!proof || proof.version !== 1 || proof.pairingId !== record.pairingId ||
          proof.challengeId !== challenge.challengeId || proof.action !== action ||
          JSON.stringify(proof.parameters) !== JSON.stringify(parameters) ||
          proof.expiresAt !== challenge.expiresAt || !/^[a-f0-9]{64}$/u.test(proof.nonce || ''))
        throw new Error('配对验证内容不匹配，请重试。');
      const signature = await signChallenge(record.privateKey, challenge.message);
      if (ticket !== generation) throw new DOMException('Aborted', 'AbortError');
      return request('pairing/complete', {
        body: { pairingId: record.pairingId, challengeId: challenge.challengeId, signature }
      });
    };
    return !locked && ['attach', 'authorize', 'release', 'unpair'].includes(action)
      ? withGrantLock(operation, record) : operation();
  }

  function errorText(error) {
    if (error.code === 'page_in_use') return '另一页面正在授权。可在原页面断开，或明确改由此页授权。';
    if (error instanceof TypeError) return connection.remote
      ? '无法连接远程服务，请检查网络后重试。配对仍保留。'
      : '无法连接本机服务，请确认原点服务正在运行。配对仍保留。';
    if (error.name === 'AbortError') return '接入服务响应超时，请稍后重新授权。';
    return error.message || '接入未完成，请重试。';
  }

  async function forgetRevoked(error, ticket) {
    if (error.status !== 401 || error.code !== 'pairing_revoked') return false;
    try { await pairingStore.clear(pairing?.pairingId); }
    catch {
      feedback('原配对已失效，但无法清除本机记录。请检查站点存储权限后重试。', true);
      return true;
    }
    if (ticket !== generation) return true;
    pairing = null;
    consent = null;
    consentReadFailed = false;
    configText.value = '';
    pageInUse = false;
    mode.value = 'read';
    feedback('原配对已失效，已清除本机配对记录。请重新配对并更新一次 Codex 配置。');
    return true;
  }

  function scheduleResume() {
    clearTimeout(resumeTimer);
    if (!consent || pageHidden || session) return;
    resumeTimer = setTimeout(() => { void restore(); }, resumeDelay);
    resumeDelay = Math.min(resumeDelay * 2, connection.maxResumeDelayMs ?? 15000);
  }

  async function storedConsent() {
    try {
      const saved = pairing?.pairingId ? await pairingStore.loadConsent(pairing.pairingId) : null;
      consentReadFailed = false;
      return saved;
    } catch (error) { consentReadFailed = true; throw error; }
  }

  function sameConsent(first, second) {
    return first?.consentId === second?.consentId && first?.pairingId === second?.pairingId && first?.mode === second?.mode;
  }

  async function boot() {
    const ticket = generation;
    try {
      const loadedIdentity = await identityReady;
      if (ticket !== generation) { loadedIdentity.release?.(); return; }
      identity = loadedIdentity;
      openCoordinationChannel();
      pairing = await pairingStore.load();
      if (ticket !== generation) return;
      consent = await storedConsent();
      if (ticket !== generation) return;
      if (consent) { mode.value = consent.mode; duration.value = 'null'; }
      await restore(ticket);
    } catch (error) {
      if (ticket !== generation) return;
      if (await forgetRevoked(error, ticket)) return;
      feedback(errorText(error), true);
    } finally {
      if (ticket === generation) { busy = false; update(); }
    }
  }

  async function restore(ticket = generation) {
    if (pageHidden || session || ticket !== generation) return;
    busy = true;
    update();
    try {
      if (!pairing?.pairingId) { feedback('尚未配对 · 首次配置一次，以后可继续使用。'); return; }
      await withGrantLock(async () => {
        if (ticket !== generation || pageHidden || session) return;
        const saved = await storedConsent();
        if (ticket !== generation) return;
        consent = saved;
        if (saved) { mode.value = saved.mode; duration.value = 'null'; }
        if (saved && !navigator.locks?.request) {
          feedback('当前浏览器不支持安全恢复永久授权，请使用支持 Web Locks 的浏览器；也可主动断开。', true);
          return;
        }
        const attached = await signed('attach', {
          pageId: identity.pageId, tabId: identity.tabId, reload: identity.reload, takeover: false
        }, pairing, true);
        if (ticket !== generation) return;
        // Only the first attach may use navigation's reload evidence.
        identity.reload = false;
        pageInUse = attached?.state === 'page_in_use';
        if (pageInUse) { feedback('当前接入由另一页面提供，可继续等待或明确改由此页授权。'); return; }
        if (!saved) { feedback('已配对 · 点击重新授权即可接入。'); return; }
        const refusal = allowed();
        if (refusal) { feedback(`${refusal}，永久授权保留，稍后自动连接。`, true); return; }
        await openSession(ticket, saved.mode, null, false, saved);
      });
    } catch (error) {
      if (ticket !== generation) return;
      if (await forgetRevoked(error, ticket)) return;
      pageInUse = error.code === 'page_in_use';
      feedback(consent ? `${errorText(error)} 永久授权保留，正在等待恢复。` : errorText(error), true);
    } finally {
      if (ticket === generation) { busy = false; update(); scheduleResume(); }
    }
  }

  async function revoke(ownerToken, keepalive = false) {
    try { await request('disconnect', { ownerToken, body: {}, keepalive }); }
    catch { /* A missing heartbeat also expires this ephemeral connection. */ }
  }

  async function openSession(ticket, permission, durationMs, takeover, restoring) {
    if (restoring && !sameConsent(restoring, await storedConsent())) return;
    if (ticket !== generation || pageHidden) return;
    const opened = await signed('authorize', {
      pageId: identity.pageId, tabId: identity.tabId, mode: permission, durationMs, takeover
    }, pairing, true);
    if (ticket !== generation || pageHidden || allowed() ||
        (restoring && !sameConsent(restoring, await storedConsent()))) {
      if (opened?.ownerToken) await revoke(opened.ownerToken);
      return;
    }
    if (!/^[a-f0-9]{64}$/u.test(opened?.ownerToken || '') || opened.scope !== 'workspace' ||
        opened.pageId !== identity.pageId || opened.mode !== permission ||
        (durationMs === null ? opened.expiresAt !== null :
          !Number.isFinite(opened.expiresAt) || opened.expiresAt <= Date.now() ||
          opened.expiresAt > Date.now() + durationMs + 1000)) {
      if (opened?.ownerToken) await revoke(opened.ownerToken);
      throw new Error('授权结果无效，请重试。');
    }
    if (!restoring) {
      try {
        if (durationMs === null) {
          const saved = { version: 1, pairingId: pairing.pairingId, consentId: crypto.randomUUID(), mode: permission };
          await pairingStore.saveConsent(saved);
          consent = saved;
        } else {
          // A refused grant must not erase another document's permanent choice.
          await pairingStore.clearConsent(pairing.pairingId);
          consent = null;
        }
        consentReadFailed = false;
      } catch (error) { await revoke(opened.ownerToken); throw error; }
    }
    if (ticket !== generation || pageHidden) {
      await revoke(opened.ownerToken);
      return;
    }
    session = { ownerToken: opened.ownerToken, scope: 'workspace', pageId: identity.pageId,
      mode: permission, expiresAt: opened.expiresAt, consentId: consent?.consentId };
    pageInUse = false;
    failedPolls = 0;
    resumeDelay = connection.resumeDelayMs ?? 1500;
    clearTimeout(resumeTimer);
    clearTimeout(expiryTimer);
    if (session.expiresAt !== null) {
      expiryTimer = setTimeout(() => {
        if (ticket === generation) void stopSession('授权已到期 · 配对保留，点击重新授权即可恢复。');
      }, session.expiresAt - Date.now());
    }
    feedback(`已授权 · ${permission === 'write' ? '读写' : '只读'} · ${session.expiresAt === null
      ? '永久（直到断开）'
      : `${new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 到期`}`);
    schedulePoll(ticket, 0);
  }

  async function authorize(takeover = false) {
    if (busy || session) return;
    const refusal = allowed();
    if (refusal) return feedback(refusal, true);
    if ((takeover || duration.value === 'null') && !navigator.locks?.request)
      return feedback('当前浏览器不支持安全跨页授权，请先在原页面断开授权，或使用支持 Web Locks 的浏览器。', true);
    const ticket = ++generation;
    clearTimeout(resumeTimer);
    const permission = mode.value;
    const durationMs = duration.value === 'null' ? null : Number(duration.value);
    if (!['read', 'write'].includes(permission) || ![null, 900000, 3600000].includes(durationMs))
      return feedback('请选择有效的权限和授权时长。', true);
    busy = true;
    feedback(pairing?.pairingId ? '正在重新授权…' : '正在配对…');
    try {
      if (!pairing?.pairingId) {
        let clientToken;
        const pasted = existingConfig.value;
        existingConfig.value = '';
        existing.open = false;
        if (pasted.trim()) clientToken = parseExistingCodexToken(pasted);
        const createPair = async () => {
          const saved = await pairingStore.load();
          if (saved?.pairingId) { pairing = saved; return; }
          pairing = saved || pairing || await pairingStore.create();
          if (ticket !== generation) return;
          const created = await request('pairings', { body: {
            publicKey: pairing.publicKey, ...(clientToken ? { clientToken } : {})
          } });
          if (!created?.pairingId || typeof created.pairingId !== 'string')
            throw new Error('配对结果不完整，请重试。');
          const config = connection.remote ? codexMcpConfiguration(created.config)
            : localMcpConfiguration(created.config, connection.apiBase);
          pairing = { ...pairing, pairingId: created.pairingId };
          await pairingStore.save(pairing);
          if (ticket !== generation) return;
          configText.value = config;
          configuration.open = false;
        };
        if (pairingStore.exclusive) await pairingStore.exclusive(createPair);
        else await createPair();
      }
      if (ticket !== generation || allowed()) return;
      await withGrantLock(async () => {
        if (ticket !== generation) return;
        if (takeover) notifyOtherPages('takeover');
        await openSession(ticket, permission, durationMs, takeover);
      });
    } catch (error) {
      if (ticket === generation) {
        if (await forgetRevoked(error, ticket)) return;
        pageInUse = error.code === 'page_in_use';
        feedback(errorText(error), true);
      }
    } finally {
      if (ticket === generation) { busy = false; update(); scheduleResume(); }
    }
  }

  function schedulePoll(ticket, delay = connection.pollDelayMs) {
    clearTimeout(pollTimer);
    if (session && ticket === generation) pollTimer = setTimeout(() => poll(ticket), delay);
  }

  async function poll(ticket) {
    const active = session;
    if (!active || ticket !== generation) return;
    if (active.expiresAt !== null && Date.now() >= active.expiresAt) return stopSession('授权已到期 · 点击重新授权即可恢复。');
    const reason = allowed();
    if (reason) return pause(`${reason}，接入已暂停。`);
    try {
      if (active.consentId) {
        const saved = await storedConsent();
        if (ticket !== generation || session !== active) return;
        if (saved?.consentId !== active.consentId) {
          consent = saved;
          return stopSession('永久授权已断开。');
        }
      }
      const pending = await request('poll', { ownerToken: active.ownerToken });
      if (ticket !== generation || session !== active) return;
      const recovered = failedPolls > 0;
      if (pending) {
        let result = completedRequests.get(pending.requestId);
        if (!result) {
          try {
            const refusal = allowed();
            const writes = pending.tool === 'edit_canvas' || pending.tool === 'create_canvas';
            const handler = Object.hasOwn(handlers, pending.tool) ? handlers[pending.tool] : null;
            if (!Number.isFinite(pending.expiresAt) || Date.now() >= pending.expiresAt)
              result = { ok: false, code: 'REQUEST_EXPIRED', error: '请求已过期，请重新读取画布。' };
            else if (refusal) result = { ok: false, code: 'UNAVAILABLE', error: refusal };
            else if (writes && active.mode !== 'write')
              result = { ok: false, code: 'READ_ONLY', error: '本次授权仅允许读取和导出画布。' };
            else if (typeof handler === 'function') {
              const context = {
                isAuthorized: () => ticket === generation && session === active &&
                  active.pageId === identity.pageId && (!writes || active.mode === 'write') &&
                  (active.expiresAt === null || Date.now() < active.expiresAt) && Number.isFinite(pending.expiresAt) &&
                  Date.now() < pending.expiresAt
              };
              result = await withGrantLock(async () => {
                if (active.consentId && (await storedConsent())?.consentId !== active.consentId)
                  return { ok: false, code: 'AUTHORIZATION_EXPIRED', error: '永久授权已断开。' };
                return context.isAuthorized() ? handler(pending.arguments, context)
                  : { ok: false, code: 'AUTHORIZATION_EXPIRED', error: '授权已失效，请重新授权后重试。' };
              });
            }
            else result = { ok: false, code: 'UNKNOWN_TOOL', error: '不支持此操作。' };
          } catch {
            result = { ok: false, code: 'CANVAS_ERROR', error: '画布操作未完成，请重新读取后重试。' };
          }
          if (ticket !== generation || session !== active) return;
          if (active.expiresAt !== null && Date.now() >= active.expiresAt) return stopSession('授权已到期 · 点击重新授权即可恢复。');
          if (Date.now() >= pending.expiresAt)
            result = { ok: false, code: 'REQUEST_EXPIRED', error: '请求已过期，请重新读取画布。' };
          completedRequests.set(pending.requestId, result);
          if (completedRequests.size > 32) completedRequests.delete(completedRequests.keys().next().value);
        }
        if (ticket !== generation || session !== active) return;
        if (active.expiresAt !== null && Date.now() >= active.expiresAt) return stopSession('授权已到期 · 点击重新授权即可恢复。');
        const refusal = allowed();
        if (refusal) return pause(`${refusal}，接入已暂停。`);
        if (!Number.isFinite(pending.expiresAt) || Date.now() >= pending.expiresAt)
          result = { ok: false, code: 'REQUEST_EXPIRED', error: '请求已过期，请重新读取画布。' };
        await request('result', { ownerToken: active.ownerToken, body: { requestId: pending.requestId, result } });
      }
      if (ticket !== generation || session !== active) return;
      failedPolls = 0;
      if (recovered) feedback(`已恢复连接 · ${active.mode === 'write' ? '读写' : '只读'} · ${active.expiresAt === null ? '永久（直到断开）' : '本次到期时间不变'}`);
    } catch (error) {
      if (ticket !== generation || session !== active) return;
      failedPolls += 1;
      if ([401, 404, 410].includes(error.status) || failedPolls >= 3)
        return pause(consent ? '连接已中断 · 永久授权保留，正在自动恢复。' : '授权已中断 · 配对保留，点击重新授权即可恢复。');
      feedback('连接暂时中断，正在重试本次未过期授权…', true);
    }
    schedulePoll(ticket, failedPolls ? 750 : connection.pollDelayMs);
  }

  async function stopSession(text, { keepalive = false } = {}) {
    const previous = session;
    generation += 1;
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
    clearTimeout(resumeTimer);
    for (const controller of requests) controller.abort();
    session = null;
    busy = false;
    mode.value = consent?.mode || 'read';
    failedPolls = 0;
    completedRequests.clear();
    configuration.open = false;
    existingConfig.value = '';
    if (keepalive) configText.value = '';
    feedback(text);
    if (previous) await revoke(previous.ownerToken, keepalive);
  }

  async function pause(text = '连接已暂停，永久授权保留。') {
    const stopped = stopSession(text);
    // Reconnect must not wait for the previous service's disconnect timeout.
    scheduleResume();
    await stopped;
  }

  async function disconnect(text = '授权已断开，配对仍保留。') {
    const stopped = stopSession('正在断开授权…');
    const ticket = generation;
    const record = pairing;
    busy = true;
    // Invalidate other documents' in-flight writes before waiting for their lock.
    notifyOtherPages();
    update();
    let cleared = false;
    try {
      await withGrantLock(async () => {
        await pairingStore.clearConsent(record?.pairingId);
        cleared = true;
        consent = null;
        consentReadFailed = false;
        mode.value = 'read';
        duration.value = '3600000';
        if (ticket !== generation || !record?.pairingId) return;
        const remote = await signed('status', { pageId: identity.pageId, tabId: identity.tabId }, record, true);
        if (ticket !== generation || !remote?.activeSessionId) return;
        await signed('release', { pageId: identity.pageId, tabId: identity.tabId,
          allPages: true, expectedSessionId: remote.activeSessionId }, record, true);
      }, record);
      if (ticket === generation) {
        pageInUse = false;
        feedback(text);
      }
    } catch (error) {
      if (ticket === generation) feedback(cleared
        ? '永久授权已清除；远程断开尚未确认，现有连接将在失联后停止。'
        : '无法清除永久授权，尚未完成断开。请检查站点存储权限后重试。', true);
    } finally {
      if (ticket === generation) { busy = false; update(); }
    }
    await stopped;
    return cleared;
  }

  async function unpair() {
    if (busy || !pairing?.pairingId) return;
    if (!navigator.locks?.request)
      return feedback('当前浏览器无法安全协调取消配对，请在支持 Web Locks 的浏览器中操作。', true);
    notifyOtherPages();
    await disconnect('正在取消配对…');
    busy = true;
    const ticket = generation;
    feedback('正在取消配对…');
    try {
      await signed('unpair');
      await pairingStore.clear(pairing.pairingId);
      if (ticket !== generation) return;
      pairing = null;
      configText.value = '';
      pageInUse = false;
      feedback('配对已取消，原客户端凭据已失效。');
    } catch (error) {
      if (ticket === generation && !await forgetRevoked(error, ticket))
        feedback(error instanceof TypeError
          ? '无法确认远程取消配对，已保留本机配对记录，请联网后重试。'
          : errorText(error), true);
    } finally {
      if (ticket === generation) { busy = false; update(); }
    }
  }

  async function copyConfiguration() {
    if (!configText.value) return;
    try { await navigator.clipboard.writeText(configText.value); feedback('配置已复制，仅首次添加到 Codex 即可。'); }
    catch { configuration.open = true; configText.focus(); configText.select(); feedback('请复制已选中的首次配置。'); }
  }

  function close() {
    const focused = root.contains(document.activeElement);
    root.hidden = true;
    update();
    if (focused) document.querySelector('#ai-menu-toggle')?.focus();
  }

  function toggle() {
    root.hidden = !root.hidden;
    update();
    if (!root.hidden) (session ? disconnectButton : mode).focus();
  }

  window.addEventListener('pagehide', () => {
    pageHidden = true;
    identity?.release?.();
    coordinationChannel?.close();
    coordinationChannel = undefined;
    void stopSession('网页已关闭，接入暂停。', { keepalive: true });
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    pageHidden = false;
    // A page restored from the back/forward cache has released its slot lock.
    // Obtain a new identity and re-read consent; never reuse its old session.
    busy = true;
    feedback('正在检查浏览器配对…');
    identityReady = pairingPageIdentity();
    void boot();
  });
  update();
  void boot();
  return {
    toggle, close, disconnect, pause,
    get authorized() { return busy || Boolean(session); },
    get connected() { return Boolean(session); },
    get root() { return root; }
  };
}
