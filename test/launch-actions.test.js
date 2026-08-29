'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLaunchAction } = require('../src/main/launch-actions');

test('automation arguments parse deterministic capture actions', () => {
  assert.deepEqual(
    parseLaunchAction(['/Applications/Kunkun.app/Contents/MacOS/Kunkun', '--capture', 'region']),
    { type: 'capture', mode: 'region' },
  );
  assert.deepEqual(
    parseLaunchAction(['electron', '.', '--capture=fullscreen']),
    { type: 'capture', mode: 'fullscreen' },
  );
  assert.deepEqual(
    parseLaunchAction(['electron', '.', '--capture', 'window']),
    { type: 'capture', mode: 'window' },
  );
});

test('timed automation is bounded and carries an explicit target mode', () => {
  assert.deepEqual(
    parseLaunchAction(['app', '--capture=region', '--delay=12']),
    { type: 'timed', mode: 'region', delay: 12 },
  );
  assert.deepEqual(
    parseLaunchAction(['app', '--capture', 'fullscreen', '--delay', '1']),
    { type: 'timed', mode: 'fullscreen', delay: 1 },
  );
  assert.throws(() => parseLaunchAction(['app', '--capture=window', '--delay=3']), /只支持区域或全屏/);
  assert.throws(() => parseLaunchAction(['app', '--capture=region', '--delay=301']), /1.*300/);
  assert.throws(() => parseLaunchAction(['app', '--capture=region', '--delay=1.5']), /整数/);
});

test('malformed, conflicting, or absent automation options fail closed', () => {
  assert.equal(parseLaunchAction(['app', '--dev']), null);
  assert.throws(() => parseLaunchAction(['app', '--capture=region', '--capture=window']), /只能指定一次/);
  assert.throws(() => parseLaunchAction(['app', '--capture=desktop']), /模式无效/);
  assert.throws(() => parseLaunchAction(['app', '--delay=3']), /必须同时指定/);
  assert.throws(() => parseLaunchAction(['app', '--capture']), /缺少模式/);
});
