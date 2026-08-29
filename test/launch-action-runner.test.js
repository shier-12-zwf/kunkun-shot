'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLaunchActionRunner } = require('../src/main/launch-action-runner');

function createHarness() {
  const calls = [];
  const runner = createLaunchActionRunner({
    startCapture: async (mode) => {
      calls.push(['capture', mode]);
      return { ok: true, mode };
    },
    captureWindow: async () => {
      calls.push(['window']);
      return { ok: true, mode: 'window' };
    },
    scheduleTimedCapture: (payload) => {
      calls.push(['timed', payload]);
      return { id: 'job-1', ...payload };
    },
  });
  return { calls, runner };
}

test('launch actions route every capture mode through its authoritative workflow', async () => {
  const directModes = ['region', 'fullscreen', 'ocr', 'long', 'record'];
  for (const mode of directModes) {
    const { calls, runner } = createHarness();
    const result = await runner.run({ type: 'capture', mode });
    assert.deepEqual(calls, [['capture', mode]]);
    assert.deepEqual(result, { handled: true, result: { ok: true, mode } });
  }

  const { calls, runner } = createHarness();
  const result = await runner.run({ type: 'capture', mode: 'window' });
  assert.deepEqual(calls, [['window']]);
  assert.deepEqual(result, { handled: true, result: { ok: true, mode: 'window' } });
});

test('timed launch actions use the shared scheduler and preserve its job id', async () => {
  const { calls, runner } = createHarness();
  const result = await runner.run({ type: 'timed', mode: 'fullscreen', delay: 12 });
  assert.deepEqual(calls, [['timed', { mode: 'fullscreen', delay: 12 }]]);
  assert.deepEqual(result, {
    handled: true,
    result: { id: 'job-1', mode: 'fullscreen', delay: 12 },
  });
});

test('runner ignores no action and rejects bypasses around parser validation', async () => {
  const { calls, runner } = createHarness();
  assert.deepEqual(await runner.run(null), { handled: false, result: null });
  assert.deepEqual(calls, []);

  await assert.rejects(() => runner.run({ type: 'capture', mode: 'invalid' }), /启动截图动作无效/);
  await assert.rejects(() => runner.run({ type: 'timed', mode: 'window', delay: 3 }), /启动延时截图动作无效/);
  await assert.rejects(() => runner.run({ type: 'timed', mode: 'region', delay: 0 }), /启动延时截图动作无效/);
  assert.deepEqual(calls, []);
});

test('runner validates its workflow dependencies eagerly', () => {
  assert.throws(() => createLaunchActionRunner({}), /启动动作执行依赖无效/);
});
