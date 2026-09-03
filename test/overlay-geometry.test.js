const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createOverlayRectFromDrag,
  getOverlayRectSourceSize,
  mapOverlayPointToSource,
  mapOverlayRectToSource,
  moveOverlayRect,
  nudgeOverlayRect,
  resizeOverlayRect,
  setOverlayRectSourceSize,
} = require('../src/renderer/overlay/overlay-geometry');

const viewport = { width: 933, height: 701 };
const source = { width: 4000, height: 3001 };

function assertInside(rect) {
  assert.ok(rect.x >= 0);
  assert.ok(rect.y >= 0);
  assert.ok(rect.x + rect.width <= viewport.width + 1e-7);
  assert.ok(rect.y + rect.height <= viewport.height + 1e-7);
}

test('source size is derived from independently mapped edges, not a scalar DPR', () => {
  const rect = { x: 100.2, y: 50.4, width: 400.4, height: 300.2 };
  assert.deepEqual(getOverlayRectSourceSize(rect, viewport, source), {
    width: 1716,
    height: 1285,
  });
  assert.deepEqual(
    getOverlayRectSourceSize({ x: 0, y: 0, width: 933, height: 701 }, viewport, source),
    { width: 4000, height: 3001 },
  );
});

test('pixel sampling maps X/Y independently and clamps the far edge to the last source pixel', () => {
  assert.deepEqual(
    mapOverlayPointToSource({ x: viewport.width, y: viewport.height }, viewport, source),
    { x: source.width - 1, y: source.height - 1 },
  );
  assert.deepEqual(
    mapOverlayPointToSource({ x: viewport.width / 2, y: viewport.height / 2 }, viewport, source),
    { x: 2000, y: 1500 },
  );
  assert.equal(
    mapOverlayPointToSource({ x: -0.01, y: 12 }, viewport, source),
    null,
  );
});

test('shift/preset drag keeps an exact source-pixel ratio at display boundaries', () => {
  const rect = createOverlayRectFromDrag(
    { x: 920, y: 690 },
    { x: 1200, y: 900 },
    viewport,
    source,
    { width: 16, height: 9 },
  );
  const mapped = mapOverlayRectToSource(rect, viewport, source);
  assertInside(rect);
  assert.ok(mapped.width > 0 && mapped.height > 0);
  assert.equal(mapped.width * 9, mapped.height * 16);
});

test('resize remains bounded and exact for every fixed-ratio handle', () => {
  const base = setOverlayRectSourceSize(
    { x: 650, y: 470, width: 100, height: 100 },
    { width: 640, height: 360, primary: 'width' },
    viewport,
    source,
    { width: 16, height: 9 },
  );

  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const rect = resizeOverlayRect(
      base,
      handle,
      { x: handle.includes('w') ? -300 : 1300, y: handle.includes('n') ? -300 : 1000 },
      viewport,
      source,
      { width: 16, height: 9 },
    );
    const mapped = mapOverlayRectToSource(rect, viewport, source);
    assertInside(rect);
    assert.equal(mapped.width * 9, mapped.height * 16, handle);
  }
});

test('numeric source dimensions round-trip to the actual exported dimensions', () => {
  const rect = setOverlayRectSourceSize(
    { x: 121.25, y: 88.5, width: 250, height: 160 },
    { width: 1280, height: 720, primary: 'width' },
    viewport,
    source,
    { width: 16, height: 9 },
  );
  assert.deepEqual(getOverlayRectSourceSize(rect, viewport, source), {
    width: 1280,
    height: 720,
  });
  assertInside(rect);
});

test('moving a selection preserves its exact source-pixel dimensions', () => {
  const base = { x: 101.25, y: 72.75, width: 333.4, height: 222.2 };
  const before = getOverlayRectSourceSize(base, viewport, source);
  const moved = moveOverlayRect(base, { x: 147.6, y: 93.2 }, viewport, source);
  assert.deepEqual(getOverlayRectSourceSize(moved, viewport, source), before);
  assertInside(moved);
});

test('keyboard resize uses inward shrink/outward expand semantics and preserves ratio', () => {
  const base = setOverlayRectSourceSize(
    { x: 200, y: 140, width: 300, height: 200 },
    { width: 640, height: 480, primary: 'width' },
    viewport,
    source,
    { width: 4, height: 3 },
  );
  const before = mapOverlayRectToSource(base, viewport, source);
  const shrunk = nudgeOverlayRect(base, 'ArrowLeft', 'shrink', viewport, source, { width: 4, height: 3 });
  const expanded = nudgeOverlayRect(base, 'ArrowLeft', 'expand', viewport, source, { width: 4, height: 3 });
  const shrinkSource = mapOverlayRectToSource(shrunk, viewport, source);
  const expandSource = mapOverlayRectToSource(expanded, viewport, source);

  assert.ok(shrinkSource.width < before.width);
  assert.ok(shrinkSource.x > before.x);
  assert.ok(expandSource.width > before.width);
  assert.ok(expandSource.x < before.x);
  assert.equal(shrinkSource.width * 3, shrinkSource.height * 4);
  assert.equal(expandSource.width * 3, expandSource.height * 4);
});

test('history image reconstruction keeps the independent source-axis canvas size', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  const historyLoader = controller.match(/function loadHistoryImage\([\s\S]*?\n  }\n  async function browseHistory/);
  assert.ok(historyLoader, 'history image loader must exist');
  assert.match(historyLoader[0], /var sourceSize = currentSourceSize\(\)/);
  assert.doesNotMatch(historyLoader[0], /var phys = dpr\(\)/);
});
