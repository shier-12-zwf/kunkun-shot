'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCaptureRect } = require('../src/main/ipc-validation');
const C = require('../src/shared/channels');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

function registerCapture({ currentDisplay, screenSourceFailure } = {}) {
  const display = currentDisplay || { id: 7, bounds: { x: -1440, y: -100, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  const context = { displayId: 7, displayBounds: { x: -1440, y: -100, width: 1440, height: 900 }, rect: { x: 100, y: 120, width: 300, height: 200 }, scaleFactor: 2 };
  const handlers = new Map();
  const calls = { captured: 0, crops: [] };
  const windows = {
    updateLongshotPresentation(id, patch) { calls.update = { id, patch }; return { ok: true }; },
    async withLongShotCapture(id, callback) {
      assert.equal(id, 31, 'the trusted controls sender owns the capture context');
      calls.wrapped = true;
      return callback(context);
    },
  };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, C, windows,
    screen: { getAllDisplays: () => display ? [display] : [] }, normalizeCaptureRect,
    async getScreenCaptureSources(options) {
      calls.captured += 1;
      calls.thumbnailSize = options.thumbnailSize;
      if (screenSourceFailure) throw new Error('screen capture denied');
      return [{ thumbnail: { crop(rect) { calls.crops.push(rect); return { toDataURL: () => 'data:image/png;base64,AAAA' }; } } }];
    },
    selectDisplaySource: (sources) => sources[0],
    requireUsableCaptureImage: (image) => image,
  };
  const start = source.indexOf('  ipcMain.handle(C.LONGSHOT_UPDATE');
  const end = source.indexOf('  ipcMain.handle(C.CAPTURE_GET_SOURCES', start);
  assert.ok(start >= 0 && end > start);
  Function(...Object.keys(deps), `'use strict';\n${source.slice(start, end)}`)(...Object.values(deps));
  return { capture: handlers.get(C.CAPTURE_REGION), update: handlers.get(C.LONGSHOT_UPDATE), calls };
}

test('capture IPC ignores forged renderer rectangle/display and crops the registered region at native DPI', async () => {
  const { capture, calls } = registerCapture();
  assert.equal(await capture({ sender: { id: 31 } }, { displayId: 999, rect: { x: 0, y: 0, width: 10000, height: 10000 } }), 'data:image/png;base64,AAAA');
  assert.equal(calls.wrapped, true);
  assert.deepEqual(calls.thumbnailSize, { width: 2880, height: 1800 });
  assert.deepEqual(calls.crops, [{ x: 200, y: 240, width: 600, height: 400 }]);
});

test('display layout/DPI changes fail before requesting any screen image', async () => {
  for (const currentDisplay of [
    { id: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 },
    { id: 7, bounds: { x: -1440, y: -100, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 1 },
    { id: 8, bounds: { x: -1440, y: -100, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 },
  ]) {
    const { capture, calls } = registerCapture({ currentDisplay });
    await assert.rejects(capture({ sender: { id: 31 } }), /断开|改变/);
    assert.equal(calls.captured, 0);
  }
});

test('screen capture failures propagate through the window suppression wrapper', async () => {
  const { capture, calls } = registerCapture({ screenSourceFailure: true });
  await assert.rejects(capture({ sender: { id: 31 } }), /screen capture denied/);
  assert.equal(calls.wrapped, true);
});

test('presentation IPC is controls-only and returns the validated host acknowledgement', () => {
  const { update, calls } = registerCapture();
  assert.deepEqual(update({ sender: { id: 31 } }, { expanded: true }), { ok: true });
  assert.deepEqual(calls.update, { id: 31, patch: { expanded: true } });
  assert.match(source, /\[C\.LONGSHOT_UPDATE\]:\s*\['longshot'\]/);
  assert.match(source, /\[C\.CAPTURE_REGION\]:\s*\['longshot'\]/);
});
