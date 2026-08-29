const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInitialOverlayRect,
  mapOverlayRectToSource,
  buildOverlayResultGeometry,
} = require('../src/renderer/overlay/overlay.js');

test('fullscreen and image modes start with the complete editor canvas selected', () => {
  assert.deepEqual(resolveInitialOverlayRect('fullscreen', 1280, 720), {
    x: 0, y: 0, width: 1280, height: 720,
  });
  assert.deepEqual(resolveInitialOverlayRect('image', 933, 700), {
    x: 0, y: 0, width: 933, height: 700,
  });
  assert.equal(resolveInitialOverlayRect('region', 1280, 720), null);
  assert.equal(resolveInitialOverlayRect('record', 1280, 720), null);
  assert.equal(resolveInitialOverlayRect('long', 1280, 720), null);
  assert.equal(resolveInitialOverlayRect('image', 0, 720), null);
});

test('integer editor rounding still maps the complete selection to every source pixel', () => {
  assert.deepEqual(mapOverlayRectToSource(
    { x: 0, y: 0, width: 933, height: 700 },
    { width: 933, height: 700 },
    { width: 4000, height: 3000 },
  ), { x: 0, y: 0, width: 4000, height: 3000 });

  assert.deepEqual(mapOverlayRectToSource(
    { x: 932, y: 699, width: 1, height: 1 },
    { width: 933, height: 700 },
    { width: 4000, height: 3000 },
  ), { x: 3996, y: 2996, width: 4, height: 4 });
});

test('result geometry uses the editor window real screen origin and stays in source bounds', () => {
  assert.deepEqual(buildOverlayResultGeometry(
    { x: 100.2, y: 50.4, width: 400.4, height: 300.2 },
    { width: 933, height: 700 },
    { width: 4000, height: 3000 },
    { x: -1267, y: 20, width: 933, height: 700 },
  ), {
    rect: { x: 100, y: 50, width: 400, height: 300 },
    bounds: { x: -1167, y: 70, width: 400, height: 300 },
    sourceRect: { x: 430, y: 216, width: 1716, height: 1287 },
  });
});
