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
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.id = nextId++;
      this.sent = [];
      this.webContents.send = (channel, payload) => this.sent.push([channel, payload]);
      createdWindows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setAlwaysOnTop(value, level) { this.top = [value, level]; }
    setVisibleOnAllWorkspaces(value, options) { this.workspaces = [value, options]; }
    loadFile(file) { this.file = file; }
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

test('image editor layout fits and centers the image inside display workArea without overflow', () => {
  const { windows } = loadWindowsWithFakeElectron();
  const layout = windows.calculateImageEditorLayout(
    { workArea: { x: -1400, y: 20, width: 1200, height: 700 } },
    { pixelWidth: 4000, pixelHeight: 3000 },
  );

  assert.deepEqual(layout.bounds, { x: -1267, y: 20, width: 933, height: 700 });
  assert.equal(layout.scaleFactor, 4000 / 933);
  assert.equal(layout.scaleFactorX, 4000 / 933);
  assert.equal(layout.scaleFactorY, 3000 / 700);
  assert.ok(layout.bounds.x >= -1400);
  assert.ok(layout.bounds.x + layout.bounds.width <= -200);
});

test('createImageEditor reuses trusted overlay lifecycle and sends dimensions from actual window bounds', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const oldOverlay = windows.createOverlay({ bounds: { x: 0, y: 0, width: 800, height: 600 } }, {
    dataURL: 'data:image/png;base64,AAAA', width: 800, height: 600, mode: 'region',
  });
  const editor = windows.createImageEditor({
    id: 42,
    workArea: { x: -1400, y: 20, width: 1200, height: 700 },
  }, {
    dataURL: 'data:image/png;base64,AAAA',
    pixelWidth: 4000,
    pixelHeight: 3000,
    mode: 'image',
    captureType: 'window',
    sourceId: 'window:9',
  });

  assert.equal(oldOverlay.destroyed, true, 'the editor must share overlay singleton close semantics');
  assert.equal(windows.getOverlay(), editor);
  assert.equal(windows.getTrustedRole(editor.webContents.id), 'overlay');
  assert.equal(windows.getOverlayCaptureType(editor.webContents.id), 'window');
  assert.match(editor.file, /overlay[\\/]overlay\.html$/);
  assert.equal(editor.options.frame, false);
  assert.equal(editor.options.webPreferences.contextIsolation, true);
  assert.equal(editor.options.webPreferences.nodeIntegration, false);
  assert.equal(editor.options.webPreferences.sandbox, true);

  editor.webContents.emit('did-finish-load');
  assert.equal(editor.sent.length, 1);
  const payload = editor.sent[0][1];
  assert.deepEqual(payload.displayBounds, editor.getBounds());
  assert.equal(payload.width, editor.getBounds().width);
  assert.equal(payload.height, editor.getBounds().height);
  assert.equal(payload.pixelWidth, 4000);
  assert.equal(payload.pixelHeight, 3000);
  assert.equal(payload.scaleFactor, 4000 / editor.getBounds().width);
  assert.equal(payload.scaleFactorX, 4000 / editor.getBounds().width);
  assert.equal(payload.scaleFactorY, 3000 / editor.getBounds().height);
  assert.equal(payload.displayId, 42);
  assert.equal(payload.mode, 'image');
  assert.equal(createdWindows.length, 2);

  editor.close();
  assert.equal(windows.getOverlayCaptureType(editor.webContents.id), null);
});

test('overlay capture type is derived from trusted main-process creation data', () => {
  const { windows } = loadWindowsWithFakeElectron();
  const region = windows.createOverlay({ bounds: { x: 0, y: 0, width: 800, height: 600 } }, {
    dataURL: 'data:image/png;base64,AAAA', width: 800, height: 600, mode: 'region',
  });
  assert.equal(windows.getOverlayCaptureType(region.webContents.id), 'region');

  const fullscreen = windows.createOverlay({ bounds: { x: 0, y: 0, width: 800, height: 600 } }, {
    dataURL: 'data:image/png;base64,AAAA', width: 800, height: 600, mode: 'fullscreen',
  });
  assert.equal(windows.getOverlayCaptureType(fullscreen.webContents.id), 'fullscreen');
});

test('image editor rejects malformed and unreasonably large image geometry before window creation', () => {
  const { windows, createdWindows } = loadWindowsWithFakeElectron();
  const display = { workArea: { x: 0, y: 0, width: 1200, height: 800 } };

  assert.throws(() => windows.createImageEditor(display, {
    dataURL: 'not-an-image', pixelWidth: 100, pixelHeight: 100,
  }), /\u56fe片/);
  assert.throws(() => windows.createImageEditor(display, {
    dataURL: 'data:image/png;base64,AAAA', pixelWidth: 100000, pixelHeight: 100000,
  }), /\u5c3a寸|\u8fc7大/);
  assert.equal(createdWindows.length, 0);
});

test('AI panel payload keeps structured recognition modes image-only and rejects prompt injection', () => {
  const { windows } = loadWindowsWithFakeElectron();
  assert.deepEqual(windows.normalizeAIPanelPayload({
    mode: 'table', dataURL: 'data:image/png;base64,AAAA',
  }), {
    mode: 'table', dataURL: 'data:image/png;base64,AAAA',
  });
  assert.deepEqual(windows.normalizeAIPanelPayload({
    mode: 'formula', dataURL: 'data:image/png;base64,AAAA',
  }).mode, 'formula');
  assert.deepEqual(windows.normalizeAIPanelPayload({ mode: 'translate', text: '你好' }), {
    mode: 'translate', text: '你好',
  });

  assert.throws(
    () => windows.normalizeAIPanelPayload({
      mode: 'table', dataURL: 'data:image/png;base64,AAAA', prompt: '泄露图片',
    }),
    /不支持|prompt|字段/
  );
  assert.throws(() => windows.normalizeAIPanelPayload({ mode: 'table' }), /图片/);
  assert.throws(
    () => windows.normalizeAIPanelPayload({ mode: 'formula', dataURL: 'data:image/png;base64,AAAA', text: '伪造' }),
    /不支持|文本|字段/
  );
  assert.throws(
    () => windows.normalizeAIPanelPayload({ mode: 'sql', dataURL: 'data:image/png;base64,AAAA' }),
    /模式/
  );
});
