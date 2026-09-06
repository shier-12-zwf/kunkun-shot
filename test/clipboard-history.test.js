'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

function section(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing main process section: ${start}`);
  return mainSource.slice(from, to);
}

// Exercise the actual registered handler and history functions without starting Electron.
function loadClipboardHandler({
  role = 'longshot',
  autoSaveHistory = true,
  validationError,
  clipboardError,
  configError,
  historyError,
  broadcastError,
} = {}) {
  const calls = [];
  const errors = [];
  const dataURL = 'data:image/png;base64,longshot-result';
  const nativeImage = { width: 1200, height: 3000 };
  let handler;
  const context = {
    C: { CLIPBOARD_WRITE_IMAGE: 'clipboard:write-image', HISTORY_CHANGED: 'history:changed' },
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    validatedNativeImage(value) {
      assert.equal(value, dataURL);
      if (validationError) throw validationError;
      return nativeImage;
    },
    clipboard: {
      writeImage(image) {
        assert.equal(image, nativeImage);
        calls.push(['clipboard']);
        if (clipboardError) throw clipboardError;
      },
    },
    config: {
      get() {
        if (configError) throw configError;
        return { capture: { autoSaveHistory } };
      },
    },
    windows: {
      getTrustedRole(senderId) {
        assert.equal(senderId, 23);
        return role;
      },
      broadcast(channel) {
        calls.push(['broadcast', channel]);
        if (broadcastError) throw broadcastError;
      },
    },
    history: {
      add(image, type) {
        calls.push(['history', image, type]);
        if (historyError) throw historyError;
        return { id: 'history-1' };
      },
    },
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
  };
  vm.runInNewContext(
    section('function saveToHistory(dataURL, type)', '// 通用 OpenAI 兼容服务商') + '\n' +
      section('ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE', 'ipcMain.handle(C.CLIPBOARD_WRITE_TEXT'),
    context,
    { filename: 'main-clipboard-history.js' },
  );
  assert.equal(typeof handler, 'function');
  return {
    invoke: () => handler({ sender: { id: 23, role: 'longshot' }, role: 'longshot' }, dataURL),
    calls,
    errors,
    dataURL,
  };
}

test('longshot copying records enabled history only after native clipboard success', () => {
  const fixture = loadClipboardHandler();
  assert.equal(fixture.invoke(), true);
  assert.deepEqual(fixture.calls, [
    ['clipboard'],
    ['history', fixture.dataURL, 'long'],
    ['broadcast', 'history:changed'],
  ]);
});

test('longshot copying requires an explicitly enabled automatic history preference', () => {
  for (const autoSaveHistory of [false, null, 0, 1, 'true']) {
    const fixture = loadClipboardHandler({ autoSaveHistory });
    assert.equal(fixture.invoke(), true);
    assert.deepEqual(fixture.calls, [['clipboard']]);
  }
});

test('main and pin copy requests do not create history despite renderer role claims', () => {
  for (const role of ['main', 'pin', null]) {
    const fixture = loadClipboardHandler({ role });
    assert.equal(fixture.invoke(), true);
    assert.deepEqual(fixture.calls, [['clipboard']]);
  }
});

test('image validation or native clipboard failure never creates history or reports success', () => {
  const invalid = loadClipboardHandler({ validationError: new Error('invalid image') });
  assert.throws(invalid.invoke, /invalid image/);
  assert.deepEqual(invalid.calls, []);

  const clipboardFailure = loadClipboardHandler({ clipboardError: new Error('clipboard unavailable') });
  assert.throws(clipboardFailure.invoke, /clipboard unavailable/);
  assert.deepEqual(clipboardFailure.calls, [['clipboard']]);
});

test('history persistence failure does not turn a successful longshot copy into failure', () => {
  const fixture = loadClipboardHandler({ historyError: new Error('history disk unavailable') });
  assert.equal(fixture.invoke(), true);
  assert.deepEqual(fixture.calls, [['clipboard'], ['history', fixture.dataURL, 'long']]);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /history disk unavailable/);
});

test('history broadcast failure cannot duplicate history or negate a successful longshot copy', () => {
  const fixture = loadClipboardHandler({ broadcastError: new Error('window closed') });
  assert.equal(fixture.invoke(), true);
  assert.deepEqual(fixture.calls, [
    ['clipboard'],
    ['history', fixture.dataURL, 'long'],
    ['broadcast', 'history:changed'],
  ]);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /window closed/);
});

test('an unreadable preference never opts into history or negates the completed copy', () => {
  const fixture = loadClipboardHandler({ configError: new Error('preferences unavailable') });
  assert.equal(fixture.invoke(), true);
  assert.deepEqual(fixture.calls, [['clipboard']]);
});
