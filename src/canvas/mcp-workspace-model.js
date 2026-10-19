/** Workspace-scoped MCP data operations. No storage, authorization or transport. */
import {
  LIMITS,
  createBoard,
  exportJSON,
  validateWorkspace
} from './model.js';
import { MCP_EDIT_SCHEMA, applyMcpEdits, revisionOf } from './mcp-model.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idSchema = { type: 'string', minLength: 1, maxLength: LIMITS.id };
const revisionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const objectSchema = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {})
});

export const MCP_LIST_SCHEMA = objectSchema({});
export const MCP_GET_SCHEMA = objectSchema({ boardId: idSchema });
export const MCP_WORKSPACE_EDIT_SCHEMA = objectSchema(
  { boardId: idSchema, ...MCP_EDIT_SCHEMA.properties },
  ['boardId', ...MCP_EDIT_SCHEMA.required]
);
export const MCP_CREATE_SCHEMA = objectSchema(
  {
    title: { type: 'string', maxLength: LIMITS.title },
    expectedWorkspaceRevision: revisionSchema
  },
  ['expectedWorkspaceRevision']
);
export const MCP_EXPORT_SCHEMA = {
  ...objectSchema({ boardId: idSchema, all: { type: 'boolean' } }),
  not: { required: ['boardId', 'all'], properties: { all: { const: true } } }
};

function fail(message) {
  throw new TypeError(message);
}

// Reject accessors before reading fields of a request received from a client.
function request(raw, allowed, required = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('MCP 请求必须是对象');
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null)
    fail('MCP 请求必须是普通对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const value = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key))
      fail('MCP 请求含未知字段');
    if (!own(descriptor, 'value') || !descriptor.enumerable)
      fail('MCP 请求只能包含 JSON 数据字段');
    value[key] = descriptor.value;
  }
  if (required.some((key) => !own(value, key))) fail('MCP 请求缺少必需字段');
  if (
    own(value, 'boardId') &&
    (typeof value.boardId !== 'string' ||
      !value.boardId.length ||
      value.boardId.length > LIMITS.id)
  )
    fail('boardId 必须是画布列表中返回的有效 ID');
  return value;
}

function copyWorkspace(workspace) {
  const result = validateWorkspace(workspace);
  if (!result.ok) fail(result.errors.join('；'));
  return result.value;
}

function findBoard(workspace, boardId) {
  return workspace.boards.find((board) => board.id === (boardId ?? workspace.activeId));
}

const missingBoard = () => ({
  ok: false,
  code: 'canvas_not_found',
  error: '画布不存在，请重新读取画布列表。'
});
const failure = (error) => ({
  ok: false,
  code: 'invalid_operation',
  error: error instanceof Error ? error.message : 'MCP 请求不合法'
});

async function digestWorkspace(workspace) {
  // Selection, viewport and timestamps are not workspace content revisions.
  const content = workspace.boards.map(({ id, title, nodes, edges }) => ({
    id,
    title,
    nodes,
    edges
  }));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(content))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** Includes board identity and content, while switching the active board is harmless. */
export async function workspaceRevisionOf(workspace) {
  return digestWorkspace(copyWorkspace(workspace));
}

export async function listMcpCanvases(workspace, args = {}) {
  try {
    request(args, []);
    const current = copyWorkspace(workspace);
    const boards = await Promise.all(
      current.boards.map(async (board) => ({
        id: board.id,
        title: board.title,
        nodeCount: board.nodes.length,
        edgeCount: board.edges.length,
        revision: await revisionOf(board)
      }))
    );
    return {
      ok: true,
      activeId: current.activeId,
      workspaceRevision: await digestWorkspace(current),
      boards
    };
  } catch (error) {
    return failure(error);
  }
}

export async function getMcpCanvas(workspace, args = {}) {
  try {
    const payload = request(args, ['boardId']);
    const current = findBoard(copyWorkspace(workspace), payload.boardId);
    if (!current) return missingBoard();
    return { ok: true, board: current, revision: await revisionOf(current) };
  } catch (error) {
    return failure(error);
  }
}

/** Board IDs are explicit for writes so a user switching pages cannot redirect an edit. */
export async function applyMcpWorkspaceEdits(workspace, args) {
  try {
    const payload = request(
      args,
      ['boardId', 'expectedRevision', 'operations'],
      ['boardId', 'expectedRevision', 'operations']
    );
    const next = copyWorkspace(workspace);
    const index = next.boards.findIndex((board) => board.id === payload.boardId);
    if (index < 0) return missingBoard();
    const result = await applyMcpEdits(next.boards[index], {
      expectedRevision: payload.expectedRevision,
      operations: payload.operations
    });
    if (!result.ok) return result;
    next.boards[index] = result.board;
    // Board-only validation cannot catch the existing whole-workspace size limit.
    const value = copyWorkspace(next);
    return {
      ok: true,
      workspace: value,
      boardId: payload.boardId,
      revision: result.revision,
      created: result.created
    };
  } catch (error) {
    return failure(error);
  }
}

export async function createMcpCanvas(workspace, args) {
  try {
    const payload = request(
      args,
      ['title', 'expectedWorkspaceRevision'],
      ['expectedWorkspaceRevision']
    );
    if (
      typeof payload.expectedWorkspaceRevision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(payload.expectedWorkspaceRevision)
    )
      fail('expectedWorkspaceRevision 必须是读取画布列表时返回的版本');
    if (
      own(payload, 'title') &&
      (typeof payload.title !== 'string' || payload.title.length > LIMITS.title)
    )
      fail(`画布名称须为不超过 ${LIMITS.title} 字符的文本`);
    const next = copyWorkspace(workspace);
    if (payload.expectedWorkspaceRevision !== await digestWorkspace(next))
      return {
        ok: false,
        code: 'revision_conflict',
        error: '工作区内容已变化，请重新读取画布列表后再新建。'
      };
    if (next.boards.length >= LIMITS.boards)
      fail(`最多保存 ${LIMITS.boards} 张画布，请先导出备份或减少画布`);
    const board = createBoard(payload.title ?? '未命名画布');
    next.boards.push(board);
    // An empty imported workspace must select its first board to remain valid v1 data.
    if (next.activeId === null) next.activeId = board.id;
    const value = copyWorkspace(next);
    return {
      ok: true,
      workspace: value,
      board: value.boards.at(-1),
      revision: await revisionOf(board),
      workspaceRevision: await digestWorkspace(value)
    };
  } catch (error) {
    return failure(error);
  }
}

function exportFilename(title) {
  let name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .slice(0, 100)
    .replace(/[ .]+$/gu, '');
  if (!name.trim()) name = '原点画布';
  // Windows reserves device names even with an extension, including superscript digits.
  const device = name.split('.')[0].replace(/ +$/gu, '');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(device))
    name = `_${name.slice(0, 99)}`;
  return `${name}.json`;
}

/** Returns the same portable v1 JSON as the file menu; does not download or persist it. */
export function exportMcpCanvas(workspace, args = {}) {
  try {
    const payload = request(args, ['boardId', 'all']);
    if (own(payload, 'all') && typeof payload.all !== 'boolean')
      fail('all 必须是布尔值');
    if (payload.all && own(payload, 'boardId'))
      fail('全部画布导出不能同时指定 boardId');
    const current = copyWorkspace(workspace);
    const selected = payload.all ? current : findBoard(current, payload.boardId);
    if (!selected) return missingBoard();
    const title = payload.all ? '原点-所有画布' : selected.title || '原点画布';
    return {
      ok: true,
      json: exportJSON(selected),
      filename: exportFilename(title),
      mimeType: 'application/json'
    };
  } catch (error) {
    return failure(error);
  }
}
