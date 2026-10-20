import {
  CANVAS_KEY,
  VERSION,
  LIMITS,
  COLORS,
  createWorkspace,
  createBoard,
  createNode,
  createSibling,
  connect,
  deleteNode,
  parseImport,
  importAppend,
  load,
  save,
  exportJSON
} from './model.js';
import { createHistory, snapshotBoard } from './history.js';
import { revisionOf } from './mcp-model.js';
import {
  listMcpCanvases,
  getMcpCanvas,
  applyMcpWorkspaceEdits,
  createMcpCanvas,
  exportMcpCanvas
} from './mcp-workspace-model.js';
import { createMcpPanel } from './mcp-ui.js';
import { getMcpConnection } from './mcp-connection.js';
import {
  clamp,
  coordinate as xy,
  worldPoint as clientToWorld,
  connectionCurve,
  directionalNode,
  rectangleBetween,
  nodesInRectangle,
  groupDragDelta,
  NODE_WIDTH,
  NODE_HEIGHT
} from './geometry.js';

const $ = (s) => document.querySelector(s);
const mcpConnection = getMcpConnection(location);
const copy = (x) => structuredClone(x);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  children.flat(Infinity).forEach((c) => {
    if (c !== null && c !== undefined && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return el;
}
const button = (text, click, cls = '', attrs = {}) =>
  h('button', { type: 'button', class: cls, onClick: click, ...attrs }, text);
let storage;
try {
  storage = localStorage;
} catch {
  storage = null;
}
const loaded = load(storage);
let workspace = loaded.workspace || createWorkspace(),
  savedRaw = loaded.raw ?? null,
  dirty = false,
  saveTimer,
  saveError = '';
let corrupt = loaded.status === 'invalid',
  conflict = false,
  selection = null,
  editing = null,
  dragging = null,
  connecting = false,
  connectFrom = null;
let spaceHeld = false;
let stage,
  world,
  svg,
  nodesLayer,
  nodeEls = new Map(),
  toastTimer;
let cardMenuOpen = false,
  toolsSelection = '';
let fileImportCandidate = null,
  fileReadTicket = 0,
  fileImportActive = false;
let mcpPanel = null;
const histories = createHistory();
const board = () => workspace.boards.find((b) => b.id === workspace.activeId);
const activeNode = () =>
  board()?.nodes.find(
    (n) => n.id === selection?.id && selection.kind === 'node'
  );
const selectedNodeIds = () =>
  selection?.kind === 'nodes'
    ? selection.ids
    : selection?.kind === 'node' ? [selection.id] : [];
function selectNodes(ids) {
  selection = ids.length > 1
    ? { kind: 'nodes', ids }
    : ids.length ? { kind: 'node', id: ids[0] } : null;
}
const snapshot = () => snapshotBoard(board());
function note(text, action, label = '撤销') {
  clearTimeout(toastTimer);
  $('.toast')?.remove();
  const el = h(
    'div',
    { class: 'toast', role: 'status' },
    text,
    action
      ? button(
          label,
          () => {
            action();
            el.remove();
          },
          'small',
          { style: 'margin-left:12px' }
        )
      : null
  );
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 7000);
}
function status() {
  const el = $('#save-state');
  if (!el) return;
  const err = corrupt
    ? '原存储异常，未覆盖'
    : conflict
      ? '另一页有更新，保存已暂停'
      : saveError;
  el.textContent = err || (dirty ? '正在保存…' : '已保存 · 本机');
  el.title = err || '记录属于当前浏览器，请定期导出 JSON';
  el.className = `save-state${err ? ' error' : ''}`;
}
function markDirty() {
  if (board()) board().updatedAt = new Date().toISOString();
  dirty = true;
  saveError = '';
  status();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 350);
}
function flush() {
  clearTimeout(saveTimer);
  const perform = () => {
    if (!dirty || corrupt || conflict) return false;
    if (dragging) {
      saveTimer = setTimeout(flush, 350);
      return false;
    }
    let raw;
    try {
      raw = storage.getItem(CANVAS_KEY);
    } catch {
      saveError = '保存不可用，请导出备份';
      status();
      return false;
    }
    if (raw !== savedRaw) {
      conflict = true;
      showRecovery();
      status();
      return false;
    }
    const r = save(storage, workspace, savedRaw);
    if (r.ok) {
      savedRaw = storage.getItem(CANVAS_KEY);
      dirty = false;
      saveError = '';
    } else if (r.status === 'conflict') {
      conflict = true;
      showRecovery();
    } else saveError = r.error || '尚未保存，请导出备份';
    status();
    return r.ok;
  };
  return navigator.locks?.request
    ? navigator.locks.request(CANVAS_KEY, perform).catch(() => {
        saveError = '保存不可用，请导出备份';
        status();
        return false;
      })
    : perform();
}
function pushHistory(before) {
  histories.record(board(), before);
  updateTools();
}
function undo(redo = false) {
  finishEdit();
  if (!(redo ? histories.redo(board()) : histories.undo(board()))) return;
  selection = null;
  cancelConnect();
  markDirty();
  renderBoard();
}
function canConnectMcp() {
  if (corrupt) return '原存储异常，请先备份并恢复数据。';
  if (conflict) return '另一页有更新，请先处理保存冲突。';
  if (saveError) return saveError;
  try {
    storage.getItem(CANVAS_KEY);
  } catch {
    return '浏览器存储不可用，请先导出备份。';
  }
  return true;
}
function mcpWriteBlock() {
  const available = canConnectMcp();
  if (available !== true) return available;
  if (
    dirty ||
    editing ||
    dragging ||
    connecting ||
    fileImportActive ||
    document.querySelector('dialog[open]') ||
    document.activeElement?.id === 'board-title'
  )
    return '画布正在编辑或保存，请完成操作后重新读取并重试。';
  return '';
}
function mcpRevoked() {
  return {
    ok: false,
    code: 'authorization_revoked',
    error: '本次 AI 接入已断开，操作未应用。'
  };
}
async function readMcpWorkspace(operation, args, { isAuthorized } = {}) {
  if (!isAuthorized?.()) return mcpRevoked();
  const result = await operation(copy(workspace), args);
  if (!isAuthorized()) return mcpRevoked();
  const unavailable = canConnectMcp();
  return unavailable === true
    ? result
    : { ok: false, code: 'canvas_unavailable', error: unavailable };
}
const listMcpWorkspace = (args, context) =>
  readMcpWorkspace(listMcpCanvases, args, context);
const readMcpCanvas = (args, context) =>
  readMcpWorkspace(getMcpCanvas, args, context);
const exportMcpData = (args, context) =>
  readMcpWorkspace(exportMcpCanvas, args, context);

function acceptMcpSave(next) {
  const saved = save(storage, next, savedRaw);
  if (!saved.ok) {
    if (saved.status === 'conflict') {
      conflict = true;
      showRecovery();
    } else saveError = saved.error || '保存失败，AI 修改未应用。';
    status();
    return { ok: false, code: saved.status, error: saved.error };
  }
  workspace = next;
  savedRaw = saved.raw;
  dirty = false;
  saveError = '';
  return { ok: true };
}

async function writeMcpWorkspace(args, { isAuthorized } = {}, operation, applied) {
  const authorized = () => typeof isAuthorized === 'function' && isAuthorized();
  const commit = async () => {
    if (!authorized()) return mcpRevoked();
    const blocked = mcpWriteBlock();
    if (blocked) return { ok: false, code: 'canvas_busy', error: blocked };
    const before = copy(workspace);
    const original = JSON.stringify(workspace);
    const result = await operation(copy(workspace), args);
    if (!authorized()) return mcpRevoked();
    if (!result.ok) return result;
    // Hashing is asynchronous: recheck local edits and cross-page state before saving.
    if (mcpWriteBlock() || JSON.stringify(workspace) !== original)
      return {
        ok: false,
        code: 'revision_conflict',
        error: '工作区已经变化，请重新读取后再操作。'
      };
    const saved = acceptMcpSave(result.workspace);
    if (!saved.ok) return saved;
    const output = applied(result, before);
    status();
    return output;
  };
  try {
    return await (navigator.locks?.request
      ? navigator.locks.request(CANVAS_KEY, commit)
      : commit());
  } catch {
    return {
      ok: false,
      code: 'operation_failed',
      error: 'AI 操作未完成，请重新读取后重试。'
    };
  }
}
function editMcpCanvas(args, context) {
  return writeMcpWorkspace(args, context, applyMcpWorkspaceEdits, (result, before) => {
    const target = workspace.boards.find((item) => item.id === result.boardId);
    const previous = before.boards.find((item) => item.id === result.boardId);
    histories.record(target, snapshotBoard(previous));
    updateBoardMenu();
    if (workspace.activeId === target.id) {
      selection = null;
      closeMenus();
      cancelConnect();
      renderBoard();
    } else updateTools();
    note(`AI 已更新“${target.title || '未命名画布'}”，可在该画布撤销。`);
    return { ok: true, boardId: target.id, revision: result.revision, created: result.created };
  });
}
function createMcpBoard(args, context) {
  return writeMcpWorkspace(args, context, createMcpCanvas, (result) => {
    updateBoardMenu();
    updateTools();
    note(`AI 已新增画布“${result.board.title || '未命名画布'}”。`,
      () => void undoMcpCreation(result.board.id, result.revision));
    return {
      ok: true,
      board: result.board,
      revision: result.revision,
      workspaceRevision: result.workspaceRevision
    };
  });
}
async function undoMcpCreation(boardId, createdRevision) {
  const commit = async () => {
    const blocked = mcpWriteBlock();
    if (blocked) return note(blocked);
    const original = JSON.stringify(workspace);
    const target = workspace.boards.find((item) => item.id === boardId);
    if (!target) return note('这张画布已不存在。');
    if (await revisionOf(target) !== createdRevision)
      return note('新增画布已有内容改动，请通过画布菜单处理。');
    if (mcpWriteBlock() || JSON.stringify(workspace) !== original)
      return note('工作区正在变化，请完成操作后重试。');
    const next = copy(workspace);
    next.boards = next.boards.filter((item) => item.id !== boardId);
    if (!next.boards.length) return note('当前只剩这张画布，无法撤销新增。');
    const wasActive = next.activeId === boardId;
    if (wasActive) next.activeId = next.boards[0].id;
    const saved = acceptMcpSave(next);
    if (!saved.ok) return note(saved.error || '撤销未保存，请重试。');
    updateBoardMenu();
    if (wasActive) {
      selection = null;
      renderBoard();
    } else updateTools();
    status();
    note('已撤销 AI 新增的画布。');
  };
  try {
    await (navigator.locks?.request ? navigator.locks.request(CANVAS_KEY, commit) : commit());
  } catch {
    note('撤销未完成，请先备份数据。');
  }
}
function toggleMcpPanel() {
  finishEdit();
  closeMenus();
  cancelConnect();
  // The panel must stay reachable to revoke permanent consent while saving is
  // paused. Its authorize/restore paths check canConnectMcp themselves.
  $('.help-pop')?.remove();
  mcpPanel.toggle();
}
function optionLabel(b) {
  const same = workspace.boards.filter((x) => x.title === b.title);
  return `${b.title || '未命名画布'}${same.length > 1 ? ` · ${same.indexOf(b) + 1}/${same.length}` : ''}`;
}
function updateBoardMenu() {
  const el = $('#board-menu');
  if (!el) return;
  el.replaceChildren(
    ...workspace.boards.map((b) =>
      button(
        optionLabel(b),
        () => {
          finishEdit();
          workspace.activeId = b.id;
          selection = null;
          closeMenus();
          cancelConnect();
          markDirty();
          renderBoard();
          stage.focus();
        },
        `board-entry${b.id === workspace.activeId ? ' current' : ''}`,
        {
          'aria-label': `切换到画布：${optionLabel(b)}`,
          'aria-current': b.id === workspace.activeId ? 'true' : null
        }
      )
    ),
    h('hr'),
    button('＋ 新画布', newBoard),
    button(
      '删除当前画布…',
      () => {
        closeMenus();
        removeBoard();
      },
      'danger'
    )
  );
}
function closeMenus() {
  cardMenuOpen = false;
  $('#card-menu')?.setAttribute('hidden', '');
  $('#card-more')?.setAttribute('aria-expanded', 'false');
  $('#board-menu')?.setAttribute('hidden', '');
  $('#board-menu-toggle')?.setAttribute('aria-expanded', 'false');
  closeFileMenu();
}
function toggleBoardMenu() {
  finishEdit();
  mcpPanel?.close();
  const opening = $('#board-menu').hidden;
  closeMenus();
  updateBoardMenu();
  $('#board-menu').hidden = !opening;
  $('#board-menu-toggle').setAttribute('aria-expanded', String(opening));
  if (opening) $('#board-menu button')?.focus();
}
function build() {
  const title = h('input', {
    id: 'board-title',
    class: 'title-input',
    type: 'text',
    maxlength: LIMITS.title,
    'aria-label': '画布名称',
    title: '点击修改画布名称',
    onFocus: closeMenus,
    onInput: (e) => {
      board().title = e.target.value;
      markDirty();
    }
  });
  const toolbar = h(
    'div',
    { class: 'toolbar', 'aria-label': '画布操作' },
    button('＋ 卡片', () => addIdea(), 'primary', { 'aria-label': '新增卡片' }),
    button('↶', () => undo(), '', {
      id: 'undo',
      title: '撤销 Ctrl / ⌘ Z',
      'aria-label': '撤销'
    }),
    button('↷', () => undo(true), '', {
      id: 'redo',
      title: '重做 Ctrl / ⌘ Shift Z',
      'aria-label': '重做'
    })
  );
  const top = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, '·'),
      h('div', { class: 'brand-name' }, '原点')
    ),
    h(
      'div',
      { class: 'board-picker', id: 'board-picker' },
      title,
      button('⌄', toggleBoardMenu, 'ghost small', {
        id: 'board-menu-toggle',
        'aria-label': '画布菜单',
        'aria-expanded': 'false',
        'aria-controls': 'board-menu'
      }),
      h('div', {
        id: 'board-menu',
        class: 'board-menu popup-menu',
        hidden: true,
        'aria-label': '切换与管理画布'
      })
    ),
    h('div', { class: 'top-grow' }),
    toolbar,
    h(
      'div',
      { class: 'top-actions' },
      h('span', { id: 'save-state', class: 'save-state', role: 'status' }),
      h(
        'div',
        { id: 'file-picker', class: 'file-picker' },
        button('文件', toggleFileMenu, 'ghost small', {
          id: 'file-menu-toggle',
          'aria-expanded': 'false',
          'aria-controls': 'file-menu'
        }),
        h(
          'div',
          {
            id: 'file-menu',
            class: 'file-menu popup-menu',
            hidden: true,
            'aria-label': '文件与备份'
          },
          button('导出当前画布', () => exportFromMenu(false)),
          button('备份全部画布', () => exportFromMenu(true)),
          button('导入 JSON…', chooseImportFile, '', {
            id: 'file-import-trigger'
          }),
          h('input', {
            id: 'file-import-input',
            type: 'file',
            accept: '.json,application/json',
            hidden: true,
            'aria-label': '选择画布 JSON 备份',
            onChange: readImportFile,
            onCancel: cancelFileImport
          }),
          h('div', {
            id: 'file-import-panel',
            class: 'file-import-panel',
            hidden: true
          })
        )
      ),
      mcpConnection.available
        ? button('AI 接入', toggleMcpPanel, 'ghost small', {
            id: 'ai-menu-toggle',
            title: 'MCP 配置与接入',
            'aria-controls': 'mcp-panel',
            'aria-expanded': 'false'
          })
        : null,
      button('帮助', toggleHelp, 'ghost small')
    )
  );
  stage = h('div', {
    class: 'stage',
    id: 'stage',
    tabindex: '0',
    'aria-label': '自由思考画布，左键框选或单选，右键拖动平移，双击空白处新增卡片'
  });
  world = h('div', { class: 'world' });
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('edges');
  svg.setAttribute('aria-label', '卡片之间的连接');
  nodesLayer = h('div', { class: 'nodes' });
  world.append(svg, nodesLayer);
  stage.append(world);
  const wrap = h(
    'main',
    { class: 'stage-wrap' },
    stage,
    h('div', {
      id: 'selection-tools',
      class: 'selection-tools floating hidden',
      'aria-label': '所选卡片操作',
      onPointerdown: (e) => e.preventDefault()
    }),
    h('div', { id: 'connect-message' }),
    h('div', { id: 'recovery' }),
    h('div', { id: 'empty' }),
    h(
      'div',
      { class: 'zoom floating' },
      button('−', () => zoomAt(0.8), '', { 'aria-label': '缩小画布' }),
      h('span', { class: 'percent', id: 'zoom' }),
      button('＋', () => zoomAt(1.25), '', { 'aria-label': '放大画布' }),
      h('div', { class: 'sep' }),
      button('显示全部', fitAll, 'fit', { 'aria-label': '显示全部卡片' })
    )
  );
  $('#app').replaceChildren(h('div', { class: 'workspace' }, top, wrap));
  updateBoardMenu();
  bindCanvas();
  renderBoard();
  status();
  showRecovery();
}
function renderBoard() {
  cancelDrag();
  editing = null;
  nodeEls = new Map();
  nodesLayer.replaceChildren();
  const b = board();
  if (!b) return;
  $('#board-title').value = b.title;
  for (const n of b.nodes) {
    const text = h('div', { class: 'idea-text' }, n.text);
    const el = h(
      'article',
      {
        class: `idea ${n.color}`,
        tabindex: '0',
        'data-node-id': n.id,
        'aria-label': `卡片：${n.text.slice(0, 80) || '空白卡片'}`,
        onDblclick: (e) => {
          if (e.target.closest('textarea')) return;
          e.stopPropagation();
          beginEdit(
            n.id,
            textCursor(el.querySelector('.idea-text'), e.clientX, e.clientY)
          );
        },
        onFocus: (e) => {
          if (e.target !== e.currentTarget) return;
          if (!selectedNodeIds().includes(n.id))
            selection = { kind: 'node', id: n.id };
          updateTools();
          renderEdges();
        }
      },
      text
    );
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    nodeEls.set(n.id, el);
    nodesLayer.append(el);
  }
  applyView();
  updateTools();
  renderEdges();
  requestAnimationFrame(renderEdges);
  $('#empty').replaceChildren(
    b.nodes.length
      ? document.createTextNode('')
      : h(
          'div',
          { class: 'empty-guide' },
          button('＋ 写下第一个想法', () => addIdea(), 'primary')
        )
  );
}
function applyView() {
  const v = board().view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  $('#zoom').textContent = `${Math.round(v.scale * 100)}%`;
  stage.style.backgroundPosition = `${v.x}px ${v.y}px`;
  stage.style.backgroundSize = `${24 * v.scale}px ${24 * v.scale}px`;
  positionTools();
}
function renderEdges() {
  const NS = 'http://www.w3.org/2000/svg',
    make = (tag, attrs = {}) => {
      const el = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return el;
    };
  svg.replaceChildren();
  const defs = make('defs'),
    marker = make('marker', {
      id: 'arrow',
      markerWidth: 7,
      markerHeight: 7,
      refX: 6,
      refY: 3.5,
      orient: 'auto'
    });
  marker.append(make('path', { d: 'M0,0 L7,3.5 L0,7', fill: '#96ad93' }));
  defs.append(marker);
  svg.append(defs);
  for (const edge of board().edges) {
    const a = board().nodes.find((n) => n.id === edge.from),
      b = board().nodes.find((n) => n.id === edge.to);
    if (!a || !b) continue;
    const ah = nodeEls.get(a.id)?.offsetHeight || NODE_HEIGHT,
      bh = nodeEls.get(b.id)?.offsetHeight || NODE_HEIGHT;
    const { path: d, label: labelPosition } = connectionCurve(a, b, ah, bh),
      group = make('g', {
        class: `edge${selection?.kind === 'edge' && selection.id === edge.id ? ' selected' : ''}`
      });
    const hit = make('path', {
      d,
      class: 'edge-hit',
      'data-edge-id': edge.id,
      'aria-label': '选择连线'
    });
    group.append(
      hit,
      make('path', { d, class: 'edge-path', 'marker-end': 'url(#arrow)' })
    );
    if (edge.label) {
      const label = make('text', {
        ...labelPosition,
        class: 'edge-label',
        'text-anchor': 'middle'
      });
      label.textContent = edge.label;
      group.append(label);
    }
    svg.append(group);
  }
  positionTools();
}
// This layer is outside the scaled world so labels and hit targets stay readable.
function positionTools() {
  const tools = $('#selection-tools');
  if (!tools || tools.classList.contains('hidden') || !selection) return;
  const viewport = stage.getBoundingClientRect();
  let anchor;
  if (selection.kind === 'node') {
    anchor = nodeEls.get(selection.id)?.getBoundingClientRect();
  } else if (selection.kind === 'nodes') {
    const bounds = selection.ids.map((id) => nodeEls.get(id)?.getBoundingClientRect()).filter(Boolean);
    if (bounds.length) anchor = {
      left: Math.min(...bounds.map((r) => r.left)),
      right: Math.max(...bounds.map((r) => r.right)),
      top: Math.min(...bounds.map((r) => r.top)),
      bottom: Math.max(...bounds.map((r) => r.bottom))
    };
  } else {
    const path = [...svg.querySelectorAll('[data-edge-id]')].find(
      (el) => el.dataset.edgeId === selection.id
    );
    if (path) {
      const bounds = path.getBoundingClientRect();
      if (
        bounds.right < viewport.left ||
        bounds.left > viewport.right ||
        bounds.bottom < viewport.top ||
        bounds.top > viewport.bottom
      ) {
        tools.style.visibility = 'hidden';
        return;
      }
      const point =
        selection.point || path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(
        path.getScreenCTM()
      );
      screen.x = clamp(screen.x, viewport.left + 12, viewport.right - 12);
      screen.y = clamp(screen.y, viewport.top + 12, viewport.bottom - 12);
      anchor = {
        left: screen.x,
        right: screen.x,
        top: screen.y,
        bottom: screen.y
      };
    }
  }
  const visible =
    anchor &&
    anchor.right >= viewport.left &&
    anchor.left <= viewport.right &&
    anchor.bottom >= viewport.top &&
    anchor.top <= viewport.bottom;
  tools.style.visibility = visible ? '' : 'hidden';
  if (!visible) return;
  const margin = 12,
    gap = 9,
    width = tools.offsetWidth,
    height = tools.offsetHeight;
  let left = clamp(
    anchor.left - viewport.left,
    margin,
    Math.max(margin, viewport.width - width - margin)
  );
  let top = anchor.bottom - viewport.top + gap;
  const above = anchor.top - viewport.top - height - gap;
  if (top + height > viewport.height - margin) {
    if (above >= margin) top = above;
    else {
      // Very tall cards: put tools beside the card when there is room.
      const right = anchor.right - viewport.left + gap;
      const sideLeft = anchor.left - viewport.left - width - gap;
      if (right + width <= viewport.width - margin) left = right;
      else if (sideLeft >= margin) left = sideLeft;
      top = clamp(
        anchor.top - viewport.top,
        margin,
        Math.max(margin, viewport.height - height - margin)
      );
    }
  }
  tools.style.left = `${left}px`;
  tools.style.top = `${top}px`;
  const menu = $('#card-menu');
  if (menu && !menu.hidden) {
    const menuLeft = clamp(
      left + width - menu.offsetWidth,
      margin,
      Math.max(margin, viewport.width - menu.offsetWidth - margin)
    );
    const below = top + height + gap;
    const menuTop =
      below + menu.offsetHeight <= viewport.height - margin
        ? below
        : clamp(
            top - menu.offsetHeight - gap,
            margin,
            Math.max(margin, viewport.height - menu.offsetHeight - margin)
          );
    menu.style.left = `${menuLeft - left}px`;
    menu.style.right = 'auto';
    menu.style.top = `${menuTop - top}px`;
  }
}
function updateTools() {
  const n = activeNode(),
    selected = !!selection;
  for (const [id, enabled] of [
    ['undo', histories.canUndo(board().id)],
    ['redo', histories.canRedo(board().id)]
  ])
    $('#' + id).disabled = !enabled;
  stage.classList.toggle('connecting', connecting);
  stage.classList.toggle('pan-ready', spaceHeld);
  const selectedIds = new Set(selectedNodeIds());
  nodeEls.forEach((el, id) => {
    el.classList.toggle(
      'selected',
      selectedIds.has(id)
    );
    el.classList.toggle('connection-source', connecting && connectFrom === id);
  });
  const tools = $('#selection-tools');
  const key = `${board().id}:${selection?.kind}:${selection?.id || selection?.ids?.join(',')}`;
  if (key !== toolsSelection) cardMenuOpen = false;
  toolsSelection = key;
  tools.classList.toggle('hidden', !selected || connecting || dragging?.kind === 'marquee');
  tools.setAttribute('aria-label', selection?.kind === 'nodes' ? '多张卡片选择' : n ? '所选卡片操作' : '所选连线操作');
  tools.replaceChildren();
  if (n) {
    tools.append(
      button('编辑', () => beginEdit(n.id), 'small', {
        disabled: editing?.id === n.id
      }),
      button('＋延伸', addBranch, 'small', {
        'aria-label': '延伸卡片',
        title: '添加相连卡片（Tab）'
      }),
      button('连接', toggleConnect, 'small', { 'aria-label': '连接卡片' }),
      button(
        '⋯',
        (event) => {
          const opening = !cardMenuOpen;
          finishEdit();
          closeMenus();
          cardMenuOpen = opening;
          updateTools();
          if (opening && event.detail === 0) $('#card-menu button')?.focus();
        },
        'small tool-more',
        {
          id: 'card-more',
          'aria-label': '卡片更多操作',
          'aria-controls': 'card-menu',
          'aria-expanded': String(cardMenuOpen)
        }
      )
    );
    const palette = h('div', { class: 'palette', 'aria-label': '卡片颜色' });
    for (const color of COLORS)
      palette.append(
        button(
          '',
          () => {
            finishEdit();
            closeMenus();
            const before = snapshot();
            n.color = color;
            pushHistory(before);
            markDirty();
            renderBoard();
            stage.focus();
          },
          `swatch ${color}${n.color === color ? ' chosen' : ''}`,
          {
            'aria-label': `颜色：${{ cream: '米白', green: '浅绿', blue: '浅蓝', rose: '浅粉' }[color]}`,
            title: '只是一种颜色，你来决定含义'
          }
        )
      );
    tools.append(
      h(
        'div',
        {
          id: 'card-menu',
          class: 'card-menu popup-menu',
          hidden: !cardMenuOpen
        },
        palette,
        h('hr'),
        button(
          '删除卡片',
          () => {
            closeMenus();
            removeSelected();
          },
          'danger',
          { 'aria-label': '删除卡片' }
        )
      )
    );
  } else if (selection?.kind === 'nodes') {
    tools.append(
      h('span', { class: 'selection-summary', role: 'status' }, `已选 ${selection.ids.length} 张 · 拖动任一卡片移动`),
      button('删除所选', removeSelected, 'small danger', {
        'aria-label': '删除所选卡片',
        title: '删除所选卡片（Delete / Backspace），可一次撤销'
      }),
      button('取消选择', () => {
        selection = null;
        updateTools();
        stage.focus();
      }, 'small')
    );
  } else if (selected)
    tools.append(
      button('删除连线', removeSelected, 'small danger', {
        'aria-label': '删除连线'
      })
    );
  const message = $('#connect-message');
  message.replaceChildren(
    connecting
      ? h(
          'div',
          { class: 'connect-message' },
          '选择另一张卡片',
          button(
            '取消连接',
            () => {
              cancelConnect();
              stage.focus();
            },
            '',
            { title: '取消连接（Esc）' }
          )
        )
      : document.createTextNode('')
  );
  positionTools();
}
function cancelConnect() {
  connecting = false;
  connectFrom = null;
  if ($('#selection-tools')) updateTools();
}
function toggleConnect() {
  finishEdit();
  if (connecting) return cancelConnect();
  if (!activeNode()) return;
  closeMenus();
  connecting = true;
  connectFrom = activeNode()?.id || null;
  updateTools();
  stage.focus();
}
function linkTo(id) {
  if (!connectFrom) {
    connectFrom = id;
    selection = { kind: 'node', id };
    updateTools();
    return;
  }
  if (connectFrom === id) return note('请选择另一个想法作为连接目标。');
  const before = snapshot(),
    edge = connect(board(), connectFrom, id);
  if (!edge) return note('这两个想法已经连接，或连线数量达到上限。');
  pushHistory(before);
  selection = { kind: 'node', id };
  connecting = false;
  connectFrom = null;
  markDirty();
  updateTools();
  renderEdges();
}
function worldPoint(clientX, clientY) {
  return clientToWorld(
    board().view,
    stage.getBoundingClientRect(),
    clientX,
    clientY
  );
}
function centerPoint() {
  const r = stage.getBoundingClientRect();
  return worldPoint(r.left + r.width / 2, r.top + r.height / 2);
}
function freePosition(x, y) {
  let pos = { x, y };
  for (let i = 0; i < board().nodes.length + 1; i++) {
    if (
      !board().nodes.some(
        (n) => Math.abs(n.x - pos.x) < 230 && Math.abs(n.y - pos.y) < 115
      )
    )
      return pos;
    pos.y += 145;
  }
  return pos;
}
function addIdea(position) {
  finishEdit();
  closeMenus();
  if (board().nodes.length >= LIMITS.nodes)
    return note('这张画布的想法已达上限，可以新建一张继续。');
  const p = position || centerPoint(),
    pos = freePosition(p.x - 112, p.y - 49),
    before = snapshot(),
    n = createNode('', xy(pos.x), xy(pos.y));
  board().nodes.push(n);
  pushHistory(before);
  selection = { kind: 'node', id: n.id };
  cancelConnect();
  markDirty();
  renderBoard();
  reveal(n);
  beginEdit(n.id);
}
function addBranch() {
  finishEdit();
  closeMenus();
  const parent = activeNode();
  if (!parent) return note('先选中一个想法，再展开分支。');
  if (
    board().nodes.length >= LIMITS.nodes ||
    board().edges.length >= LIMITS.edges
  )
    return note('当前画布已达容量上限。');
  const before = snapshot(),
    pos = freePosition(parent.x + 320, parent.y),
    n = createNode('', xy(pos.x), xy(pos.y), parent.color);
  board().nodes.push(n);
  connect(board(), parent.id, n.id);
  pushHistory(before);
  selection = { kind: 'node', id: n.id };
  cancelConnect();
  markDirty();
  renderBoard();
  reveal(n);
  beginEdit(n.id);
}
function addSibling() {
  finishEdit();
  closeMenus();
  const source = activeNode();
  if (!source) return;
  const height = nodeEls.get(source.id)?.offsetHeight || NODE_HEIGHT,
    pos = freePosition(source.x, source.y + height + 47),
    before = snapshot(),
    n = createSibling(board(), source.id, xy(pos.x), xy(pos.y));
  if (!n) {
    nodeEls.get(source.id)?.focus({ preventScroll: true });
    void flush();
    return note('当前画布已达容量上限，无法新增同级卡片。');
  }
  pushHistory(before);
  selection = { kind: 'node', id: n.id };
  cancelConnect();
  markDirty();
  renderBoard();
  reveal(n);
  beginEdit(n.id);
}
function moveSelection(key) {
  const heights = new Map(
      [...nodeEls].map(([id, el]) => [id, el.offsetHeight])
    ),
    n = directionalNode(board().nodes, activeNode()?.id, key, heights);
  if (!n) return;
  selection = { kind: 'node', id: n.id };
  cancelConnect();
  updateTools();
  renderEdges();
  reveal(n);
  nodeEls.get(n.id)?.focus({ preventScroll: true });
}
function reveal(n) {
  const v = board().view,
    oldX = v.x,
    oldY = v.y,
    w = stage.clientWidth,
    ht = stage.clientHeight,
    height = nodeEls.get(n.id)?.offsetHeight || NODE_HEIGHT,
    nx = n.x * v.scale + v.x,
    ny = n.y * v.scale + v.y;
  if (nx < 35 || nx + NODE_WIDTH * v.scale > w - 35)
    v.x = xy(w / 2 - (n.x + NODE_WIDTH / 2) * v.scale);
  if (ny < 35 || ny + height * v.scale > ht - 75)
    v.y = xy(Math.max(50, ht / 2) - (n.y + height / 2) * v.scale);
  applyView();
  if (v.x !== oldX || v.y !== oldY) markDirty();
}
function textCursor(element, x, y) {
  if (!element) return;
  const caret = document.caretPositionFromPoint?.(x, y);
  const range = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode || range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || !element.contains(node)) return;
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(node, offset);
  return before.toString().length;
}
function beginEdit(id, cursor) {
  if (editing?.id === id) return;
  finishEdit();
  cancelConnect();
  const n = board().nodes.find((x) => x.id === id),
    el = nodeEls.get(id);
  if (!n || !el) return;
  selection = { kind: 'node', id };
  editing = { id, boardId: board().id, before: snapshot() };
  updateTools();
  el.classList.add('editing');
  const input = h('textarea', {
    class: 'idea-editor',
    maxlength: LIMITS.text,
    'aria-label': '编辑卡片',
    placeholder: '写下任何想法…',
    value: n.text,
    onInput: () => {
      n.text = input.value;
      resize();
      markDirty();
    },
    onKeydown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        finishEdit();
        addBranch();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) addSibling();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishEdit();
        void flush();
        el.focus({ preventScroll: true });
      }
    },
    onBlur: () => {
      queueMicrotask(() => {
        if (editing?.id === id) finishEdit();
      });
    }
  });
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(650, Math.max(96, input.scrollHeight))}px`;
    renderEdges();
  };
  el.querySelector('.idea-text').replaceWith(input);
  resize();
  input.focus();
  const insertion = Number.isInteger(cursor)
    ? clamp(cursor, 0, n.text.length)
    : n.text.length;
  input.setSelectionRange(insertion, insertion);
}
function finishEdit() {
  if (!editing) return;
  const old = editing;
  editing = null;
  const b = workspace.boards.find((x) => x.id === old.boardId),
    n = b?.nodes.find((x) => x.id === old.id),
    el = nodeEls.get(old.id);
  if (n && el) {
    el.querySelector('textarea')?.replaceWith(
      h('div', { class: 'idea-text' }, n.text)
    );
    el.classList.remove('editing');
    el.setAttribute('aria-label', `卡片：${n.text.slice(0, 80) || '空白卡片'}`);
    if (b.id === workspace.activeId) pushHistory(old.before);
  }
  updateTools();
  renderEdges();
}
function removeSelected() {
  finishEdit();
  closeMenus();
  if (!selection) return;
  const before = snapshot();
  const ids = selectedNodeIds();
  if (ids.length) {
    for (const id of ids) deleteNode(board(), id);
  } else board().edges = board().edges.filter((e) => e.id !== selection.id);
  pushHistory(before);
  selection = null;
  cancelConnect();
  markDirty();
  renderBoard();
  note(ids.length > 1 ? `已删除 ${ids.length} 张卡片，可以一次撤销。` : '已删除，可以撤销。');
  stage.focus();
}
function zoomAt(factor, client) {
  finishEdit();
  const r = stage.getBoundingClientRect(),
    cx = client?.x ?? r.left + r.width / 2,
    cy = client?.y ?? r.top + r.height / 2,
    p = worldPoint(cx, cy),
    v = board().view;
  v.scale = clamp(v.scale * factor, 0.2, 2.5);
  v.x = xy(cx - r.left - p.x * v.scale);
  v.y = xy(cy - r.top - p.y * v.scale);
  applyView();
  markDirty();
}
function fitAll() {
  finishEdit();
  const ns = board().nodes;
  if (!ns.length) {
    Object.assign(board().view, {
      x: stage.clientWidth / 2,
      y: stage.clientHeight / 2,
      scale: 1
    });
    applyView();
    markDirty();
    return;
  }
  const minX = Math.min(...ns.map((n) => n.x)),
    minY = Math.min(...ns.map((n) => n.y)),
    maxX = Math.max(...ns.map((n) => n.x + 225)),
    maxY = Math.max(
      ...ns.map((n) => n.y + (nodeEls.get(n.id)?.offsetHeight || 98))
    );
  const v = board().view,
    w = stage.clientWidth,
    ht = stage.clientHeight;
  v.scale = clamp(
    Math.min(1, (w - 90) / (maxX - minX + 50), (ht - 120) / (maxY - minY + 50)),
    0.2,
    2.5
  );
  v.x = xy(w / 2 - ((minX + maxX) / 2) * v.scale);
  v.y = xy(ht / 2 - ((minY + maxY) / 2) * v.scale);
  applyView();
  markDirty();
}
function clearDrag() {
  const old = dragging;
  dragging = null;
  stage.classList.remove('panning', 'dragging', 'selecting');
  stage.querySelector('.marquee')?.remove();
  if (old?.capture.hasPointerCapture(old.pointerId))
    old.capture.releasePointerCapture(old.pointerId);
  return old;
}
function cancelDrag() {
  if (!dragging) return;
  const old = clearDrag(),
    b = workspace.boards.find((item) => item.id === old.boardId);
  if (b && old.kind === 'node') {
    for (const origin of old.nodes) {
      const n = b.nodes.find((item) => item.id === origin.id);
      if (n) Object.assign(n, { x: origin.x, y: origin.y });
      const el = nodeEls.get(origin.id);
      if (el) {
        el.style.left = `${origin.x}px`;
        el.style.top = `${origin.y}px`;
      }
    }
  } else if (b && old.kind === 'pan') {
    b.view.x = old.nx;
    b.view.y = old.ny;
    if (b.id === board().id) applyView();
  } else if (old.kind === 'marquee') selection = old.selection;
  // Resume saving any earlier edits with the restored positions.
  if (old.changed && old.kind !== 'marquee') markDirty();
  updateTools();
  renderEdges();
}
function bindCanvas() {
  stage.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    if (![0, 1, 2].includes(e.button)) return;
    if (e.target.closest('button,textarea')) return;
    finishEdit();
    $('.help-pop')?.remove();
    const idea = e.target.closest('.idea'),
      edge = e.target.closest('[data-edge-id]'),
      pan = e.button === 1 || e.button === 2 || spaceHeld;
    if (connecting && idea && !pan) {
      e.preventDefault();
      linkTo(idea.dataset.nodeId);
      return;
    }
    if (edge && !pan) {
      selection = {
        kind: 'edge',
        id: edge.dataset.edgeId,
        point: worldPoint(e.clientX, e.clientY)
      };
      updateTools();
      renderEdges();
      return;
    }
    e.preventDefault();
    if (idea && !pan) {
      if (!selectedNodeIds().includes(idea.dataset.nodeId))
        selection = { kind: 'node', id: idea.dataset.nodeId };
      updateTools();
      const ids = new Set(selectedNodeIds());
      dragging = {
        kind: 'node',
        clickId: idea.dataset.nodeId,
        nodes: board().nodes.filter((n) => ids.has(n.id)).map(({ id, x, y }) => ({ id, x, y })),
        before: snapshot()
      };
    } else if (!pan) {
      cancelConnect();
      dragging = {
        kind: 'marquee',
        start: worldPoint(e.clientX, e.clientY),
        selection
      };
      selection = null;
      stage.append(h('div', { class: 'marquee', 'aria-hidden': 'true' }));
    } else {
      dragging = {
        kind: 'pan',
        nx: board().view.x,
        ny: board().view.y
      };
    }
    Object.assign(dragging, {
      x: e.clientX,
      y: e.clientY,
      scale: board().view.scale,
      boardId: board().id,
      pointerId: e.pointerId,
      changed: false,
      capture: idea || stage
    });
    dragging.capture.setPointerCapture(e.pointerId);
    updateTools();
    renderEdges();
    stage.focus();
  });
  const move = (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    const dx = e.clientX - dragging.x,
      dy = e.clientY - dragging.y;
    if (!dragging.changed && Math.hypot(dx, dy) < 5) return;
    dragging.changed = true;
    stage.classList.add(dragging.kind === 'pan' ? 'panning' : dragging.kind === 'marquee' ? 'selecting' : 'dragging');
    if (dragging.kind === 'node') {
      const delta = groupDragDelta(dragging.nodes, dx / dragging.scale, dy / dragging.scale);
      for (const origin of dragging.nodes) {
        const n = board().nodes.find((item) => item.id === origin.id);
        if (!n) continue;
        n.x = origin.x + delta.x;
        n.y = origin.y + delta.y;
        const el = nodeEls.get(n.id);
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
      }
      renderEdges();
    } else if (dragging.kind === 'marquee') {
      const end = worldPoint(e.clientX, e.clientY),
        r = rectangleBetween(dragging.start, end),
        v = board().view;
      Object.assign(stage.querySelector('.marquee').style, {
        left: `${r.left * v.scale + v.x}px`,
        top: `${r.top * v.scale + v.y}px`,
        width: `${(r.right - r.left) * v.scale}px`,
        height: `${(r.bottom - r.top) * v.scale}px`
      });
      selectNodes(nodesInRectangle(board().nodes, dragging.start, end,
        new Map([...nodeEls].map(([id, el]) => [id, el.offsetHeight]))));
      updateTools();
    } else {
      board().view.x = xy(dragging.nx + dx);
      board().view.y = xy(dragging.ny + dy);
      applyView();
    }
  };
  stage.addEventListener('pointermove', move);
  const end = (e) => {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    move(e);
    const old = clearDrag();
    if (old.kind === 'node' && !old.changed)
      selection = { kind: 'node', id: old.clickId };
    if (old.changed) {
      if (old.kind === 'node' && snapshot() !== old.before) {
        pushHistory(old.before);
        markDirty();
      } else if (old.kind === 'pan' && (board().view.x !== old.nx || board().view.y !== old.ny)) markDirty();
    }
    updateTools();
  };
  stage.addEventListener('pointerup', end);
  const cancel = (e) => {
    if (e.pointerId === dragging?.pointerId) cancelDrag();
  };
  stage.addEventListener('pointercancel', cancel);
  stage.addEventListener('lostpointercapture', cancel);
  stage.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('textarea,input,[contenteditable=true]'))
      e.preventDefault();
  });
  stage.addEventListener('dblclick', (e) => {
    if (e.button !== 0) return;
    if (!e.target.closest('.idea,[data-edge-id]') && !connecting) {
      e.preventDefault();
      addIdea(worldPoint(e.clientX, e.clientY));
    }
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('textarea,.idea-text')) return;
      e.preventDefault();
      if (dragging) return;
      if (e.ctrlKey || e.metaKey)
        zoomAt(Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
      else {
        board().view.x = xy(board().view.x - e.deltaX);
        board().view.y = xy(board().view.y - e.deltaY);
        applyView();
        markDirty();
      }
    },
    { passive: false }
  );
}
function newBoard() {
  finishEdit();
  closeMenus();
  if (workspace.boards.length >= LIMITS.boards)
    return note('画布数量已达上限。');
  const b = createBoard('未命名画布');
  workspace.boards.push(b);
  workspace.activeId = b.id;
  selection = null;
  cancelConnect();
  updateBoardMenu();
  renderBoard();
  fitAll();
  markDirty();
  beginEdit(b.nodes[0].id);
}
function modal(title, ...children) {
  const d = h(
    'dialog',
    { 'aria-label': title },
    button('×', () => d.close(), 'dialog-x', { 'aria-label': '关闭窗口' }),
    h('h2', {}, title),
    children
  );
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
function download(text, name, type = 'application/json') {
  const url = URL.createObjectURL(
      new Blob([text], { type: `${type};charset=utf-8` })
    ),
    a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function backup(all = true) {
  finishEdit();
  try {
    download(
      exportJSON(all ? workspace : board()),
      `${(all ? '原点-所有画布' : board().title || '原点画布').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100)}.json`
    );
  } catch (e) {
    note(`导出失败：${e.message}`);
  }
}
function resetFileImport() {
  fileReadTicket++;
  fileImportCandidate = null;
  fileImportActive = false;
  const input = $('#file-import-input'),
    panel = $('#file-import-panel');
  if (input) input.value = '';
  if (panel) {
    panel.hidden = true;
    panel.replaceChildren();
  }
}
function closeFileMenu() {
  $('#file-menu')?.setAttribute('hidden', '');
  $('#file-menu-toggle')?.setAttribute('aria-expanded', 'false');
  resetFileImport();
}
function toggleFileMenu() {
  finishEdit();
  mcpPanel?.close();
  const opening = $('#file-menu').hidden;
  closeMenus();
  cancelConnect();
  $('#file-menu').hidden = !opening;
  $('#file-menu-toggle').setAttribute('aria-expanded', String(opening));
  if (opening) $('#file-menu button')?.focus();
}
function exportFromMenu(all) {
  closeMenus();
  backup(all);
  $('#file-menu-toggle').focus();
}
function cancelFileImport() {
  resetFileImport();
  if (!$('#file-menu').hidden) $('#file-import-trigger').focus();
}
function showFileImport(message, error = false, fileName = '') {
  const panel = $('#file-import-panel');
  panel.hidden = false;
  panel.replaceChildren(
    h(
      'div',
      {
        class: `file-import-status${error ? ' error' : ''}`,
        role: error ? 'alert' : 'status'
      },
      message
    ),
    fileName
      ? h(
          'div',
          { class: 'file-import-summary' },
          h('div', {}, fileName),
          fileImportCandidate
            ? [
                h(
                  'p',
                  {},
                  `将追加 ${fileImportCandidate.boards.length} 张画布，保留已有内容。`
                ),
                fileImportCandidate.boards.map((b) =>
                  h(
                    'div',
                    {},
                    `${b.title || '未命名画布'} · ${b.nodes.length} 张卡片`
                  )
                )
              ]
            : null
        )
      : null,
    h(
      'div',
      { class: 'file-import-actions' },
      button('追加导入', appendFileImport, 'primary', {
        disabled: !fileImportCandidate
      }),
      button('取消', cancelFileImport, 'ghost')
    )
  );
}
function chooseImportFile() {
  resetFileImport();
  fileImportActive = true;
  $('#file-import-input').click();
}
async function readImportFile(e) {
  if ($('#file-menu').hidden) return;
  const ticket = ++fileReadTicket,
    file = e.target.files[0];
  fileImportCandidate = null;
  if (!file) return cancelFileImport();
  fileImportActive = true;
  showFileImport('正在读取…', false, file.name);
  if (file.size > LIMITS.chars * 3) {
    showFileImport('备份文件超过大小上限。', true, file.name);
    return;
  }
  try {
    const text = await file.text();
    if (ticket !== fileReadTicket) return;
    const result = parseImport(text);
    if (!result.ok) {
      showFileImport(result.errors.join('；'), true, file.name);
      return;
    }
    fileImportCandidate = result.value;
    showFileImport('备份已就绪', false, file.name);
  } catch {
    if (ticket === fileReadTicket)
      showFileImport('文件读取失败。', true, file.name);
  }
}
function appendFileImport() {
  if (!fileImportCandidate) return;
  finishEdit();
  const result = importAppend(workspace, fileImportCandidate);
  if (!result.ok) {
    const fileName = $('#file-import-input').files[0]?.name || '';
    fileImportCandidate = null;
    showFileImport(result.errors.join('；'), true, fileName);
    $('#file-import-trigger').focus();
    return;
  }
  closeMenus();
  workspace = result.workspace;
  selection = null;
  cancelConnect();
  markDirty();
  updateBoardMenu();
  renderBoard();
  fitAll();
  stage.focus();
  note('已追加导入，已有画布保留。');
}
function removeBoard() {
  finishEdit();
  const target = copy(board());
  const d = modal(
    '删除这张画布？',
    h(
      'p',
      {},
      `“${target.title || '未命名画布'}”会从当前列表移除。也可以先取消并从“文件”导出备份。`
    ),
    h(
      'div',
      { class: 'actions' },
      button('取消', () => d.close()),
      button(
        '删除，可撤销',
        () => {
          workspace.boards = workspace.boards.filter((b) => b.id !== target.id);
          if (!workspace.boards.length) workspace.boards.push(createBoard());
          workspace.activeId = workspace.boards[0].id;
          selection = null;
          d.close();
          markDirty();
          updateBoardMenu();
          renderBoard();
          note('画布已移除。', () => {
            if (workspace.boards.length >= LIMITS.boards)
              return note('画布数量已达上限，请先备份。');
            workspace.boards.push(target);
            workspace.activeId = target.id;
            markDirty();
            updateBoardMenu();
            renderBoard();
          });
        },
        'danger'
      )
    )
  );
}
function toggleHelp() {
  closeMenus();
  mcpPanel?.close();
  if ($('.help-pop')) {
    $('.help-pop').remove();
    return;
  }
  const help = h(
    'aside',
    { class: 'help-pop floating', 'aria-label': '画布使用提示' },
    button('×', () => help.remove(), 'help-close', {
      'aria-label': '关闭提示'
    }),
    h('h2', {}, '让思维可以自由生长'),
    h(
      'p',
      {},
      '① 双击一张卡片，或选中后按 Enter 编辑。编辑中 Enter 换行，Esc 保存并退出，也可点击空白完成。'
    ),
    h(
      'p',
      {},
      '② 选中卡片点旁边的“＋延伸”，或按 ',
      h('kbd', {}, 'Tab'),
      '，继续展开。按 Ctrl / ⌘ + Enter 新增同级卡片；没有父卡片时新增独立卡片。拖动卡片改变组合。'
    ),
    h(
      'p',
      {},
      '选中卡片后，用 ↑ ↓ ← → 按位置切换卡片；编辑文字时方向键移动光标。'
    ),
    h(
      'p',
      {},
      '③ 选中卡片点“连接”，再点另一张卡片；按 Esc 取消。点击线条后可以删除。'
    ),
    h(
      'p',
      {},
      '点卡片旁的“⋯”换色或删除。按住鼠标右键拖动平移画布；Ctrl / ⌘ + 滚轮缩放，“显示全部”找回卡片。'
    ),
    h('p', {}, '左键点击卡片单选，拖动空白框选多张卡片；拖动任一所选卡片整体移动。点“删除所选”或按 Delete / Backspace 批量删除，一次撤销恢复卡片及连线。点空白或 Esc 取消多选；也可按住空格或用中键拖动平移。'),
    h('p', {}, '点击顶部画布名称改名；旁边菜单可切换、新建或删除画布。'),
    h(
      'p',
      {},
      h('kbd', {}, 'Ctrl / ⌘ Z'),
      ' 撤销　',
      h('kbd', {}, 'Delete'),
      ' 删除选中内容'
    ),
    h(
      'p',
      { class: 'subtle' },
      '颜色和位置都由你赋予含义。这里没有必填顺序。记录保存在本机，请定期从“文件”备份。',
      h('br'),
      h('a', { href: 'guided.html' }, '打开旧版六步工具 ↗')
    )
  );
  $('.stage-wrap').append(help);
}
function showRecovery() {
  const el = $('#recovery');
  if (!el) return;
  el.replaceChildren();
  if (!corrupt && !conflict) return;
  mcpPanel?.close();
  if (mcpPanel?.authorized) {
    if (mcpPanel.pause) void mcpPanel.pause('保存已暂停，AI 接入暂时暂停。');
    else void mcpPanel.disconnect('保存已暂停，AI 接入已断开。');
  }
  el.append(
    h(
      'div',
      { class: 'recovery' },
      h(
        'p',
        {},
        corrupt
          ? '原有画布存储无法读取，未覆盖。请先导出当前画布及原始数据。'
          : '另一个页面更新了画布，本页编辑仍在内存。可保留本页为副本后合并。'
      ),
      button('备份本页', () => backup(true)),
      corrupt
        ? button('下载原始数据', () =>
            download(loaded.raw || '', '原点-待恢复原始数据.txt', 'text/plain')
          )
        : button('保留本页副本', () => {
            const remote = load(storage);
            if (remote.status !== 'loaded' && remote.status !== 'empty')
              return note('无法读取另一页数据，请先导出本页备份。');
            const r = importAppend(remote.workspace, workspace);
            if (!r.ok) return note(r.errors.join('；'));
            workspace = r.workspace;
            savedRaw = remote.raw ?? null;
            conflict = false;
            selection = null;
            editing = null;
            markDirty();
            updateBoardMenu();
            renderBoard();
            showRecovery();
            flush();
            note('已保留两边内容，本页画布作为副本加入。');
          })
    )
  );
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#file-picker')) closeFileMenu();
  if (!e.target.closest('#board-picker')) {
    $('#board-menu')?.setAttribute('hidden', '');
    $('#board-menu-toggle')?.setAttribute('aria-expanded', 'false');
  }
  if (!e.target.closest('#selection-tools')) {
    cardMenuOpen = false;
    $('#card-menu')?.setAttribute('hidden', '');
    $('#card-more')?.setAttribute('aria-expanded', 'false');
  }
});
window.addEventListener('resize', positionTools);
document.addEventListener('keydown', (e) => {
  if (
    e.isComposing ||
    e.keyCode === 229 ||
    document.querySelector('dialog[open]')
  )
    return;
  const typing = e.target.closest(
    'textarea,input,select,[contenteditable=true]'
  );
  if (e.key === 'Escape') {
    e.preventDefault();
    if (dragging) {
      cancelDrag();
      return;
    }
    if (selection?.kind === 'nodes') selection = null;
    const focusBack = !$('#file-menu').hidden
      ? '#file-menu-toggle'
      : !$('#board-menu').hidden
        ? '#board-menu-toggle'
        : cardMenuOpen
          ? '#card-more'
          : mcpPanel?.root && !mcpPanel.root.hidden
            ? '#ai-menu-toggle'
            : null;
    closeMenus();
    finishEdit();
    cancelConnect();
    $('.help-pop')?.remove();
    mcpPanel?.close();
    ($(focusBack || '#stage') || stage).focus();
    return;
  }
  if (
    typing ||
    !$('#file-menu').hidden ||
    mcpPanel?.root.contains(e.target) ||
    (mcpPanel?.root && !mcpPanel.root.hidden && e.target === document.body)
  )
    return;
  if (dragging) {
    e.preventDefault();
    return;
  }
  if (e.code === 'Space' && (e.target === stage || e.target.closest('.idea'))) {
    e.preventDefault();
    spaceHeld = true;
    updateTools();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    undo(true);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection) {
      e.preventDefault();
      removeSelected();
    }
  } else if (
    (e.target === stage || e.target.closest('.idea')) &&
    activeNode() &&
    !dragging
  ) {
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    ) {
      e.preventDefault();
      moveSelection(e.key);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) addSibling();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      addBranch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      beginEdit(activeNode().id);
    }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    updateTools();
  }
});
window.addEventListener('blur', () => {
  spaceHeld = false;
  cancelDrag();
  updateTools();
});
window.addEventListener('storage', (e) => {
  if (e.key !== CANVAS_KEY || e.newValue === savedRaw) return;
  if (
    dirty ||
    editing ||
    dragging ||
    fileImportActive ||
    document.querySelector('dialog[open]') ||
    corrupt ||
    conflict
  ) {
    conflict = true;
    showRecovery();
    status();
    return;
  }
  const r = load(storage);
  if (!['loaded', 'empty'].includes(r.status)) {
    conflict = true;
    showRecovery();
    status();
    return;
  }
  const active = workspace.activeId;
  workspace = r.workspace;
  savedRaw = r.raw ?? null;
  if (!workspace.boards.length) workspace = createWorkspace();
  if (workspace.boards.some((b) => b.id === active))
    workspace.activeId = active;
  selection = null;
  histories.clear();
  cancelConnect();
  updateBoardMenu();
  renderBoard();
  note('已载入另一个页面的更新。');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush();
});
window.addEventListener('beforeunload', (e) => {
  flush();
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
const freshCanvas =
  loaded.status === 'empty' ||
  loaded.status === 'unavailable' ||
  !workspace.boards.length;
if (!workspace.boards.length) workspace = createWorkspace();
build();
mcpPanel = createMcpPanel({
  connection: mcpConnection,
  listCanvases: listMcpWorkspace,
  readCanvas: readMcpCanvas,
  editCanvas: editMcpCanvas,
  createCanvas: createMcpBoard,
  exportCanvas: exportMcpData,
  canConnect: canConnectMcp
});
new ResizeObserver(positionTools).observe(stage);
if (freshCanvas || loaded.status === 'invalid') fitAll();
if (freshCanvas) beginEdit(board().nodes[0].id);
if (loaded.status === 'unavailable') {
  saveError = '保存不可用，请从文件导出';
  status();
}
