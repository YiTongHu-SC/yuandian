/** Session-only node/edge history. Board titles and viewport changes are excluded. */
export function snapshotBoard(board) {
  return JSON.stringify({ nodes: board.nodes, edges: board.edges });
}

export function createHistory(limit = 50) {
  const boards = new Map();
  const historyFor = (id) => {
    if (!boards.has(id)) boards.set(id, { undo: [], redo: [] });
    return boards.get(id);
  };

  function restore(board, redo) {
    const history = historyFor(board.id);
    const source = redo ? history.redo : history.undo;
    const target = redo ? history.undo : history.redo;
    if (!source.length) return false;
    target.push(snapshotBoard(board));
    Object.assign(board, JSON.parse(source.pop()));
    return true;
  }

  return {
    record(board, before) {
      if (before === snapshotBoard(board)) return;
      const history = historyFor(board.id);
      history.undo.push(before);
      if (history.undo.length > limit) history.undo.shift();
      history.redo = [];
    },
    undo: (board) => restore(board, false),
    redo: (board) => restore(board, true),
    canUndo: (id) => historyFor(id).undo.length > 0,
    canRedo: (id) => historyFor(id).redo.length > 0,
    clear: () => boards.clear()
  };
}
