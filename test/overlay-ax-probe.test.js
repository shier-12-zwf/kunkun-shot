const test = require('node:test');
const assert = require('node:assert/strict');

const { createAxProbeScheduler } = require('../src/renderer/overlay/overlay');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('AX probing keeps only the latest pointer while busy and blocks selection until it settles', async () => {
  const pending = [];
  const calls = [];
  const frames = [];
  const scheduler = createAxProbeScheduler({
    probe(point) {
      calls.push(point);
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
    resolveFrame(result) {
      return result && result.frame;
    },
    onFrame(frame) {
      frames.push(frame);
    },
  });

  scheduler.enable();
  const idle = scheduler.schedule({ x: 10, y: 20 });
  assert.equal(scheduler.isBusy(), true);
  assert.equal(scheduler.getSelectableFrame(), null);

  scheduler.schedule({ x: 30, y: 40 });
  scheduler.schedule({ x: 50, y: 60 });
  pending[0].resolve({ frame: { id: 'superseded' } });
  await Promise.resolve();

  assert.deepEqual(calls, [{ x: 10, y: 20 }, { x: 50, y: 60 }]);
  assert.deepEqual(frames, []);
  assert.equal(scheduler.getSelectableFrame(), null);

  pending[1].resolve({ frame: { id: 'latest' } });
  await idle;

  assert.equal(scheduler.isBusy(), false);
  assert.deepEqual(frames, [{ id: 'latest' }]);
  assert.deepEqual(scheduler.getSelectableFrame(), { id: 'latest' });
});

test('AX generation ignores an off-to-on stale response and runs the current queued pointer', async () => {
  const pending = [];
  const frames = [];
  const scheduler = createAxProbeScheduler({
    probe(point) {
      const request = deferred();
      pending.push({ point, request });
      return request.promise;
    },
    resolveFrame(result) {
      return result && result.frame;
    },
    onFrame(frame) {
      frames.push(frame);
    },
  });

  scheduler.enable();
  const idle = scheduler.schedule({ x: 1, y: 2 });
  scheduler.disable();
  scheduler.enable();
  scheduler.schedule({ x: 3, y: 4 });

  pending[0].request.resolve({ frame: { id: 'old-generation' } });
  await Promise.resolve();
  assert.deepEqual(pending.map(({ point }) => point), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(frames, []);

  pending[1].request.resolve({ frame: { id: 'current-generation' } });
  await idle;
  assert.deepEqual(frames, [{ id: 'current-generation' }]);
  assert.deepEqual(scheduler.getSelectableFrame(), { id: 'current-generation' });
});

test('AX probe errors clear the prior frame and remain non-selectable', async () => {
  const pending = [];
  const cleared = [];
  const errors = [];
  const scheduler = createAxProbeScheduler({
    probe() {
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
    resolveFrame(result) {
      return result && result.frame;
    },
    onClear() {
      cleared.push(true);
    },
    onError(error) {
      errors.push(error);
    },
  });

  scheduler.enable();
  let idle = scheduler.schedule({ x: 5, y: 6 });
  pending[0].resolve({ frame: { id: 'first' } });
  await idle;
  assert.deepEqual(scheduler.getSelectableFrame(), { id: 'first' });

  idle = scheduler.schedule({ x: 7, y: 8 });
  assert.equal(scheduler.getSelectableFrame(), null);
  pending[1].resolve({ error: 'permission denied' });
  await idle;

  assert.equal(scheduler.getSelectableFrame(), null);
  assert.ok(cleared.length >= 2);
  assert.deepEqual(errors, ['permission denied']);

  idle = scheduler.schedule({ x: 9, y: 10 });
  pending[2].reject(new Error('bridge failed'));
  await idle;
  assert.equal(scheduler.getSelectableFrame(), null);
  assert.deepEqual(errors, ['permission denied', 'bridge failed']);
});

test('AX throttling keeps a trailing pointer instead of dropping an idle move', async () => {
  let currentTime = 1000;
  let timer = null;
  const calls = [];
  const scheduler = createAxProbeScheduler({
    probe(point) {
      calls.push(point);
      return Promise.resolve({ frame: { id: `${point.x},${point.y}` } });
    },
    resolveFrame(result) {
      return result.frame;
    },
    minIntervalMs: 150,
    now() {
      return currentTime;
    },
    setDelay(callback, delay) {
      timer = { callback, delay, canceled: false };
      return timer;
    },
    clearDelay(handle) {
      handle.canceled = true;
    },
  });

  scheduler.enable();
  await scheduler.schedule({ x: 1, y: 2 });
  assert.deepEqual(calls, [{ x: 1, y: 2 }]);

  currentTime = 1050;
  const trailing = scheduler.schedule({ x: 3, y: 4 });
  scheduler.schedule({ x: 5, y: 6 });
  assert.equal(scheduler.getSelectableFrame(), null);
  assert.equal(timer.delay, 100);
  assert.deepEqual(calls, [{ x: 1, y: 2 }]);

  currentTime = 1150;
  timer.callback();
  await trailing;
  assert.deepEqual(calls, [{ x: 1, y: 2 }, { x: 5, y: 6 }]);
  assert.deepEqual(scheduler.getSelectableFrame(), { id: '5,6' });
});

test('AX throttling cancels an old wait across disable and immediate re-enable', async () => {
  let currentTime = 1000;
  let timer = null;
  const calls = [];
  const scheduler = createAxProbeScheduler({
    probe(point) {
      calls.push(point);
      return Promise.resolve({ frame: { id: `${point.x},${point.y}` } });
    },
    resolveFrame(result) {
      return result.frame;
    },
    minIntervalMs: 150,
    now() {
      return currentTime;
    },
    setDelay(callback, delay) {
      timer = { callback, delay, canceled: false };
      return timer;
    },
    clearDelay(handle) {
      handle.canceled = true;
    },
  });

  scheduler.enable();
  await scheduler.schedule({ x: 1, y: 2 });
  currentTime = 1050;
  scheduler.schedule({ x: 3, y: 4 });
  const oldTimer = timer;
  assert.equal(oldTimer.delay, 100);

  scheduler.disable();
  scheduler.enable();
  const current = scheduler.schedule({ x: 7, y: 8 });
  await current;

  assert.equal(oldTimer.canceled, true);
  assert.deepEqual(calls, [{ x: 1, y: 2 }, { x: 7, y: 8 }]);
  assert.deepEqual(scheduler.getSelectableFrame(), { id: '7,8' });
});
