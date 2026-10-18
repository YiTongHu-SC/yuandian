import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, STORAGE_KEY, LIMITS, createWorkspace, createAnalysis,
  createExampleAnalysis, createRecord, validateWorkspace, normalizeImport,
  mergeImport, loadWorkspace, saveWorkspace, exportMarkdown, getReadiness, getAnalysis,
} from './model.js';

const copy = value => JSON.parse(JSON.stringify(value));
function memoryStorage(initial = null) {
  let raw = initial;
  let writes = 0;
  return { getItem(key) { assert.equal(key, STORAGE_KEY); return raw; }, setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; writes++; }, get raw() { return raw; }, get writes() { return writes; } };
}
function linkedWorkspace() {
  const analysis = createAnalysis('关联测试');
  const claim = { ...createRecord('claims'), text: '待验证假设' };
  const derived = { ...createRecord('claims'), text: '推断', type: 'inference', basisIds: [claim.id] };
  const parent = { ...createRecord('breakdown'), question: '父问题', claimIds: [claim.id] };
  const child = { ...createRecord('breakdown'), question: '子问题', parentId: parent.id, claimIds: [derived.id], rationale: '拆解理由', disconfirm: '反证', focus: true };
  const option = { ...createRecord('options'), title: '候选', claimIds: [claim.id] };
  const left = { ...createRecord('data'), label: '观察值', value: '', claimId: claim.id };
  const right = { ...createRecord('data'), label: '估计值', value: '2', kind: 'estimate', claimId: derived.id };
  const calc = { ...createRecord('calculations'), leftId: left.id, rightId: right.id };
  const experiment = { ...createRecord('experiments'), title: '验证', optionId: option.id, claimId: claim.id, questionId: child.id };
  const task = { ...createRecord('tasks'), text: '执行', experimentId: experiment.id };
  analysis.claims.push(claim, derived); analysis.breakdown.push(parent, child); analysis.options.push(option);
  analysis.data.push(left, right); analysis.calculations.push(calc); analysis.experiments.push(experiment); analysis.tasks.push(task);
  return { schemaVersion: SCHEMA_VERSION, activeId: analysis.id, analyses: [analysis] };
}

test('fresh workspace is one blank problem; example is explicitly a hypothesis', () => {
  const workspace = createWorkspace();
  assert.equal(workspace.analyses.length, 1);
  const blank = getAnalysis(workspace);
  assert.equal(blank.title, '我的第一个问题');
  assert.equal(blank.claims.length, 0);
  assert.equal(blank.goal.outcome, '');
  assert.equal(getAnalysis(workspace, 'missing'), null);
  const example = createExampleAnalysis();
  assert.match(example.title, /示例.*非事实/);
  assert.equal(example.claims[0].type, 'assumption');
  assert.equal(example.claims[0].text, '差异化内容可能吸引付费方');
  assert.equal(example.data[0].value, '');
  assert.equal(example.experiments[0].metric, '');
  assert.equal(example.experiments[0].result, '');
  assert.equal(normalizeImport(example).ok, true);
  assert.equal(getReadiness(blank).ready, false);
});

test('all fields and associations survive JSON/storage roundtrip without mutation', () => {
  const workspace = linkedWorkspace();
  const original = copy(workspace);
  const validated = validateWorkspace(workspace);
  assert.equal(validated.ok, true, validated.errors.join(';'));
  assert.deepEqual(validated.value, original);
  const imported = normalizeImport(JSON.stringify(workspace));
  assert.equal(imported.ok, true, imported.errors.join(';'));
  assert.deepEqual(imported.workspace, original);
  const store = memoryStorage();
  const empty = loadWorkspace(store);
  assert.equal(empty.status, 'empty'); assert.equal(store.writes, 0);
  assert.equal(saveWorkspace(store, workspace).status, 'saved');
  assert.deepEqual(loadWorkspace(store).workspace, workspace);
  assert.deepEqual(workspace, original);
});

test('invalid JSON, schema, dates, types, enum and active references fail explicitly', () => {
  assert.equal(normalizeImport('{broken').ok, false);
  assert.equal(normalizeImport('(()=>alert(1))()').ok, false);
  const mutations = [
    w => { w.schemaVersion = 2; }, w => { w.activeId = 'missing'; },
    w => { w.analyses[0].goal.outcome = 42; }, w => { w.analyses[0].tasks[0].done = 'false'; },
    w => { w.analyses[0].createdAt = '2026-02-30T00:00:00.000Z'; },
    w => { w.analyses[0].data[0].value = 0; }, w => { w.analyses[0].claims[0].type = 'proven'; },
    w => { w.analyses[0].calculations[0].operator = '**'; },
    w => { delete w.analyses[0].claims[0].basisIds; },
  ];
  for (const mutate of mutations) { const workspace = linkedWorkspace(); mutate(workspace); assert.equal(validateWorkspace(workspace).ok, false); }
});

test('unknown safe fields are removed; pollution, getters, functions and cycles are rejected', () => {
  const workspace = linkedWorkspace();
  workspace.extra = { safe: 'discarded' }; workspace.analyses[0].claims[0].unknown = 'discarded';
  const validated = validateWorkspace(workspace);
  assert.equal(validated.ok, true);
  assert.equal('extra' in validated.value, false);
  assert.equal('unknown' in validated.value.analyses[0].claims[0], false);
  assert.equal(normalizeImport('{"__proto__":{"polluted":true}}').ok, false);
  assert.equal({}.polluted, undefined);
  let invoked = false;
  const getter = createWorkspace(); Object.defineProperty(getter, 'attack', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.equal(validateWorkspace(getter).ok, false); assert.equal(invoked, false);
  const fn = createWorkspace(); fn.extra = () => 1; assert.equal(validateWorkspace(fn).ok, false);
  const cyclic = createWorkspace(); cyclic.extra = cyclic; assert.equal(validateWorkspace(cyclic).ok, false);
  const proto = createWorkspace(); Object.setPrototypeOf(proto.analyses[0].goal, { attack: true }); assert.equal(validateWorkspace(proto).ok, false);
});

test('character, quantity, nesting, serialized-size and sparse-array limits reject payloads', () => {
  const long = createWorkspace(); long.analyses[0].title = 'x'.repeat(LIMITS.title + 1); assert.equal(validateWorkspace(long).ok, false);
  const many = createWorkspace(); many.analyses = Array.from({ length: LIMITS.analyses + 1 }, () => createAnalysis()); assert.equal(validateWorkspace(many).ok, false);
  const manyRows = createWorkspace(); manyRows.analyses[0].inbox = Array.from({ length: LIMITS.records + 1 }, () => createRecord('inbox')); assert.equal(validateWorkspace(manyRows).ok, false);
  const nested = createWorkspace(); let cursor = nested; for (let i = 0; i < LIMITS.depth + 1; i++) cursor = cursor.extra = {}; assert.equal(validateWorkspace(nested).ok, false);
  assert.equal(normalizeImport(' '.repeat(LIMITS.importChars + 1)).ok, false);
  const sparse = createWorkspace(); sparse.analyses[0].inbox = new Array(2); assert.equal(validateWorkspace(sparse).ok, false);
});

test('dangling, duplicate and circular associations fail; external links are safe schemes', () => {
  const mutations = [
    w => { w.analyses[0].data[0].claimId = 'missing'; },
    w => { w.analyses[0].experiments[0].questionId = 'missing'; },
    w => { w.analyses[0].calculations[0].rightId = 'missing'; },
    w => { w.analyses[0].claims[0].basisIds = [w.analyses[0].claims[1].id]; },
    w => { w.analyses[0].breakdown[0].parentId = w.analyses[0].breakdown[1].id; },
    w => { w.analyses[0].claims.push(copy(w.analyses[0].claims[0])); },
    w => { w.analyses[0].claims[0].links = ['javascript:alert(1)']; },
    w => { w.analyses[0].claims[0].links = ['https://user:password@example.com/']; },
  ];
  for (const mutate of mutations) { const workspace = linkedWorkspace(); mutate(workspace); assert.equal(validateWorkspace(workspace).ok, false); }
  const workspace = linkedWorkspace(); workspace.analyses[0].claims[0].links = ['https://example.com/a?q=1'];
  assert.equal(validateWorkspace(workspace).ok, true);
});

test('append import remaps every conflicting ID and repairs only incoming internal references', () => {
  const existing = linkedWorkspace(); const before = copy(existing);
  const result = mergeImport(existing, copy(existing));
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.workspace.analyses.length, 2);
  assert.deepEqual(result.workspace.analyses[0], before.analyses[0]);
  assert.deepEqual(existing, before);
  const a = result.workspace.analyses[1];
  assert.notEqual(a.id, existing.activeId);
  assert.equal(result.workspace.activeId, a.id);
  assert.deepEqual(a.claims[1].basisIds, [a.claims[0].id]);
  assert.equal(a.breakdown[1].parentId, a.breakdown[0].id);
  assert.deepEqual(a.breakdown[1].claimIds, [a.claims[1].id]);
  assert.deepEqual(a.options[0].claimIds, [a.claims[0].id]);
  assert.equal(a.data[0].claimId, a.claims[0].id);
  assert.equal(a.calculations[0].leftId, a.data[0].id);
  assert.equal(a.calculations[0].rightId, a.data[1].id);
  assert.equal(a.experiments[0].optionId, a.options[0].id);
  assert.equal(a.experiments[0].claimId, a.claims[0].id);
  assert.equal(a.experiments[0].questionId, a.breakdown[1].id);
  assert.equal(a.tasks[0].experimentId, a.experiments[0].id);
  for (const section of ['claims', 'breakdown', 'options', 'data', 'calculations', 'experiments', 'tasks']) assert.notEqual(a[section][0].id, before.analyses[0][section][0].id);
});

test('same local entity IDs in separate incoming analyses remain correctly scoped', () => {
  const incoming = linkedWorkspace(); const other = copy(incoming.analyses[0]); other.id = 'other_analysis'; incoming.analyses.push(other); incoming.activeId = other.id;
  assert.equal(validateWorkspace(incoming).ok, true);
  const normalized = normalizeImport(incoming);
  assert.equal(normalized.ok, true, normalized.errors.join(';'));
  const [first, second] = normalized.workspace.analyses;
  assert.notEqual(first.claims[0].id, second.claims[0].id);
  assert.equal(second.experiments[0].claimId, second.claims[0].id);
  assert.equal(normalized.workspace.activeId, second.id);
});

test('load preserves corrupted original text and never overwrites it, including subsequent save', () => {
  const bad = '{broken original <script>alert(1)</script>';
  const store = memoryStorage(bad);
  const loaded = loadWorkspace(store);
  assert.equal(loaded.ok, false); assert.equal(loaded.status, 'invalid'); assert.equal(loaded.raw, bad); assert.equal(loaded.workspace, null);
  assert.equal(store.writes, 0);
  const saved = saveWorkspace(store, createWorkspace());
  assert.equal(saved.status, 'blocked'); assert.equal(saved.raw, bad); assert.equal(store.raw, bad); assert.equal(store.writes, 0);
});

test('quota and unavailable/private storage are explicit failures, not fake saved states', () => {
  const quota = { getItem() { return null; }, setItem() { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } };
  const result = saveWorkspace(quota, createWorkspace()); assert.equal(result.ok, false); assert.equal(result.status, 'unavailable'); assert.match(result.error, /QuotaExceededError/);
  const privateStorage = { getItem() { throw new Error('private storage blocked'); } };
  assert.equal(loadWorkspace(privateStorage).status, 'unavailable');
  assert.equal(saveWorkspace(privateStorage, createWorkspace()).ok, false);
  assert.equal(loadWorkspace(null).ok, false);
});

test('optional expectedRaw detects interleaved changes at the final pre-write read', () => {
  const workspace = createWorkspace();
  const originalRaw = JSON.stringify(workspace);
  const updated = copy(workspace); updated.analyses[0].title = '我的修改';
  const concurrent = copy(workspace); concurrent.analyses[0].title = '另一标签的修改';
  const concurrentRaw = JSON.stringify(concurrent);
  let reads = 0; let writes = 0; let stored = originalRaw;
  const interleaved = {
    getItem(key) {
      assert.equal(key, STORAGE_KEY);
      if (++reads === 2) stored = concurrentRaw;
      return stored;
    },
    setItem() { writes++; },
  };
  const conflict = saveWorkspace(interleaved, updated, originalRaw);
  assert.equal(conflict.ok, false); assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.raw, concurrentRaw); assert.equal(reads, 2); assert.equal(writes, 0); assert.equal(stored, concurrentRaw);

  const matching = memoryStorage(originalRaw);
  assert.equal(saveWorkspace(matching, updated, originalRaw).status, 'saved');
  assert.equal(loadWorkspace(matching).workspace.analyses[0].title, '我的修改');

  const initialEmpty = memoryStorage();
  assert.equal(saveWorkspace(initialEmpty, workspace, null).status, 'saved');
  // Exact text matters: identical data with different formatting is a change.
  const reformatted = memoryStorage(JSON.stringify(workspace, null, 2));
  assert.equal(saveWorkspace(reformatted, updated, originalRaw).status, 'conflict');
  assert.equal(reformatted.writes, 0);
  // Omission preserves the original unguarded API.
  const unguarded = memoryStorage(originalRaw);
  assert.equal(saveWorkspace(unguarded, updated).status, 'saved');
});

test('URL canonical expansion is bounded and every accepted link survives save then load', () => {
  const oversized = linkedWorkspace();
  const originalUrl = `https://example.com/${'中'.repeat(300)}`;
  assert.ok(originalUrl.length < LIMITS.url);
  assert.ok(new URL(originalUrl).href.length > LIMITS.url);
  oversized.analyses[0].claims[0].links = [originalUrl];
  const rejected = validateWorkspace(oversized);
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(';'), /规范化后/);
  const emptyStore = memoryStorage();
  assert.equal(saveWorkspace(emptyStore, oversized).status, 'invalid');
  assert.equal(emptyStore.writes, 0);

  const accepted = linkedWorkspace();
  accepted.analyses[0].claims[0].links = [`https://example.com/${'中'.repeat(224)}`];
  const validated = validateWorkspace(accepted);
  assert.equal(validated.ok, true, validated.errors.join(';'));
  assert.ok(validated.value.analyses[0].claims[0].links[0].length <= LIMITS.url);
  const store = memoryStorage();
  assert.equal(saveWorkspace(store, accepted).ok, true);
  const loaded = loadWorkspace(store);
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.workspace, validated.value);
});

test('serialized capacity includes JSON escapes and rejects oversized merges before saving', () => {
  const createLarge = () => {
    const workspace = createWorkspace();
    workspace.analyses[0].inbox = Array.from({ length: 90 }, () => ({ ...createRecord('inbox'), text: '\n'.repeat(6000) }));
    return workspace;
  };
  const existing = createLarge();
  const incoming = createLarge();
  assert.equal(validateWorkspace(existing).ok, true);
  assert.equal(validateWorkspace(incoming).ok, true);
  const before = copy(existing);
  const merged = mergeImport(existing, incoming);
  assert.equal(merged.ok, false);
  assert.match(merged.errors.join(';'), /序列化后.*无法保存/);
  assert.deepEqual(existing, before);

  const excessive = copy(existing);
  excessive.analyses.push(copy(incoming.analyses[0]));
  // Raw text stays below the character budget; JSON newline escaping doubles it.
  assert.ok(excessive.analyses.reduce((total, analysis) => total + analysis.inbox.reduce((sum, item) => sum + item.text.length, 0), 0) < LIMITS.importChars);
  assert.ok(JSON.stringify(excessive).length > LIMITS.importChars);
  assert.equal(validateWorkspace(excessive).ok, false);
  const store = memoryStorage();
  assert.equal(saveWorkspace(store, excessive).status, 'invalid');
  assert.equal(store.writes, 0);
  // Each accepted large workspace still satisfies read-your-write consistency.
  assert.equal(saveWorkspace(store, existing).ok, true);
  assert.deepEqual(loadWorkspace(store).workspace, existing);
});

test('Markdown does not invent zero, income, results or computed output and escapes active syntax', () => {
  const a = createExampleAnalysis();
  a.title = '<img src=x onerror=alert(1)> [click](javascript:alert(1))';
  a.inbox[0].text = '<script>alert(1)</script>';
  const output = exportMarkdown(a);
  assert.match(output, /差异化内容可能吸引付费方/);
  assert.match(output, /数值：未填写/); assert.match(output, /指标：未填写/); assert.match(output, /结果：未填写/);
  assert.doesNotMatch(output, /数值：0|收入：0|结果：0/);
  assert.doesNotMatch(output, /<script>|<img/);
  assert.match(output, /&lt;script&gt;/); assert.match(output, /\\\[click\\\]/);
  assert.match(output, /此导出不计算结果/);
  assert.match(output, /算式：未填写 \+ 未填写/);

  const linked = getAnalysis(linkedWorkspace());
  const readable = exportMarkdown(linked);
  assert.match(readable, /依据主张：待验证假设/);
  assert.match(readable, /父问题：父问题/);
  assert.match(readable, /关联主张：推断/);
  assert.match(readable, /关联方案：候选/);
  assert.match(readable, /关联问题：子问题/);
  assert.match(readable, /关联实验：验证/);
  assert.match(readable, /算式：观察值 \+ 估计值/);
  for (const section of ['claims', 'breakdown', 'options', 'data', 'experiments']) {
    for (const item of linked[section]) assert.equal(readable.includes(item.id), false);
  }
  // Duplicated names use the same short distinguishing suffix in headings/refs.
  linked.data[1].label = linked.data[0].label;
  const ambiguous = exportMarkdown(linked);
  const leftName = `观察值（${linked.data[0].id.slice(-8)}）`;
  const rightName = `观察值（${linked.data[1].id.slice(-8)}）`;
  assert.ok(ambiguous.includes(`### 1. ${leftName}`));
  assert.ok(ambiguous.includes(`### 2. ${rightName}`));
  assert.ok(ambiguous.includes(`算式：${leftName} + ${rightName}`));
});
