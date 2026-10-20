import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinate,
  worldPoint,
  rectangleBetween,
  nodesInRectangle,
  groupDragDelta,
  directionalNode,
  connectionCurve
} from '../../src/canvas/geometry.js';
import { LIMITS } from '../../src/canvas/model.js';

test('client positions convert to world coordinates across pan, zoom, and stage offsets', () => {
  const rect = { left: 25, top: 70 };
  for (const scale of [0.2, 0.5, 1, 2.5]) {
    const view = { x: -60, y: 120, scale };
    const expected = { x: 320, y: -150 };
    assert.deepEqual(
      worldPoint(
        view,
        rect,
        rect.left + view.x + expected.x * scale,
        rect.top + view.y + expected.y * scale
      ),
      expected
    );
  }
});

test('drag coordinates stop at the supported model limits', () => {
  assert.equal(coordinate(LIMITS.coordinate + 100), LIMITS.coordinate);
  assert.equal(coordinate(-LIMITS.coordinate - 100), -LIMITS.coordinate);
  assert.equal(coordinate(-123.75), -123.75);
});

test('selection rectangles normalize all drag directions in world coordinates', () => {
  const expected = { left: -80, top: -60, right: 320, bottom: 150 };
  for (const [start, end] of [
    [{ x: -80, y: -60 }, { x: 320, y: 150 }],
    [{ x: 320, y: 150 }, { x: -80, y: -60 }],
    [{ x: -80, y: 150 }, { x: 320, y: -60 }],
    [{ x: 320, y: -60 }, { x: -80, y: 150 }]
  ]) assert.deepEqual(rectangleBetween(start, end), expected);
});

test('marquee selection includes whole and partially intersecting cards in board order', () => {
  const nodes = [
    { id: 'inside', x: 20, y: 20 },
    { id: 'partial-left', x: -224, y: 10 },
    { id: 'partial-top', x: 100, y: -97 },
    { id: 'partial-right', x: 299, y: 50 },
    { id: 'partial-bottom', x: 80, y: 199 },
    { id: 'outside', x: 500, y: 500 }
  ];
  const start = { x: 0, y: 0 }, end = { x: 300, y: 200 };
  const expected = ['inside', 'partial-left', 'partial-top', 'partial-right', 'partial-bottom'];
  assert.deepEqual(nodesInRectangle(nodes, start, end), expected);
  assert.deepEqual(nodesInRectangle(nodes, end, start), expected);
  assert.deepEqual(nodesInRectangle(nodes, { x: end.x, y: start.y }, { x: start.x, y: end.y }), expected);
});

test('marquee selection excludes cards that only touch rectangle edges', () => {
  const nodes = [
    { id: 'left', x: -225, y: 20 },
    { id: 'right', x: 300, y: 20 },
    { id: 'top', x: 20, y: -98 },
    { id: 'bottom', x: 20, y: 200 },
    { id: 'corner', x: -225, y: -98 }
  ];
  assert.deepEqual(nodesInRectangle(nodes, { x: 0, y: 0 }, { x: 300, y: 200 }), []);
});

test('marquee selection uses measured card height and rejects zero-area rectangles', () => {
  const nodes = [{ id: 'tall', x: -100, y: -150 }, { id: 'short', x: 0, y: -150 }];
  const heights = new Map([['tall', 400]]);
  assert.deepEqual(nodesInRectangle(nodes, { x: 10, y: 150 }, { x: 20, y: 240 }, heights), ['tall']);
  assert.deepEqual(nodesInRectangle(nodes, { x: 10, y: 150 }, { x: 20, y: 240 }), []);
  assert.deepEqual(nodesInRectangle(nodes, { x: 10, y: -150 }, { x: 10, y: 240 }, heights), []);
  assert.deepEqual(nodesInRectangle(nodes, { x: -100, y: 10 }, { x: 20, y: 10 }, heights), []);
  assert.deepEqual(nodesInRectangle([], { x: 0, y: 0 }, { x: 300, y: 200 }), []);
});

test('group dragging preserves the requested movement away from model bounds without mutating cards', () => {
  const nodes = [{ id: 'a', x: -100, y: 120 }, { id: 'b', x: 300, y: -80 }];
  const before = structuredClone(nodes);
  assert.deepEqual(groupDragDelta(nodes, 123.75, -200.5), { x: 123.75, y: -200.5 });
  assert.deepEqual(nodes, before);
  assert.deepEqual(groupDragDelta([], 500, -500), { x: 0, y: 0 });
});

test('group dragging stops all cards at the first positive or negative boundary', () => {
  const limit = LIMITS.coordinate;
  const nodes = [
    { id: 'a', x: limit - 15, y: -limit + 25 },
    { id: 'b', x: limit - 215, y: -limit + 125 }
  ];
  assert.deepEqual(groupDragDelta(nodes, 300, -400), { x: 15, y: -25 });
  const moved = nodes.map((node) => ({ ...node, x: node.x + 15, y: node.y - 25 }));
  assert.equal(moved[0].x, limit);
  assert.equal(moved[0].y, -limit);
  assert.equal(moved[0].x - moved[1].x, nodes[0].x - nodes[1].x);
  assert.equal(moved[0].y - moved[1].y, nodes[0].y - nodes[1].y);
  assert.deepEqual(groupDragDelta(moved, 50, -50), { x: 0, y: 0 });
  assert.deepEqual(groupDragDelta(moved, -50, 50), { x: -50, y: 50 });
  assert.deepEqual(groupDragDelta([
    { id: 'a', x: -limit + 8, y: limit - 12 },
    { id: 'b', x: -limit + 108, y: limit - 112 }
  ], -300, 400), { x: -8, y: 12 });
});

test('groups spanning both coordinate boundaries cannot move on that axis', () => {
  const limit = LIMITS.coordinate;
  const nodes = [{ id: 'a', x: -limit, y: -5 }, { id: 'b', x: limit, y: 5 }];
  assert.deepEqual(groupDragDelta(nodes, -20, 15), { x: 0, y: 15 });
  assert.deepEqual(groupDragDelta(nodes, 20, -15), { x: 0, y: -15 });
});

test('direction keys move by card positions across a freely arranged canvas', () => {
  const nodes = [
    { id: 'center', x: -120, y: 80 },
    { id: 'up', x: -140, y: -150 },
    { id: 'down', x: -80, y: 350 },
    { id: 'left', x: -460, y: 100 },
    { id: 'right', x: 260, y: 20 },
    { id: 'far-right', x: 600, y: 80 }
  ];
  for (const [key, id] of Object.entries({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' })) {
    assert.equal(directionalNode(nodes, 'center', key).id, id);
  }
});

test('directional navigation prefers aligned cards over near-perpendicular candidates', () => {
  const nodes = [
    { id: 'center', x: 0, y: 0 },
    { id: 'below', x: 5, y: 160 },
    { id: 'right', x: 500, y: 10 }
  ];
  assert.equal(directionalNode(nodes, 'center', 'ArrowRight').id, 'right');
  assert.equal(directionalNode(nodes, 'center', 'ArrowDown').id, 'below');
  assert.equal(directionalNode(nodes, 'right', 'ArrowLeft').id, 'center');
});

test('directional navigation uses both measured centers for tall cards', () => {
  const nodes = [
    { id: 'tall', x: 0, y: 0 },
    { id: 'aligned', x: 300, y: 100 },
    { id: 'top', x: 300, y: 0 }
  ];
  const heights = new Map([['tall', 298]]);
  assert.equal(directionalNode(nodes, 'tall', 'ArrowRight', heights).id, 'aligned');
  assert.equal(directionalNode(nodes, 'tall', 'ArrowUp', heights).id, 'top');
  assert.equal(directionalNode(nodes, 'tall', 'ArrowDown', heights), null);
  assert.equal(directionalNode(nodes, 'aligned', 'ArrowLeft', heights).id, 'tall');
  assert.equal(directionalNode(nodes, 'tall', 'ArrowRight').id, 'top');
});

test('directional navigation leaves focus in place without a directional candidate', () => {
  const nodes = [{ id: 'center', x: 0, y: 0 }, { id: 'overlap', x: 0, y: 0 }];
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(directionalNode(nodes, 'center', key), null);
  }
  assert.equal(directionalNode(nodes, 'missing', 'ArrowRight'), null);
  assert.equal(directionalNode([], 'missing', 'ArrowRight'), null);
  assert.equal(directionalNode(nodes, 'center', 'Enter'), null);
});

test('directional navigation resolves equally suitable cards in stable board order', () => {
  const nodes = [
    { id: 'center', x: 0, y: 0 },
    { id: 'above-right', x: 300, y: -80 },
    { id: 'below-right', x: 300, y: 80 }
  ];
  assert.equal(directionalNode(nodes, 'center', 'ArrowRight').id, 'above-right');
  assert.equal(directionalNode(nodes, 'center', 'ArrowRight').id, 'above-right');
});

test('horizontal connections attach to facing sides and honor multiline node heights', () => {
  const from = { x: 0, y: 0 },
    to = { x: 400, y: 80 };
  const curve = connectionCurve(from, to, 200, 100);
  assert.match(curve.path, /^M 225 100 C .* 400 130$/);
  assert.deepEqual(curve.label, { x: 312.5, y: 106 });
  const reverse = connectionCurve(to, from, 100, 200);
  assert.match(reverse.path, /^M 400 130 C .* 225 100$/);
  assert.deepEqual(reverse.label, curve.label);
});

test('vertical connections use top and bottom edges in either direction', () => {
  const from = { x: 0, y: 0 },
    to = { x: 40, y: 300 };
  assert.match(
    connectionCurve(from, to, 150, 200).path,
    /^M 112.5 150 C .* 152.5 300$/
  );
  assert.match(
    connectionCurve(to, from, 200, 150).path,
    /^M 152.5 300 C .* 112.5 150$/
  );
});

test('overlapping node positions still produce finite connection paths', () => {
  const curve = connectionCurve({ x: 10, y: 20 }, { x: 10, y: 20 });
  assert.equal(/NaN|Infinity|undefined/.test(curve.path), false);
  assert.deepEqual(curve.label, { x: 122.5, y: 60 });
});
