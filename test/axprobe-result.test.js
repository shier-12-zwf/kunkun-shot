const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_AX_GEOMETRY,
  normalizeProbePoint,
  normalizeProbeResult,
} = require('../src/main/axprobe');

test('AX input accepts only bounded finite numeric coordinates', () => {
  assert.deepEqual(normalizeProbePoint(-100, 200), { x: -100, y: 200 });
  for (const point of [
    ['1', 2],
    [true, 2],
    [null, 2],
    [Number.NaN, 2],
    [2, Number.POSITIVE_INFINITY],
    [MAX_AX_GEOMETRY + 1, 2],
  ]) {
    assert.equal(normalizeProbePoint(point[0], point[1]), null);
  }
});

test('AX result rejects a frame when any geometry field is invalid', () => {
  for (const frame of [
    { x: Number.POSITIVE_INFINITY, y: 2, w: 20, h: 20 },
    { x: 1, y: Number.NaN, w: 20, h: 20 },
    { x: '1', y: 2, w: 20, h: 20 },
    { x: 1, y: 2, w: 0, h: 20 },
    { x: 1, y: 2, w: 20, h: 0 },
    { x: 1, y: 2, w: -1, h: 20 },
    { x: 1, y: 2, w: 20, h: -1 },
    { x: 1, y: 2, w: Number.NaN, h: 20 },
    { x: 1, y: 2, w: 20, h: Number.POSITIVE_INFINITY },
    { x: 1, y: 2, w: '20', h: 20 },
    { x: 1, y: 2, w: true, h: 20 },
    { x: 1, y: 2, w: MAX_AX_GEOMETRY + 1, h: 20 },
    { x: 1, y: 2, h: 20 },
    { x: 1, y: 2, w: 20 },
  ]) {
    assert.deepEqual(normalizeProbeResult({ frame }), { frame: null });
  }
});

test('AX result preserves a frame only when all geometry is bounded and valid', () => {
  const result = { frame: { x: -1, y: 2, w: 30, h: 40, role: 'AXButton' } };
  assert.equal(normalizeProbeResult(result), result);
  assert.equal(normalizeProbeResult(null), null);
});
