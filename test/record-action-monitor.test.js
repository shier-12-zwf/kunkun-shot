'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createRecordActionMonitor,
  createRecordActionOwnerRegistry,
} = require('../src/main/record-action-monitor');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('record action monitor waits for readiness and forwards sanitized events with Electron coordinates', async () => {
  const child = fakeChild();
  const received = [];
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => child,
    cursorPoint: () => ({ x: -20, y: 42 }),
    now: () => 987,
    readyTimeoutMs: 100,
  });

  const started = monitor.start({ ownerId: 7, send: (payload) => received.push(payload) });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  assert.deepEqual(await started, { ok: true, active: true });

  child.stdout.emit('data', Buffer.from(
    '{"type":"mouse-down","button":"left","modifiers":{"meta":true}}\n'
      + '{"type":"key","key":"K","modifiers":{"meta":true}}\n'
      + '{"type":"key","key":"bad\\nkey"}\n'
  ));
  assert.deepEqual(received, [
    {
      type: 'mouse-down', button: 'left', x: -20, y: 42, at: 987,
      modifiers: { alt: false, control: false, meta: true, shift: false },
    },
    {
      type: 'key', key: 'K', at: 987,
      modifiers: { alt: false, control: false, meta: true, shift: false },
    },
  ]);
});

test('record action monitor prefers bounded event-time helper coordinates and only falls back when absent', () => {
  const cursorCalls = [];
  const dependencies = {
    now: () => 321,
    cursorPoint: () => {
      cursorCalls.push(true);
      return { x: -44, y: 88 };
    },
  };

  assert.deepEqual(
    require('../src/main/record-action-monitor').sanitizeEvent({
      type: 'mouse-down',
      button: 'left',
      x: 12.5,
      y: -8.25,
    }, dependencies),
    {
      type: 'mouse-down',
      button: 'left',
      x: 12.5,
      y: -8.25,
      at: 321,
      modifiers: { alt: false, control: false, meta: false, shift: false },
    },
  );
  assert.equal(cursorCalls.length, 0, 'valid helper coordinates must describe the event-time point');

  assert.deepEqual(
    require('../src/main/record-action-monitor').sanitizeEvent({ type: 'mouse-up' }, dependencies),
    {
      type: 'mouse-up',
      button: 'left',
      x: -44,
      y: 88,
      at: 321,
      modifiers: { alt: false, control: false, meta: false, shift: false },
    },
  );
  assert.equal(cursorCalls.length, 1, 'legacy helpers without coordinates retain the Electron fallback');

  assert.equal(
    require('../src/main/record-action-monitor').sanitizeEvent({
      type: 'mouse-down',
      x: 10_000_000,
      y: 0,
    }, dependencies),
    null,
    'present but untrusted coordinates must be rejected instead of silently sampled later',
  );
  assert.equal(cursorCalls.length, 1);
});

test('record action monitor is owner-scoped, idempotent, and terminates the helper', async () => {
  const child = fakeChild();
  let spawnCount = 0;
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => { spawnCount += 1; return child; },
    cursorPoint: () => ({ x: 0, y: 0 }),
    readyTimeoutMs: 100,
  });
  const first = monitor.start({ ownerId: 9, send() {} });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await first;
  assert.deepEqual(await monitor.start({ ownerId: 9, send() {} }), { ok: true, active: true });
  assert.equal(spawnCount, 1);
  assert.deepEqual(monitor.stop(10), { ok: false, active: true });
  assert.deepEqual(monitor.stop(9), { ok: true, active: false });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('record action monitor reports helper startup failures and leaves no active owner', async () => {
  const child = fakeChild();
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => child,
    cursorPoint: () => ({ x: 0, y: 0 }),
    readyTimeoutMs: 100,
  });
  const starting = monitor.start({ ownerId: 3, send() {} });
  await Promise.resolve();
  child.stderr.emit('data', Buffer.from('permission denied'));
  child.emit('exit', 3, null);
  await assert.rejects(starting, /permission denied|启动失败/);
  assert.deepEqual(monitor.status(), { active: false, ownerId: null });
});

for (const stopMethod of ['stop', 'stopAll']) {
  test(`record action monitor ${stopMethod} cancels a pending helper preparation before spawn`, async () => {
    const binary = deferred();
    const child = fakeChild();
    let spawnCount = 0;
    const monitor = createRecordActionMonitor({
      ensureBinary: () => binary.promise,
      spawnProcess: () => {
        spawnCount += 1;
        return child;
      },
      cursorPoint: () => ({ x: 0, y: 0 }),
      readyTimeoutMs: 100,
    });

    const starting = monitor.start({ ownerId: 17, send() {} });
    const outcome = starting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await Promise.resolve();
    const stopped = stopMethod === 'stop' ? monitor.stop(17) : monitor.stopAll();
    assert.deepEqual(stopped, { ok: true, active: false });
    binary.resolve('/safe/helper');
    await new Promise((resolve) => setImmediate(resolve));
    if (spawnCount > 0) child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));

    const result = await outcome;
    assert.equal(spawnCount, 0, 'a canceled preparation must never launch a background input monitor');
    assert.match(String(result.error && result.error.message), /取消|停止/);
    assert.deepEqual(monitor.status(), { active: false, ownerId: null });
  });
}

test('record action monitor escalates an unresponsive helper from TERM to KILL', async () => {
  const child = fakeChild();
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => child,
    cursorPoint: () => ({ x: 0, y: 0 }),
    readyTimeoutMs: 100,
    terminationGraceMs: 10,
  });
  const starting = monitor.start({ ownerId: 18, send() {} });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await starting;

  monitor.stop(18);
  assert.deepEqual(child.kills, ['SIGTERM']);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('record action monitor cancels KILL escalation after the helper exits on TERM', async () => {
  const child = fakeChild();
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => child,
    cursorPoint: () => ({ x: 0, y: 0 }),
    readyTimeoutMs: 100,
    terminationGraceMs: 10,
  });
  const starting = monitor.start({ ownerId: 181, send() {} });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await starting;

  monitor.stop(181);
  child.emit('exit', 0, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('record action monitor notifies the renderer and releases ownership after a runtime crash', async () => {
  const child = fakeChild();
  const received = [];
  const stopped = [];
  const monitor = createRecordActionMonitor({
    ensureBinary: async () => '/safe/helper',
    spawnProcess: () => child,
    cursorPoint: () => ({ x: 0, y: 0 }),
    now: () => 654,
    readyTimeoutMs: 100,
    terminationGraceMs: 10,
  });
  const starting = monitor.start({
    ownerId: 19,
    send: (payload) => received.push(payload),
    onStopped: (detail) => stopped.push(detail),
  });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n'));
  await starting;

  child.emit('exit', 9, null);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'monitor-error');
  assert.match(received[0].error, /退出/);
  assert.equal(received[0].at, 654);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].unexpected, true);
  assert.deepEqual(monitor.status(), { active: false, ownerId: null });
});

test('record action owner registry keeps one destroyed listener and removes it on release', () => {
  const sender = new EventEmitter();
  sender.id = 27;
  const stoppedOwners = [];
  const registry = createRecordActionOwnerRegistry({
    stop: (ownerId) => stoppedOwners.push(ownerId),
  });

  const release = registry.watch(sender);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(registry.watch(sender), release);
  }
  assert.equal(sender.listenerCount('destroyed'), 1);

  release();
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.deepEqual(stoppedOwners, []);

  registry.watch(sender);
  sender.emit('destroyed');
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.deepEqual(stoppedOwners, [27]);
});

test('destroying an owner while helper preparation is pending prevents the late spawn', async () => {
  const binary = deferred();
  const sender = new EventEmitter();
  sender.id = 28;
  let spawnCount = 0;
  const monitor = createRecordActionMonitor({
    ensureBinary: () => binary.promise,
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
    cursorPoint: () => ({ x: 0, y: 0 }),
    readyTimeoutMs: 100,
  });
  const registry = createRecordActionOwnerRegistry({
    stop: (ownerId) => monitor.stop(ownerId),
  });
  const release = registry.watch(sender);
  const outcome = monitor.start({
    ownerId: sender.id,
    send() {},
    onStopped: release,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  sender.emit('destroyed');
  binary.resolve('/safe/helper');
  await new Promise((resolve) => setImmediate(resolve));
  const result = await outcome;

  assert.equal(spawnCount, 0);
  assert.match(String(result.error && result.error.message), /取消|停止/);
  assert.deepEqual(monitor.status(), { active: false, ownerId: null });
  assert.equal(sender.listenerCount('destroyed'), 0);
});
