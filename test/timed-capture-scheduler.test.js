const test = require('node:test');
const assert = require('node:assert/strict');

const { createTimedCaptureScheduler } = require('../src/main/timed-capture-scheduler');

function fakeTimers() {
  let nextHandle = 1;
  const callbacks = new Map();
  const delays = new Map();
  return {
    callbacks,
    delays,
    setTimer(callback, delay) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      delays.set(handle, delay);
      return handle;
    },
    clearTimer(handle) {
      callbacks.delete(handle);
    },
    async fire(handle) {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      if (callback) await callback();
    },
  };
}

test('timed capture is owned by the main-process scheduler and fires exactly once', async () => {
  const timers = fakeTimers();
  const fired = [];
  const scheduler = createTimedCaptureScheduler({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeId: () => 'capture-1',
    onFire: async (job) => fired.push(job),
  });

  const job = scheduler.schedule({ delay: 5, mode: 'region' });
  assert.deepEqual(job, { id: 'capture-1', delay: 5, mode: 'region' });
  assert.equal([...timers.delays.values()][0], 5000);

  await timers.fire(1);
  await timers.fire(1);
  assert.deepEqual(fired, [{ id: 'capture-1', delay: 5, mode: 'region' }]);
  assert.equal(scheduler.cancel('capture-1'), false, 'completed jobs are no longer cancellable');
});

test('cancel removes the durable timer and unknown ids do not affect another job', async () => {
  const timers = fakeTimers();
  const fired = [];
  let id = 0;
  const scheduler = createTimedCaptureScheduler({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeId: () => `capture-${++id}`,
    onFire: async (job) => fired.push(job.id),
  });

  scheduler.schedule({ delay: 3, mode: 'region' });
  scheduler.schedule({ delay: 10, mode: 'fullscreen' });
  assert.equal(scheduler.cancel('missing'), false);
  assert.equal(scheduler.cancel('capture-1'), true);
  await timers.fire(1);
  await timers.fire(2);
  assert.deepEqual(fired, ['capture-2']);
});

test('invalid mode or delay is rejected instead of silently changing the requested schedule', () => {
  const timers = fakeTimers();
  let id = 0;
  const scheduler = createTimedCaptureScheduler({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeId: () => `job-${++id}`,
    onFire: async () => {},
  });

  assert.throws(() => scheduler.schedule({ delay: 1, mode: 'window' }), /模式无效/);
  assert.throws(() => scheduler.schedule({ delay: 0, mode: 'region' }), /1.*300/);
  assert.throws(() => scheduler.schedule({ delay: 301, mode: 'region' }), /1.*300/);
  assert.throws(() => scheduler.schedule({ delay: 1.5, mode: 'region' }), /整数/);
  assert.throws(() => scheduler.schedule({ delay: '5', mode: 'region' }), /整数/);
  assert.equal(timers.callbacks.size, 0);
});

test('cancel aborts a job that is already firing so downstream capture cannot create an editor later', async () => {
  const timers = fakeTimers();
  let releaseCapture;
  let notifyStarted;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let editorCreations = 0;
  const scheduler = createTimedCaptureScheduler({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeId: () => 'firing-job',
    onFire: async (_job, control) => {
      notifyStarted();
      assert.equal(control.signal.aborted, false);
      await captureGate;
      if (!control.signal.aborted) editorCreations += 1;
    },
  });

  scheduler.schedule({ delay: 1, mode: 'region' });
  const firing = timers.fire(1);
  await started;
  assert.equal(scheduler.cancel('firing-job'), true, 'firing jobs remain cancellable');
  releaseCapture();
  await firing;

  assert.equal(editorCreations, 0);
  assert.equal(scheduler.cancel('firing-job'), false);
});

test('cancelAll aborts both pending and firing jobs and reports the complete active count', async () => {
  const timers = fakeTimers();
  let releaseCapture;
  let notifyStarted;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const observedSignals = [];
  let id = 0;
  const scheduler = createTimedCaptureScheduler({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeId: () => `job-${++id}`,
    onFire: async (_job, control) => {
      notifyStarted();
      observedSignals.push(control.signal);
      await captureGate;
    },
  });

  scheduler.schedule({ delay: 1, mode: 'region' });
  scheduler.schedule({ delay: 2, mode: 'fullscreen' });
  const firing = timers.fire(1);
  await started;

  assert.equal(scheduler.cancelAll(), 2);
  assert.equal(observedSignals[0].aborted, true);
  releaseCapture();
  await firing;
  await timers.fire(2);
});
