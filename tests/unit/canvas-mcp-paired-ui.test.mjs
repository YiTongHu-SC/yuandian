import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairedMcpPanel } from '../../src/canvas/mcp-paired-ui.js';
import { REMOTE_MCP_URL } from '../../src/canvas/mcp-connection.js';

// A DOM substitute verifies grant state transitions only. Real IndexedDB,
// browser reloads, rendering and actual Codex calls require separate evidence.
class Element {
  constructor(tag, document) {
    Object.assign(this, { tag, document, children: [], attributes: {}, listeners: new Map(), value: '', className: '' });
    this.classList = { toggle() {} };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) {
    this.children.push(...nodes);
    if (this.tag === 'select' && !this.value) this.value = this.children[0]?.attributes.value || '';
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, event) { return this.listeners.get(name)?.(event); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.document.activeElement = this; }
  select() { this.selected = true; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function aborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}
async function until(check) {
  for (let count = 0; count < 300; count++) { if (check()) return; await delay(5); }
  assert.fail('面板操作没有按期完成。');
}

function fixture(t, { paired = false, permanent = false, handle, editCanvas, createCanvas, readCanvas,
  signChallenge, locks, storageFailure, remote = true, resumeDelayMs = 10, BroadcastChannel,
  canConnect = () => true } = {}) {
  const originals = new Map();
  const nodes = [];
  const document = {
    createElement(tag) { const node = new Element(tag, document); nodes.push(node); return node; },
    querySelector(selector) { return nodes.find(node => selector.startsWith('#')
      ? node.attributes.id === selector.slice(1) : node.className.split(' ').includes(selector.slice(1))); }
  };
  document.body = document.createElement('body');
  document.activeElement = document.body;
  document.createElement('main').className = 'stage-wrap';
  document.createElement('button').setAttribute('id', 'ai-menu-toggle');
  const window = new Element('window', document);
  window.location = { href: 'http://127.0.0.1:4176/' };
  window.BroadcastChannel = BroadcastChannel;
  const identity = { pageId: crypto.randomUUID(), tabId: crypto.randomUUID(), reload: true };
  const clientToken = '2'.repeat(64);
  const ownerToken = '1'.repeat(64);
  let stored = paired ? { version: 1, pairingId: crypto.randomUUID(), privateKey: 'private', publicKey: { kty: 'EC' } } : null;
  let consent = permanent && stored ? { version: 1, pairingId: stored.pairingId,
    consentId: crypto.randomUUID(), mode: permanent === 'write' ? 'write' : 'read' } : null;
  const storeWrites = [];
  const pairingStore = {
    async load() { return stored; },
    async create() { stored = { version: 1, pairingId: null, privateKey: 'private', publicKey: { kty: 'EC' } }; storeWrites.push(structuredClone(stored)); return stored; },
    async save(record) { stored = record; storeWrites.push(structuredClone(record)); },
    async clear() { stored = null; consent = null; },
    async loadConsent(pairingId) {
      if (storageFailure?.load) throw new Error('永久授权记录无法使用，请断开授权后重试。');
      return consent?.pairingId === pairingId ? structuredClone(consent) : null;
    },
    async saveConsent(record) {
      if (storageFailure?.save) throw new Error('模拟永久授权保存失败');
      consent = structuredClone(record);
      storeWrites.push(structuredClone(record));
    },
    async clearConsent(pairingId) {
      if (storageFailure?.clear) throw new Error('模拟永久授权清除失败');
      if (!pairingId || consent?.pairingId === pairingId) consent = null;
    }
  };
  const calls = [];
  const challenges = new Map();
  const fetch = async (url, options) => {
    const route = url.split('/api/mcp/')[1];
    const body = options.body ? JSON.parse(options.body) : undefined;
    const action = route === 'pairing/complete' ? challenges.get(body.challengeId) : body;
    calls.push({ route, body, options, action });
    const custom = await handle?.({ route, body, action, options, identity, ownerToken });
    if (custom !== undefined) return custom;
    if (route === 'pairings') return json({ ok: true, pairingId: crypto.randomUUID(),
      config: remote ? { url: REMOTE_MCP_URL, headers: { Authorization: `Bearer ${clientToken}` } }
        : { command: 'node', args: ['F:/fictional/scripts/mcp-server.mjs'],
          env: { YUANDIAN_URL: 'http://127.0.0.1:4176', YUANDIAN_MCP_TOKEN: clientToken } } }, 201);
    if (route === 'pairing/challenge') {
      const challengeId = crypto.randomUUID();
      const expiresAt = Date.now() + 30000;
      challenges.set(challengeId, body);
      return json({ challengeId, expiresAt,
        message: JSON.stringify({ version: 1, ...body, challengeId, expiresAt, nonce: 'a'.repeat(64) }) });
    }
    if (route === 'pairing/complete' && action.action === 'authorize') return json({
      ok: true, ownerToken, scope: 'workspace', pageId: action.parameters.pageId,
      mode: action.parameters.mode, expiresAt: action.parameters.durationMs === null ? null : Date.now() + action.parameters.durationMs
    });
    if (route === 'pairing/complete') return json({ ok: true, paired: true, connected: false, state: 'needs_authorization' });
    if (route === 'poll') return aborted(options.signal);
    return json({ ok: true });
  };
  const navigator = { clipboard: { writeText: async () => {} },
    ...(locks === false ? {} : { locks: locks || {
      request: async (name, options, callback) => (typeof options === 'function' ? options : callback)({ name })
    } }) };
  window.navigator = navigator;
  for (const [key, value] of Object.entries({ document, window, fetch, navigator })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const panel = createPairedMcpPanel({
    connection: { remote, available: true, apiBase: remote ? 'https://stellarcore.games/yuandian-mcp/api/mcp' : '/api/mcp',
      pollDelayMs: 0, requestTimeoutMs: 35000, resumeDelayMs, maxResumeDelayMs: 30 },
    pairingStore, identity, signChallenge: signChallenge || (async () => 'signed-proof'), canConnect,
    listCanvases: async () => ({ ok: true, boards: [] }),
    readCanvas: readCanvas || (async () => ({ ok: true })),
    editCanvas: editCanvas || (async () => ({ ok: true })),
    createCanvas: createCanvas || (async () => ({ ok: true })),
    exportCanvas: async () => ({ ok: true, json: '{}' })
  });
  t.after(async () => {
    fakedPageHide();
    await panel.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function fakedPageHide() { window.emit('pagehide'); }
  return {
    panel, document, window, calls, storeWrites, stored: () => stored, consent: () => consent,
    clearSavedConsent: () => { consent = null; },
    button: text => nodes.find(node => node.tag === 'button' && node.textContent === text),
    input: label => nodes.find(node => node.attributes['aria-label'] === label)
  };
}

test('首次配对先持久保存证明，再只读授权；配置只在当前页面显示', async t => {
  const f = fixture(t);
  await until(() => f.button('配对并授权'));
  await f.button('配对并授权').emit('click');
  assert.equal(f.panel.connected, true);
  assert.equal(f.storeWrites[0].pairingId, null);
  assert.ok(f.storeWrites[1].pairingId);
  assert.equal(f.storeWrites.some(value => JSON.stringify(value).includes('2'.repeat(64))), false);
  assert.equal(f.document.querySelector('.mcp-configuration').open, false);
  const parameters = f.calls.find(call => call.route === 'pairing/challenge' && call.body.action === 'authorize').body.parameters;
  assert.equal(parameters.mode, 'read');
  assert.equal(parameters.durationMs, 3600000);
  assert.equal(parameters.takeover, false);
  assert.deepEqual(f.input('本次授权时长').children.map(option => option.textContent),
    ['15 分钟', '1 小时', '永久（直到断开）']);
});

test('永久授权可执行带期限的请求；断开立即使等待中的编辑失效', async t => {
  let context;
  let finish;
  let delivered = false;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'poll' && !delivered) {
      delivered = true;
      return json({ requestId: 'permanent-edit', tool: 'edit_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
    }
  }, editCanvas: async (args, received) => {
    context = received;
    await waiting;
    return { ok: received.isAuthorized() };
  } });
  await until(() => f.button('重新授权'));
  f.input('本次授权时长').value = 'null';
  f.input('AI 接入权限').value = 'write';
  await f.button('重新授权').emit('click');
  await until(() => context);
  assert.equal(context.isAuthorized(), true);
  assert.equal(f.panel.connected, true);
  assert.match(f.document.querySelector('.mcp-status').textContent, /永久（直到断开）/u);
  const parameters = f.calls.find(call => call.route === 'pairing/challenge' && call.body.action === 'authorize').body.parameters;
  assert.equal(parameters.durationMs, null);
  await f.button('断开授权').emit('click');
  assert.equal(context.isAuthorized(), false);
  finish();
  await delay(15);
  assert.equal(f.calls.some(call => call.route === 'result'), false);
  assert.equal(f.input('AI 接入权限').value, 'read');
});

test('有限授权不能被服务端静默改为永久，永久也拒绝缺失期限的响应', async t => {
  let returnedExpiry = null;
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'authorize')
      return json({ ok: true, ownerToken: request.ownerToken, scope: 'workspace', pageId: request.identity.pageId,
        mode: request.action.parameters.mode, ...(returnedExpiry === null ? { expiresAt: null } : {}) });
  } });
  await until(() => f.button('重新授权'));
  f.input('本次授权时长').value = '900000';
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, false);
  assert.match(f.document.querySelector('.mcp-status').textContent, /授权结果无效/u);
  returnedExpiry = undefined;
  f.input('本次授权时长').value = 'null';
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 2);
});

test('刷新只加载配对并 attach，不恢复授权、不显示旧配置；一键授权复用配对', async t => {
  const f = fixture(t, { paired: true });
  await until(() => f.button('重新授权'));
  assert.equal(f.panel.connected, false);
  assert.equal(f.input('MCP 客户端配置').value, '');
  assert.deepEqual(f.calls.filter(call => call.route === 'pairing/challenge').map(call => call.body.action), ['attach']);
  assert.equal(f.calls.find(call => call.route === 'pairing/challenge').body.parameters.reload, true);
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, true);
  assert.equal(f.calls.filter(call => call.route === 'pairings').length, 0);
  await f.button('断开授权').emit('click');
  assert.ok(f.stored().pairingId);
  assert.equal(f.input('AI 接入权限').value, 'read');
  assert.equal(f.input('MCP 客户端配置').value, '');
});

test('到期后保留配对并恢复只读，重新授权不产生新配置', async t => {
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'authorize')
      return json({ ok: true, ownerToken: request.ownerToken, scope: 'workspace', pageId: request.identity.pageId,
        mode: request.action.parameters.mode, expiresAt: Date.now() + 100 });
  } });
  await until(() => f.button('重新授权'));
  f.input('AI 接入权限').value = 'write';
  await f.button('重新授权').emit('click');
  await until(() => !f.panel.connected);
  assert.ok(f.stored().pairingId);
  assert.equal(f.input('AI 接入权限').value, 'read');
  assert.match(f.document.querySelector('.mcp-status').textContent, /到期/u);
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, true);
  assert.equal(f.calls.filter(call => call.route === 'pairings').length, 0);
});

test('其他页面授权时仅显示明确接管入口，首次 attach 不能自动接管', async t => {
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'attach')
      return json({ ok: false, code: 'page_in_use', error: '另一页面正在授权' }, 409);
  } });
  await until(() => f.button('改由此页授权')?.hidden === false);
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'authorize').length, 0);
  await f.button('改由此页授权').emit('click');
  const grant = f.calls.find(call => call.route === 'pairing/challenge' && call.body.action === 'authorize');
  assert.equal(grant.body.parameters.takeover, true);
  assert.equal(grant.body.parameters.mode, 'read');
});

test('沿用配置立即清空输入，仅提交首次配对，不保存客户端凭据', async t => {
  const f = fixture(t);
  await until(() => f.button('配对并授权'));
  const token = 'a'.repeat(64);
  const input = f.input('沿用已有 Codex 配置');
  input.value = `[mcp_servers.yuandian]\nurl = "${REMOTE_MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  await f.button('配对并授权').emit('click');
  assert.equal(input.value, '');
  assert.equal(f.calls.find(call => call.route === 'pairings').body.clientToken, token);
  assert.equal(f.storeWrites.some(record => JSON.stringify(record).includes(token)), false);
});

test('默认只读也在浏览器拒绝编辑和新建，pagehide 后不回传迟到数据', async t => {
  let delivered = 0;
  let edits = 0;
  const pending = ['edit_canvas', 'create_canvas'];
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'poll' && pending.length)
      return json({ requestId: `readonly-${++delivered}`, tool: pending.shift(), arguments: {}, expiresAt: Date.now() + 10000 });
  }, editCanvas: async () => { edits++; }, createCanvas: async () => { edits++; } });
  await until(() => f.button('重新授权'));
  await f.button('重新授权').emit('click');
  await until(() => f.calls.filter(call => call.route === 'result').length === 2);
  assert.equal(edits, 0);
  assert.deepEqual(f.calls.filter(call => call.route === 'result').map(call => call.body.result.code), ['READ_ONLY', 'READ_ONLY']);
  f.window.emit('pagehide');
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.find(call => call.route === 'disconnect').options.keepalive, true);
  assert.ok(f.stored().pairingId);
});

test('取消配对撤销当前授权和持久身份', async t => {
  const f = fixture(t, { paired: true });
  await until(() => f.button('重新授权'));
  await f.button('重新授权').emit('click');
  await f.button('取消配对').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.stored(), null);
  assert.equal(f.input('MCP 客户端配置').value, '');
  assert.equal(f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'unpair').length, 1);
});

test('服务端明确已撤销的配对可安全恢复为首次配对，网络错误不清除身份', async t => {
  let revoked = true;
  const f = fixture(t, { paired: true, handle: request => {
    if (revoked && request.route === 'pairing/challenge')
      return json({ ok: false, code: 'pairing_revoked', error: '配对已取消。' }, 401);
  } });
  await until(() => f.button('配对并授权'));
  assert.equal(f.stored(), null);
  assert.match(f.document.querySelector('.mcp-status').textContent, /配对已失效/u);
  revoked = false;
  await f.button('配对并授权').emit('click');
  assert.equal(f.panel.connected, true);
});

test('取消配对遇到网络错误不会声称已撤销或清除本机证明', async t => {
  let failing = false;
  const f = fixture(t, { paired: true, handle: request => {
    if (failing && request.route === 'pairing/challenge') throw new TypeError('模拟断网');
  } });
  await until(() => f.button('重新授权'));
  failing = true;
  await f.button('取消配对').emit('click');
  assert.ok(f.stored().pairingId);
  assert.match(f.document.querySelector('.mcp-status').textContent, /无法确认远程取消配对/u);
});

test('配对签名前拒绝响应中被替换的操作，不把 authorize 变为 unpair', async t => {
  const f = fixture(t, { paired: true, handle: request => {
    if (request.route === 'pairing/challenge') {
      const challengeId = crypto.randomUUID();
      const expiresAt = Date.now() + 30000;
      return json({ challengeId, expiresAt, message: JSON.stringify({ version: 1, ...request.body,
        action: 'unpair', challengeId, expiresAt, nonce: 'a'.repeat(64) }) });
    }
  } });
  await until(() => f.button('重新授权'));
  assert.equal(f.calls.some(call => call.route === 'pairing/complete'), false);
  assert.match(f.document.querySelector('.mcp-status').textContent, /验证内容不匹配/u);
});

test('pagehide 发生在签名等待期间时，不再提交迟到的授权确认', async t => {
  let waitForProof = false;
  let signing = false;
  let finishProof;
  const proof = new Promise(resolve => { finishProof = resolve; });
  const f = fixture(t, { paired: true, signChallenge: async () => {
    if (!waitForProof) return 'signed-proof';
    signing = true;
    return proof;
  } });
  await until(() => f.button('重新授权'));
  waitForProof = true;
  const authorizing = f.button('重新授权').emit('click');
  await until(() => signing);
  f.window.emit('pagehide');
  finishProof('late-proof');
  await authorizing;
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.filter(call => call.route === 'pairing/complete').length, 1); // Initial attach only.
});

test('返回缓存恢复的页面重新获取身份并 attach，不恢复旧授权', async t => {
  const f = fixture(t, { paired: true });
  await until(() => f.button('重新授权'));
  await f.button('重新授权').emit('click');
  f.window.emit('pagehide');
  f.window.emit('pageshow', { persisted: true });
  await until(() => f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'attach').length === 2);
  assert.equal(f.panel.connected, false);
  const attached = f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'attach');
  assert.notEqual(attached[0].body.parameters.pageId, attached[1].body.parameters.pageId);
});

test('取消配对与在途处理使用同一排他锁，等待期间本地授权已失效', async t => {
  const queues = new Map();
  const locks = {
    request(name, callback) {
      const work = (queues.get(name) || Promise.resolve()).then(() => callback({ name }));
      queues.set(name, work.catch(() => {}));
      return work;
    }
  };
  let finishWrite;
  let context;
  let delivered = false;
  const writing = new Promise(resolve => { finishWrite = resolve; });
  const f = fixture(t, { paired: true, locks, handle: request => {
    if (request.route === 'poll' && !delivered) {
      delivered = true;
      return json({ requestId: 'waiting-write', tool: 'edit_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
    }
  }, editCanvas: async (args, received) => { context = received; await writing; return { ok: received.isAuthorized() }; } });
  await until(() => f.button('重新授权'));
  f.input('AI 接入权限').value = 'write';
  await f.button('重新授权').emit('click');
  await until(() => context);
  const cancelling = f.button('取消配对').emit('click');
  await delay(15);
  assert.equal(context.isAuthorized(), false);
  assert.equal(f.calls.some(call => call.route === 'pairing/challenge' && call.body.action === 'unpair'), false);
  finishWrite();
  await cancelling;
  assert.equal(f.stored(), null);
  assert.equal(f.calls.some(call => call.route === 'result'), false);
});

test('不支持 Web Locks 时拒绝跨页接管和取消配对，保留当前身份', async t => {
  const f = fixture(t, { paired: true, locks: false, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'attach')
      return json({ ok: false, code: 'page_in_use', error: '另一页面授权中。' }, 409);
  } });
  await until(() => f.button('改由此页授权').hidden === false);
  await f.button('改由此页授权').emit('click');
  assert.match(f.document.querySelector('.mcp-status').textContent, /先在原页面断开/u);
  await f.button('取消配对').emit('click');
  assert.match(f.document.querySelector('.mcp-status').textContent, /Web Locks/u);
  assert.ok(f.stored().pairingId);
  assert.equal(f.calls.some(call => call.route === 'pairing/challenge' && ['authorize', 'unpair'].includes(call.body.action)), false);
});


function serialLocks() {
  const queues = new Map();
  return { request(name, options, callback) {
    const operation = typeof options === 'function' ? options : callback;
    const work = (queues.get(name) || Promise.resolve()).then(() => operation({ name }));
    queues.set(name, work.catch(() => {}));
    return work;
  } };
}

test('永久读写意愿在打开时自动恢复，关闭和 BFCache 重开保留同一意愿并获取新页面身份', async t => {
  const f = fixture(t, { paired: true, permanent: 'write' });
  const saved = structuredClone(f.consent());
  await until(() => f.panel.connected);
  const grants = () => f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'authorize');
  assert.equal(grants()[0].body.parameters.mode, 'write');
  assert.equal(grants()[0].body.parameters.durationMs, null);
  assert.equal(f.storeWrites.length, 0);
  f.window.emit('pagehide');
  assert.equal(f.panel.connected, false);
  assert.deepEqual(f.consent(), saved);
  f.window.emit('pageshow', { persisted: true });
  await until(() => f.panel.connected && grants().length === 2);
  assert.notEqual(grants()[0].body.parameters.pageId, grants()[1].body.parameters.pageId);
  assert.deepEqual(f.consent(), saved);
  assert.deepEqual(Object.keys(f.consent()).sort(), ['consentId', 'mode', 'pairingId', 'version']);
  await f.button('断开授权').emit('click');
  assert.equal(f.consent(), null);
  await delay(50);
  assert.equal(grants().length, 2);
});

test('中继重启使旧 owner 失效时，永久权限自动重签恢复且不改写意愿', async t => {
  let polls = 0;
  const f = fixture(t, { paired: true, permanent: 'write', handle: request => {
    if (request.route === 'poll' && ++polls === 1)
      return json({ ok: false, code: 'unauthorized', error: '模拟服务重启' }, 401);
  } });
  const saved = structuredClone(f.consent());
  await until(() => f.panel.connected && f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'authorize').length === 2);
  assert.deepEqual(f.consent(), saved);
  assert.equal(f.storeWrites.length, 0);
  assert.equal(f.input('AI 接入权限').value, 'write');
});

test('永久意愿遇其他活跃页面只等待，旧连接消失后自动恢复而不静默接管', async t => {
  let occupied = true;
  const f = fixture(t, { paired: true, permanent: true, handle: request => {
    if (occupied && request.route === 'pairing/complete' && request.action.action === 'attach')
      return json({ ok: false, code: 'page_in_use', error: '另一页面正在授权' }, 409);
  } });
  await until(() => f.calls.filter(call => call.route === 'pairing/challenge' && call.body.action === 'attach').length >= 2);
  assert.equal(f.panel.connected, false);
  assert.equal(f.button('断开授权').hidden, false);
  assert.equal(f.calls.some(call => call.route === 'pairing/challenge' && call.body.action === 'authorize'), false);
  occupied = false;
  await until(() => f.panel.connected);
  assert.equal(f.calls.some(call => call.body?.parameters?.takeover === true), false);
});

test('恢复签名等待时主动断开，等待锁前立即失效且迟到签名不能复活', async t => {
  let signing = false;
  let finish;
  const proof = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { paired: true, permanent: 'write', locks: serialLocks(), signChallenge: async (key, message) => {
    if (JSON.parse(message).action === 'authorize') { signing = true; return proof; }
    return 'signed-proof';
  } });
  await until(() => signing);
  const stopping = f.button('断开授权').emit('click');
  assert.equal(f.panel.connected, false);
  finish('late-signature');
  await stopping;
  await delay(40);
  assert.equal(f.consent(), null);
  assert.equal(f.calls.some(call => call.route === 'pairing/complete' && call.action.action === 'authorize'), false);
  assert.equal(f.calls.filter(call => call.route === 'pairing/complete').length, 2); // Attach and conditional status only.
});

test('永久意愿保存失败撤回新连接；清除失败保留可重试断开入口且不假报成功', async t => {
  const failures = { save: true };
  const f = fixture(t, { paired: true, storageFailure: failures });
  await until(() => f.button('重新授权'));
  f.input('本次授权时长').value = 'null';
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.consent(), null);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 1);
  failures.save = false;
  await f.button('重新授权').emit('click');
  assert.equal(f.panel.connected, true);
  failures.clear = true;
  await f.button('断开授权').emit('click');
  assert.ok(f.consent());
  assert.match(f.document.querySelector('.mcp-status').textContent, /尚未完成断开/u);
  assert.equal(f.button('断开授权').hidden, false);
  failures.clear = false;
  await f.button('断开授权').emit('click');
  assert.equal(f.consent(), null);
});

test('损坏的永久意愿仍提供清除入口，无 Web Locks 时不自动恢复永久授权', async t => {
  const failure = { load: true };
  const f = fixture(t, { paired: true, permanent: true, storageFailure: failure, locks: false });
  await until(() => f.button('断开授权')?.hidden === false);
  assert.match(f.document.querySelector('.mcp-status').textContent, /永久授权记录无法使用/u);
  await f.button('断开授权').emit('click');
  assert.equal(f.consent(), null);
  assert.equal(f.calls.some(call => call.body?.action === 'authorize'), false);
});

test('本机首次配对展示通用 stdio JSON，客户端凭据不进入配对和永久意愿记录', async t => {
  const f = fixture(t, { remote: false });
  await until(() => f.button('配对并授权'));
  f.input('本次授权时长').value = 'null';
  await f.button('配对并授权').emit('click');
  const config = JSON.parse(f.input('MCP 客户端配置').value);
  assert.equal(config.mcpServers.yuandian.command, 'node');
  assert.equal(config.mcpServers.yuandian.env.YUANDIAN_MCP_TOKEN, '2'.repeat(64));
  assert.equal(f.storeWrites.some(record => JSON.stringify(record).includes('2'.repeat(64))), false);
  assert.equal(f.document.querySelector('.mcp-existing').hidden, true);
});


test('明确改用有限授权会清除永久意愿，到期后不恢复', async t => {
  const f = fixture(t, { paired: true, permanent: 'write', resumeDelayMs: 5000, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'authorize' && request.action.parameters.durationMs !== null)
      return json({ ok: true, ownerToken: request.ownerToken, scope: 'workspace', pageId: request.action.parameters.pageId,
        mode: request.action.parameters.mode, expiresAt: Date.now() + 80 });
  } });
  await until(() => f.panel.connected);
  await f.panel.pause('测试暂停');
  f.input('本次授权时长').value = '900000';
  await f.button('重新授权').emit('click');
  assert.equal(f.consent(), null);
  await until(() => !f.panel.connected);
  await delay(50);
  assert.equal(f.calls.filter(call => call.route === 'pairing/complete' && call.action.action === 'authorize').length, 2);
  assert.equal(f.input('AI 接入权限').value, 'read');
});

test('网页保存暂不可用时保留意愿并等待恢复，pause 同样保留权限', async t => {
  let available = false;
  const f = fixture(t, { paired: true, permanent: 'write', canConnect: () => available || '保存已暂停' });
  await until(() => /永久授权保留/u.test(f.document.querySelector('.mcp-status').textContent));
  assert.equal(f.panel.connected, false);
  assert.ok(f.consent());
  available = true;
  await until(() => f.panel.connected);
  available = false;
  await f.panel.pause('保存已暂停');
  assert.equal(f.panel.connected, false);
  assert.equal(f.consent().mode, 'write');
  await delay(50);
  assert.equal(f.panel.connected, false);
  available = true;
  await until(() => f.panel.connected);
});

test('离线页主动断开先清意愿，再按签名状态中的 sessionId 条件撤销另一页面', async t => {
  const activeSessionId = crypto.randomUUID();
  const f = fixture(t, { paired: true, permanent: true, handle: request => {
    if (request.route === 'pairing/complete' && request.action.action === 'attach')
      return json({ ok: false, code: 'page_in_use', error: '另一页面正在授权' }, 409);
    if (request.route === 'pairing/complete' && request.action.action === 'status')
      return json({ ok: true, state: 'page_in_use', activeSessionId });
    if (request.route === 'pairing/challenge' && request.body.action === 'status')
      assert.equal(f.consent(), null);
  } });
  await until(() => f.button('改由此页授权')?.hidden === false);
  await f.button('断开授权').emit('click');
  const release = f.calls.find(call => call.route === 'pairing/challenge' && call.body.action === 'release');
  assert.equal(release.body.parameters.allPages, true);
  assert.equal(release.body.parameters.expectedSessionId, activeSessionId);
  assert.equal(f.consent(), null);
  assert.equal(f.button('改由此页授权').hidden, true);
  assert.equal(f.button('重新授权').hidden, false);
});

test('没有 Web Locks 的浏览器保留既有永久意愿但不自动恢复，仍可清除', async t => {
  const f = fixture(t, { paired: true, permanent: true, locks: false });
  await until(() => /不支持安全恢复永久授权/u.test(f.document.querySelector('.mcp-status').textContent));
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.some(call => call.body?.action === 'authorize'), false);
  await f.button('断开授权').emit('click');
  assert.equal(f.consent(), null);
});

test('本机配置拒绝额外执行参数及非本机服务环境，不显示未知配置', async t => {
  const f = fixture(t, { remote: false, handle: request => {
    if (request.route === 'pairings') return json({ ok: true, pairingId: crypto.randomUUID(), config: {
      command: 'node', args: ['--eval', 'arbitrary-code'], env: { YUANDIAN_URL: 'http://127.0.0.1:4176', YUANDIAN_MCP_TOKEN: '2'.repeat(64) }
    } });
  } });
  await until(() => f.button('配对并授权'));
  await f.button('配对并授权').emit('click');
  assert.equal(f.input('MCP 客户端配置').value, '');
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.some(call => call.body?.action === 'authorize'), false);
  assert.match(f.document.querySelector('.mcp-status').textContent, /本机客户端配置无效/u);
});


test('另一页面广播断开先使持锁等待中的编辑失效，不回传迟到结果', async t => {
  let channel;
  class Channel {
    constructor() { channel = this; }
    addEventListener(name, callback) { this.receive = callback; }
    postMessage() {}
    close() {}
  }
  let delivered = false;
  let context;
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { paired: true, permanent: 'write', BroadcastChannel: Channel, locks: serialLocks(), handle: request => {
    if (request.route === 'poll' && !delivered) {
      delivered = true;
      return json({ requestId: 'broadcast-write', tool: 'edit_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
    }
  }, editCanvas: async (args, received) => { context = received; await waiting; return { ok: received.isAuthorized() }; } });
  await until(() => context);
  assert.equal(context.isAuthorized(), true);
  channel.receive({ data: { type: 'revoke', pairingId: f.stored().pairingId, pageId: crypto.randomUUID() } });
  assert.equal(context.isAuthorized(), false);
  f.clearSavedConsent();
  finish();
  await delay(50);
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.some(call => call.route === 'result'), false);
  assert.equal(f.calls.filter(call => call.route === 'pairing/complete' && call.action.action === 'authorize').length, 1);
});


test('并发页面抢先授权导致本页授权被拒时，不清除原永久意愿', async t => {
  let available = false;
  const f = fixture(t, { paired: true, permanent: 'write', resumeDelayMs: 5000,
    canConnect: () => available || '暂不可用', handle: request => {
      if (request.route === 'pairing/complete' && request.action.action === 'authorize')
        return json({ ok: false, code: 'page_in_use', error: '另一页面抢先授权' }, 409);
    } });
  const saved = structuredClone(f.consent());
  await until(() => /永久授权保留/u.test(f.document.querySelector('.mcp-status').textContent));
  available = true;
  f.input('本次授权时长').value = '900000';
  await f.button('重新授权').emit('click');
  assert.deepEqual(f.consent(), saved);
  assert.equal(f.panel.connected, false);
});
