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

function fixture(t, { handle, listCanvases, readCanvas, editCanvas, createCanvas, exportCanvas, clipboard, remote = true } = {}) {
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
    scope: 'workspace',
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
    pairing: false,
    getCanvas: () => current,
    canConnect: () => true,
    listCanvases: listCanvases || (async () => ({ ok: true, activeId: current.id, boards: [current] })),
    readCanvas: readCanvas || (async () => ({ ok: true, board: current })),
    editCanvas: editCanvas || (async () => ({ ok: true })),
    createCanvas: createCanvas || (async () => ({ ok: true })),
    exportCanvas: exportCanvas || (async () => ({ ok: true, json: '{}' })),
    connection: {
      available: true,
      remote,
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

test('开启一次授权全部画布，开启途中切换画布也不撤销', async t => {
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
  assert.equal(f.panel.authorized, true);
  f.changeBoard('board-b');
  response.resolve(json(opened));
  await start;
  assert.equal(f.panel.connected, true);
  assert.notEqual(f.config.value, '');
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 0);
  const body = f.calls.find(call => call.route === 'session').body;
  assert.deepEqual(Object.keys(body).sort(), ['durationMs', 'mode', 'pageId', 'scope']);
  assert.equal(body.durationMs, 3600000);
  assert.equal(body.scope, 'workspace');
  assert.match(body.pageId, /^[a-f0-9-]{36}$/u);
  assert.equal(f.document.querySelector('.mcp-scope').textContent, '授权范围：当前浏览器、当前站点的全部画布');
});

test('本机同样绑定页面实例，主动撤销后迟到授权不能复活', async t => {
  const response = deferred();
  let opened;
  const f = fixture(t, { remote: false, handle: request => {
    if (request.route === 'session') {
      opened = request.opened();
      return response.promise;
    }
  } });
  const start = f.button('开启接入').emit('click');
  assert.equal(f.panel.authorized, true);
  await f.panel.disconnect();
  response.resolve(json(opened));
  await start;
  assert.equal(f.panel.authorized, false);
  assert.equal(f.panel.connected, false);
  assert.equal(f.config.value, '');
  assert.equal(f.calls.filter(call => call.route === 'poll').length, 0);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 1);
  assert.match(f.calls.find(call => call.route === 'session').body.pageId, /^[a-f0-9-]{36}$/u);
});

test('本机永久授权仍约束在途写入，断开后不能保存或回传', async t => {
  const response = deferred();
  let context;
  let delivered = false;
  const f = fixture(t, { remote: false, handle: request => {
    if (request.route === 'session') return json({ ...request.opened(), expiresAt: null });
    if (request.route === 'poll' && !delivered) {
      delivered = true;
      return json({ requestId: 'permanent-edit', tool: 'edit_canvas', arguments: {}, expiresAt: Date.now() + 10000 });
    }
  }, editCanvas: async (args, received) => { context = received; await response.promise; return { ok: received.isAuthorized() }; } });
  f.document.querySelector('#mcp-duration').value = 'null';
  f.document.querySelector('#mcp-permission').value = 'write';
  await f.button('开启接入').emit('click');
  await until(() => context);
  assert.equal(f.calls.find(call => call.route === 'session').body.durationMs, null);
  assert.equal(f.panel.connected, true);
  assert.equal(context.isAuthorized(), true);
  assert.match(f.document.querySelector('.mcp-status').textContent, /永久（直到断开）/u);
  await f.button('断开接入').emit('click');
  assert.equal(context.isAuthorized(), false);
  response.resolve();
  await delay(15);
  assert.equal(f.calls.some(call => call.route === 'result'), false);
  assert.equal(f.document.querySelector('#mcp-permission').value, 'read');
});

test('本机十五分钟授权不能被响应扩大为一小时或永久', async t => {
  let expiresAt = Date.now() + 3600000;
  const f = fixture(t, { remote: false, handle: request => {
    if (request.route === 'session') return json({ ...request.opened(), expiresAt });
  } });
  f.document.querySelector('#mcp-duration').value = '900000';
  await f.button('开启接入').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.find(call => call.route === 'session').body.durationMs, 900000);
  expiresAt = null;
  await f.button('开启接入').emit('click');
  assert.equal(f.panel.connected, false);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 2);
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

test('切换画布后可按显式 ID 编辑原画布，授权检查不绑定当前画布', async t => {
  const edited = deferred();
  let polls = 0;
  let authorized;
  let received;
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && ++polls === 1)
        return json({ requestId: 'target-a', tool: 'edit_canvas', arguments: { boardId: 'board-a', operations: [] }, expiresAt: Date.now() + 10000 });
    },
    editCanvas: (args, context) => {
      received = args;
      authorized = context.isAuthorized;
      return edited.promise;
    }
  });
  f.document.querySelector('#mcp-permission').value = 'write';
  await f.button('开启接入').emit('click');
  await until(() => authorized);
  f.changeBoard('board-b');
  assert.equal(authorized(), true);
  edited.resolve({ ok: true, revision: '3'.repeat(64) });
  await until(() => f.calls.some(call => call.route === 'result'));
  assert.deepEqual(received, { boardId: 'board-a', operations: [] });
  assert.equal(f.panel.connected, true);
  assert.equal(f.calls.filter(call => call.route === 'disconnect').length, 0);
});

test('读取、列举与导出均收到目标参数和可撤销授权，导出不需要写权限', async t => {
  const requests = [
    { requestId: 'list', tool: 'list_canvases', arguments: {} },
    { requestId: 'read', tool: 'get_canvas', arguments: { boardId: 'board-a' } },
    { requestId: 'export', tool: 'export_canvas', arguments: { boardId: 'board-b' } }
  ];
  const received = [];
  const contexts = [];
  const handler = name => async (args, context) => {
    received.push({ name, args });
    contexts.push(context);
    assert.equal(context.isAuthorized(), true);
    return { ok: true };
  };
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && requests.length)
        return json({ ...requests.shift(), expiresAt: Date.now() + 10000 });
    },
    listCanvases: handler('list'),
    readCanvas: handler('read'),
    exportCanvas: handler('export')
  });
  await f.button('开启接入').emit('click');
  await until(() => f.calls.filter(call => call.route === 'result').length === 3);
  assert.deepEqual(received, [
    { name: 'list', args: {} },
    { name: 'read', args: { boardId: 'board-a' } },
    { name: 'export', args: { boardId: 'board-b' } }
  ]);
  await f.panel.disconnect();
  assert.equal(contexts.every(context => !context.isAuthorized()), true);
});

test('创建画布复用读写授权，回执重试不重复创建且新增后接入仍有效', async t => {
  let created = 0;
  let polls = 0;
  let acknowledgements = 0;
  const pending = { requestId: 'create-once', tool: 'create_canvas', arguments: { title: '虚构新增画布' }, expiresAt: Date.now() + 10000 };
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && ++polls <= 2) return json(pending);
      if (request.route === 'result' && ++acknowledgements === 1)
        throw new TypeError('模拟回执丢失');
    },
    createCanvas: async (args, context) => {
      assert.equal(args.title, '虚构新增画布');
      assert.equal(context.isAuthorized(), true);
      created += 1;
      f.changeBoard('new-board');
      assert.equal(context.isAuthorized(), true);
      return { ok: true, board: { id: 'new-board' } };
    }
  });
  f.document.querySelector('#mcp-permission').value = 'write';
  await f.button('开启接入').emit('click');
  await until(() => acknowledgements === 2);
  assert.equal(created, 1);
  assert.equal(f.panel.connected, true);
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

test('默认只读在浏览器侧拒绝新增画布', async t => {
  let delivered = false;
  let created = 0;
  const f = fixture(t, {
    handle: request => {
      if (request.route === 'poll' && !delivered) {
        delivered = true;
        return json({ requestId: 'read-only-create', tool: 'create_canvas', arguments: { title: '不应创建' }, expiresAt: Date.now() + 10000 });
      }
    },
    createCanvas: async () => { created += 1; }
  });
  await f.button('开启接入').emit('click');
  await until(() => f.calls.some(call => call.route === 'result'));
  assert.equal(created, 0);
  assert.equal(f.calls.find(call => call.route === 'result').body.result.code, 'READ_ONLY');
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

test('旧版单画布授权响应不得升级为全画布授权', async t => {
  const f = fixture(t, { handle: request => {
    if (request.route === 'session') {
      const opened = request.opened();
      delete opened.scope;
      return json({ ...opened, boardId: 'board-a' });
    }
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
