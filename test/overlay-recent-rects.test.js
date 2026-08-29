const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendRecentRect,
  loadRecentRects,
  persistRecentRects,
  resolveRecentRect,
} = require('../src/renderer/overlay/overlay.js');

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test('recent selections survive a new overlay session and keep only the latest ten', () => {
  const storage = memoryStorage();
  let records = [];
  for (let index = 0; index < 11; index += 1) {
    records = appendRecentRect(
      records,
      { x: index * 10, y: index, width: 300, height: 180 },
      { id: 'display-1', width: 1440, height: 900 },
      10
    );
  }
  persistRecentRects(storage, records);

  const nextOverlaySession = loadRecentRects(storage);
  assert.equal(nextOverlaySession.length, 10);
  assert.equal(nextOverlaySession[0].x, 10);
  assert.equal(nextOverlaySession[9].x, 100);
  assert.equal(nextOverlaySession[9].displayId, 'display-1');
});

test('retrying the same confirmed selection does not create duplicate history entries', () => {
  const display = { id: 'display-1', width: 1440, height: 900 };
  const rect = { x: 10, y: 20, width: 300, height: 180 };
  const once = appendRecentRect([], rect, display, 10);
  const retried = appendRecentRect(once, rect, display, 10);

  assert.equal(retried.length, 1);
  assert.deepEqual(retried, once);
});

test('malformed persisted selections are ignored without breaking capture startup', () => {
  const storage = memoryStorage({
    'kunkun-shot:recent-rects:v1': JSON.stringify([
      null,
      { x: 'oops', y: 1, width: 10, height: 10, displayWidth: 100, displayHeight: 100 },
      { x: 1, y: 2, width: -4, height: 8, displayWidth: 100, displayHeight: 100 },
      { x: 5, y: 6, width: 20, height: 30, displayWidth: 100, displayHeight: 100 },
    ]),
  });

  assert.deepEqual(loadRecentRects(storage), [
    {
      x: 5,
      y: 6,
      width: 20,
      height: 30,
      displayId: '',
      displayWidth: 100,
      displayHeight: 100,
    },
  ]);

  const brokenStorage = { getItem() { throw new Error('denied'); } };
  assert.deepEqual(loadRecentRects(brokenStorage), []);
});

test('a saved selection is scaled and clamped for the current display', () => {
  const resolved = resolveRecentRect(
    { x: 1200, y: 700, width: 400, height: 300, displayWidth: 1600, displayHeight: 1000 },
    { width: 800, height: 500 }
  );

  assert.deepEqual(resolved, { x: 600, y: 350, width: 200, height: 150 });
  const clamped = resolveRecentRect(
    { x: 1900, y: 1000, width: 500, height: 500, displayWidth: 1920, displayHeight: 1080 },
    { width: 1280, height: 720 }
  );
  assert.ok(Math.abs(clamped.x - 946.6666666666666) < 1e-9);
  assert.ok(Math.abs(clamped.y - 386.6666666666667) < 1e-9);
  assert.ok(Math.abs(clamped.width - 333.3333333333333) < 1e-9);
  assert.ok(Math.abs(clamped.height - 333.3333333333333) < 1e-9);
});
