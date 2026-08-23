const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

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

test('tampered history metadata cannot read or delete files outside history/images', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-history-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const historyDir = path.join(tempDir, 'history');
  const imageDir = path.join(historyDir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  const outside = path.join(tempDir, 'outside.txt');
  fs.writeFileSync(outside, 'private-local-file', { mode: 0o600 });
  fs.writeFileSync(
    path.join(historyDir, 'index.json'),
    JSON.stringify([{ id: 'tampered', file: '../../outside.txt', thumbFile: '../../outside.txt', time: 1 }]),
    { mode: 0o600 }
  );
  const history = loadHistory(tempDir);

  assert.equal(history.get('tampered'), null);
  assert.equal(history.remove('tampered'), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private-local-file');
});

test('history index is durably replaced from a private same-directory temporary file', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-history-atomic-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const historyDir = path.join(tempDir, 'history');
  const imageDir = path.join(historyDir, 'images');
  const indexPath = path.join(historyDir, 'index.json');
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify([{ id: 'kept', file: 'kept.png' }]));
  const history = loadHistory(tempDir);

  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalRenameSync = fs.renameSync;
  let opened = null;
  let syncedFd = null;
  let renamed = null;
  fs.openSync = function trackedOpen(file, flags, mode) {
    const fd = originalOpenSync.call(this, file, flags, mode);
    if (path.dirname(file) === historyDir && file !== indexPath) {
      opened = { file, flags, mode, fd };
    }
    return fd;
  };
  fs.fsyncSync = function trackedFsync(fd) {
    syncedFd = fd;
    return originalFsyncSync.call(this, fd);
  };
  fs.renameSync = function trackedRename(from, to) {
    renamed = { from, to };
    return originalRenameSync.call(this, from, to);
  };
  try {
    history.clear();
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
    fs.renameSync = originalRenameSync;
  }

  assert.ok(opened, 'index update must first create a temporary file');
  assert.equal(opened.flags, 'wx');
  assert.equal(opened.mode, 0o600);
  assert.equal(path.dirname(opened.file), historyDir);
  assert.match(path.basename(opened.file), /^\.index-\d+-[a-f0-9]{16}\.tmp$/);
  assert.equal(syncedFd, opened.fd);
  assert.deepEqual(renamed, { from: opened.file, to: indexPath });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), '[]');
  assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(opened.file), false);
});

test('interrupted history index write preserves the previous index and removes the temporary file', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-history-interrupt-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const historyDir = path.join(tempDir, 'history');
  const imageDir = path.join(historyDir, 'images');
  const indexPath = path.join(historyDir, 'index.json');
  const originalIndex = '[\n]\n';
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(indexPath, originalIndex, { mode: 0o600 });
  const history = loadHistory(tempDir);
  history.list();

  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function interruptedWrite(target, data, options) {
    if (!injected && (target === indexPath || typeof target === 'number')) {
      injected = true;
      const partial = String(data).slice(0, 1);
      if (typeof target === 'number') {
        fs.writeSync(target, partial, null, 'utf8');
      } else {
        originalWriteFileSync.call(this, target, partial, options);
      }
      throw new Error('simulated interrupted index write');
    }
    return originalWriteFileSync.call(this, target, data, options);
  };
  try {
    history.clear();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), originalIndex);
  assert.deepEqual(
    fs.readdirSync(historyDir).filter((name) => /^\.index-.*\.tmp$/.test(name)),
    []
  );
});

test('failed index commit rolls back in-memory clear and preserves image files', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-history-rollback-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const historyDir = path.join(tempDir, 'history');
  const imageDir = path.join(historyDir, 'images');
  const indexPath = path.join(historyDir, 'index.json');
  fs.mkdirSync(imageDir, { recursive: true });
  const item = { id: 'kept', file: 'kept.png', thumbFile: 'kept.thumb.png', time: 1 };
  fs.writeFileSync(path.join(imageDir, item.file), 'original');
  fs.writeFileSync(path.join(imageDir, item.thumbFile), 'thumbnail');
  fs.writeFileSync(indexPath, JSON.stringify([item]), { mode: 0o600 });
  const history = loadHistory(tempDir);
  assert.equal(history.list().length, 1);

  const originalRenameSync = fs.renameSync;
  fs.renameSync = function failIndexCommit(from, to) {
    if (to === indexPath) throw new Error('simulated ENOSPC');
    return originalRenameSync.call(this, from, to);
  };
  let result;
  try {
    result = history.clear();
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(result, false);
  assert.equal(history.list().length, 1);
  assert.equal(fs.readFileSync(path.join(imageDir, item.file), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(imageDir, item.thumbFile), 'utf8'), 'thumbnail');
  assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf8')), [item]);
});
