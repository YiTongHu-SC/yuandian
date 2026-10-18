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
