import { LIMITS } from './model.js';

// Keep aligned with .idea width/min-height in styles.css; heights may grow while editing.
export const NODE_WIDTH = 225;
export const NODE_HEIGHT = 98;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const coordinate = (value) =>
  clamp(value, -LIMITS.coordinate, LIMITS.coordinate);

export function worldPoint(view, rect, clientX, clientY) {
  return {
    x: (clientX - rect.left - view.x) / view.scale,
    y: (clientY - rect.top - view.y) / view.scale
  };
}

export function rectangleBetween(start, end) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y)
  };
}

/** A card is selected when any visible area intersects the world-space rectangle. */
export function nodesInRectangle(nodes, start, end, heights = new Map()) {
  const rect = rectangleBetween(start, end);
  if (rect.left === rect.right || rect.top === rect.bottom) return [];
  return nodes.filter((node) =>
    node.x < rect.right && node.x + NODE_WIDTH > rect.left &&
    node.y < rect.bottom && node.y + (heights.get(node.id) || NODE_HEIGHT) > rect.top
  ).map((node) => node.id);
}

/** Limit the shared movement once so every card keeps its position within the group. */
export function groupDragDelta(nodes, dx, dy) {
  if (!nodes.length) return { x: 0, y: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  return {
    x: clamp(dx, -LIMITS.coordinate - minX, LIMITS.coordinate - maxX),
    y: clamp(dy, -LIMITS.coordinate - minY, LIMITS.coordinate - maxY)
  };
}

/** Move through freely placed cards using measured centers and directional alignment. */
export function directionalNode(nodes, currentId, key, heights = new Map()) {
  const direction = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0]
  }[key];
  const current = nodes.find((node) => node.id === currentId);
  if (!direction || !current) return null;

  const center = (node) => ({
    x: node.x + NODE_WIDTH / 2,
    y: node.y + (heights.get(node.id) || NODE_HEIGHT) / 2
  });
  const origin = center(current);
  let best = null, bestScore = Infinity;
  for (const node of nodes) {
    if (node.id === currentId) continue;
    const target = center(node), dx = target.x - origin.x, dy = target.y - origin.y;
    const forward = dx * direction[0] + dy * direction[1];
    if (forward <= 0) continue;
    const sideways = Math.abs(dx * direction[1] - dy * direction[0]);
    // Near-perpendicular cards should not steal a horizontal/vertical move.
    const score = forward + sideways * 2 + sideways * sideways / forward;
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

/** Curve anchors use measured node heights, including multiline editors. */
export function connectionCurve(
  from,
  to,
  fromHeight = NODE_HEIGHT,
  toHeight = NODE_HEIGHT
) {
  let ax, ay, bx, by, c1, c2;
  if (Math.abs(to.x - from.x) > 100) {
    const sign = to.x > from.x ? 1 : -1;
    ax = from.x + (sign > 0 ? NODE_WIDTH : 0);
    ay = from.y + fromHeight / 2;
    bx = to.x + (sign > 0 ? 0 : NODE_WIDTH);
    by = to.y + toHeight / 2;
    const distance = Math.max(55, Math.abs(bx - ax) * 0.45);
    c1 = [ax + sign * distance, ay];
    c2 = [bx - sign * distance, by];
  } else {
    const sign = to.y > from.y ? 1 : -1;
    ax = from.x + NODE_WIDTH / 2;
    ay = from.y + (sign > 0 ? fromHeight : 0);
    bx = to.x + NODE_WIDTH / 2;
    by = to.y + (sign > 0 ? 0 : toHeight);
    const distance = Math.max(55, Math.abs(by - ay) * 0.45);
    c1 = [ax, ay + sign * distance];
    c2 = [bx, by - sign * distance];
  }
  return {
    path: `M ${ax} ${ay} C ${c1} ${c2} ${bx} ${by}`,
    label: { x: (ax + bx) / 2, y: (ay + by) / 2 - 9 }
  };
}
