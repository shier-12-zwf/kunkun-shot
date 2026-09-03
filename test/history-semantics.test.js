const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const {
  shouldAutoSaveOverlayHistory,
  historyTypeForImageSaveRole,
  persistRecordingHistory,
} = require('../src/main/history-semantics');

function loadHistory(tempDir) {
  const electronMock = {
    app: { getPath: () => tempDir },
    nativeImage: {},
  };
  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/history');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('an explicitly persisted quick-save result is never auto-added a second time', () => {
  assert.equal(shouldAutoSaveOverlayHistory({ imageDataURL: 'data:image/png;base64,abc', savedToHistory: true }), false);
  assert.equal(shouldAutoSaveOverlayHistory({ imageDataURL: 'data:image/png;base64,abc', savedToHistory: false }), true);
  assert.equal(shouldAutoSaveOverlayHistory({ imageDataURL: '', savedToHistory: false }), false);
});

test('generic image save derives a semantic type from the trusted sender role', () => {
  assert.equal(historyTypeForImageSaveRole('longshot'), 'long');
  assert.equal(historyTypeForImageSaveRole('pin'), 'pin');
  assert.equal(historyTypeForImageSaveRole('main'), 'region');
  assert.equal(historyTypeForImageSaveRole(null), 'region');
});

test('recording history failure is contained after the user export has succeeded', async () => {
  const failures = [];
  const item = await persistRecordingHistory('/tmp/export.webm', {
    addMedia: async () => { throw new Error('history disk unavailable'); },
    broadcast: () => { throw new Error('must not broadcast'); },
    onError: (error) => failures.push(error.message),
  });

  assert.equal(item, null);
  assert.deepEqual(failures, ['history disk unavailable']);
});

test('recording history forwards dimensions for filename-template exports', async () => {
  let received = null;
  const expected = { id: 'recording-1' };
  const item = await persistRecordingHistory('/tmp/export.webm', {
    addMedia: async (filePath, type, metadata) => {
      received = { filePath, type, metadata };
      return expected;
    },
    width: 1920,
    height: 1080,
  });

  assert.equal(item, expected);
  assert.deepEqual(received, {
    filePath: '/tmp/export.webm',
    type: 'recording',
    metadata: { width: 1920, height: 1080 },
  });
});

test('recording history uses a managed private copy without blocking the main process', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-recording-history-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const original = path.join(tempDir, 'user-recording.webm');
  fs.writeFileSync(original, Buffer.from('recording-bytes'), { mode: 0o600 });
  const history = loadHistory(tempDir);

  const pending = history.addMedia(original, 'recording', { width: 1280, height: 720 });
  assert.equal(typeof pending.then, 'function', 'copying a large recording must be asynchronous');
  const item = await pending;

  assert.ok(item);
  assert.equal(item.type, 'recording');
  assert.equal(item.kind, 'media');
  assert.equal(item.width, 1280);
  assert.equal(item.height, 720);
  assert.equal(history.list().length, 0, 'image-only consumers must not receive video records');
  assert.deepEqual(history.list({ includeMedia: true }).map((entry) => entry.type), ['recording']);
  const managed = history.filePathOf(item.id);
  assert.notEqual(managed, original);
  assert.equal(fs.readFileSync(managed, 'utf8'), 'recording-bytes');
  assert.equal(fs.statSync(managed).mode & 0o777, 0o600);

  assert.equal(history.remove(item.id), true);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'recording-bytes', 'clearing history must not delete the user export');
});

test('recording history rejects unsupported media and tampered traversal metadata', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-recording-history-security-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const unsupported = path.join(tempDir, 'secret.txt');
  fs.writeFileSync(unsupported, 'secret');
  const historyDir = path.join(tempDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify([
    { id: 'tampered-recording', kind: 'media', type: 'recording', file: '../../secret.txt', time: 1 },
  ]));
  const history = loadHistory(tempDir);

  assert.equal(await history.addMedia(unsupported, 'recording'), null);
  assert.deepEqual(history.list({ includeMedia: true }), []);
  assert.equal(history.filePathOf('tampered-recording'), null);
  assert.equal(fs.readFileSync(unsupported, 'utf8'), 'secret');
});

test('the history page opts into media records and exposes semantic longshot/recording filters', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'history.js'),
    'utf8',
  );

  assert.match(source, /long:\s*\{\s*name:\s*'长截图'/);
  assert.match(source, /recording:\s*\{\s*name:\s*'录屏'/);
  assert.match(source, /historyList\(\{\s*includeMedia:\s*true\s*\}\)/);
});
