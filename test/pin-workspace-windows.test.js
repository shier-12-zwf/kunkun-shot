const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const C = require('../src/shared/channels');

function loadWindowsWithFakeElectron() {
  let nextWebContentsId = 1;
  const createdWindows = [];

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.destroyed = false;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.id = nextWebContentsId++;
      this.sent = [];
      this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
      createdWindows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; }
    setOpacity(value) { this.opacity = value; }
    setResizable(value) { this.resizable = value; }
    setTitle(value) { this.title = value; }
    loadFile() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
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

test('window workspace snapshot uses current bounds instead of stale creation bounds', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const pin = windows.createPin({
    text: 'keep me',
    bounds: { x: 1, y: 2, width: 200, height: 100 },
    state: { opacity: 0.8, locked: true, title: 'notes' },
  });
  pin.setBounds({ x: 50, y: 60, width: 500, height: 300 });
  let saved = null;

  assert.equal(windows.savePinWorkspace({ save(value) { saved = value; return value.length; } }), 1);
  assert.deepEqual(saved, [{
    payload: {
      bounds: { x: 1, y: 2, width: 200, height: 100 },
      text: 'keep me',
      state: { opacity: 0.8, locked: true, title: 'notes' },
    },
    bounds: { x: 50, y: 60, width: 500, height: 300 },
    state: { opacity: 0.8, locked: true, title: 'notes' },
  }]);
  assert.equal(createdWindows.length, 1);
});

test('restoring a persisted workspace recreates all valid pin payloads', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const count = windows.restorePinWorkspace({
    load() {
      return [
        { text: 'one', bounds: { x: 10, y: 20, width: 200, height: 100 } },
        { color: '#336699', bounds: { x: 30, y: 40, width: 240, height: 140 }, state: { onTop: false } },
        { bogus: true },
      ];
    },
  });

  assert.equal(count, 2);
  assert.equal(createdWindows.length, 2);
  assert.equal(windows.getPinPayload(createdWindows[1].webContents.id).state.onTop, false);
});

test('live pin state updates are validated, applied and included in workspace snapshots', () => {
  const { windows } = loadWindowsWithFakeElectron();
  const pin = windows.createPin({
    text: 'stateful',
    bounds: { x: 10, y: 20, width: 200, height: 100 },
    state: { opacity: 0.9, onTop: true },
  });
  const changes = [];
  const stop = windows.onPinWorkspaceChanged((reason) => changes.push(reason));

  assert.deepEqual(windows.updatePinWorkspaceState(pin.webContents.id, {
    opacity: 0.2,
    locked: true,
    onTop: false,
    title: 'Reference',
    ignored: 'drop me',
  }), {
    opacity: 0.3,
    locked: true,
    onTop: false,
    title: 'Reference',
  });
  assert.equal(pin.opacity, 0.3);
  assert.equal(pin.resizable, false);
  assert.equal(pin.alwaysOnTop, false);
  assert.equal(pin.title, 'Reference');
  assert.deepEqual(windows.getPinPayload(pin.webContents.id).state, {
    opacity: 0.3,
    locked: true,
    onTop: false,
    title: 'Reference',
  });

  pin.emit('move');
  pin.emit('resize');
  stop();
  assert.deepEqual(changes, ['state', 'bounds', 'bounds']);
});

test('image content updates are ordered, replay-safe and persisted in snapshots', () => {
  const { windows } = loadWindowsWithFakeElectron();
  const initial = 'data:image/png;base64,QUFBQQ==';
  const annotated = 'data:image/png;base64,QkJCQg==';
  const conflicting = 'data:image/png;base64,Q0NDQw==';
  const pin = windows.createPin({
    dataURL: initial,
    bounds: { x: 10, y: 20, width: 200, height: 100 },
  });
  const changes = [];
  windows.onPinWorkspaceChanged((reason) => changes.push(reason));

  assert.deepEqual(windows.updatePinContent(pin.webContents.id, {
    baseRevision: 0,
    revision: 1,
    dataURL: annotated,
  }), { revision: 1 });
  assert.deepEqual(windows.updatePinContent(pin.webContents.id, {
    baseRevision: 0,
    revision: 1,
    dataURL: annotated,
  }), { revision: 1 }, 'an exact retry must be idempotent');
  assert.throws(() => windows.updatePinContent(pin.webContents.id, {
    baseRevision: 0,
    revision: 1,
    dataURL: conflicting,
  }), /版本/);
  assert.throws(() => windows.updatePinContent(pin.webContents.id, {
    baseRevision: 0,
    revision: 2,
    dataURL: conflicting,
  }), /版本/);

  const payload = windows.getPinPayload(pin.webContents.id);
  assert.equal(payload.dataURL, annotated);
  assert.equal(payload.contentRevision, 1);
  let saved = null;
  windows.savePinWorkspace({ save(value) { saved = value; return value.length; } });
  assert.equal(saved[0].payload.dataURL, annotated);
  assert.equal(changes.filter((reason) => reason === 'content').length, 1);
});

test('application quit waits for every pin renderer to flush and rejects stale acknowledgements', async () => {
  const { windows } = loadWindowsWithFakeElectron();
  const first = windows.createPin({
    text: 'one',
    bounds: { x: 1, y: 2, width: 200, height: 100 },
  });
  const second = windows.createPin({
    dataURL: 'data:image/png;base64,QUFBQQ==',
    bounds: { x: 3, y: 4, width: 220, height: 120 },
  });

  const pending = windows.preparePinsForClose({ timeoutMs: 1000 });
  const firstRequest = first.sent.at(-1).payload.requestId;
  const secondRequest = second.sent.at(-1).payload.requestId;
  assert.equal(first.sent.at(-1).payload.cmd, 'prepare-close');
  assert.equal(second.sent.at(-1).payload.cmd, 'prepare-close');
  assert.throws(() => windows.acknowledgePinClose(first.webContents.id, {
    requestId: `${firstRequest}-stale`, ok: true,
  }), /过期/);

  assert.deepEqual(windows.acknowledgePinClose(first.webContents.id, {
    requestId: firstRequest, ok: true,
  }), { ok: true });
  assert.deepEqual(windows.acknowledgePinClose(second.webContents.id, {
    requestId: secondRequest, ok: true,
  }), { ok: true });
  assert.deepEqual(await pending, {
    ok: true,
    results: [
      { ok: true, webContentsId: first.webContents.id, error: '' },
      { ok: true, webContentsId: second.webContents.id, error: '' },
    ],
  });
});

test('a pin that disappears before its quit acknowledgement fails closed', async () => {
  const { windows } = loadWindowsWithFakeElectron();
  const pin = windows.createPin({
    text: 'not yet flushed',
    bounds: { x: 1, y: 2, width: 200, height: 100 },
  });
  const pending = windows.preparePinsForClose({ timeoutMs: 1000 });
  pin.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /同步完成前已关闭/);
});

test('canceling application quit clears waiters and tells every live pin to resume', async () => {
  const { windows } = loadWindowsWithFakeElectron();
  const first = windows.createPin({ text: 'one', bounds: { x: 1, y: 2, width: 30, height: 40 } });
  const second = windows.createPin({ text: 'two', bounds: { x: 5, y: 6, width: 30, height: 40 } });
  const pending = windows.preparePinsForClose({ timeoutMs: 1000 });

  assert.equal(windows.cancelPinClosePreparation(), 2);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.results.every((item) => /退出已取消/.test(item.error)), true);
  for (const win of [first, second]) {
    assert.deepEqual(win.sent.at(-1), {
      channel: C.PIN_CMD,
      payload: { cmd: 'cancel-prepare-close' },
    });
  }
});
