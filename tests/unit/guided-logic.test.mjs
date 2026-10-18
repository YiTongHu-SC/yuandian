import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, detachRecord, changedAnalyses, safeFileName } from '../../src/guided/logic.js';
import { createAnalysis, createRecord, validateWorkspace, SCHEMA_VERSION } from '../../src/guided/model.js';

function calculationFixture(leftValue, rightValue, extras = {}) {
  const analysis = {
    data: [
      { id: 'left', value: leftValue, unit: '', kind: 'observed', ...extras.left },
      { id: 'right', value: rightValue, unit: '', kind: 'observed', ...extras.right },
    ],
  };
  const calculation = { leftId: 'left', rightId: 'right', operator: '+', resultUnit: '', ...extras.calculation };
  return { analysis, calculation };
}

function compute(left, right, extras) {
  const fixture = calculationFixture(left, right, extras);
  return calculate(fixture.analysis, fixture.calculation);
}

test('empty, textual, nondecimal and nonfinite values are unknown rather than zero', () => {
  for (const value of ['', ' ', '\n', '未知', '12人', '1,000', '12%', '1/2', '0x10', '0b10', 'Infinity', 'NaN', '1e309', '1e-9999', null, undefined, 12]) {
    const result = compute(value, '0');
    assert.equal(result.ok, false, `must reject ${String(value)}`);
    assert.equal('value' in result, false);
    assert.match(result.message, /未知/);
  }
});

test('zero is valid and finite decimal/scientific strings calculate normally', () => {
  assert.equal(compute('0', '0').value, 0);
  assert.equal(compute('  -1.5 ', '.5').value, -1);
  assert.equal(compute('+2e2', '1.').value, 201);
  assert.equal(compute('8', '2', { calculation: { operator: '-' } }).value, 6);
  assert.equal(compute('8', '2', { calculation: { operator: '*' } }).value, 16);
  assert.equal(compute('8', '2', { calculation: { operator: '/' } }).value, 4);
  assert.match(compute('0', '2').message, /算术结果.*不是新的观察值.*因果/);
});

test('missing records and operators outside the allowlist fail without evaluation', () => {
  assert.equal(calculate({ data: [] }, { operator: '+' }).ok, false);
  assert.deepEqual(calculate({ data: [] }, { operator: '+' }).inputKinds, ['unknown', 'unknown']);
  for (const operator of ['**', '%', 'Math.max', '', null]) {
    assert.equal(compute('2', '3', { calculation: { operator } }).ok, false);
  }
  globalThis.logicTestEvaluated = false;
  assert.equal(compute('(globalThis.logicTestEvaluated=true)', '1').ok, false);
  assert.equal(globalThis.logicTestEvaluated, false);
  delete globalThis.logicTestEvaluated;
});

test('division by positive/negative zero and result overflow fail', () => {
  for (const value of ['0', '-0', '0e9']) {
    assert.match(compute('4', value, { calculation: { operator: '/' } }).message, /不能除以0/);
  }
  for (const operator of ['+', '*', '/']) {
    const result = operator === '/'
      ? compute('1e308', '1e-308', { calculation: { operator } })
      : compute('1e308', '1e308', { calculation: { operator } });
    assert.equal(result.ok, false);
    assert.match(result.message, /溢出/);
  }
});

test('addition/subtraction require matching units and cannot relabel a conversion', () => {
  for (const operator of ['+', '-']) {
    for (const rightUnit of ['美元', '']) {
      const result = compute('1', '2', { left: { unit: '元' }, right: { unit: rightUnit }, calculation: { operator, resultUnit: '元' } });
      assert.equal(result.ok, false);
      assert.match(result.message, /先统一单位/);
    }
  }
  assert.equal(compute('1', '2', { left: { unit: ' 元 ' }, right: { unit: '元' } }).unit, '元');
  assert.equal(compute('1', '2', { left: { unit: '元' }, right: { unit: '元' }, calculation: { resultUnit: '美元' } }).ok, false);
});

test('multiplication/division expose units and never claim automatic conversion', () => {
  const product = compute('4', '2', { left: { unit: '元/件' }, right: { unit: '件' }, calculation: { operator: '*', resultUnit: '元' } });
  assert.equal(product.value, 8);
  assert.equal(product.unit, '元');
  assert.match(product.message, /不做单位换算/);
  assert.equal(compute('4', '2', { left: { unit: '元' }, right: { unit: '件' }, calculation: { operator: '/' } }).unit, '(元)/(件)');
  assert.equal(compute('4', '2', { left: { unit: '元' }, right: { unit: '元' }, calculation: { operator: '/' } }).unit, '');
});

test('estimate and target inputs mark all results as scenarios, with ordered inputKinds', () => {
  for (const kind of ['estimate', 'target']) {
    const result = compute('4', '2', { right: { kind } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.inputKinds, ['observed', kind]);
    assert.match(result.message, /演算.*不是观察值.*因果/);
    assert.match(compute('', '2', { right: { kind } }).message, /演算.*不是观察值/);
  }
  const fixture = calculationFixture('4', '2');
  const before = structuredClone(fixture);
  calculate(fixture.analysis, fixture.calculation);
  assert.deepEqual(fixture, before);
});

function graphFixture() {
  const a = createAnalysis('引用清理');
  const add = (section, id, fields = {}) => {
    const record = { ...createRecord(section), id, ...fields };
    a[section].push(record);
    return record;
  };
  add('claims', 'c1');
  add('claims', 'c2', { basisIds: ['c1'] });
  add('claims', 'c3', { basisIds: ['c1', 'c2'] });
  add('breakdown', 'q0');
  add('breakdown', 'q1', { parentId: 'q0', claimIds: ['c1', 'c2'] });
  add('breakdown', 'q2', { parentId: 'q1', claimIds: ['c1'] });
  add('breakdown', 'q3', { parentId: 'q2' });
  add('options', 'o1', { claimIds: ['c1', 'c2'] });
  add('options', 'o2', { claimIds: ['c2'] });
  add('data', 'd1', { claimId: 'c1' });
  add('data', 'd2', { claimId: 'c2' });
  add('calculations', 'k1', { leftId: 'd1', rightId: 'd2' });
  add('calculations', 'k2', { leftId: 'd2', rightId: 'd1' });
  add('experiments', 'e1', { optionId: 'o1', claimId: 'c1', questionId: 'q1' });
  add('experiments', 'e2', { optionId: 'o2', claimId: 'c2', questionId: 'q2' });
  add('tasks', 't1', { experimentId: 'e1' });
  add('tasks', 't2', { experimentId: 'e2' });
  return a;
}

function assertValid(analysis) {
  const result = validateWorkspace({ schemaVersion: SCHEMA_VERSION, activeId: analysis.id, analyses: [analysis] });
  assert.equal(result.ok, true, result.errors.join('; '));
}

test('deleting a claim clears every supported association and preserves other records', () => {
  const a = graphFixture();
  assertValid(a);
  const originalClaims = a.claims;
  assert.equal(detachRecord(a, 'claims', 'c1'), true);
  assert.equal(a.claims, originalClaims);
  assert.deepEqual(a.claims.map(item => item.basisIds), [[], ['c2']]);
  assert.deepEqual(a.breakdown[1].claimIds, ['c2']);
  assert.deepEqual(a.breakdown[2].claimIds, []);
  assert.deepEqual(a.options[0].claimIds, ['c2']);
  assert.equal(a.data[0].claimId, '');
  assert.equal(a.experiments[0].claimId, '');
  assert.equal(a.data[1].claimId, 'c2');
  assert.equal(a.tasks.length, 2);
  assertValid(a);
});

test('deleting a question reparents direct children and clears experiment questions', () => {
  const a = graphFixture();
  detachRecord(a, 'breakdown', 'q1');
  assert.equal(a.breakdown.find(item => item.id === 'q2').parentId, 'q0');
  assert.equal(a.breakdown.find(item => item.id === 'q3').parentId, 'q2');
  assert.equal(a.experiments[0].questionId, '');
  assert.equal(a.experiments[1].questionId, 'q2');
  assertValid(a);
  detachRecord(a, 'breakdown', 'q0');
  assert.equal(a.breakdown.find(item => item.id === 'q2').parentId, null);
  assertValid(a);
});

test('deleting an option preserves experiments and their tasks', () => {
  const a = graphFixture();
  detachRecord(a, 'options', 'o1');
  assert.equal(a.experiments[0].optionId, '');
  assert.equal(a.experiments[1].optionId, 'o2');
  assert.equal(a.experiments.length, 2);
  assert.equal(a.tasks[0].experimentId, 'e1');
  assertValid(a);
});

test('deleting data clears both calculation input positions without deleting calculations', () => {
  const a = graphFixture();
  detachRecord(a, 'data', 'd1');
  assert.equal(a.calculations[0].leftId, '');
  assert.equal(a.calculations[0].rightId, 'd2');
  assert.equal(a.calculations[1].leftId, 'd2');
  assert.equal(a.calculations[1].rightId, '');
  assert.equal(a.calculations.length, 2);
  assertValid(a);
});

test('deleting an experiment keeps tasks but clears their experiment reference', () => {
  const a = graphFixture();
  detachRecord(a, 'experiments', 'e1');
  assert.equal(a.tasks.length, 2);
  assert.equal(a.tasks[0].experimentId, '');
  assert.equal(a.tasks[1].experimentId, 'e2');
  assertValid(a);
});

test('invalid or stale deletion requests leave content unchanged', () => {
  const a = graphFixture();
  const before = structuredClone(a);
  for (const section of ['unknown', '__proto__', 'constructor', 'goal']) assert.equal(detachRecord(a, section, 'c1'), false);
  assert.equal(detachRecord(a, 'claims', ''), false);
  assert.equal(detachRecord(a, 'claims', 'missing'), false);
  assert.deepEqual(a, before);
});

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('changedAnalyses returns only edits/additions, ignores timestamps and object key order', () => {
  const base = { analyses: [{ id: 'a', title: '一', updatedAt: 'old', goal: { outcome: '目标', why: '' } }, { id: 'b', title: '二' }, { id: 'deleted', title: '删除' }] };
  const untouched = { goal: { why: '', outcome: '目标' }, updatedAt: 'new', title: '一', id: 'a' };
  const edited = { id: 'b', title: '已修改' };
  const added = { id: 'c', title: '新增' };
  const local = { analyses: [untouched, edited, added] };
  freezeDeep(base);
  freezeDeep(local);
  const result = changedAnalyses(base, local);
  assert.deepEqual(result, [edited, added]);
  assert.equal(result[0], edited);
  assert.equal(result[1], added);
  assert.deepEqual(changedAnalyses(base.analyses, local.analyses), result);
  assert.deepEqual(changedAnalyses(local, local), []);
});

test('nested updatedAt and array order remain meaningful content changes', () => {
  const original = { id: 'a', rows: [{ id: 'x', updatedAt: 'old' }, { id: 'y' }] };
  const nestedChange = structuredClone(original);
  nestedChange.rows[0].updatedAt = 'new';
  assert.deepEqual(changedAnalyses([original], [nestedChange]), [nestedChange]);
  const orderChange = structuredClone(original);
  orderChange.rows.reverse();
  assert.deepEqual(changedAnalyses([original], [orderChange]), [orderChange]);
  assert.deepEqual(changedAnalyses([original], []), []);
});

test('safeFileName keeps Chinese while neutralizing paths, controls and Windows names', () => {
  assert.equal(safeFileName('我的第一性原理分析'), '我的第一性原理分析');
  for (const value of ['../../目标\\计划:草稿?*.json', '\\服务器\\共享\\文件', 'A\u0000B\nC\u202eD']) {
    const name = safeFileName(value);
    assert.ok(name.length > 0);
    assert.doesNotMatch(name, /[<>:"/\\|?*\p{Cc}\p{Cf}]/u);
    assert.doesNotMatch(name, /^[.\s]|[.\s]$/);
  }
  for (const value of ['CON', 'con.txt', 'LPT1', 'nul']) assert.match(safeFileName(value), /^_/);
  assert.equal(safeFileName('  ...  '), '分析记录');
  assert.equal(safeFileName(null), '分析记录');
  const long = safeFileName('中文😀'.repeat(100));
  assert.ok(Array.from(long).length <= 80);
  assert.doesNotMatch(long, /[\uD800-\uDBFF]$/);
});
