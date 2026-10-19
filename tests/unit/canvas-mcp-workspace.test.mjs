import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LIMITS,
  createBoard,
  createNode,
  createWorkspace,
  importAppend,
  parseImport,
  validateWorkspace
} from '../../src/canvas/model.js';
import { MCP_EDIT_SCHEMA, revisionOf } from '../../src/canvas/mcp-model.js';
import {
  MCP_CREATE_SCHEMA,
  MCP_EXPORT_SCHEMA,
  MCP_GET_SCHEMA,
  MCP_LIST_SCHEMA,
  MCP_WORKSPACE_EDIT_SCHEMA,
  applyMcpWorkspaceEdits,
  createMcpCanvas,
  exportMcpCanvas,
  getMcpCanvas,
  listMcpCanvases,
  workspaceRevisionOf
} from '../../src/canvas/mcp-workspace-model.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
function workspaceWithTwoBoards() {
  const workspace = createWorkspace();
  workspace.boards[0].title = '第一个画布';
  workspace.boards.push(createBoard('第二个画布'));
  return workspace;
}
async function create(workspace, args = {}) {
  return createMcpCanvas(workspace, {
    expectedWorkspaceRevision: await workspaceRevisionOf(workspace),
    ...args
  });
}

test('workspace schemas require explicit write target and preserve the legacy board-only schema', () => {
  for (const schema of [
    MCP_LIST_SCHEMA,
    MCP_GET_SCHEMA,
    MCP_WORKSPACE_EDIT_SCHEMA,
    MCP_CREATE_SCHEMA,
    MCP_EXPORT_SCHEMA
  ])
    assert.equal(schema.additionalProperties, false);
  assert.deepEqual(MCP_WORKSPACE_EDIT_SCHEMA.required, [
    'boardId', 'expectedRevision', 'operations'
  ]);
  assert.deepEqual(MCP_EDIT_SCHEMA.required, ['expectedRevision', 'operations']);
  assert.equal(MCP_EDIT_SCHEMA.properties.boardId, undefined);
  assert.deepEqual(MCP_CREATE_SCHEMA.required, ['expectedWorkspaceRevision']);
});

test('workspace revision excludes selection, viewport, timestamps and unknown fields', async () => {
  const workspace = workspaceWithTwoBoards();
  const revision = await workspaceRevisionOf(workspace);
  assert.equal(
    revision,
    createHash('sha256')
      .update(JSON.stringify(workspace.boards.map(({ id, title, nodes, edges }) => ({
        id, title, nodes, edges
      }))))
      .digest('hex')
  );
  workspace.activeId = workspace.boards[1].id;
  workspace.boards[0].view.x = 500;
  workspace.boards[0].updatedAt = '2020-01-01T00:00:00.000Z';
  workspace.extra = { token: 'not workspace data' };
  workspace.boards[0].extra = 'ignored';
  assert.equal(await workspaceRevisionOf(workspace), revision);
  workspace.boards[0].nodes[0].text = '内容变化';
  assert.notEqual(await workspaceRevisionOf(workspace), revision);
  await assert.rejects(workspaceRevisionOf({}), TypeError);
});

test('adding, removing, reordering, renaming and replacing a board change the workspace revision', async () => {
  const workspace = workspaceWithTwoBoards();
  const revision = await workspaceRevisionOf(workspace);
  for (const change of [
    (value) => value.boards.push(createBoard()),
    (value) => value.boards.pop(),
    (value) => value.boards.reverse(),
    (value) => { value.boards[1].title = '改名'; },
    (value) => { value.boards[1].id = 'replacement-id'; }
  ]) {
    const changed = copy(workspace);
    change(changed);
    assert.notEqual(await workspaceRevisionOf(changed), revision);
  }
});

test('list reveals metadata and versions, with no card text or mutable source references', async () => {
  const workspace = workspaceWithTwoBoards();
  workspace.boards[1].nodes[0].text = '不要放进列表的正文';
  const before = copy(workspace);
  const result = await listMcpCanvases(workspace);
  assert.equal(result.ok, true);
  assert.equal(result.activeId, workspace.activeId);
  assert.equal(result.workspaceRevision, await workspaceRevisionOf(workspace));
  assert.deepEqual(result.boards, await Promise.all(workspace.boards.map(async (board) => ({
    id: board.id,
    title: board.title,
    nodeCount: 1,
    edgeCount: 0,
    revision: await revisionOf(board)
  }))));
  assert.equal(JSON.stringify(result).includes('不要放进列表的正文'), false);
  result.boards[0].title = '客户端改动';
  assert.deepEqual(workspace, before);
});

test('reads default to the active board or an explicit other board and reject missing IDs', async () => {
  const workspace = workspaceWithTwoBoards();
  const active = await getMcpCanvas(workspace);
  const other = await getMcpCanvas(workspace, { boardId: workspace.boards[1].id });
  assert.deepEqual(active.board, workspace.boards[0]);
  assert.deepEqual(other.board, workspace.boards[1]);
  assert.equal(other.revision, await revisionOf(workspace.boards[1]));
  other.board.nodes[0].text = '副本';
  assert.equal(workspace.boards[1].nodes[0].text, '');
  assert.equal((await getMcpCanvas(workspace, { boardId: 'missing' })).code, 'canvas_not_found');
  assert.equal((await getMcpCanvas({ version: 1, activeId: null, boards: [] })).code, 'canvas_not_found');
});

test('cross-board edits use the explicit board even after active selection changes', async () => {
  const workspace = workspaceWithTwoBoards();
  const target = workspace.boards[1];
  const result = await applyMcpWorkspaceEdits(workspace, {
    boardId: target.id,
    expectedRevision: await revisionOf(target),
    operations: [{ op: 'create_card', text: '第二张画布的新卡片' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.boardId, target.id);
  assert.equal(result.workspace.activeId, workspace.activeId);
  assert.deepEqual(result.workspace.boards[0], workspace.boards[0]);
  assert.equal(result.workspace.boards[1].nodes[1].text, '第二张画布的新卡片');
  assert.equal(workspace.boards[1].nodes.length, 1);
  assert.equal(validateWorkspace(result.workspace).ok, true);
  workspace.activeId = target.id;
  assert.equal((await applyMcpWorkspaceEdits(workspace, {
    expectedRevision: await revisionOf(target),
    operations: [{ op: 'create_card' }]
  })).code, 'invalid_operation');
});

test('cross-board edits reject stale revisions, missing boards and invalid batches without mutation', async () => {
  const workspace = workspaceWithTwoBoards();
  const target = workspace.boards[1];
  const revision = await revisionOf(target);
  target.nodes[0].text = '用户已更新';
  const before = copy(workspace);
  const request = {
    boardId: target.id,
    expectedRevision: revision,
    operations: [{ op: 'create_card' }]
  };
  assert.equal((await applyMcpWorkspaceEdits(workspace, request)).code, 'revision_conflict');
  assert.equal((await applyMcpWorkspaceEdits(workspace, { ...request, boardId: 'missing' })).code, 'canvas_not_found');
  assert.equal((await applyMcpWorkspaceEdits(workspace, {
    ...request,
    expectedRevision: await revisionOf(target),
    operations: [{ op: 'create_card' }, { op: 'delete_card', id: 'missing' }]
  })).code, 'invalid_operation');
  assert.deepEqual(workspace, before);
});

test('create adds one blank board without changing the existing active board or v1 data', async () => {
  const workspace = workspaceWithTwoBoards();
  const before = copy(workspace);
  const oldRevision = await workspaceRevisionOf(workspace);
  const result = await create(workspace, { title: 'AI 新建画布' });
  assert.equal(result.ok, true);
  assert.deepEqual(workspace, before);
  assert.equal(result.workspace.version, 1);
  assert.equal(result.workspace.activeId, workspace.activeId);
  assert.deepEqual(result.workspace.boards.slice(0, 2), workspace.boards);
  assert.equal(result.board.title, 'AI 新建画布');
  assert.equal(result.board.nodes.length, 1);
  assert.equal(result.board.nodes[0].text, '');
  assert.equal(result.board.edges.length, 0);
  assert.equal(result.revision, await revisionOf(result.board));
  assert.equal(result.workspaceRevision, await workspaceRevisionOf(result.workspace));
  assert.notEqual(result.workspaceRevision, oldRevision);
  assert.equal(parseImport(result.workspace).ok, true);
  assert.equal((await create(workspace)).board.title, '未命名画布');
  assert.equal((await create(workspace, { title: '' })).board.title, '');
});

test('create accepts selection-only changes, but rejects stale workspace content', async () => {
  const workspace = workspaceWithTwoBoards();
  const revision = await workspaceRevisionOf(workspace);
  workspace.activeId = workspace.boards[1].id;
  assert.equal((await createMcpCanvas(workspace, { expectedWorkspaceRevision: revision })).ok, true);
  workspace.boards[0].nodes[0].text = '新的内容';
  const before = copy(workspace);
  const result = await createMcpCanvas(workspace, { expectedWorkspaceRevision: revision });
  assert.equal(result.code, 'revision_conflict');
  assert.deepEqual(workspace, before);
});

test('create works for empty imported workspaces and rejects board-count capacity atomically', async () => {
  const empty = { version: 1, activeId: null, boards: [] };
  const result = await create(empty);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.activeId, result.board.id);
  const full = createWorkspace();
  while (full.boards.length < LIMITS.boards) full.boards.push(createBoard());
  const before = copy(full);
  assert.equal((await create(full)).code, 'invalid_operation');
  assert.deepEqual(full, before);
});

test('whole-workspace size protects both creation and a valid board-only edit', async () => {
  const workspace = createWorkspace();
  const nodes = workspace.boards[0].nodes;
  while (JSON.stringify(workspace).length < LIMITS.chars - LIMITS.text)
    nodes.push(createNode('x'.repeat(LIMITS.text)));
  nodes[0].text = 'x'.repeat(LIMITS.chars - 10 - JSON.stringify(workspace).length);
  assert.equal(JSON.stringify(workspace).length, LIMITS.chars - 10);
  assert.equal(validateWorkspace(workspace).ok, true);
  const before = copy(workspace);
  assert.equal((await create(workspace)).code, 'invalid_operation');
  assert.equal((await applyMcpWorkspaceEdits(workspace, {
    boardId: workspace.activeId,
    expectedRevision: await revisionOf(workspace.boards[0]),
    operations: [{ op: 'create_card' }]
  })).code, 'invalid_operation');
  assert.deepEqual(workspace, before);
});

test('single and all exports round trip through the existing v1 append importer', () => {
  const workspace = workspaceWithTwoBoards();
  workspace.boards[0].title = '名字/不能:作文件名';
  workspace.boards[1].nodes[0].text = '<script>只作为文本</script>';
  const current = exportMcpCanvas(workspace);
  const explicit = exportMcpCanvas(workspace, { boardId: workspace.boards[1].id });
  const all = exportMcpCanvas(workspace, { all: true });
  assert.equal(current.ok, true);
  assert.equal(current.filename, '名字_不能_作文件名.json');
  assert.equal(current.mimeType, 'application/json');
  assert.equal(typeof current.json, 'string');
  assert.deepEqual(parseImport(current.json).value.boards, [workspace.boards[0]]);
  assert.deepEqual(parseImport(explicit.json).value.boards, [workspace.boards[1]]);
  assert.equal(all.filename, '原点-所有画布.json');
  assert.deepEqual(parseImport(all.json).value, workspace);
  const appended = importAppend(workspace, all.json);
  assert.equal(appended.ok, true);
  assert.equal(appended.workspace.boards.length, 4);
  assert.equal(appended.workspace.boards[3].nodes[0].text, '<script>只作为文本</script>');
});

test('MCP export filenames avoid Windows device names without changing the backed-up title or content', () => {
  const workspace = createWorkspace();
  const board = workspace.boards[0];
  board.nodes[0].text = '文件名清理不应改变正文';
  const reserved = [
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
    'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³',
    'con', 'nUl.notes', 'COM1.txt', 'LPT9 .备份'
  ];
  for (const title of reserved) {
    board.title = title;
    const before = copy(workspace);
    const result = exportMcpCanvas(workspace);
    assert.equal(result.filename, `_${title}.json`, title);
    assert.deepEqual(parseImport(result.json).value, before);
    assert.deepEqual(workspace, before);
  }
});

test('MCP export preserves ordinary Chinese filenames and repairs empty or trailing-space/dot suggestions', () => {
  const workspace = createWorkspace();
  const board = workspace.boards[0];
  for (const [title, filename] of [
    ['自由生长 · 我的思考', '自由生长 · 我的思考.json'],
    ['CONCEPT', 'CONCEPT.json'],
    ['COM10', 'COM10.json'],
    ['NULable', 'NULable.json'],
    ['.灵感', '.灵感.json'],
    ['保留中间.空 格', '保留中间.空 格.json'],
    ['未完成.  ', '未完成.json'],
    ['   ', '原点画布.json'],
    ['...', '原点画布.json'],
    ['CON. ', '_CON.json']
  ]) {
    board.title = title;
    const before = copy(workspace);
    const result = exportMcpCanvas(workspace);
    assert.equal(result.filename, filename, title);
    assert.deepEqual(parseImport(result.json).value, before);
    assert.deepEqual(workspace, before);
  }
});

test('export whitelists persisted fields and never includes runtime metadata or unknown credentials', () => {
  const workspace = workspaceWithTwoBoards();
  const before = copy(workspace);
  workspace.token = 'private-workspace-token';
  workspace.session = { token: 'private-session-token' };
  workspace.revision = 'runtime-revision';
  workspace.boards[0].ownerToken = 'private-owner-token';
  workspace.boards[0].nodes[0].clientToken = 'private-client-token';
  const result = exportMcpCanvas(workspace, { all: true });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.json), before);
  assert.equal(/private-|runtime-revision/u.test(result.json), false);
  assert.equal(workspace.token, 'private-workspace-token');
});

test('exports reject ambiguous scope, invalid IDs, unknown commands and invalid scalars', async () => {
  const workspace = workspaceWithTwoBoards();
  for (const args of [
    { boardId: workspace.activeId, all: true },
    { all: 'true' },
    { all: undefined },
    { boardId: null },
    { boardId: '' },
    { boardId: 'x'.repeat(LIMITS.id + 1) },
    { execute: 'anything' },
    null,
    []
  ]) assert.equal(exportMcpCanvas(workspace, args).code, 'invalid_operation');
  assert.equal(exportMcpCanvas(workspace, { boardId: 'missing' }).code, 'canvas_not_found');
  assert.equal(exportMcpCanvas(workspace, { boardId: workspace.activeId, all: false }).ok, true);
  for (const args of [
    {},
    { expectedWorkspaceRevision: 'bad' },
    { expectedWorkspaceRevision: await workspaceRevisionOf(workspace), title: null },
    { expectedWorkspaceRevision: await workspaceRevisionOf(workspace), title: undefined },
    { expectedWorkspaceRevision: await workspaceRevisionOf(workspace), title: 'x'.repeat(LIMITS.title + 1) },
    { expectedWorkspaceRevision: await workspaceRevisionOf(workspace), all: true }
  ]) assert.equal((await createMcpCanvas(workspace, args)).code, 'invalid_operation');
  assert.equal((await listMcpCanvases(workspace, { boardId: workspace.activeId })).code, 'invalid_operation');
});

test('all new request surfaces reject accessors and inherited requests without executing code', async () => {
  const workspace = workspaceWithTwoBoards();
  let accessed = 0;
  const getter = (key) => Object.defineProperty({}, key, {
    enumerable: true,
    get() { accessed++; return workspace.activeId; }
  });
  assert.equal((await getMcpCanvas(workspace, getter('boardId'))).code, 'invalid_operation');
  assert.equal(exportMcpCanvas(workspace, getter('all')).code, 'invalid_operation');
  assert.equal((await createMcpCanvas(workspace, getter('expectedWorkspaceRevision'))).code, 'invalid_operation');
  assert.equal((await applyMcpWorkspaceEdits(workspace, getter('boardId'))).code, 'invalid_operation');
  assert.equal((await listMcpCanvases(workspace, getter('unknown'))).code, 'invalid_operation');
  assert.equal((await getMcpCanvas(workspace, Object.create({ boardId: workspace.activeId }))).code, 'invalid_operation');
  const hidden = Object.defineProperty({}, 'boardId', { value: workspace.activeId });
  assert.equal((await getMcpCanvas(workspace, hidden)).code, 'invalid_operation');
  assert.equal((await getMcpCanvas(workspace, { [Symbol('bad')]: true })).code, 'invalid_operation');
  assert.equal(accessed, 0);
});
