/** Local, dependency-free JSON model. No DOM, network, eval, or HTML rendering. */
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'yitong.first-principles.workspace.v1';
export const LIMITS = Object.freeze({
  analyses: 50,
  records: 300,
  claims: 500,
  links: 50,
  references: 100,
  title: 200,
  text: 10000,
  short: 1000,
  id: 100,
  url: 2048,
  importChars: 2000000,
  depth: 10,
  nodes: 50000,
});

const SECTIONS = ['inbox', 'concepts', 'claims', 'breakdown', 'options', 'data', 'calculations', 'experiments', 'tasks'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = value => typeof value === 'string' && value.trim().length > 0;

function newId(prefix) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${token}`;
}

/** Create one editable row with every required field; unknown sections throw. */
export function createRecord(section) {
  const id = newId(section);
  switch (section) {
    case 'inbox': return { id, text: '' };
    case 'concepts': return { id, term: '', definition: '', measure: '' };
    case 'claims': return { id, text: '', type: 'assumption', source: '', date: '', note: '', links: [], basisIds: [] };
    case 'breakdown': return { id, question: '', parentId: null, claimIds: [], rationale: '', disconfirm: '', focus: false };
    case 'options': return { id, title: '', mechanism: '', needs: '', tradeoffs: '', claimIds: [], status: 'candidate' };
    case 'data': return { id, label: '', value: '', unit: '', source: '', date: '', kind: 'observed', note: '', claimId: '' };
    case 'calculations': return { id, title: '', leftId: '', operator: '+', rightId: '', resultUnit: '' };
    case 'experiments': return { id, title: '', optionId: '', claimId: '', questionId: '', hypothesis: '', evidenceNeeded: '', method: '', metric: '', threshold: '', budget: '', deadline: '', result: '', decision: '', status: 'planned' };
    case 'tasks': return { id, text: '', experimentId: '', deadline: '', done: false };
    default: throw new TypeError(`未知记录类型：${section}`);
  }
}

export function createAnalysis(title = '未命名问题') {
  if (typeof title !== 'string' || title.length > LIMITS.title) throw new TypeError(`标题必须是长度不超过${LIMITS.title}的字符串`);
  const now = new Date().toISOString();
  return {
    id: newId('analysis'), title, createdAt: now, updatedAt: now,
    inbox: [],
    goal: { outcome: '', why: '', success: '', deadline: '', constraints: '', nonGoals: '' },
    concepts: [], claims: [], breakdown: [], options: [], data: [], calculations: [], experiments: [], tasks: [],
    review: { decision: '', reason: '', nextReview: '' },
  };
}

export function createWorkspace() {
  const analysis = createAnalysis('我的第一个问题');
  return { schemaVersion: SCHEMA_VERSION, activeId: analysis.id, analyses: [analysis] };
}

/** A structural demonstration only: no invented income, observations, or targets. */
export function createExampleAnalysis() {
  const analysis = createAnalysis('示例（非事实）：一个待验证的问题');
  analysis.inbox.push({ ...createRecord('inbox'), text: '这是结构示例，不是你的项目结论。请填写自己的目标、证据与实验；空白指标不代表零。' });
  const claim = { ...createRecord('claims'), text: '差异化内容可能吸引付费方', note: '仅为待验证假设，不代表已有咨询、客户或收入。' };
  const question = { ...createRecord('breakdown'), claimIds: [claim.id] };
  analysis.claims.push(claim);
  analysis.breakdown.push(question);
  analysis.options.push(createRecord('options'));
  analysis.data.push(createRecord('data'));
  analysis.calculations.push(createRecord('calculations'));
  analysis.experiments.push({ ...createRecord('experiments'), claimId: claim.id, questionId: question.id });
  return analysis;
}

/** Reject non-JSON structures before reading values; unknown safe fields are dropped later. */
function preflight(raw) {
  let nodes = 0;
  let chars = 0;
  const ancestors = new Set();
  function visit(value, depth, route) {
    if (++nodes > LIMITS.nodes) throw new Error(`数据节点超过上限${LIMITS.nodes}`);
    if (depth > LIMITS.depth) throw new Error(`嵌套深度超过上限${LIMITS.depth}（${route}）`);
    if (typeof value === 'string') {
      chars += value.length;
      if (value.length > LIMITS.text * 2 || chars > LIMITS.importChars) throw new Error(`字符数量超过上限（${route}）`);
      return;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object') throw new Error(`只接受JSON数据，不接受函数或其他特殊值（${route}）`);
    if (ancestors.has(value)) throw new Error(`数据含循环引用（${route}）`);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`只接受普通JSON对象（${route}）`);
    if (Object.getOwnPropertySymbols(value).length) throw new Error(`不接受Symbol字段（${route}）`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter(key => !(Array.isArray(value) && key === 'length'));
    if (Array.isArray(value)) {
      if (value.length > LIMITS.claims || keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error(`数组超限、稀疏或含额外属性（${route}）`);
    } else if (keys.length > 64) throw new Error(`对象字段过多（${route}）`);
    ancestors.add(value);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`不接受污染字段${key}（${route}）`);
      if (key.length > LIMITS.short) throw new Error(`字段名过长（${route}）`);
      const descriptor = descriptors[key];
      if (!own(descriptor, 'value') || !descriptor.enumerable) throw new Error(`不接受访问器或隐藏属性（${route}.${key}）`);
      visit(descriptor.value, depth + 1, `${route}.${key}`);
    }
    ancestors.delete(value);
  }
  visit(raw, 0, '$');
}

function reader(errors) {
  function object(value, route) {
    if (!isObject(value)) { errors.push(`${route}必须是对象`); return {}; }
    return value;
  }
  function text(value, route, max = LIMITS.text) {
    if (typeof value !== 'string') { errors.push(`${route}必须是字符串`); return ''; }
    if (value.length > max) errors.push(`${route}超过${max}字符`);
    return value;
  }
  function id(value, route) {
    const result = text(value, route, LIMITS.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) errors.push(`${route}必须是非空且仅含字母、数字、点、下划线、冒号或短横线的ID`);
    return result;
  }
  function ref(value, route) {
    if (value === null || value === '') return value;
    return id(value, route);
  }
  function enumeration(value, route, choices) {
    if (!choices.includes(value)) errors.push(`${route}必须是${choices.join(' / ')}之一`);
    return choices.includes(value) ? value : choices[0];
  }
  function boolean(value, route) {
    if (typeof value !== 'boolean') errors.push(`${route}必须是布尔值`);
    return value === true;
  }
  function list(value, route, max, parse) {
    if (!Array.isArray(value)) { errors.push(`${route}必须是数组`); return []; }
    if (value.length > max) { errors.push(`${route}数量超过${max}`); return []; }
    return value.map((item, index) => parse(item, `${route}[${index}]`));
  }
  function ids(value, route) {
    const result = list(value, route, LIMITS.references, id);
    if (new Set(result).size !== result.length) errors.push(`${route}有重复关联ID`);
    return result;
  }
  function url(value, route) {
    const result = text(value, route, LIMITS.url);
    try {
      if (/[\u0000-\u0020\u007f]/.test(result)) throw new Error('control');
      const parsed = new URL(result);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('protocol');
      if (parsed.href.length > LIMITS.url) errors.push(`${route}规范化后超过${LIMITS.url}字符`);
      return parsed.href;
    } catch { errors.push(`${route}必须是不含凭据的http/https链接`); return result; }
  }
  function timestamp(value, route) {
    const result = text(value, route, 40);
    try {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || new Date(result).toISOString() !== result) throw new Error('date');
    } catch { errors.push(`${route}必须是有效ISO时间`); }
    return result;
  }
  return { object, text, id, ref, enumeration, boolean, list, ids, url, timestamp };
}

function parseAnalysis(raw, route, read) {
  const r = read;
  const a = r.object(raw, route);
  const field = (row, key, at, max) => r.text(row[key], `${at}.${key}`, max);
  const row = (rawRow, at) => {
    const value = r.object(rawRow, at);
    return [value, { id: r.id(value.id, `${at}.id`) }];
  };
  const section = (name, parse, max = LIMITS.records) => r.list(a[name], `${route}.${name}`, max, parse);
  const g = r.object(a.goal, `${route}.goal`);
  const review = r.object(a.review, `${route}.review`);
  return {
    id: r.id(a.id, `${route}.id`), title: r.text(a.title, `${route}.title`, LIMITS.title),
    createdAt: r.timestamp(a.createdAt, `${route}.createdAt`), updatedAt: r.timestamp(a.updatedAt, `${route}.updatedAt`),
    inbox: section('inbox', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, text: field(v, 'text', at) }; }),
    goal: Object.fromEntries(['outcome', 'why', 'success', 'deadline', 'constraints', 'nonGoals'].map(key => [key, field(g, key, `${route}.goal`, key === 'deadline' ? LIMITS.short : LIMITS.text)])),
    concepts: section('concepts', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, term: field(v, 'term', at, LIMITS.title), definition: field(v, 'definition', at), measure: field(v, 'measure', at) }; }),
    claims: section('claims', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, text: field(v, 'text', at), type: r.enumeration(v.type, `${at}.type`, ['fact', 'assumption', 'inference', 'unknown']), source: field(v, 'source', at), date: field(v, 'date', at, LIMITS.short), note: field(v, 'note', at), links: r.list(v.links, `${at}.links`, LIMITS.links, r.url), basisIds: r.ids(v.basisIds, `${at}.basisIds`) }; }, LIMITS.claims),
    breakdown: section('breakdown', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, question: field(v, 'question', at), parentId: r.ref(v.parentId, `${at}.parentId`), claimIds: r.ids(v.claimIds, `${at}.claimIds`), rationale: field(v, 'rationale', at), disconfirm: field(v, 'disconfirm', at), focus: r.boolean(v.focus, `${at}.focus`) }; }),
    options: section('options', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, title: field(v, 'title', at, LIMITS.title), mechanism: field(v, 'mechanism', at), needs: field(v, 'needs', at), tradeoffs: field(v, 'tradeoffs', at), claimIds: r.ids(v.claimIds, `${at}.claimIds`), status: r.enumeration(v.status, `${at}.status`, ['candidate', 'selected', 'parked']) }; }),
    data: section('data', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, label: field(v, 'label', at, LIMITS.title), value: field(v, 'value', at, LIMITS.short), unit: field(v, 'unit', at, LIMITS.short), source: field(v, 'source', at), date: field(v, 'date', at, LIMITS.short), kind: r.enumeration(v.kind, `${at}.kind`, ['observed', 'estimate', 'target']), note: field(v, 'note', at), claimId: r.ref(v.claimId, `${at}.claimId`) }; }),
    calculations: section('calculations', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, title: field(v, 'title', at, LIMITS.title), leftId: r.ref(v.leftId, `${at}.leftId`), operator: r.enumeration(v.operator, `${at}.operator`, ['+', '-', '*', '/']), rightId: r.ref(v.rightId, `${at}.rightId`), resultUnit: field(v, 'resultUnit', at, LIMITS.short) }; }),
    experiments: section('experiments', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, title: field(v, 'title', at, LIMITS.title), optionId: r.ref(v.optionId, `${at}.optionId`), claimId: r.ref(v.claimId, `${at}.claimId`), questionId: r.ref(v.questionId, `${at}.questionId`), hypothesis: field(v, 'hypothesis', at), evidenceNeeded: field(v, 'evidenceNeeded', at), method: field(v, 'method', at), metric: field(v, 'metric', at), threshold: field(v, 'threshold', at), budget: field(v, 'budget', at), deadline: field(v, 'deadline', at, LIMITS.short), result: field(v, 'result', at), decision: field(v, 'decision', at), status: r.enumeration(v.status, `${at}.status`, ['planned', 'doing', 'done']) }; }),
    tasks: section('tasks', (rawRow, at) => { const [v, base] = row(rawRow, at); return { ...base, text: field(v, 'text', at), experimentId: r.ref(v.experimentId, `${at}.experimentId`), deadline: field(v, 'deadline', at, LIMITS.short), done: r.boolean(v.done, `${at}.done`) }; }),
    review: Object.fromEntries(['decision', 'reason', 'nextReview'].map(key => [key, field(review, key, `${route}.review`, key === 'nextReview' ? LIMITS.short : LIMITS.text)])),
  };
}

function checkAssociations(analysis, route, errors) {
  const maps = {};
  for (const section of SECTIONS) {
    maps[section] = new Map();
    for (const item of analysis[section]) {
      if (maps[section].has(item.id)) errors.push(`${route}.${section}有重复ID：${item.id}`);
      maps[section].set(item.id, item);
    }
  }
  const ref = (id, section, at) => {
    if (id !== '' && id !== null && !maps[section].has(id)) errors.push(`${at}引用了不存在的${section}记录：${id}`);
  };
  for (const item of analysis.claims) for (const id of item.basisIds) ref(id, 'claims', `${route}.claims.${item.id}.basisIds`);
  for (const item of analysis.breakdown) {
    ref(item.parentId, 'breakdown', `${route}.breakdown.${item.id}.parentId`);
    for (const id of item.claimIds) ref(id, 'claims', `${route}.breakdown.${item.id}.claimIds`);
  }
  for (const item of analysis.options) for (const id of item.claimIds) ref(id, 'claims', `${route}.options.${item.id}.claimIds`);
  for (const item of analysis.data) ref(item.claimId, 'claims', `${route}.data.${item.id}.claimId`);
  for (const item of analysis.calculations) {
    ref(item.leftId, 'data', `${route}.calculations.${item.id}.leftId`);
    ref(item.rightId, 'data', `${route}.calculations.${item.id}.rightId`);
  }
  for (const item of analysis.experiments) {
    ref(item.optionId, 'options', `${route}.experiments.${item.id}.optionId`);
    ref(item.claimId, 'claims', `${route}.experiments.${item.id}.claimId`);
    ref(item.questionId, 'breakdown', `${route}.experiments.${item.id}.questionId`);
  }
  for (const item of analysis.tasks) ref(item.experimentId, 'experiments', `${route}.tasks.${item.id}.experimentId`);
  // Prevent circular reasoning and cyclic parent trees; use bounded iterative DFS.
  for (const [section, edges] of [['claims', item => item.basisIds], ['breakdown', item => item.parentId ? [item.parentId] : []]]) {
    const state = new Map();
    for (const start of maps[section].keys()) {
      if (state.get(start) === 2) continue;
      const stack = [[start, false]];
      while (stack.length) {
        const [id, exit] = stack.pop();
        if (exit) { state.set(id, 2); continue; }
        if (state.get(id) === 1) { errors.push(`${route}.${section}存在循环关联`); break; }
        if (state.get(id) === 2 || !maps[section].has(id)) continue;
        state.set(id, 1);
        stack.push([id, true]);
        for (const next of edges(maps[section].get(id))) stack.push([next, false]);
      }
      if (errors.some(error => error === `${route}.${section}存在循环关联`)) break;
    }
  }
}

/** Strict types/limits/associations; returns a fresh allowlisted value on success. */
export function validateWorkspace(raw) {
  const errors = [];
  try { preflight(raw); } catch (error) { return { ok: false, errors: [error.message] }; }
  const r = reader(errors);
  const root = r.object(raw, '$');
  if (root.schemaVersion !== SCHEMA_VERSION) errors.push(`$.schemaVersion必须为${SCHEMA_VERSION}`);
  const analyses = r.list(root.analyses, '$.analyses', LIMITS.analyses, (value, at) => parseAnalysis(value, at, r));
  const activeId = root.activeId === null ? null : r.id(root.activeId, '$.activeId');
  if (new Set(analyses.map(item => item.id)).size !== analyses.length) errors.push('$.analyses有重复分析ID');
  if (analyses.length ? !analyses.some(item => item.id === activeId) : activeId !== null) errors.push('$.activeId必须指向现有分析；空工作区必须为null');
  analyses.forEach((analysis, index) => checkAssociations(analysis, `$.analyses[${index}]`, errors));
  if (errors.length) return { ok: false, errors };
  const value = { schemaVersion: SCHEMA_VERSION, activeId, analyses };
  // JSON escaping (for example newlines) and canonical URLs can expand text.
  // Validate the exact representation used by saveWorkspace, including on merge.
  if (JSON.stringify(value).length > LIMITS.importChars) return { ok: false, errors: [`工作区序列化后超过${LIMITS.importChars}字符，无法保存`] };
  return { ok: true, value, errors: [] };
}

const importFailure = errors => ({ ok: false, workspace: null, importedIds: [], errors });

function readImport(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.importChars) return { ok: false, errors: [`导入内容超过${LIMITS.importChars}字符`] };
    try { value = JSON.parse(raw); } catch { return { ok: false, errors: ['导入文件不是有效JSON'] }; }
  }
  try { preflight(value); } catch (error) { return { ok: false, errors: [error.message] }; }
  if (isObject(value) && own(value, 'id') && !own(value, 'analyses')) value = { schemaVersion: SCHEMA_VERSION, activeId: value.id, analyses: [value] };
  return validateWorkspace(value);
}

/** Accept a workspace or one analysis, as JSON text or plain data. No code is run. */
export function normalizeImport(raw, existingWorkspace) {
  const result = readImport(raw);
  if (!result.ok) return importFailure(result.errors);
  if (existingWorkspace !== undefined) return mergeImport(existingWorkspace, result.value);
  return mergeImport({ schemaVersion: SCHEMA_VERSION, activeId: null, analyses: [] }, result.value);
}

/** Append only. IDs conflicting anywhere in the destination are remapped by type. */
export function mergeImport(existing, incoming) {
  const old = validateWorkspace(existing);
  if (!old.ok) return importFailure(old.errors.map(error => `现有工作区：${error}`));
  const next = readImport(incoming);
  if (!next.ok) return importFailure(next.errors);
  if (old.value.analyses.length + next.value.analyses.length > LIMITS.analyses) return importFailure([`合并后分析数量超过${LIMITS.analyses}`]);
  const workspace = old.value;
  const used = new Set();
  for (const analysis of workspace.analyses) {
    used.add(analysis.id);
    for (const section of SECTIONS) for (const item of analysis[section]) used.add(item.id);
  }
  const analysisIds = new Map();
  const importedIds = [];
  function available(id, prefix) {
    let result = id;
    while (used.has(result)) result = newId(prefix);
    used.add(result);
    return result;
  }
  for (const analysis of next.value.analyses) {
    const priorId = analysis.id;
    analysis.id = available(analysis.id, 'analysis');
    analysisIds.set(priorId, analysis.id);
    importedIds.push(analysis.id);
    const maps = {};
    for (const section of SECTIONS) {
      maps[section] = new Map();
      for (const item of analysis[section]) {
        const prior = item.id;
        item.id = available(prior, section);
        maps[section].set(prior, item.id);
      }
    }
    const ref = (id, section) => id === '' || id === null ? id : maps[section].get(id);
    for (const item of analysis.claims) item.basisIds = item.basisIds.map(id => ref(id, 'claims'));
    for (const item of analysis.breakdown) { item.parentId = ref(item.parentId, 'breakdown'); item.claimIds = item.claimIds.map(id => ref(id, 'claims')); }
    for (const item of analysis.options) item.claimIds = item.claimIds.map(id => ref(id, 'claims'));
    for (const item of analysis.data) item.claimId = ref(item.claimId, 'claims');
    for (const item of analysis.calculations) { item.leftId = ref(item.leftId, 'data'); item.rightId = ref(item.rightId, 'data'); }
    for (const item of analysis.experiments) { item.optionId = ref(item.optionId, 'options'); item.claimId = ref(item.claimId, 'claims'); item.questionId = ref(item.questionId, 'breakdown'); }
    for (const item of analysis.tasks) item.experimentId = ref(item.experimentId, 'experiments');
    workspace.analyses.push(analysis);
  }
  if (importedIds.length) workspace.activeId = analysisIds.get(next.value.activeId) || importedIds[0];
  const final = validateWorkspace(workspace);
  return final.ok ? { ok: true, workspace: final.value, importedIds, errors: [] } : importFailure(final.errors);
}

/** Get an analysis; an unknown id returns null rather than a different analysis. */
export function getAnalysis(workspace, id = workspace?.activeId) {
  return workspace?.analyses?.find(analysis => analysis.id === id) || null;
}

function storageError(error) {
  return `${error?.name || 'StorageError'}：${error?.message || '浏览器存储不可用'}`;
}

/** Read only: invalid original text is returned and is never auto-replaced. */
export function loadWorkspace(storage) {
  let raw = null;
  try {
    if (!storage || typeof storage.getItem !== 'function') throw new Error('未提供可用存储');
    raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { ok: true, status: 'empty', workspace: createWorkspace(), raw: null, error: null };
    if (typeof raw !== 'string') return { ok: false, status: 'invalid', workspace: null, raw, error: '保存的数据不是字符串' };
    const parsed = raw.length > LIMITS.importChars ? { ok: false, errors: ['保存的数据超过大小上限'] } : (() => {
      try { return validateWorkspace(JSON.parse(raw)); } catch { return { ok: false, errors: ['保存的数据不是有效JSON'] }; }
    })();
    if (!parsed.ok) return { ok: false, status: 'invalid', workspace: null, raw, error: parsed.errors.join('；') };
    return { ok: true, status: 'loaded', workspace: parsed.value, raw, error: null };
  } catch (error) { return { ok: false, status: 'unavailable', workspace: null, raw, error: storageError(error) }; }
}

/**
 * Validate before writing; errors and corrupt old data are explicit. When
 * expectedRaw is supplied (string or null), compare the latest stored text just
 * before setItem. This is a stale-write guard, not an atomic compare-and-swap;
 * callers coordinating tabs should additionally serialize with Web Locks.
 */
export function saveWorkspace(storage, workspace, expectedRaw) {
  const result = validateWorkspace(workspace);
  if (!result.ok) return { ok: false, status: 'invalid', error: result.errors.join('；'), errors: result.errors };
  if (expectedRaw !== undefined && expectedRaw !== null && typeof expectedRaw !== 'string') return { ok: false, status: 'invalid', error: 'expectedRaw必须是原始字符串或null' };
  try {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('未提供可用存储');
    const previous = loadWorkspace(storage);
    if (!previous.ok) return { ok: false, status: previous.status === 'invalid' ? 'blocked' : 'unavailable', error: previous.status === 'invalid' ? `原数据已损坏，先导出或明确清除后再保存：${previous.error}` : previous.error, raw: previous.raw };
    const serialized = JSON.stringify(result.value);
    if (serialized.length > LIMITS.importChars) return { ok: false, status: 'invalid', error: '工作区超过保存大小上限' };
    if (expectedRaw !== undefined) {
      const latest = storage.getItem(STORAGE_KEY);
      if (latest !== expectedRaw) return { ok: false, status: 'conflict', error: '工作区已被其他页面修改，请读取最新内容后再保存。', raw: latest };
    }
    storage.setItem(STORAGE_KEY, serialized);
    return { ok: true, status: 'saved', error: null };
  } catch (error) { return { ok: false, status: 'unavailable', error: storageError(error) }; }
}

/** Structural prompts only. This does not verify truth, profitability, or correctness. */
export function getReadiness(analysis) {
  const result = readImport(analysis);
  if (!result.ok) return { ready: false, checks: [], missing: result.errors, error: '分析结构无效' };
  const a = result.value.analyses[0];
  if (!a) return { ready: false, checks: [], missing: ['尚无分析'], error: null };
  const checks = [
    { id: 'goal', label: '结果与成功条件已填写', complete: filled(a.goal.outcome) && filled(a.goal.success) },
    { id: 'concepts', label: '关键概念有定义与观察方式', complete: a.concepts.some(item => filled(item.term) && filled(item.definition) && filled(item.measure)) },
    { id: 'claims', label: '已区分证据与假设；事实附来源', complete: a.claims.some(item => filled(item.text)) && a.claims.filter(item => item.type === 'fact' && filled(item.text)).every(item => filled(item.source) || item.links.length > 0) && a.claims.filter(item => item.type === 'inference' && filled(item.text)).every(item => item.basisIds.length > 0) },
    { id: 'breakdown', label: '拆解问题含反证与焦点', complete: a.breakdown.some(item => item.focus && filled(item.question) && filled(item.rationale) && filled(item.disconfirm)) },
    { id: 'options', label: '候选方案写明机制与代价', complete: a.options.some(item => filled(item.title) && filled(item.mechanism) && filled(item.tradeoffs)) },
    { id: 'experiment', label: '验证方式、指标与判据已填写', complete: a.experiments.some(item => filled(item.hypothesis) && filled(item.evidenceNeeded) && filled(item.method) && filled(item.metric) && filled(item.threshold)) },
    { id: 'review', label: '决定、理由与复查安排已填写', complete: filled(a.review.decision) && filled(a.review.reason) && filled(a.review.nextReview) },
  ];
  return { ready: checks.every(check => check.complete), checks, missing: checks.filter(check => !check.complete).map(check => check.label), error: null };
}

function markdownText(value) {
  const text = filled(value) ? value : '未填写';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|]/g, '\\$&');
}

/** Markdown is generated from escaped text; no raw imported HTML or executable links. */
export function exportMarkdown(analysis) {
  const checked = readImport(analysis);
  if (!checked.ok || checked.value.analyses.length !== 1) throw new TypeError(`无法导出：${checked.errors?.join('；') || '需要一份分析'}`);
  const a = checked.value.analyses[0];
  const lines = [`# ${markdownText(a.title)}`, '', `创建：${markdownText(a.createdAt)}`, `更新：${markdownText(a.updatedAt)}`, '', '> 这是思考记录；结构完整不代表事实已核实或方案已成立。', ''];
  const field = (label, value) => lines.push(`- ${label}：${markdownText(value).replace(/\r?\n/g, '\n  ')}`);
  const rowName = item => [item.title, item.term, item.label, item.question, item.text].find(filled)?.trim() || '';
  const names = Object.fromEntries(SECTIONS.map(key => {
    const counts = new Map();
    const suffixCounts = new Map();
    for (const item of a[key]) {
      const name = rowName(item);
      counts.set(name, (counts.get(name) || 0) + 1);
      const suffix = item.id.slice(-8);
      suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
    }
    return [key, new Map(a[key].map(item => {
      const name = rowName(item);
      const suffix = item.id.slice(-8);
      const disambiguator = suffixCounts.get(suffix) === 1 ? suffix : item.id;
      // The same display name is used in its heading and in all associations.
      return [item.id, name && counts.get(name) > 1 ? `${name}（${disambiguator}）` : name];
    }))];
  }));
  const nameFor = (key, id) => id ? names[key].get(id) || '' : '';
  const section = (title, key, render) => { const rows = a[key]; lines.push(`## ${title}`, ''); if (!rows.length) lines.push('未填写', ''); else rows.forEach((item, index) => { lines.push(`### ${index + 1}. ${markdownText(nameFor(key, item.id))}`, ''); render(item); lines.push(''); }); };
  const refs = (key, ids) => ids.map(id => nameFor(key, id) || '未填写').join('、');
  const status = { candidate: '候选', selected: '已选', parked: '暂存', planned: '计划中', doing: '进行中', done: '已完成', observed: '观察值', estimate: '估计值', target: '目标值', fact: '事实（待核实其来源）', assumption: '假设', inference: '推断', unknown: '未知' };
  section('原始材料', 'inbox', item => field('内容', item.text));
  lines.push('## 目标与边界', '');
  for (const [key, label] of [['outcome', '希望的结果'], ['why', '为什么'], ['success', '成功条件'], ['deadline', '期限'], ['constraints', '限制'], ['nonGoals', '不做什么']]) field(label, a.goal[key]);
  lines.push('');
  section('概念', 'concepts', item => { field('定义', item.definition); field('如何观察或测量', item.measure); });
  section('主张与证据', 'claims', item => { field('类型', status[item.type]); field('来源', item.source); field('日期', item.date); field('备注', item.note); field('依据主张', refs('claims', item.basisIds)); if (!item.links.length) field('证据链接', ''); else item.links.forEach(url => lines.push(`- 证据链接：<${url}>`)); });
  section('拆解', 'breakdown', item => { field('父问题', nameFor('breakdown', item.parentId)); field('关联主张', refs('claims', item.claimIds)); field('为什么这样拆', item.rationale); field('什么会推翻它', item.disconfirm); field('当前焦点', item.focus ? '是' : '否'); });
  section('方案', 'options', item => { field('状态', status[item.status]); field('作用机制', item.mechanism); field('所需条件', item.needs); field('代价与取舍', item.tradeoffs); field('关联主张', refs('claims', item.claimIds)); });
  section('数据', 'data', item => { field('数值', item.value); field('单位', item.unit); field('性质', status[item.kind]); field('来源', item.source); field('日期', item.date); field('备注', item.note); field('关联主张', nameFor('claims', item.claimId)); });
  section('算式记录（此导出不计算结果）', 'calculations', item => { field('算式', `${nameFor('data', item.leftId) || '未填写'} ${item.operator} ${nameFor('data', item.rightId) || '未填写'}`); field('结果单位', item.resultUnit); });
  section('实验', 'experiments', item => { field('状态', status[item.status]); field('关联方案', nameFor('options', item.optionId)); field('关联主张', nameFor('claims', item.claimId)); field('关联问题', nameFor('breakdown', item.questionId)); for (const [key, label] of [['hypothesis', '假设'], ['evidenceNeeded', '需要的证据'], ['method', '方法'], ['metric', '指标'], ['threshold', '判据'], ['budget', '预算'], ['deadline', '期限'], ['result', '结果'], ['decision', '决定']]) field(label, item[key] || ''); });
  section('行动', 'tasks', item => { field('状态', item.done ? '已完成' : '待办'); field('关联实验', nameFor('experiments', item.experimentId)); field('期限', item.deadline); });
  lines.push('## 复查', ''); field('决定', a.review.decision); field('理由', a.review.reason); field('下次复查', a.review.nextReview);
  return `${lines.join('\n')}\n`;
}
