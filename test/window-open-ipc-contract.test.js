'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

function windowOpenHandlersSource() {
  const startMarker = 'ipcMain.handle(C.OPEN_SETTINGS';
  const endMarker = 'ipcMain.handle(C.CAPTURE_TRIGGER';
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'window-open IPC handlers must remain registered together');
  return mainSource.slice(start, end);
}

function registerWindowOpenHandlers(windows) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const C = {
    OPEN_SETTINGS: 'window:open-settings',
    OPEN_AI_PANEL: 'window:open-ai',
  };

  Function('ipcMain', 'C', 'windows', `'use strict';\n${windowOpenHandlersSource()}`)(
    ipcMain,
    C,
    windows,
  );
  return { handlers, C };
}

test('window-open IPC handlers return explicit structured-clone-safe results', () => {
  const browserWindow = { destroy() {} };
  let settingsOpenCount = 0;
  let receivedAIPayload = null;
  const { handlers, C } = registerWindowOpenHandlers({
    openSettings() {
      settingsOpenCount += 1;
      return browserWindow;
    },
    openAIPanel(payload) {
      receivedAIPayload = payload;
      return browserWindow;
    },
  });
  const payload = { mode: 'ocr', dataURL: 'data:image/png;base64,AAAA' };

  const settingsResult = handlers.get(C.OPEN_SETTINGS)({ sender: { id: 1 } });
  const aiResult = handlers.get(C.OPEN_AI_PANEL)({ sender: { id: 2 } }, payload);

  assert.equal(settingsOpenCount, 1);
  assert.equal(receivedAIPayload, payload);
  assert.doesNotThrow(() => structuredClone(settingsResult));
  assert.doesNotThrow(() => structuredClone(aiResult));
  assert.deepEqual(settingsResult, { ok: true });
  assert.deepEqual(aiResult, { ok: true });
  assert.notEqual(settingsResult, browserWindow);
  assert.notEqual(aiResult, browserWindow);
});
