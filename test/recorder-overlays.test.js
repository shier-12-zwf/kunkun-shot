'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRecorderOverlayState,
  normalizeRecorderActionEvent,
  resolveRecorderCaptureGeometry,
} = require('../src/shared/recorder-overlays');

const geometry = {
  rect: { x: 100, y: 50, width: 400, height: 200 },
  displayBounds: { x: -300, y: 20, width: 1440, height: 900 },
  scaleFactor: 2,
};

test('recorder action coordinates map from global logical points into capture pixels', () => {
  const event = normalizeRecorderActionEvent({
    type: 'mouse-down',
    button: 'left',
    x: -150,
    y: 120,
  }, geometry, 1234);

  assert.deepEqual(event, {
    type: 'mouse-down',
    button: 'left',
    x: 100,
    y: 100,
    at: 1234,
    modifiers: { alt: false, control: false, meta: false, shift: false },
  });
});

test('capture geometry follows the desktop stream actual pixels instead of the nominal display scale', () => {
  const resolved = resolveRecorderCaptureGeometry({
    rect: { x: 200, y: 100, width: 800, height: 500 },
    displayBounds: { x: -1600, y: 40, width: 1600, height: 1000 },
    scaleFactor: 2,
  }, {
    width: 2560,
    height: 1440,
  });

  assert.deepEqual(resolved, {
    sourceX: 320,
    sourceY: 144,
    sourceWidth: 1280,
    sourceHeight: 720,
    outputWidth: 1280,
    outputHeight: 720,
    actionGeometry: {
      rect: { x: 200, y: 100, width: 800, height: 500 },
      displayBounds: { x: -1600, y: 40, width: 1600, height: 1000 },
      pixelWidth: 1280,
      pixelHeight: 720,
    },
  });

  const center = normalizeRecorderActionEvent({
    type: 'mouse-down',
    x: -1000,
    y: 390,
  }, resolved.actionGeometry, 99);
  assert.equal(center.x, 640);
  assert.equal(center.y, 360);
});

test('capture geometry rounds shared crop edges once so output and pointer endpoints stay aligned', () => {
  const resolved = resolveRecorderCaptureGeometry({
    rect: { x: 101, y: 51, width: 401, height: 201 },
    displayBounds: { x: 300, y: -900, width: 1440, height: 900 },
    scaleFactor: 1,
  }, {
    width: 2560,
    height: 1600,
  });

  assert.equal(resolved.sourceX, 180);
  assert.equal(resolved.sourceY, 91);
  assert.equal(resolved.sourceWidth, 712);
  assert.equal(resolved.sourceHeight, 357);
  const farEdge = normalizeRecorderActionEvent({
    type: 'mouse-up',
    x: 300 + 101 + 401,
    y: -900 + 51 + 201,
  }, resolved.actionGeometry, 1);
  assert.equal(farEdge.x, resolved.outputWidth);
  assert.equal(farEdge.y, resolved.outputHeight);
});

test('recorder action normalization rejects out-of-bounds and untrusted keys', () => {
  assert.equal(normalizeRecorderActionEvent({
    type: 'mouse-down', x: 9999, y: 9999,
  }, geometry, 1), null);
  assert.equal(normalizeRecorderActionEvent({
    type: 'key', key: 'secret\nvalue', x: 0, y: 0,
  }, geometry, 1), null);
  assert.equal(normalizeRecorderActionEvent({ type: 'unknown' }, geometry, 1), null);
});

test('click and keystroke prompts expire and queues remain bounded', () => {
  const state = createRecorderOverlayState({ maxActions: 4, actionLifetimeMs: 1000 });
  for (let index = 0; index < 12; index += 1) {
    state.accept({ type: 'key', key: `F${index}`, modifiers: {} }, geometry, index * 10);
  }
  assert.equal(state.snapshot().actions.length, 4);
  assert.equal(state.snapshot().actions.at(-1).key, 'F11');

  const calls = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'globalAlpha' || prop === 'fillStyle' || prop === 'strokeStyle'
        || prop === 'lineWidth' || prop === 'font' || prop === 'textAlign'
        || prop === 'textBaseline' || prop === 'lineCap' || prop === 'lineJoin') return undefined;
      return (...args) => calls.push([prop, ...args]);
    },
    set() { return true; },
  });
  state.render(ctx, 800, 400, 200);
  assert.ok(calls.some(([name]) => name === 'fillText'));
  state.render(ctx, 800, 400, 5000);
  assert.equal(state.snapshot().actions.length, 0);
});

test('live pen builds bounded persistent strokes only while enabled', () => {
  const state = createRecorderOverlayState({ maxStrokes: 2, maxPointsPerStroke: 3 });
  state.accept({ type: 'mouse-down', button: 'left', x: -150, y: 120 }, geometry, 1);
  assert.equal(state.snapshot().strokes.length, 0);

  state.setPenEnabled(true);
  state.accept({ type: 'mouse-down', button: 'left', x: -150, y: 120 }, geometry, 2);
  state.accept({ type: 'mouse-dragged', button: 'left', x: -140, y: 125 }, geometry, 3);
  state.accept({ type: 'mouse-dragged', button: 'left', x: -130, y: 130 }, geometry, 4);
  state.accept({ type: 'mouse-dragged', button: 'left', x: -120, y: 135 }, geometry, 5);
  state.accept({ type: 'mouse-up', button: 'left', x: -120, y: 135 }, geometry, 6);

  const snapshot = state.snapshot();
  assert.equal(snapshot.strokes.length, 1);
  assert.equal(snapshot.strokes[0].length, 3);
  state.clearStrokes();
  assert.equal(state.snapshot().strokes.length, 0);
});
