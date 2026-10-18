import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, snapshotBoard } from '../../src/canvas/history.js';
import {
  createBoard,
  createNode,
  connect,
  deleteNode
} from '../../src/canvas/model.js';

function change(history, board, edit) {
  const before = snapshotBoard(board);
  edit();
  history.record(board, before);
}

test('undo and redo restore deleted nodes and links without changing the current viewport or title', () => {
  const board = createBoard('原名'),
    history = createHistory();
  const node = createNode('分支', 320, 20, 'blue');
  board.nodes.push(node);
  connect(board, board.nodes[0].id, node.id);
  const content = snapshotBoard(board);
  change(history, board, () => deleteNode(board, node.id));
  board.title = '新名';
  board.view = { x: 10, y: -20, scale: 0.5 };
  assert.equal(history.undo(board), true);
  assert.equal(snapshotBoard(board), content);
  assert.equal(board.title, '新名');
  assert.deepEqual(board.view, { x: 10, y: -20, scale: 0.5 });
  assert.equal(history.redo(board), true);
  assert.equal(board.nodes.length, 1);
  assert.equal(board.edges.length, 0);
});

test('histories are independent for each board and clear when another tab replaces the workspace', () => {
  const a = createBoard(),
    b = createBoard(),
    history = createHistory();
  change(history, a, () => {
    a.nodes[0].text = '画布 A';
  });
  assert.equal(history.canUndo(b.id), false);
  assert.equal(history.undo(b), false);
  change(history, b, () => {
    b.nodes[0].color = 'rose';
  });
  history.undo(a);
  assert.equal(b.nodes[0].color, 'rose');
  assert.equal(history.canUndo(b.id), true);
  assert.equal(history.canRedo(a.id), true);
  history.clear();
  assert.equal(history.canUndo(b.id), false);
  assert.equal(history.canRedo(a.id), false);
});

test('no-op edits preserve redo, while a new content edit discards that board’s redo', () => {
  const board = createBoard(),
    history = createHistory();
  change(history, board, () => {
    board.nodes[0].text = '第一次';
  });
  history.undo(board);
  change(history, board, () => {
    board.view.x = 50;
  });
  assert.equal(history.canRedo(board.id), true);
  change(history, board, () => {
    board.nodes[0].text = '另一个方向';
  });
  assert.equal(history.canRedo(board.id), false);
  assert.equal(history.redo(board), false);
  history.undo(board);
  assert.notEqual(board.nodes[0].text, '第一次');
  assert.equal(board.view.x, 50);
});

test('only the latest 50 content changes can be undone, and a new session starts empty', () => {
  const board = createBoard(),
    history = createHistory();
  for (let i = 1; i <= 55; i++) {
    change(history, board, () => {
      board.nodes[0].text = String(i);
    });
  }
  for (let i = 0; i < 50; i++) assert.equal(history.undo(board), true);
  assert.equal(board.nodes[0].text, '5');
  assert.equal(history.undo(board), false);
  for (let i = 0; i < 50; i++) assert.equal(history.redo(board), true);
  assert.equal(board.nodes[0].text, '55');
  assert.equal(history.redo(board), false);
  assert.equal(createHistory().canUndo(board.id), false);
});
