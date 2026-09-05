'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadWindowsWithFakeElectron() {
  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: class FakeBrowserWindow {},
        screen: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/windows');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function assertFullyVisible(bounds, displayBounds) {
  assert.ok(bounds.x >= displayBounds.x);
  assert.ok(bounds.y >= displayBounds.y);
  assert.ok(bounds.x + bounds.width <= displayBounds.x + displayBounds.width);
  assert.ok(bounds.y + bounds.height <= displayBounds.y + displayBounds.height);
}

test('full-screen longshot and recorder controls remain fully visible', () => {
  const windows = loadWindowsWithFakeElectron();
  const displayBounds = { x: 0, y: 0, width: 1440, height: 900 };
  const fullScreen = { x: 0, y: 0, width: 1440, height: 900 };

  const longshot = windows.calculateCaptureControlBounds({
    rect: fullScreen,
    displayBounds,
    width: 860,
    height: 126,
  });
  const recorder = windows.calculateCaptureControlBounds({
    rect: fullScreen,
    displayBounds,
    width: 520,
    height: 56,
  });

  assertFullyVisible(longshot, displayBounds);
  assertFullyVisible(recorder, displayBounds);
});

test('control geometry respects negative display origins and clamps oversized widths', () => {
  const windows = loadWindowsWithFakeElectron();
  const displayBounds = { x: -1728, y: -120, width: 1728, height: 1117 };
  const rect = { x: 0, y: 20, width: 1728, height: 1070 };
  const bounds = windows.calculateCaptureControlBounds({
    rect,
    displayBounds,
    width: 2200,
    height: 126,
  });

  assert.deepEqual(bounds, {
    x: -1728,
    y: 871,
    width: 1728,
    height: 126,
  });
  assertFullyVisible(bounds, displayBounds);
});

test('control geometry keeps the preferred below-selection placement when it fits', () => {
  const windows = loadWindowsWithFakeElectron();
  const displayBounds = { x: 100, y: 50, width: 1200, height: 800 };
  const rect = { x: 200, y: 100, width: 400, height: 240 };
  const bounds = windows.calculateCaptureControlBounds({
    rect,
    displayBounds,
    width: 520,
    height: 56,
  });

  assert.deepEqual(bounds, {
    x: 240,
    y: 400,
    width: 520,
    height: 56,
  });
});
