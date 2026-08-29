'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function loadWindowsWithFakeElectron() {
  const createdWindows = [];
  let nextId = 1;

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.closeAttempts = 0;
      this.preventedCloseAttempts = 0;
      this.showCalls = 0;
      this.focusCalls = 0;
      this.webContents = new EventEmitter();
      this.webContents.id = nextId++;
      this.sent = [];
      this.webContents.send = (channel, payload) => this.sent.push([channel, payload]);
      createdWindows.push(this);
    }

    isDestroyed() { return this.destroyed; }
    show() { this.showCalls += 1; }
    focus() { this.focusCalls += 1; }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = [value, level]; }
    setVisibleOnAllWorkspaces(value, options) { this.workspaces = [value, options]; }
    loadFile(file) { this.file = file; }

    close() {
      if (this.destroyed) return false;
      this.closeAttempts += 1;
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      this.emit('close', event);
      if (prevented) {
        this.preventedCloseAttempts += 1;
        return false;
      }
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
      return true;
    }
  }
  FakeBrowserWindow.getAllWindows = () => createdWindows.filter((win) => !win.destroyed);

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

function recorderInit() {
  return {
    rect: { x: 40, y: 60, width: 320, height: 180 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    scaleFactor: 2,
    displayId: 1,
    fps: 30,
    toGif: false,
    systemAudio: false,
    microphone: false,
  };
}

test('recorder window wiring focuses content-bearing singleton and enforces lifecycle tokens', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const first = windows.createRecorder(recorderInit());
  assert.equal(first.created, true);
  assert.equal(first.busy, false);
  assert.equal(first.state, 'opening');
  const win = first.win;

  const second = windows.createRecorder(recorderInit());
  assert.equal(second.created, false, 'a second start must reuse the existing recorder');
  assert.equal(second.busy, true);
  assert.equal(second.win, win);
  assert.equal(createdWindows.length, 1);
  assert.equal(win.closeAttempts, 0);
  assert.equal(win.focusCalls, 1);

  assert.deepEqual(
    windows.updateRecorderState(win.webContents.id, {
      state: 'active', generation: 4, saveAttempt: 0,
    }),
    { ok: true, state: 'active', generation: 4, saveAttempt: 0 },
  );

  win.close();
  assert.equal(win.destroyed, false, 'native close must be prevented while recording');
  assert.equal(win.preventedCloseAttempts, 1);
  assert.equal(win.showCalls, 2);
  assert.equal(win.focusCalls, 2);
  assert.deepEqual(windows.requestRecorderClose(win.webContents.id), {
    ok: false, busy: true, state: 'active',
  });

  assert.throws(
    () => windows.updateRecorderState(win.webContents.id, {
      state: 'paused', generation: 3, saveAttempt: 0,
    }),
    /过期/,
  );
  assert.deepEqual(
    windows.updateRecorderState(win.webContents.id, {
      state: 'saved', generation: 4, saveAttempt: 1,
    }),
    { ok: true, state: 'saved', generation: 4, saveAttempt: 1 },
  );

  assert.deepEqual(windows.requestRecorderClose(win.webContents.id), {
    ok: true, state: 'saved',
  });
  assert.equal(win.destroyed, true, 'a saved recorder may close directly');
  assert.equal(windows.getRecorderState(), null);
});
