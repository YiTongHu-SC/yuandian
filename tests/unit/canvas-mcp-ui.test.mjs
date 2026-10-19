import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpPanel } from '../../src/canvas/mcp-ui.js';
import { REMOTE_MCP_URL } from '../../src/canvas/mcp-connection.js';

// This small DOM substitute exercises authorization and asynchronous control
// flow. It does not verify rendering, browser storage or real page interactions.
class Element {
  constructor(tag, document) {
    this.tag = tag;
    this.document = document;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.className = '';
    this.classList = { toggle() {} };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) {
    this.children.push(...children);
    if (this.tag === 'select' && !this.value)
      this.value = this.children[0]?.attributes.value || '';
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name) { return this.listeners.get(name)?.(); }
  contains(target) {
    return target === this || this.children.some(child => child.contains(target));
  }
  focus() { this.document.activeElement = this; }
  select() { this.selected = true; }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('异步面板操作没有在预期时间内完成。');
}

function fixture(t, { handle, readCanvas, editCanvas, clipboard } = {}) {
  const originals = new Map();
  const nodes = [];
  const document = {
    createElement(tag) {
      const node = new Element(tag, document);
      nodes.push(node);
      return node;
    },
    querySelector(selector) {
      return nodes.find(node => selector.startsWith('#')
        ? node.attributes.id === selector.slice(1)
        : node.className.split(' ').includes(selector.slice(1)));
    }
  };
  document.body = document.createElement('body');
  document.activeElement = document.body;
  document.createElement('main').className = 'stage-wrap';
  document.createElement('button').setAttribute('id', 'ai-menu-toggle');
  const window = new Element('window', document);
  const calls = [];
  let current = { id: 'board-a', title: '虚构画布' };
  let pageId;
  const ownerToken = '1'.repeat(64);
  const clientToken = '2'.repeat(64);
  const opened = () => ({
    ownerToken,
    clientToken,
    boardId: current.id,
    mode: document.querySelector('#mcp-permission').value,
    pageId,
    expiresAt: Date.now() + 60000,
    config: { url: REMOTE_MCP_URL, headers: { Authorization: `Bearer ${clientToken}` } }
  });
  const fetch = async (url, options) => {
    const route = url.split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ route, body, options });
    if (route === 'session') pageId = body.pageId;
    const custom = await handle?.({ route, body, options, opened });
    if (custom !== undefined) return custom;
    if (route === 'session') return json(opened());
    if (route === 'poll') return waitForAbort(options.signal);
    return json({ ok: true });
  };
  for (const [key, value] of Object.entries({
    document,
    window,
    fetch,
    navigator: { clipboard: clipboard || { writeText: async () => {} } }
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const panel = createMcpPanel({
    getCanvas: () => current,
    canConnect: () => true,
    readCanvas: readCanvas || (async () => ({ ok: true, board: current })),
    editCanvas: editCanvas || (async () => ({ ok: true })),
    connection: {
      available: true,
      remote: true,
      apiBase: 'https://stellarcore.games/yuandian-mcp/api/mcp',
      pollDelayMs: 0,
      requestTimeoutMs: 35000
    }
  });
  t.after(async () => {
    await panel.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    panel,
    calls,
    document,
    window,
    changeBoard: id => { current = { id, title: '虚构另一画布' }; },
    button: text => nodes.find(node => node.tag === 'button' && node.textContent === text),
    config: nodes.find(node => node.tag === 'textarea'),
    details: nodes.find(node => node.tag === 'details')
  };
}

test('尚在开启时切换画布会撤销，迟到的授权响应不能在切回后复活', async t => {
  const response = deferred();
  let opened;
  const f = fixture(t, { handle: request => {
    if (request.route === 'session') {
      opened = request.opened();
      return response.promise;
    }
  } });
  f.document.querySelector('#mcp-permission').value = 'write';
  const start = f.button('开启接入').emit('click');
  assert.equal(f.panel.boardId, 'board-a');
  f.changeBoard('board-b');
  await f.panel.disconnect('已切换画布');
  f.changeBoard('board-a');
  response.resolve(json(opened));
  await start;
  assert.equal(f.panel.connected, false);
  assert.equal(f.panel.boardId, null);
  assert.equal(f.config.value, '');
  assert.equal(f.document.querySelector('#mcp-permission').value, 'read');
  assert.equal(f.calls.filter(call => call.route === 'poll').length, 0);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 1);
});

test('异步读取途中 pagehide 撤销，读取完成也不向中继回传画布', async t => {
  const read = deferred();
  let reading = false;
  let delivered = false;
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && !delivered) {
        delivered = true;
        return json({ requestId: 'read-once', tool: 'get_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
      }
    },
    readCanvas: () => { reading = true; return read.promise; }
  });
  await f.button('开启接入').emit('click');
  assert.equal(f.details.open, false);
  await until(() => reading);
  f.window.emit('pagehide');
  read.resolve({ ok: true, board: { id: 'board-a', nodes: [{ text: '虚构私有内容' }] } });
  await delay(10);
  assert.equal(f.panel.connected, false);
  assert.equal(f.config.value, '');
  assert.equal(f.calls.filter(call => call.route === 'result').length, 0);
  assert.equal(f.calls.find(call => call.route === 'disconnect').options.keepalive, true);
});

test('读写结果回执丢失后只重传结果，不重复执行同一批编辑', async t => {
  let edits = 0;
  let polls = 0;
  let acknowledgements = 0;
  let authorized;
  const pending = { requestId: 'edit-once', tool: 'edit_canvas', arguments: { operations: [] }, expiresAt: Date.now() + 10000 };
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && ++polls <= 2) return json(pending);
      if (request.route === 'result' && ++acknowledgements === 1) throw new TypeError('模拟回执丢失');
    },
    editCanvas: async (args, context) => {
      authorized = context.isAuthorized;
      assert.equal(authorized(), true);
      edits += 1;
      return { ok: true, revision: '3'.repeat(64) };
    }
  });
  f.document.querySelector('#mcp-permission').value = 'write';
  await f.button('开启接入').emit('click');
  await until(() => acknowledgements === 2);
  assert.equal(edits, 1);
  const results = f.calls.filter(call => call.route === 'result');
  assert.deepEqual(results[0].body, results[1].body);
  await f.panel.disconnect();
  assert.equal(authorized(), false);
  assert.equal(f.calls.every(call => call.options.redirect === 'error'), true);
  assert.equal(f.calls.every(call => call.options.credentials === 'omit'), true);
});

test('默认只读在浏览器侧也拒绝编辑，配置复制失败时展开后选择文本', async t => {
  let edits = 0;
  let delivered = false;
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && !delivered) {
        delivered = true;
        return json({ requestId: 'read-only', tool: 'edit_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
      }
    },
    editCanvas: async () => { edits += 1; },
    clipboard: { writeText: async () => { throw new Error('剪贴板不可用'); } }
  });
  await f.button('开启接入').emit('click');
  await until(() => f.calls.some(call => call.route === 'result'));
  assert.equal(edits, 0);
  assert.equal(f.calls.find(call => call.route === 'result').body.result.code, 'READ_ONLY');
  await f.button('复制配置').emit('click');
  assert.equal(f.details.open, true);
  assert.equal(f.config.selected, true);
  assert.equal(f.document.activeElement, f.config);
});

test('服务返回其他页面的授权时拒绝配置，并立即请求撤销', async t => {
  const f = fixture(t, { handle: request => {
    if (request.route === 'session')
      return json({ ...request.opened(), pageId: 'another-page' });
  } });
  await f.button('开启接入').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.config.value, '');
  assert.equal(f.calls.filter(call => call.route === 'poll').length, 0);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 1);
});

test('收起面板仍可保持授权，绝对到期会中止长轮询并清除配置', async t => {
  const f = fixture(t, { handle: request => {
    if (request.route === 'session')
      return json({ ...request.opened(), expiresAt: Date.now() + 200 });
  } });
  await f.button('开启接入').emit('click');
  await until(() => f.calls.some(call => call.route === 'poll'));
  f.panel.close();
  assert.equal(f.panel.connected, true);
  assert.notEqual(f.config.value, '');
  const signal = f.calls.find(call => call.route === 'poll').options.signal;
  assert.equal(signal.aborted, false);
  await until(() => !f.panel.connected);
  assert.equal(signal.aborted, true);
  assert.equal(f.config.value, '');
  assert.equal(f.document.querySelector('#mcp-permission').value, 'read');
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 1);
});
