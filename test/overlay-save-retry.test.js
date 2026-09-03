const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getOverlayActionReadiness,
  submitOverlayResult,
} = require('../src/renderer/overlay/overlay.js');

test('static overlay actions wait for a decoded source image instead of creating a blank result', () => {
  assert.deepEqual(getOverlayActionReadiness({ bgReady: false, bgImage: null }, 'pin'), {
    ok: false,
    reason: 'loading',
  });
  assert.deepEqual(getOverlayActionReadiness({ bgReady: true, bgImage: null }, 'pin'), {
    ok: false,
    reason: 'failed',
  });
  assert.deepEqual(getOverlayActionReadiness({ bgReady: true, bgImage: {} }, 'pin'), { ok: true });
});

test('live capture actions do not require a decoded static screenshot', () => {
  assert.deepEqual(getOverlayActionReadiness({ bgReady: false, bgImage: null }, 'long'), { ok: true });
  assert.deepEqual(getOverlayActionReadiness({ bgReady: false, bgImage: null }, 'record'), { ok: true });
});

test('every toolbar restore path keeps the decoded-image gate and load failures stay actionable', () => {
  const overlaySource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.js'),
    'utf8'
  );
  const mouseupStart = overlaySource.indexOf("if (S.dragMode === 'move' || S.dragMode === 'resize')");
  const mouseupEnd = overlaySource.indexOf('if (S.shapeDrag)', mouseupStart);
  const closeAiStart = overlaySource.indexOf('function closeAIPanel()');
  const closeAiEnd = overlaySource.indexOf('// ================= 键盘', closeAiStart);
  const recentStart = overlaySource.indexOf('function applyRecentRect(step)');
  const recentEnd = overlaySource.indexOf('bindQrPanel()', recentStart);

  for (const [name, source] of [
    ['drag/resize', overlaySource.slice(mouseupStart, mouseupEnd)],
    ['AI panel close', overlaySource.slice(closeAiStart, closeAiEnd)],
    ['recent selection', overlaySource.slice(recentStart, recentEnd)],
  ]) {
    assert.match(source, /showToolbar\(\)/, `${name} must restore through the readiness gate`);
    assert.doesNotMatch(source, /toolbar\.hidden\s*=\s*false/, `${name} must not bypass the readiness gate`);
  }

  assert.match(
    overlaySource,
    /function showBackgroundLoadFailure\(\)[\s\S]*?hint\.textContent\s*=\s*['"]截图加载失败[^'"]*Esc[^'"]*['"][\s\S]*?hint\.hidden\s*=\s*false/,
    '解码失败后应保留持久且可操作的退出提示'
  );
});

test('overlay stays retryable when the main process reports a canceled or failed action', async () => {
  for (const outcome of [undefined, null, { ok: false, canceled: true }, { ok: false, error: 'disk full' }]) {
    const calls = [];
    const failures = [];
    const completed = await submitOverlayResult(
      {
        finishCapture: async () => {
          calls.push('finish');
          return outcome;
        },
        cancelCapture: async () => calls.push('close'),
      },
      { action: 'save' },
      (failure) => failures.push(failure)
    );

    assert.equal(completed, false);
    assert.deepEqual(calls, ['finish']);
    assert.equal(failures.length, 1);
  }
});

test('overlay closes only after the main process explicitly confirms success', async () => {
  const calls = [];
  const completed = await submitOverlayResult(
    {
      finishCapture: async () => {
        calls.push('finish');
        return { ok: true };
      },
      cancelCapture: async () => calls.push('close'),
    },
    { action: 'save' },
    () => calls.push('retry')
  );

  assert.equal(completed, true);
  assert.deepEqual(calls, ['finish', 'close']);
});

test('overlay remains retryable when the result IPC rejects', async () => {
  const failures = [];
  const completed = await submitOverlayResult(
    {
      finishCapture: async () => {
        throw new Error('IPC unavailable');
      },
      cancelCapture: async () => assert.fail('must not close after a rejected result IPC'),
    },
    { action: 'quickSave' },
    (failure) => failures.push(failure)
  );

  assert.equal(completed, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /IPC unavailable/);
});

test('main overlay-result handler returns an outcome and never closes before replying', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const start = mainSource.indexOf('ipcMain.handle(C.OVERLAY_RESULT');
  const end = mainSource.indexOf("ipcMain.handle(C.IMAGE_SAVE", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = mainSource.slice(start, end);

  assert.doesNotMatch(handler, /windows\.closeOverlay\s*\(/);
  assert.match(handler, /return\s+\{\s*ok:\s*true\s*\}/);
  assert.match(handler, /return\s+\{\s*ok:\s*false/);
});
