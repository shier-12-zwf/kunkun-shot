'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const C = require('../src/shared/channels');

function loadWindows() {
  const created = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = options.show !== false;
      this.destroyed = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.id = created.length + 1;
      this.webContents.send = (...args) => this.sent.push(args);
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setAlwaysOnTop(value, level) { this.top = [value, level]; }
    setVisibleOnAllWorkspaces(value, options) { this.workspaces = [value, options]; }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    loadFile(file) { this.file = file; }
    hide() { this.visible = false; }
    showInactive() { this.visible = true; this.showInactiveCalls = (this.showInactiveCalls || 0) + 1; }
    moveTop() { this.moveTopCalls = (this.moveTopCalls || 0) + 1; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
    close() { this.destroy(); }
  }
  const previous = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: FakeWindow, screen: {} };
    return previous.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/main/windows')];
    return { windows: require('../src/main/windows'), created };
  } finally { Module._load = previous; }
}

const init = (rect = { x: 100, y: 100, width: 700, height: 500 }) => ({
  rect, displayBounds: { x: -1440, y: -100, width: 1440, height: 900 }, displayId: 7, scaleFactor: 2,
});

test('longshot owns a permanently mouse-transparent non-focusing guide and a separate compact toolbar', () => {
  const { windows, created } = loadWindows();
  const controls = windows.createLongShot(init());
  assert.equal(created.length, 2);
  const guide = created.find((win) => win !== controls);
  assert.equal(guide.ignoreMouse, true);
  assert.equal(guide.options.focusable, false);
  assert.equal(guide.options.hasShadow, false);
  assert.equal(controls.options.show, false);
  assert.equal(controls.options.height, 76);
  assert.equal(windows.getTrustedRole(guide.webContents.id), 'longshot-guide');
  assert.equal(windows.isTrustedSender(guide.webContents.id, ['longshot']), false);
  assert.deepEqual(guide.bounds, init().displayBounds);
  controls.webContents.emit('did-finish-load');
  guide.webContents.emit('did-finish-load');
  assert.equal(controls.sent[0][1].surface, 'controls');
  assert.equal(controls.sent[0][1].autoStart, true);
  assert.equal(guide.sent[0][1].surface, 'guide');
  assert.deepEqual(guide.sent[0][1].layout.rect, init().rect);
  assert.equal(guide.showInactiveCalls, 1);
  assert.equal(controls.showInactiveCalls, 1);
  assert.equal(controls.moveTopCalls, 2, 'a later-loading guide must not dim or cover the controls');
});

test('native close, renderer crash and new sessions cannot leave an invisible event-eating guide behind', () => {
  for (const close of ['controls', 'guide', 'crash']) {
    const { windows, created } = loadWindows();
    const controls = windows.createLongShot(init());
    const guide = created.find((win) => win !== controls);
    if (close === 'crash') controls.webContents.emit('render-process-gone');
    else (close === 'controls' ? controls : guide).close();
    assert.equal(controls.destroyed, true);
    assert.equal(guide.destroyed, true);
    assert.equal(windows.getLongShotSnapshot(), null);
    assert.equal(windows.getTrustedRole(guide.webContents.id), null);
  }
  const { windows, created } = loadWindows();
  windows.createLongShot(init());
  windows.createLongShot(init());
  assert.ok(created.slice(0, 2).every((win) => win.destroyed));
  windows.closeLongShot();
  assert.ok(created.every((win) => win.destroyed));
});

test('presentation updates resize controls, hydrate guides after reload and reject unknown senders', () => {
  const { windows, created } = loadWindows();
  const controls = windows.createLongShot(init());
  const guide = created.find((win) => win !== controls);
  const result = windows.updateLongshotPresentation(controls.webContents.id, { expanded: true, frameCount: 4, outputWidth: 1400, outputHeight: 2400, capturing: false });
  assert.equal(result.ok, true);
  assert.equal(controls.bounds.height, 300);
  assert.equal(guide.sent.at(-1)[1].frameCount, 4);
  assert.ok('layout' in guide.sent.at(-1)[1]);
  guide.webContents.emit('did-finish-load');
  assert.equal(guide.sent.at(-1)[1].presentation.frameCount, 4);
  assert.throws(() => windows.updateLongshotPresentation(guide.webContents.id, { expanded: false }), /不存在|失效/);
});

test('repeated presentation skips duplicate thumbnails and unchanged bounds while guide reload restores full state', () => {
  const { windows, created } = loadWindows();
  const controls = windows.createLongShot(init());
  const guide = created.find((win) => win !== controls);
  const previewDataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
  const fullState = { previewDataURL, outputWidth: 1400, outputHeight: 2400, frameCount: 4, capturing: true, expanded: false };
  let resizeCalls = 0;
  const setBounds = controls.setBounds.bind(controls);
  controls.setBounds = (bounds) => { resizeCalls += 1; setBounds(bounds); };
  controls.webContents.emit('did-finish-load');
  guide.webContents.emit('did-finish-load');

  windows.updateLongshotPresentation(controls.webContents.id, fullState);
  assert.equal(guide.sent.at(-1)[0], C.LONGSHOT_STATE);
  assert.equal(guide.sent.at(-1)[1].previewDataURL, previewDataURL);
  windows.updateLongshotPresentation(controls.webContents.id, { capturing: false });
  assert.equal(guide.sent.at(-1)[1].capturing, false, 'pausing must still update the guide status');
  assert.equal(Object.hasOwn(guide.sent.at(-1)[1], 'previewDataURL'), false);
  windows.updateLongshotPresentation(controls.webContents.id, { previewDataURL, frameCount: 5 });
  assert.equal(guide.sent.at(-1)[1].frameCount, 5, 'other metadata must not be lost when thumbnail bytes repeat');
  assert.equal(Object.hasOwn(guide.sent.at(-1)[1], 'previewDataURL'), false);
  assert.equal(resizeCalls, 0, 'unchanged geometry must not issue redundant native resize calls');

  const retainedState = { ...fullState, frameCount: 5, capturing: false };
  assert.deepEqual(windows.getLongShotSnapshot().presentation, retainedState);
  guide.webContents.emit('did-finish-load');
  assert.equal(guide.sent.at(-1)[0], C.WINDOW_INIT);
  assert.deepEqual(guide.sent.at(-1)[1].presentation, retainedState, 'a reloaded guide must receive the retained image even after deduped updates');
  windows.closeLongShot();
});

test('changed and cleared thumbnails are forwarded once and cleared state survives guide reload', () => {
  const { windows, created } = loadWindows();
  const controls = windows.createLongShot(init());
  const guide = created.find((win) => win !== controls);
  const previews = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ];
  for (const previewDataURL of previews) {
    windows.updateLongshotPresentation(controls.webContents.id, { previewDataURL });
    assert.equal(guide.sent.at(-1)[0], C.LONGSHOT_STATE);
    assert.equal(guide.sent.at(-1)[1].previewDataURL, previewDataURL);
  }
  windows.updateLongshotPresentation(controls.webContents.id, { previewDataURL: null });
  assert.equal(Object.hasOwn(guide.sent.at(-1)[1], 'previewDataURL'), true, 'explicit null must clear the previous image');
  assert.equal(guide.sent.at(-1)[1].previewDataURL, null);
  windows.updateLongshotPresentation(controls.webContents.id, { previewDataURL: null, capturing: false });
  assert.equal(Object.hasOwn(guide.sent.at(-1)[1], 'previewDataURL'), false, 'repeated clears should also be deduplicated');
  const sentThumbnails = guide.sent.filter(([channel, state]) => channel === C.LONGSHOT_STATE && Object.hasOwn(state, 'previewDataURL'));
  assert.deepEqual(sentThumbnails.map(([, state]) => state.previewDataURL), [...previews, null]);
  guide.webContents.emit('did-finish-load');
  assert.equal(guide.sent.at(-1)[0], C.WINDOW_INIT);
  assert.equal(guide.sent.at(-1)[1].presentation.previewDataURL, null, 'reload must not resurrect the old thumbnail');
  windows.closeLongShot();
});

test('capture uses registered selection and leaves non-overlapping controls visible', async () => {
  const { windows } = loadWindows();
  const controls = windows.createLongShot(init());
  controls.webContents.emit('did-finish-load');
  const result = await windows.withLongShotCapture(controls.webContents.id, async (context) => {
    assert.deepEqual(context.rect, init().rect);
    assert.equal(context.displayId, 7);
    assert.equal(controls.visible, true);
    return 'frame';
  });
  assert.equal(result, 'frame');
  await assert.rejects(windows.withLongShotCapture(999, async () => 'forged'), /不存在|失效/);
});

test('capture hides overlapping controls, serializes requests and restores without stealing focus on failures', async () => {
  const { windows } = loadWindows();
  const controls = windows.createLongShot(init({ x: 0, y: 0, width: 1440, height: 900 }));
  controls.webContents.emit('did-finish-load');
  await assert.rejects(windows.withLongShotCapture(controls.webContents.id, async () => {
    assert.equal(controls.visible, false);
    await assert.rejects(windows.withLongShotCapture(controls.webContents.id, async () => 'overlap'), /进行中/);
    throw new Error('capture failed');
  }), /capture failed/);
  assert.equal(controls.visible, true);
  assert.equal(controls.showInactiveCalls, 2);
});

test('closing the session while a frame is in-flight does not resurrect either window', async () => {
  const { windows, created } = loadWindows();
  const controls = windows.createLongShot(init({ x: 0, y: 0, width: 1440, height: 900 }));
  controls.webContents.emit('did-finish-load');
  await assert.rejects(windows.withLongShotCapture(controls.webContents.id, async () => {
    windows.closeLongShot();
    return 'stale frame';
  }), /结束|失效/);
  assert.ok(created.every((win) => win.destroyed));
});

test('automatic first capture waits for the static selection overlay to close', async () => {
  const { windows } = loadWindows();
  const selection = windows.createOverlay({ bounds: init().displayBounds }, { mode: 'long' });
  const controls = windows.createLongShot(init());
  let captured = false;
  const promise = windows.withLongShotCapture(controls.webContents.id, async () => {
    assert.equal(selection.destroyed, true);
    captured = true;
    return 'fresh';
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(captured, false);
  windows.closeOverlay();
  assert.equal(await promise, 'fresh');
});

test('expanding a toolbar in-flight cannot move it into the capture rectangle before capture finishes', async () => {
  const { windows } = loadWindows();
  const controls = windows.createLongShot(init({ x: 100, y: 10, width: 800, height: 800 }));
  controls.webContents.emit('did-finish-load');
  assert.equal(controls.bounds.height, 76);
  await windows.withLongShotCapture(controls.webContents.id, async () => {
    const oldBounds = controls.getBounds();
    windows.updateLongshotPresentation(controls.webContents.id, { expanded: true });
    assert.deepEqual(controls.getBounds(), oldBounds);
    return 'clean frame';
  });
  assert.equal(controls.bounds.height, 300);
});

test('explicit smoke autoStart opt-out is forwarded but normal sessions retain automatic capture', () => {
  const { windows } = loadWindows();
  const controls = windows.createLongShot({ ...init(), autoStart: false });
  controls.webContents.emit('did-finish-load');
  assert.equal(controls.sent[0][1].autoStart, false);
});
