/** Free canvas data. No DOM, network calls, or dependency on the earlier form tool. */
export const CANVAS_KEY = 'yitong.thinking-canvas.v1';
export const VERSION = 1;
export const LIMITS = Object.freeze({
  boards: 40,
  nodes: 300,
  edges: 600,
  text: 10000,
  title: 200,
  id: 100,
  chars: 2000000,
  coordinate: 1000000
});
export const COLORS = Object.freeze(['cream', 'green', 'blue', 'rose']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = (prefix) =>
  `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;

export function createNode(text = '', x = 0, y = 0, color = 'cream') {
  if (
    typeof text !== 'string' ||
    text.length > LIMITS.text ||
    !coordinate(x) ||
    !coordinate(y) ||
    !COLORS.includes(color)
  )
    throw new TypeError('节点内容、位置或颜色不合法');
  return { id: uid('node'), text, x, y, color };
}

export function createBoard(title = '未命名画布') {
  if (typeof title !== 'string' || title.length > LIMITS.title)
    throw new TypeError('画布名称过长或格式不合法');
  const now = new Date().toISOString();
  return {
    id: uid('board'),
    title,
    createdAt: now,
    updatedAt: now,
    nodes: [createNode()],
    edges: [],
    view: { x: 0, y: 0, scale: 1 }
  };
}

export function createWorkspace() {
  const board = createBoard();
  return { version: VERSION, activeId: board.id, boards: [board] };
}

/** Connect in place. Existing ideas may have multiple parents and circular links. */
export function connect(board, from, to) {
  if (
    from === to ||
    board.edges.length >= LIMITS.edges ||
    !board.nodes.some((n) => n.id === from) ||
    !board.nodes.some((n) => n.id === to) ||
    board.edges.some((e) => e.from === from && e.to === to)
  )
    return null;
  const edge = { id: uid('edge'), from, to, label: '' };
  board.edges.push(edge);
  return edge;
}

/** Delete in place, including all incoming and outgoing links. */
export function deleteNode(board, id) {
  const found = board.nodes.find((n) => n.id === id);
  if (!found) return false;
  board.nodes = board.nodes.filter((n) => n.id !== id);
  board.edges = board.edges.filter((e) => e.from !== id && e.to !== id);
  return true;
}

const coordinate = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= LIMITS.coordinate;
const finiteScale = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.2 &&
  value <= 2.5;
const validId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= LIMITS.id;
const validText = (value, max = LIMITS.text) =>
  typeof value === 'string' && value.length <= max;
const validDate = (value) =>
  validText(value, 100) && Number.isFinite(Date.parse(value));

function serialized(raw) {
  try {
    const text = JSON.stringify(raw);
    if (typeof text !== 'string' || text.length > LIMITS.chars)
      return { error: '文件过大，最多支持 2,000,000 个字符' };
    return { text };
  } catch {
    return { error: '数据不是可读取的 JSON' };
  }
}

function inspectBoard(raw, index, errors) {
  const at = `画布 ${index + 1}`;
  if (!object(raw)) {
    errors.push(`${at}格式不合法`);
    return null;
  }
  if (!validId(raw.id)) errors.push(`${at}缺少有效 ID`);
  if (!validText(raw.title, LIMITS.title))
    errors.push(`${at}名称须为不超过 ${LIMITS.title} 字符的文本`);
  if (!validDate(raw.createdAt) || !validDate(raw.updatedAt))
    errors.push(`${at}日期格式不合法`);
  if (
    !Array.isArray(raw.nodes) ||
    raw.nodes.length > LIMITS.nodes ||
    !Array.isArray(raw.edges) ||
    raw.edges.length > LIMITS.edges
  ) {
    errors.push(
      `${at}节点或连线数量不合法（上限 ${LIMITS.nodes} 个节点、${LIMITS.edges} 条连线）`
    );
    return null;
  }
  const nodeIds = new Set(),
    edgeIds = new Set(),
    pairs = new Set();
  const nodes = [];
  for (const n of raw.nodes) {
    if (
      !object(n) ||
      !validId(n.id) ||
      !validText(n.text) ||
      !coordinate(n.x) ||
      !coordinate(n.y) ||
      !COLORS.includes(n.color)
    ) {
      errors.push(`${at}含有格式不合法的节点`);
      continue;
    }
    if (nodeIds.has(n.id)) errors.push(`${at}含有重复节点 ID`);
    nodeIds.add(n.id);
    nodes.push({ id: n.id, text: n.text, x: n.x, y: n.y, color: n.color });
  }
  const edges = [];
  for (const e of raw.edges) {
    if (
      !object(e) ||
      !validId(e.id) ||
      !validId(e.from) ||
      !validId(e.to) ||
      !validText(e.label)
    ) {
      errors.push(`${at}含有格式不合法的连线`);
      continue;
    }
    if (edgeIds.has(e.id)) errors.push(`${at}含有重复连线 ID`);
    edgeIds.add(e.id);
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to))
      errors.push(`${at}连线指向了不存在的节点`);
    if (e.from === e.to) errors.push(`${at}含有指向自身的连线`);
    const pair = JSON.stringify([e.from, e.to]);
    if (pairs.has(pair)) errors.push(`${at}含有重复连线`);
    pairs.add(pair);
    edges.push({ id: e.id, from: e.from, to: e.to, label: e.label });
  }
  if (
    !object(raw.view) ||
    !coordinate(raw.view.x) ||
    !coordinate(raw.view.y) ||
    !finiteScale(raw.view.scale)
  ) {
    errors.push(`${at}视图位置或缩放不合法`);
    return null;
  }
  return {
    id: raw.id,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    nodes,
    edges,
    view: { x: raw.view.x, y: raw.view.y, scale: raw.view.scale }
  };
}

/** Validate and copy only known fields. Never mutate input, even on failure. */
export function validateWorkspace(raw) {
  const errors = [];
  const s = serialized(raw);
  if (s.error) return { ok: false, errors: [s.error] };
  // Read a plain JSON copy so getters, prototypes and references cannot escape validation.
  raw = JSON.parse(s.text);
  if (
    !object(raw) ||
    raw.version !== VERSION ||
    !Array.isArray(raw.boards) ||
    raw.boards.length > LIMITS.boards
  )
    return { ok: false, errors: ['工作区版本或画布列表不合法'] };
  const boardIds = new Set();
  const boards = raw.boards.map((b, i) => {
    const result = inspectBoard(b, i, errors);
    if (result) {
      if (boardIds.has(result.id)) errors.push('含有重复画布 ID');
      boardIds.add(result.id);
    }
    return result;
  });
  if (
    raw.activeId !== null &&
    (!validId(raw.activeId) || !boardIds.has(raw.activeId))
  )
    errors.push('当前画布 ID 无效');
  if (raw.boards.length > 0 && raw.activeId === null)
    errors.push('请选择一个当前画布');
  if (!own(raw, 'activeId')) errors.push('缺少当前画布信息');
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: { version: VERSION, activeId: raw.activeId, boards },
    errors: []
  };
}

/** Import accepts either an entire workspace or an exported single board. */
export function parseImport(raw) {
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.chars)
      return { ok: false, errors: ['文件过大，最多支持 2,000,000 个字符'] };
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['无法读取 JSON，请选择本工具导出的文件'] };
    }
  }
  if (
    object(raw) &&
    !own(raw, 'version') &&
    own(raw, 'nodes') &&
    own(raw, 'edges')
  )
    raw = { version: VERSION, activeId: raw.id, boards: [raw] };
  return validateWorkspace(raw);
}

/** Append only; original boards and the caller's objects remain untouched. */
export function importAppend(existing, incoming) {
  const base = validateWorkspace(existing),
    added = parseImport(incoming);
  if (!base.ok || !added.ok)
    return { ok: false, errors: [...base.errors, ...added.errors] };
  if (base.value.boards.length + added.value.boards.length > LIMITS.boards)
    return {
      ok: false,
      errors: [`最多保存 ${LIMITS.boards} 张画布，请先导出备份或减少画布`]
    };
  const workspace = base.value;
  const used = new Set();
  for (const b of workspace.boards) {
    used.add(b.id);
    for (const n of b.nodes) used.add(n.id);
    for (const e of b.edges) used.add(e.id);
  }
  const take = (id, prefix) => {
    let result = id;
    while (used.has(result)) result = uid(prefix);
    used.add(result);
    return result;
  };
  const importedIds = [];
  for (const original of added.value.boards) {
    const board = clone(original),
      nodeMap = new Map();
    board.id = take(board.id, 'board');
    for (const n of board.nodes) {
      const previous = n.id;
      n.id = take(n.id, 'node');
      nodeMap.set(previous, n.id);
    }
    for (const e of board.edges) {
      e.id = take(e.id, 'edge');
      e.from = nodeMap.get(e.from);
      e.to = nodeMap.get(e.to);
    }
    workspace.boards.push(board);
    importedIds.push(board.id);
  }
  if (importedIds.length) workspace.activeId = importedIds[0];
  const final = validateWorkspace(workspace);
  if (!final.ok) return final;
  return { ok: true, workspace: final.value, importedIds, errors: [] };
}

/** Does not write or overwrite corrupt data. */
export function load(storage) {
  let raw;
  try {
    raw = storage.getItem(CANVAS_KEY);
  } catch {
    return {
      workspace: createWorkspace(),
      raw: null,
      error: '浏览器存储不可用，请导出文件保存',
      status: 'unavailable'
    };
  }
  if (raw === null)
    return {
      workspace: createWorkspace(),
      raw: null,
      error: '',
      status: 'empty'
    };
  const result = parseImport(raw);
  if (!result.ok)
    return {
      workspace: createWorkspace(),
      raw,
      error: `原始数据未覆盖：${result.errors.join('；')}`,
      status: 'invalid'
    };
  return { workspace: result.value, raw, error: '', status: 'loaded' };
}

/** Optional expectedRaw provides compare-and-set protection across browser tabs. */
export function save(storage, workspace, expectedRaw) {
  const result = validateWorkspace(workspace);
  if (!result.ok)
    return { ok: false, status: 'invalid', error: result.errors.join('；') };
  let current;
  try {
    current = storage.getItem(CANVAS_KEY);
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      error: '浏览器存储不可用，请导出文件保存'
    };
  }
  if (current !== null && !parseImport(current).ok)
    return {
      ok: false,
      status: 'blocked',
      error: '浏览器原始数据损坏，未覆盖。请先导出备份，再重新开始。',
      raw: current
    };
  if (arguments.length >= 3 && current !== expectedRaw)
    return {
      ok: false,
      status: 'conflict',
      error: '另一个页面已更新画布，已暂停保存以保留双方内容',
      raw: current
    };
  const raw = JSON.stringify(result.value);
  try {
    storage.setItem(CANVAS_KEY, raw);
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      error: '未能保存，可能是存储已满。请导出文件备份。',
      raw: current
    };
  }
  return { ok: true, status: 'saved', error: '', raw };
}

export function exportJSON(workspaceOrBoard) {
  const result = parseImport(workspaceOrBoard);
  if (!result.ok) throw new TypeError(result.errors.join('；'));
  return JSON.stringify(result.value);
}
