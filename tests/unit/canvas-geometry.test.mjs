import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinate,
  worldPoint,
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
