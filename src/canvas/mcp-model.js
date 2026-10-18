/** Bounded, atomic MCP edits. Browser storage and transport stay outside this module. */
import {
  COLORS,
  LIMITS,
  connect,
  createNode,
  deleteNode,
  parseImport
} from './model.js';

const MAX_OPERATIONS = 50;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idSchema = { type: 'string', minLength: 1, maxLength: LIMITS.id };
const textSchema = { type: 'string', maxLength: LIMITS.text };
const coordinateSchema = {
  type: 'number',
  minimum: -LIMITS.coordinate,
  maximum: LIMITS.coordinate
};
const colorSchema = { type: 'string', enum: [...COLORS] };
const cardFields = {
  text: textSchema,
  x: coordinateSchema,
  y: coordinateSchema,
  color: colorSchema
};
const operationSchema = (op, fields, required = []) => ({
  type: 'object',
  additionalProperties: false,
  required: ['op', ...required],
  properties: { op: { const: op }, ...fields }
});

/** JSON Schema shared by MCP transport adapters; this module also validates at runtime. */
export const MCP_EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision', 'operations'],
  properties: {
    expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_OPERATIONS,
      items: {
        oneOf: [
          operationSchema('create_card', { ref: idSchema, ...cardFields }),
          {
            ...operationSchema('update_card', { id: idSchema, ...cardFields }, [
              'id'
            ]),
            anyOf: Object.keys(cardFields).map((key) => ({ required: [key] }))
          },
          operationSchema('delete_card', { id: idSchema }, ['id']),
          operationSchema(
            'connect_cards',
            { from: idSchema, to: idSchema, label: textSchema },
            ['from', 'to']
          ),
          operationSchema('delete_connection', { id: idSchema }, ['id'])
        ]
      }
    }
  }
};

const fieldsByOperation = new Map([
  ['create_card', ['op', 'ref', 'text', 'x', 'y', 'color']],
  ['update_card', ['op', 'id', 'text', 'x', 'y', 'color']],
  ['delete_card', ['op', 'id']],
  ['connect_cards', ['op', 'from', 'to', 'label']],
  ['delete_connection', ['op', 'id']]
]);

function fail(message) {
  throw new TypeError(message);
}

/** Inspect only data properties, so untrusted accessor fields never execute here. */
function record(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label}必须是对象`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label}必须是普通对象`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key))
      fail(`${label}含未知字段`);
    if (!own(descriptor, 'value') || !descriptor.enumerable)
      fail(`${label}只能包含 JSON 数据字段`);
    result[key] = descriptor.value;
  }
  if (required.some((key) => !own(result, key))) fail(`${label}缺少必需字段`);
  return result;
}

function validId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= LIMITS.id
  );
}

function inspectOperation(raw, index) {
  const label = `操作 ${index + 1}`;
  // Discover op without evaluating an accessor, then inspect its exact whitelist.
  const descriptor =
    raw && typeof raw === 'object'
      ? Object.getOwnPropertyDescriptor(raw, 'op')
      : null;
  if (
    !descriptor ||
    !own(descriptor, 'value') ||
    !fieldsByOperation.has(descriptor.value)
  )
    fail(`${label}类型不支持`);
  const op = record(
    raw,
    fieldsByOperation.get(descriptor.value),
    ['op'],
    label
  );
  for (const key of ['id', 'ref', 'from', 'to']) {
    if (own(op, key) && !validId(op[key]))
      fail(`${label}的 ${key} 必须是有效 ID 或引用`);
  }
  for (const key of ['text', 'label']) {
    if (
      own(op, key) &&
      (typeof op[key] !== 'string' || op[key].length > LIMITS.text)
    )
      fail(`${label}的文本过长或格式不合法`);
  }
  for (const key of ['x', 'y']) {
    if (
      own(op, key) &&
      (typeof op[key] !== 'number' ||
        !Number.isFinite(op[key]) ||
        Math.abs(op[key]) > LIMITS.coordinate)
    )
      fail(`${label}的位置不合法`);
  }
  if (own(op, 'color') && !COLORS.includes(op.color))
    fail(`${label}的颜色不合法`);
  const required =
    op.op === 'connect_cards'
      ? ['from', 'to']
      : ['update_card', 'delete_card', 'delete_connection'].includes(op.op)
        ? ['id']
        : [];
  if (required.some((key) => !own(op, key))) fail(`${label}缺少必需字段`);
  if (
    op.op === 'update_card' &&
    !Object.keys(cardFields).some((key) => own(op, key))
  )
    fail(`${label}没有要更新的字段`);
  return op;
}

function inspectEdits(raw) {
  const payload = record(
    raw,
    ['expectedRevision', 'operations'],
    ['expectedRevision', 'operations'],
    '编辑请求'
  );
  if (
    typeof payload.expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.expectedRevision)
  )
    fail('expectedRevision 必须是读取画布时返回的版本');
  const operations = payload.operations;
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > MAX_OPERATIONS
  )
    fail(`每批必须包含 1 至 ${MAX_OPERATIONS} 项操作`);
  if (
    Reflect.ownKeys(operations).some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= operations.length)
    )
  )
    fail('操作列表只能包含 JSON 数组元素');
  const inspected = [];
  for (let i = 0; i < operations.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(operations, String(i));
    if (!descriptor || !own(descriptor, 'value'))
      fail('操作列表不能含空项或访问器');
    inspected.push(inspectOperation(descriptor.value, i));
  }
  return { expectedRevision: payload.expectedRevision, operations: inspected };
}

function copyBoard(board) {
  if (!board || !Array.isArray(board.nodes) || !Array.isArray(board.edges))
    fail('缺少有效画布');
  const parsed = parseImport(board);
  if (!parsed.ok) fail(parsed.errors.join('；'));
  return parsed.value.boards[0];
}

async function digestBoard(board) {
  const source = JSON.stringify({
    title: board.title,
    nodes: board.nodes,
    edges: board.edges
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** View changes and timestamps do not cause content revision conflicts. */
export async function revisionOf(board) {
  return digestBoard(copyBoard(board));
}

/** Execute sequential operations on a copy; references name earlier creates in this batch. */
export async function applyMcpEdits(board, edits) {
  try {
    const payload = inspectEdits(edits);
    const next = copyBoard(board);
    const originalRevision = await digestBoard(next);
    if (payload.expectedRevision !== originalRevision) {
      return {
        ok: false,
        code: 'revision_conflict',
        error: '画布内容已变化，请重新读取后再编辑'
      };
    }
    const references = new Map();
    const created = { cards: [], connections: [] };
    const resolveCard = (value) => {
      const id = references.get(value) ?? value;
      if (!next.nodes.some((node) => node.id === id))
        fail('引用的卡片不存在，或尚未在本批中创建');
      return id;
    };

    for (const op of payload.operations) {
      if (op.op === 'create_card') {
        if (next.nodes.length >= LIMITS.nodes)
          fail(`最多支持 ${LIMITS.nodes} 张卡片`);
        if (
          own(op, 'ref') &&
          (references.has(op.ref) ||
            next.nodes.some((node) => node.id === op.ref))
        )
          fail('新卡片引用重复或与已有 ID 冲突');
        const rightmost = next.nodes.reduce(
          (last, node) => (!last || node.x > last.x ? node : last),
          null
        );
        const node = createNode(
          op.text ?? '',
          op.x ?? (rightmost ? rightmost.x + 300 : 0),
          op.y ?? rightmost?.y ?? 0,
          op.color ?? 'cream'
        );
        next.nodes.push(node);
        if (own(op, 'ref')) references.set(op.ref, node.id);
        created.cards.push({ ref: op.ref ?? null, id: node.id });
      } else if (op.op === 'update_card') {
        const id = resolveCard(op.id);
        const node = next.nodes.find((item) => item.id === id);
        const keys = Object.keys(cardFields).filter((key) => own(op, key));
        if (!keys.some((key) => node[key] !== op[key]))
          fail('卡片更新没有改变任何字段');
        for (const key of keys) node[key] = op[key];
      } else if (op.op === 'delete_card') {
        deleteNode(next, resolveCard(op.id));
      } else if (op.op === 'connect_cards') {
        const from = resolveCard(op.from),
          to = resolveCard(op.to);
        const edge = connect(next, from, to);
        if (!edge) fail('无法建立连线：卡片相同、关系重复或连线数量已达上限');
        edge.label = op.label ?? '';
        created.connections.push({ id: edge.id, from, to });
      } else if (op.op === 'delete_connection') {
        if (!next.edges.some((edge) => edge.id === op.id))
          fail('要删除的连线不存在');
        next.edges = next.edges.filter((edge) => edge.id !== op.id);
      }
    }

    const revision = await digestBoard(next);
    if (revision !== originalRevision)
      next.updatedAt = new Date().toISOString();
    const final = parseImport(next);
    if (!final.ok) fail(final.errors.join('；'));
    created.cards = created.cards.filter(({ id }) =>
      next.nodes.some((node) => node.id === id)
    );
    created.connections = created.connections.filter(({ id }) =>
      next.edges.some((edge) => edge.id === id)
    );
    return { ok: true, board: final.value.boards[0], revision, created };
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_operation',
      error: error instanceof Error ? error.message : '编辑请求不合法'
    };
  }
}
