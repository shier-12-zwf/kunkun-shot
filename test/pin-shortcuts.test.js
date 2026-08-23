const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function loadWindowsWithFakeElectron() {
  let nextWebContentsId = 1;
  const createdWindows = [];

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.id = nextWebContentsId++;
      this.webContents.send = () => {};
      createdWindows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    loadFile() {}
    close() { this.destroy(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
  }

  FakeBrowserWindow.getAllWindows = () => createdWindows.filter((win) => !win.isDestroyed());

  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: FakeBrowserWindow, screen: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/windows');
    delete require.cache[modulePath];
    return { windows: require(modulePath), createdWindows };
  } finally {
    Module._load = originalLoad;
  }
}

test('pin shortcut loader maps persisted pin* keys to runtime actions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pin', 'pin.js'), 'utf8');
  const expected = {
    lock: 'pinLock',
    top: 'pinTop',
    select: 'pinSelect',
    pass: 'pinPass',
    thumb: 'pinThumb',
  };
  for (const [action, configKey] of Object.entries(expected)) {
    assert.match(source, new RegExp(`${action}\\s*:\\s*['\"]${configKey}['\"]`));
  }
});

test('bulk pin destroy does not retain sensitive payloads in restorable history', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const pin = windows.createPin({
    text: 'sensitive clipboard text',
    bounds: { x: 10, y: 20, width: 300, height: 200 },
  });

  windows.pinAllDestroy();

  assert.equal(windows.pinCount(), 0);
  assert.equal(windows.getPinPayload(pin.webContents.id), null);
  assert.equal(windows.restoreLastPin(), false, 'destroyed payload must not be recoverable through pin history');
  assert.equal(createdWindows.length, 1, 'restoring must not recreate a destroyed sensitive pin');
});

test('restoreLastPin recreates a normally closed Finder file pin', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const file = path.resolve(__filename);
  const pin = windows.createPin({
    file,
    bounds: { x: 10, y: 20, width: 280, height: 120 },
  });

  pin.close();

  assert.equal(windows.restoreLastPin(), true);
  assert.equal(createdWindows.length, 2);
  assert.equal(windows.getPinPayload(createdWindows[1].webContents.id).file, file);
});
