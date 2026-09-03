const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const channels = fs.readFileSync(path.join(root, 'src/shared/channels.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

test('save-all uses a dedicated renderer flush handshake before reading pin snapshots', () => {
  assert.match(channels, /PIN_SYNC_READY:\s*'pin:sync-ready'/);
  assert.match(preload, /PIN_SYNC_READY:\s*'pin:sync-ready'/);
  assert.match(preload, /pinSyncReady:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(C\.PIN_SYNC_READY, payload\)/);
  assert.match(main, /\[C\.PIN_SYNC_READY\]:\s*\['pin'\]/);
  assert.match(main, /ipcMain\.handle\(C\.PIN_SYNC_READY/);

  const start = main.indexOf('async function pinSaveAll()');
  const end = main.indexOf('// 从剪贴板文本里识别颜色', start);
  const body = main.slice(start, end);
  const syncIndex = body.indexOf('await windows.syncPinsContent');
  const snapshotIndex = body.indexOf('windows.pinSnapshots()');
  assert.ok(syncIndex >= 0, 'save-all must request a renderer flush');
  assert.ok(snapshotIndex > syncIndex, 'snapshots must be read only after every renderer ACKs');
});
