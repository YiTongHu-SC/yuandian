/** Pure helpers for the local workbench. No DOM, storage, network, or evaluation. */
const OPERATORS = new Set(['+', '-', '*', '/']);
const SECTIONS = new Set(['inbox', 'concepts', 'claims', 'breakdown', 'options', 'data', 'calculations', 'experiments', 'tasks']);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const text = value => typeof value === 'string' ? value.trim() : '';
const rows = (analysis, section) => Array.isArray(analysis?.[section]) ? analysis[section] : [];

function finiteNumber(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return null;
  const number = Number(value.trim());
  if (!Number.isFinite(number)) return null;
  // Do not silently turn a nonzero decimal below Number's range into zero.
  if (number === 0 && /[1-9]/.test(value.trim().split(/[eE]/)[0])) return null;
  return number;
}

function inferredUnit(left, right, operator) {
  if (operator === '+' || operator === '-') return left;
  if (operator === '*') return left && right ? `(${left})·(${right})` : left || right;
  if (left === right) return '';
  if (!right) return left;
  return left ? `(${left})/(${right})` : `1/(${right})`;
}

/**
 * Calculate only two finite decimal strings (scientific notation is allowed).
 * inputKinds preserves left/right order; a missing record has kind "unknown".
 * resultUnit is an optional user label, never a conversion instruction.
 */
export function calculate(analysis, calculation) {
  const data = rows(analysis, 'data');
  const left = data.find(item => item.id === calculation?.leftId);
  const right = data.find(item => item.id === calculation?.rightId);
  const inputKinds = [left?.kind || 'unknown', right?.kind || 'unknown'];
  const hypothetical = inputKinds.some(kind => kind === 'estimate' || kind === 'target');
  const notice = hypothetical
    ? '输入含估计值或目标值；结果仅为演算，不是观察值，也不能据此推出因果关系。'
    : '这是按所填数据得到的算术结果，不是新的观察值，也不能据此推出因果关系。';
  const fail = message => ({ ok: false, message: hypothetical ? `${message} ${notice}` : message, inputKinds });
  const operator = calculation?.operator;
  if (!OPERATORS.has(operator)) return fail('仅支持 +、-、*、/ 四种运算。');
  if (!left || !right) return fail('请先选择两条有效数据；缺失的数据视为未知，不能当作0。');
  const leftValue = finiteNumber(left.value);
  const rightValue = finiteNumber(right.value);
  if (leftValue === null || rightValue === null) {
    return fail('输入需为有限的纯数字字符串；空白、文本或超出数值范围的输入视为未知，不能当作0。');
  }
  const leftUnit = text(left.unit);
  const rightUnit = text(right.unit);
  const resultUnit = text(calculation.resultUnit);
  if ((operator === '+' || operator === '-') && leftUnit !== rightUnit) {
    return fail('加减运算的输入单位不一致，请先统一单位；工具不做单位换算。');
  }
  if ((operator === '+' || operator === '-') && leftUnit && resultUnit && resultUnit !== leftUnit) {
    return fail('结果单位与输入单位不一致，请先统一单位；工具不做单位换算。');
  }
  if (operator === '/' && rightValue === 0) return fail('不能除以0，请检查右侧数据。');
  let value;
  switch (operator) {
    case '+': value = leftValue + rightValue; break;
    case '-': value = leftValue - rightValue; break;
    case '*': value = leftValue * rightValue; break;
    case '/': value = leftValue / rightValue; break;
  }
  if (!Number.isFinite(value)) return fail('运算结果溢出有限数值范围，请调整输入或计算方式。');
  return {
    ok: true,
    value: Object.is(value, -0) ? 0 : value,
    unit: resultUnit || inferredUnit(leftUnit, rightUnit, operator),
    message: `${notice} 工具不做单位换算，结果单位需自行核对。`,
    inputKinds,
  };
}

function removeReferences(items, field, id) {
  for (const item of items) {
    if (!Array.isArray(item[field])) continue;
    for (let index = item[field].length - 1; index >= 0; index -= 1) {
      if (item[field][index] === id) item[field].splice(index, 1);
    }
  }
}

function clearReferences(items, field, id) {
  for (const item of items) if (item[field] === id) item[field] = '';
}

/** Remove one existing record in place and detach its references. Returns removed. */
export function detachRecord(analysis, section, id) {
  if (!SECTIONS.has(section) || typeof id !== 'string' || !id) return false;
  const collection = rows(analysis, section);
  const index = collection.findIndex(item => item.id === id);
  if (index < 0) return false;
  const removed = collection[index];
  collection.splice(index, 1);
  switch (section) {
    case 'claims':
      removeReferences(rows(analysis, 'claims'), 'basisIds', id);
      removeReferences(rows(analysis, 'breakdown'), 'claimIds', id);
      removeReferences(rows(analysis, 'options'), 'claimIds', id);
      clearReferences(rows(analysis, 'data'), 'claimId', id);
      clearReferences(rows(analysis, 'experiments'), 'claimId', id);
      break;
    case 'breakdown':
      for (const child of rows(analysis, 'breakdown')) {
        if (child.parentId === id) child.parentId = removed.parentId || null;
      }
      clearReferences(rows(analysis, 'experiments'), 'questionId', id);
      break;
    case 'options':
      clearReferences(rows(analysis, 'experiments'), 'optionId', id);
      break;
    case 'data':
      clearReferences(rows(analysis, 'calculations'), 'leftId', id);
      clearReferences(rows(analysis, 'calculations'), 'rightId', id);
      break;
    case 'experiments':
      clearReferences(rows(analysis, 'tasks'), 'experimentId', id);
      break;
  }
  return true;
}

function equalContent(left, right, analysisRoot = false) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => equalContent(item, right[index]));
  }
  const keys = value => Object.keys(value).filter(key => !analysisRoot || key !== 'updatedAt').sort();
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalContent(left[key], right[key]));
}

function analysisList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.analyses) ? value.analyses : [];
}

/**
 * Return local additions/edits as original references, without changing inputs.
 * Accepts workspaces or analysis arrays. Only top-level updatedAt is ignored;
 * record/array order and all other fields are content. Deletions are not returned.
 */
export function changedAnalyses(base, local) {
  const originals = new Map(analysisList(base).map(analysis => [analysis.id, analysis]));
  return analysisList(local).filter(analysis => {
    const original = originals.get(analysis.id);
    return !original || !equalContent(original, analysis, true);
  });
}

/** Safe basename (no extension added), at most 80 Unicode code points. */
export function safeFileName(value) {
  let name = typeof value === 'string' ? value : '';
  name = name.normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  name = Array.from(name).slice(0, 80).join('').replace(/[.\s-]+$/g, '');
  return name || '分析记录';
}
