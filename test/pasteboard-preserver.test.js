const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const packageJson = require('../package.json');
const { HELPER_PATH, resolveHelperPath, simulateCopy } = require('../src/main/pasteboard-preserver');

test('packaged pasteboard helper is unpacked and resolved outside app.asar', () => {
  assert.ok(packageJson.build.asarUnpack.includes('src/main/pasteboard-preserver.jxa'));
  assert.equal(
    resolveHelperPath('/Applications/Kunkun.app/Contents/Resources/app.asar/src/main'),
    '/Applications/Kunkun.app/Contents/Resources/app.asar.unpacked/src/main/pasteboard-preserver.jxa'
  );
});

test('native pasteboard helper round-trips multiple items and formats without touching the general clipboard', () => {
  if (process.platform !== 'darwin') return;
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', HELPER_PATH, 'selftest'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report, { ok: true, itemCount: 2, typeCount: 3 });
});

test('simulated Cmd+C times out and terminates a hung osascript child', async () => {
  const child = new EventEmitter();
  let killedWith = null;
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };

  const startedAt = Date.now();
  const copied = await simulateCopy({
    timeoutMs: 25,
    spawnImpl: () => child,
  });

  assert.equal(copied, false);
  assert.equal(killedWith, 'SIGKILL');
  assert.ok(Date.now() - startedAt < 500, 'hung copy command must settle promptly');
});

test('simulated Cmd+C can be aborted and terminates its child', async () => {
  const child = new EventEmitter();
  let killedWith = null;
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };
  const controller = new AbortController();

  const pending = simulateCopy({
    timeoutMs: 5000,
    signal: controller.signal,
    spawnImpl: () => child,
  });
  controller.abort();

  assert.equal(await pending, false);
  assert.equal(killedWith, 'SIGTERM');
});

test('native helper restores only the expected pasteboard generation and detects failed writes', () => {
  if (process.platform !== 'darwin') return;
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', HELPER_PATH, 'selftest-cas'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.restoredWhenCurrent, true);
  assert.equal(report.skippedWhenChanged, true);
  assert.equal(report.newerContentPreserved, true);
  assert.equal(report.writeFailureDetected, true);
});
