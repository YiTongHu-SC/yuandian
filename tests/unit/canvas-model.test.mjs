import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_KEY, VERSION, LIMITS, createWorkspace, createBoard, createNode, connect, createSibling, deleteNode, validateWorkspace, parseImport, importAppend, load, save, exportJSON } from '../../src/canvas/model.js';

const copy = value => JSON.parse(JSON.stringify(value));
function storage(raw = null) {
  const values = new Map(raw === null ? [] : [[CANVAS_KEY, raw]]);
  return {
    calls: [],
    getItem(key) { this.calls.push(['get', key]); return values.get(key) ?? null; },
    setItem(key, value) { this.calls.push(['set', key]); values.set(key, value); },
  };
}

test('new workspace is a valid editable canvas without prescribed structure', () => {
  const workspace = createWorkspace(), board = workspace.boards[0];
  assert.equal(workspace.version, VERSION);
  assert.equal(workspace.activeId, board.id);
  assert.equal(board.nodes.length, 1);
  assert.equal(board.nodes[0].text, '');
  assert.deepEqual(board.view, { x: 0, y: 0, scale: 1 });
  assert.equal(validateWorkspace(workspace).ok, true);
});

test('new blank card survives save and load without adding placeholder content', () => {
  const workspace = createWorkspace(), local = storage();
  const saved = save(local, workspace, null);
  assert.equal(saved.ok, true);
  const restored = load(local);
  assert.equal(restored.status, 'loaded');
  assert.deepEqual(restored.workspace, workspace);
  assert.equal(restored.workspace.boards[0].nodes[0].text, '');
});

test('existing v1 starter text and graph survive load, export and append without rewriting storage', () => {
  const legacy = {
    version: 1,
    activeId: 'board-legacy',
    boards: [{
      id: 'board-legacy',
      title: '原有问题与想法',
      createdAt: '2026-10-17T09:00:00.000Z',
      updatedAt: '2026-10-17T10:00:00.000Z',
      nodes: [
        { id: 'node-legacy-root', text: '我想想清楚的问题', x: -160.5, y: 80, color: 'green' },
        { id: 'node-legacy-child', text: '原有第二张卡\n保留原文', x: 240, y: -95.25, color: 'rose' }
      ],
      edges: [{ id: 'edge-legacy', from: 'node-legacy-root', to: 'node-legacy-child', label: '原有联系' }],
      view: { x: 135, y: -42.5, scale: 1.25 }
    }]
  };
  const originalRaw = JSON.stringify(legacy), local = storage(originalRaw);
  assert.equal(CANVAS_KEY, 'yitong.thinking-canvas.v1');
  assert.equal(VERSION, 1);
  const loaded = load(local);
  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(loaded.workspace, legacy);
  const exported = exportJSON(loaded.workspace);
  assert.deepEqual(JSON.parse(exported), legacy);

  // Import back into the same workspace to also exercise identity collisions.
  const appended = importAppend(loaded.workspace, exported);
  assert.equal(appended.ok, true);
  assert.deepEqual(appended.workspace.boards[0], legacy.boards[0]);
  const imported = appended.workspace.boards[1], original = legacy.boards[0];
  assert.notEqual(imported.id, original.id);
  assert.equal(imported.title, original.title);
  assert.equal(imported.createdAt, original.createdAt);
  assert.equal(imported.updatedAt, original.updatedAt);
  assert.deepEqual(imported.view, original.view);
  assert.deepEqual(imported.nodes.map(({ id, ...content }) => content), original.nodes.map(({ id, ...content }) => content));
  assert.notEqual(imported.nodes[0].id, original.nodes[0].id);
  assert.notEqual(imported.nodes[1].id, original.nodes[1].id);
  assert.equal(imported.edges[0].from, imported.nodes[0].id);
  assert.equal(imported.edges[0].to, imported.nodes[1].id);
  assert.equal(imported.edges[0].label, original.edges[0].label);
  assert.equal(appended.workspace.activeId, imported.id);
  assert.deepEqual(loaded.workspace, legacy);
  assert.equal(JSON.stringify(legacy), originalRaw);
  assert.equal(local.getItem(CANVAS_KEY), originalRaw);
  assert.equal(local.calls.some(([call]) => call === 'set'), false);
});

test('connect supports free graph relationships but rejects invalid links', () => {
  const board = createBoard(), [a] = board.nodes;
  const b = createNode('第二个想法', 200, 40), c = createNode('第三个想法', -150, 80);
  board.nodes.push(b, c);
  assert.equal(connect(board, a.id, a.id), null);
  assert.equal(connect(board, a.id, 'missing'), null);
  assert.ok(connect(board, a.id, b.id));
  assert.equal(connect(board, a.id, b.id), null);
  assert.ok(connect(board, b.id, a.id));
  assert.ok(connect(board, b.id, c.id));
  assert.ok(connect(board, c.id, a.id));
  assert.equal(parseImport(board).ok, true);
});

test('siblings of independent cards stay independent and inherit only color', () => {
  const board = createBoard(), source = board.nodes[0];
  source.text = '已有内容'; source.color = 'rose';
  const child = createNode('下一级', 300, 100);
  board.nodes.push(child); connect(board, source.id, child.id);
  const sibling = createSibling(board, source.id, -90, 200);
  assert.deepEqual(sibling, { id: sibling.id, text: '', x: -90, y: 200, color: 'rose' });
  assert.equal(board.nodes.at(-1), sibling);
  assert.deepEqual(board.edges.map(edge => [edge.from, edge.to]), [[source.id, child.id]]);
  assert.deepEqual(parseImport(exportJSON(board)).value.boards[0], board);
});

test('siblings share every incoming parent through multi-parent and circular relationships', () => {
  const board = createBoard(), source = board.nodes[0];
  const first = createNode('父卡片一', -300, 0), second = createNode('父卡片二', -300, 200);
  board.nodes.push(first, second);
  connect(board, first.id, source.id); connect(board, second.id, source.id);
  connect(board, source.id, first.id);
  const original = copy(board), sibling = createSibling(board, source.id, 0, 240);
  assert.deepEqual(board.edges.slice(0, original.edges.length), original.edges);
  assert.deepEqual(board.edges.slice(original.edges.length).map(edge => [edge.from, edge.to]),
    [[first.id, sibling.id], [second.id, sibling.id]]);
  const imported = importAppend(createWorkspace(), exportJSON(board));
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.workspace.boards[1], board);
  assert.equal(Object.hasOwn(sibling, 'level'), false);
});

test('sibling creation deduplicates incoming parents before adding their new links', () => {
  const board = createBoard(), source = board.nodes[0], parent = createNode();
  board.nodes.push(parent);
  const edge = connect(board, parent.id, source.id);
  board.edges.push({ ...edge, id: 'duplicate-parent' });
  const sibling = createSibling(board, source.id, 0, 200);
  assert.equal(board.edges.filter(edge => edge.to === sibling.id).length, 1);
});

test('sibling creation refuses node and edge capacity overflow without partial changes', () => {
  const fullNodes = createBoard();
  while (fullNodes.nodes.length < LIMITS.nodes) fullNodes.nodes.push(createNode());
  const nodesBefore = copy(fullNodes);
  assert.equal(createSibling(fullNodes, fullNodes.nodes[0].id, 0, 0), null);
  assert.deepEqual(fullNodes, nodesBefore);

  const fullEdges = createBoard(), source = fullEdges.nodes[0];
  for (let i = 0; i < 26; i++) fullEdges.nodes.push(createNode());
  connect(fullEdges, fullEdges.nodes[1].id, source.id);
  connect(fullEdges, fullEdges.nodes[2].id, source.id);
  for (const from of fullEdges.nodes.slice(1)) {
    for (const to of fullEdges.nodes.slice(1)) {
      if (fullEdges.edges.length < LIMITS.edges - 1) connect(fullEdges, from.id, to.id);
    }
  }
  assert.equal(fullEdges.edges.length, LIMITS.edges - 1);
  const edgesBefore = copy(fullEdges);
  assert.equal(createSibling(fullEdges, source.id, 0, 200), null);
  assert.deepEqual(fullEdges, edgesBefore);
});

test('sibling creation fits exact edge capacity and validates positions before mutating', () => {
  const board = createBoard(), source = board.nodes[0], parent = createNode();
  board.nodes.push(parent); connect(board, parent.id, source.id);
  const before = copy(board);
  assert.equal(createSibling(board, 'missing', 0, 0), null);
  assert.throws(() => createSibling(board, source.id, Infinity, 0), TypeError);
  assert.throws(() => createSibling(board, source.id, 0, LIMITS.coordinate + 1), TypeError);
  assert.deepEqual(board, before);
  for (let i = 0; i < 24; i++) board.nodes.push(createNode());
  for (const from of board.nodes.slice(1)) {
    for (const to of board.nodes.slice(1)) {
      if (board.edges.length < LIMITS.edges - 1) connect(board, from.id, to.id);
    }
  }
  assert.equal(board.edges.length, LIMITS.edges - 1);
  assert.ok(createSibling(board, source.id, 0, 200));
  assert.equal(board.edges.length, LIMITS.edges);
  assert.equal(parseImport(board).ok, true);
});

test('node deletion removes only its incoming and outgoing links', () => {
  const board = createBoard(), a = board.nodes[0], b = createNode(), c = createNode();
  board.nodes.push(b, c);
  connect(board, a.id, b.id); connect(board, b.id, c.id); connect(board, a.id, c.id);
  assert.equal(deleteNode(board, b.id), true);
  assert.equal(board.nodes.length, 2);
  assert.deepEqual(board.edges.map(e => [e.from, e.to]), [[a.id, c.id]]);
  assert.equal(deleteNode(board, 'missing'), false);
  deleteNode(board, a.id); deleteNode(board, c.id);
  assert.equal(parseImport(board).ok, true);
});

test('JSON roundtrip preserves text, geometry, edge label and viewport', () => {
  const workspace = createWorkspace(), b = workspace.boards[0];
  const second = createNode('<script>不能执行</script>\n第一行 → 第二行', -201.25, 300, 'blue');
  b.nodes.push(second);
  connect(b, b.nodes[0].id, second.id).label = '因为？\n待验证';
  b.view = { x: -20.5, y: 60, scale: .8 };
  assert.deepEqual(parseImport(exportJSON(workspace)).value, workspace);
  assert.equal(parseImport(exportJSON(b)).value.boards[0].nodes[1].text, second.text);
});

test('validation rejects missing fields, bad types, nonfinite geometry and invalid references', () => {
  const mutate = fn => { const w = createWorkspace(); fn(w, w.boards[0]); assert.equal(validateWorkspace(w).ok, false); };
  mutate(w => { w.version = 2; });
  mutate(w => { delete w.activeId; });
  mutate((w, b) => { w.activeId = 'missing'; });
  mutate((w, b) => { b.nodes[0].text = 1; });
  mutate((w, b) => { b.nodes[0].x = NaN; });
  mutate((w, b) => { b.nodes[0].y = Infinity; });
  mutate((w, b) => { b.nodes[0].x = LIMITS.coordinate + 1; });
  mutate((w, b) => { b.nodes[0].color = 'purple'; });
  mutate((w, b) => { b.view.scale = .19; });
  mutate((w, b) => { b.view.scale = 2.51; });
  mutate((w, b) => { b.createdAt = 'invalid-date'; });
  mutate((w, b) => { b.edges.push({ id: 'edge', from: b.nodes[0].id, to: 'missing', label: '' }); });
});

test('duplicate identities, self links, and parallel same-direction links are invalid', () => {
  const base = createWorkspace(), b = base.boards[0], second = createNode();
  b.nodes.push(second); connect(b, b.nodes[0].id, second.id);
  const check = fn => { const w = copy(base); fn(w, w.boards[0]); assert.equal(validateWorkspace(w).ok, false); };
  check((w, b) => b.nodes.push(copy(b.nodes[0])));
  check((w, b) => b.edges.push({ ...b.edges[0], id: 'other-edge' }));
  check((w, b) => { b.edges[0].to = b.edges[0].from; });
  check(w => w.boards.push(copy(w.boards[0])));
});

test('validation is bounded and permits blank text and a completely empty workspace', () => {
  const b = createBoard(''); b.nodes[0].text = '';
  assert.equal(parseImport(b).ok, true);
  assert.equal(validateWorkspace({ version: 1, activeId: null, boards: [] }).ok, true);
  assert.equal(parseImport({ ...b, title: 'x'.repeat(201) }).ok, false);
  assert.equal(parseImport({ ...b, nodes: [{ ...b.nodes[0], text: 'x'.repeat(10001) }] }).ok, false);
  assert.equal(parseImport({ ...b, nodes: Array.from({ length: 301 }, () => createNode()) }).ok, false);
  assert.equal(parseImport(' '.repeat(LIMITS.chars + 1)).ok, false);
  assert.equal(parseImport('{invalid').ok, false);
});

test('validation discards unknown fields and cannot pollute object prototypes', () => {
  const w = createWorkspace();
  const raw = JSON.stringify(w).replace('"version":1', '"version":1,"__proto__":{"canvasPolluted":true},"extra":42');
  const result = parseImport(raw);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.value, '__proto__'), false);
  assert.equal(Object.hasOwn(result.value, 'extra'), false);
  assert.equal({}.canvasPolluted, undefined);
});

test('append import keeps originals untouched and remaps collisions and edge endpoints', () => {
  const original = createWorkspace(), b = original.boards[0], next = createNode('第二项');
  b.nodes.push(next); connect(b, b.nodes[0].id, next.id);
  const before = JSON.stringify(original), incoming = copy(original), incomingBefore = JSON.stringify(incoming);
  const result = importAppend(original, incoming);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(original), before);
  assert.equal(JSON.stringify(incoming), incomingBefore);
  const appended = result.workspace.boards[1];
  assert.notEqual(appended.id, b.id);
  assert.notEqual(appended.nodes[0].id, b.nodes[0].id);
  assert.equal(appended.edges[0].from, appended.nodes[0].id);
  assert.equal(appended.edges[0].to, appended.nodes[1].id);
  assert.notEqual(appended.edges[0].id, b.edges[0].id);
  assert.equal(result.workspace.activeId, appended.id);
  assert.deepEqual(result.importedIds, [appended.id]);
  assert.equal(validateWorkspace(result.workspace).ok, true);
});

test('append preserves fresh identities and refuses invalid or oversized imports atomically', () => {
  const existing = createWorkspace(), incoming = createBoard('新问题');
  const result = importAppend(existing, incoming);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.boards[1].id, incoming.id);
  const full = { version: 1, activeId: null, boards: Array.from({ length: 40 }, () => createBoard()) };
  full.activeId = full.boards[0].id;
  const before = JSON.stringify(full);
  assert.equal(importAppend(full, incoming).ok, false);
  assert.equal(JSON.stringify(full), before);
  assert.equal(importAppend(existing, '{broken').ok, false);
  assert.equal(existing.boards.length, 1);
});

test('load never writes and ignores the earlier six-step storage key', () => {
  const empty = storage();
  assert.equal(load(empty).status, 'empty');
  assert.deepEqual(empty.calls, [['get', CANVAS_KEY]]);
  const source = createWorkspace(), valid = storage(exportJSON(source));
  assert.deepEqual(load(valid).workspace, source);
  assert.equal(valid.calls.some(([call]) => call === 'set'), false);
  const broken = storage('{broken');
  const loaded = load(broken);
  assert.equal(loaded.status, 'invalid');
  assert.equal(loaded.raw, '{broken');
  assert.equal(broken.calls.some(([call]) => call === 'set'), false);
});

test('save preserves corrupt data and detects cross-tab changes before writing', () => {
  const w = createWorkspace(), empty = storage();
  const first = save(empty, w, null);
  assert.equal(first.ok, true);
  assert.equal(first.status, 'saved');
  const other = createWorkspace(), remote = save(empty, other, first.raw);
  assert.equal(remote.ok, true);
  const conflict = save(empty, w, first.raw);
  assert.equal(conflict.status, 'conflict');
  assert.equal(empty.getItem(CANVAS_KEY), remote.raw);
  const broken = storage('corrupt');
  assert.equal(save(broken, w, 'corrupt').status, 'blocked');
  assert.equal(broken.getItem(CANVAS_KEY), 'corrupt');
});

test('save reports storage denial and quota failure without losing in-memory data', () => {
  const w = createWorkspace(), before = JSON.stringify(w);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const quota = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  assert.equal(load(denied).status, 'unavailable');
  assert.equal(save(denied, w).status, 'unavailable');
  assert.equal(save(quota, w).status, 'unavailable');
  assert.equal(JSON.stringify(w), before);
});

test('save validates before touching storage, and exports cannot bypass validation', () => {
  const s = storage(), w = createWorkspace(); w.boards[0].nodes[0].x = 'zero';
  assert.equal(save(s, w).status, 'invalid');
  assert.deepEqual(s.calls, []);
  assert.throws(() => exportJSON(w), TypeError);
});
