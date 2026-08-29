const test = require('node:test');
const assert = require('node:assert/strict');

const { createCaptureCoordinator } = require('../src/main/capture-coordinator');
const { createTimedCaptureScheduler } = require('../src/main/timed-capture-scheduler');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a late screen grab from a superseded request cannot replace the current editor', async () => {
  const grabs = [];
  const opened = [];
  let editorState = { open: false, dirty: false };
  const coordinator = createCaptureCoordinator({
    getEditorState: () => editorState,
    captureFrame: ({ mode, signal }) => {
      const gate = deferred();
      grabs.push({ mode, signal, gate });
      return gate.promise;
    },
    openEditor: (frame, context) => {
      opened.push({ frame, context });
      editorState = { open: true, dirty: false };
      return { id: context.generation };
    },
  });

  const first = coordinator.start('region');
  const second = coordinator.start('fullscreen');
  assert.equal(grabs[0].signal.aborted, true, 'latest direct request invalidates the older grab');

  grabs[1].gate.resolve({ frame: 'new' });
  assert.equal((await second).ok, true);
  grabs[0].gate.resolve({ frame: 'old' });
  const stale = await first;

  assert.equal(stale.ok, false);
  assert.equal(stale.canceled, true);
  assert.equal(stale.reason, 'superseded');
  assert.deepEqual(opened.map(({ frame }) => frame), [{ frame: 'new' }]);
});

test('timed capture never replaces an existing editor, including a dirty editor', async () => {
  let captureCalls = 0;
  let openCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: true, dirty: true }),
    captureFrame: async () => { captureCalls += 1; },
    openEditor: () => { openCalls += 1; },
  });

  const result = await coordinator.start('region', { trigger: 'timed' });
  assert.deepEqual(result, {
    ok: false,
    busy: true,
    reason: 'editor-active',
    editorDirty: true,
    requiresConfirmation: true,
    mode: 'region',
  });
  assert.equal(captureCalls, 0);
  assert.equal(openCalls, 0);
});

test('an editor appearing while capture is awaiting a frame blocks editor creation', async () => {
  const grab = deferred();
  let editorState = { open: false, dirty: false };
  let openCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => editorState,
    captureFrame: () => grab.promise,
    openEditor: () => { openCalls += 1; },
  });

  const pending = coordinator.start('region', { trigger: 'timed' });
  editorState = { open: true, dirty: false };
  grab.resolve({ frame: 'late' });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.equal(result.reason, 'editor-active');
  assert.equal(openCalls, 0);
});

test('scheduler abort signal is checked after an asynchronous grab and before opening', async () => {
  const grab = deferred();
  const controller = new AbortController();
  let openCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: () => grab.promise,
    openEditor: () => { openCalls += 1; },
  });

  const pending = coordinator.start('fullscreen', {
    trigger: 'timed',
    signal: controller.signal,
  });
  controller.abort();
  grab.resolve({ frame: 'too-late' });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(result.reason, 'aborted');
  assert.equal(openCalls, 0);
});

test('timed requests do not supersede another capture already being prepared', async () => {
  const grab = deferred();
  let captureCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: () => {
      captureCalls += 1;
      return grab.promise;
    },
    openEditor: () => ({ id: 1 }),
  });

  const direct = coordinator.start('region');
  const timed = await coordinator.start('fullscreen', { trigger: 'timed' });
  assert.equal(timed.ok, false);
  assert.equal(timed.busy, true);
  assert.equal(timed.reason, 'capture-pending');
  assert.equal(captureCalls, 1);

  grab.resolve({ frame: 'direct' });
  await direct;
});

test('capture coordinator rejects unknown modes, triggers, and asynchronous editor factories', async () => {
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: async () => ({ frame: 'ok' }),
    openEditor: async () => ({ id: 1 }),
  });

  await assert.rejects(() => coordinator.start('invalid'), /模式无效/);
  await assert.rejects(() => coordinator.start('region', { trigger: 'background' }), /触发来源无效/);
  await assert.rejects(() => coordinator.start('region'), /必须同步/);
});

test('interactive window selection cancellation does not call the editor factory', async () => {
  let openCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: async ({ mode }) => {
      assert.equal(mode, 'window');
      return null;
    },
    openEditor: () => { openCalls += 1; },
  });

  assert.deepEqual(await coordinator.start('window'), {
    ok: false,
    canceled: true,
    reason: 'user-canceled',
    mode: 'window',
  });
  assert.equal(openCalls, 0);
});

test('scheduler and coordinator compose so cancel during firing blocks a late editor commit', async () => {
  const grab = deferred();
  let timerCallback;
  let openCalls = 0;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: () => grab.promise,
    openEditor: () => { openCalls += 1; return { id: 1 }; },
  });
  const scheduler = createTimedCaptureScheduler({
    setTimer: (callback) => { timerCallback = callback; return 1; },
    clearTimer: () => {},
    makeId: () => 'composed-job',
    onFire: (job, control) => coordinator.start(job.mode, {
      trigger: 'timed',
      signal: control.signal,
    }),
  });

  scheduler.schedule({ delay: 1, mode: 'region' });
  const firing = timerCallback();
  assert.equal(scheduler.cancel('composed-job'), true);
  grab.resolve({ frame: 'late' });
  await firing;

  assert.equal(openCalls, 0);
});

test('app shutdown cancellation waits for the active capture cleanup', async () => {
  let cleanupFinished = false;
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        setImmediate(() => {
          cleanupFinished = true;
          resolve(null);
        });
      }, { once: true });
    }),
    openEditor: () => ({ id: 1 }),
  });

  const capture = coordinator.start('window');
  assert.equal(await coordinator.cancelPendingAndWait('app-quit', 1000), true);
  assert.equal(cleanupFinished, true);
  assert.equal(coordinator.status().pending, null);
  assert.deepEqual(await capture, {
    ok: false,
    canceled: true,
    reason: 'app-quit',
    mode: 'window',
  });
});

test('shutdown cancellation reports a timeout when capture cleanup is stuck', async () => {
  const coordinator = createCaptureCoordinator({
    getEditorState: () => ({ open: false, dirty: false }),
    captureFrame: () => new Promise(() => {}),
    openEditor: () => ({ id: 1 }),
  });

  coordinator.start('window');
  assert.equal(await coordinator.cancelPendingAndWait('app-quit', 5), false);
  assert.equal(coordinator.status().pending.mode, 'window');
  await assert.rejects(
    () => coordinator.cancelPendingAndWait('app-quit', 0),
    /等待时间无效/
  );
});
