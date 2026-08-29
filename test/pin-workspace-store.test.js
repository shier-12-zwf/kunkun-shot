const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPinWorkspaceStore } = require('../src/main/pin-workspace-store');

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function tempStore(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-pin-workspace-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, store: createPinWorkspaceStore({ rootDir }) };
}

test('active image and text pins survive a fresh store instance with live bounds and state', (t) => {
  const { rootDir, store } = tempStore(t);
  store.save([
    {
      payload: { dataURL: PNG_1PX, bounds: { x: 1, y: 2, width: 3, height: 4 } },
      bounds: { x: 40, y: 50, width: 320, height: 180 },
      state: { opacity: 0.72, locked: true, onTop: false, title: '参考图' },
    },
    {
      payload: { text: '跨重启文字', bounds: { x: 10, y: 20, width: 260, height: 120 } },
      bounds: { x: 100, y: 120, width: 420, height: 240 },
    },
  ]);

  const restored = createPinWorkspaceStore({ rootDir }).load();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].dataURL, PNG_1PX);
  assert.deepEqual(restored[0].bounds, { x: 40, y: 50, width: 320, height: 180 });
  assert.deepEqual(restored[0].state, {
    opacity: 0.72,
    locked: true,
    onTop: false,
    title: '参考图',
  });
  assert.equal(restored[1].text, '跨重启文字');
  assert.deepEqual(restored[1].bounds, { x: 100, y: 120, width: 420, height: 240 });

  const indexStat = fs.statSync(path.join(rootDir, 'index.json'));
  assert.equal(indexStat.mode & 0o077, 0, 'workspace metadata must not be readable by other users');
  const imageFiles = fs.readdirSync(path.join(rootDir, 'images'));
  assert.equal(imageFiles.length, 1);
  assert.equal(fs.statSync(path.join(rootDir, 'images', imageFiles[0])).mode & 0o077, 0);
});

test('corrupt and path-traversing workspace entries are ignored', (t) => {
  const { rootDir, store } = tempStore(t);
  fs.mkdirSync(path.join(rootDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'index.json'), JSON.stringify({
    version: 1,
    pins: [
      { kind: 'image', imageFile: '../outside.png', mime: 'image/png', bounds: { x: 1, y: 2, width: 40, height: 40 } },
      { kind: 'text', text: 'valid', bounds: { x: 3, y: 4, width: 80, height: 60 } },
      { kind: 'text', text: 'x', bounds: { x: 'NaN', y: 0, width: 10, height: 10 } },
    ],
  }));

  assert.deepEqual(store.load(), [
    { text: 'valid', bounds: { x: 3, y: 4, width: 80, height: 60 } },
  ]);

  fs.writeFileSync(path.join(rootDir, 'index.json'), '{broken json');
  assert.deepEqual(store.load(), []);
});

test('a failed replacement preserves the last complete workspace', (t) => {
  const { rootDir, store } = tempStore(t);
  store.save([{ payload: { text: 'previous', bounds: { x: 1, y: 2, width: 80, height: 60 } } }]);

  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error('simulated rename failure'); };
  const failingStore = createPinWorkspaceStore({ rootDir, fsModule: failingFs });
  assert.throws(
    () => failingStore.save([{ payload: { text: 'new', bounds: { x: 5, y: 6, width: 90, height: 70 } } }]),
    /simulated rename failure/
  );

  assert.deepEqual(store.load(), [
    { text: 'previous', bounds: { x: 1, y: 2, width: 80, height: 60 } },
  ]);
  assert.deepEqual(fs.readdirSync(rootDir).filter((name) => name.endsWith('.tmp')), []);
});

test('workspace load rejects same-length image corruption and save repairs it by hash', (t) => {
  const { rootDir, store } = tempStore(t);
  store.save([{
    payload: { dataURL: PNG_1PX, bounds: { x: 1, y: 2, width: 80, height: 60 } },
  }]);

  const imagesDir = path.join(rootDir, 'images');
  const imageFile = fs.readdirSync(imagesDir)[0];
  const imagePath = path.join(imagesDir, imageFile);
  const original = fs.readFileSync(imagePath);
  const corrupt = Buffer.from(original);
  corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
  assert.equal(corrupt.length, original.length, 'fixture must preserve byte length');
  fs.writeFileSync(imagePath, corrupt);

  assert.deepEqual(store.load(), [], 'a same-length but hash-mismatched image must not be restored');

  store.save([{
    payload: { dataURL: PNG_1PX, bounds: { x: 1, y: 2, width: 80, height: 60 } },
  }]);
  assert.deepEqual(fs.readFileSync(imagePath), original, 'save must replace corrupt content, not trust its size');
  assert.equal(store.load()[0].dataURL, PNG_1PX);
});
