'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');

function between(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section ${start}`);
  return mainSource.slice(from, to);
}

test('main process wires parsed launch actions only to authoritative capture workflows', () => {
  assert.match(mainSource, /require\(['"]\.\/launch-actions['"]\)/);
  assert.match(mainSource, /require\(['"]\.\/launch-action-runner['"]\)/);

  const runner = between('const launchActionRunner', 'async function handleLaunchArguments');
  assert.match(runner, /startCapture/);
  assert.match(runner, /doWindowCapture/);
  assert.match(runner, /timedCaptureScheduler\.schedule/);
});

test('initial and second-instance arguments share fail-closed launch handling', () => {
  const handler = between('async function handleLaunchArguments', '// Renderer 按窗口职责分权');
  assert.match(handler, /parseLaunchAction\(argv\)/);
  assert.match(handler, /launchActionRunner\.run\(action\)/);
  assert.match(handler, /handled:\s*true/);
  assert.match(handler, /dialog\.showErrorBox/);

  const lifecycle = between('// ---------- 生命周期 ----------', "app.on('will-quit'");
  assert.match(lifecycle, /app\.on\(['"]second-instance['"],\s*\([^)]*argv/);
  assert.match(lifecycle, /handleLaunchArguments\(argv\)/);
  assert.match(lifecycle, /handleLaunchArguments\(process\.argv\)/);
  assert.match(lifecycle, /!initialLaunch\.handled/);
});

test('a no-action second launch keeps the visible settings fallback', () => {
  const lifecycle = between('// ---------- 生命周期 ----------', "app.on('will-quit'");
  assert.match(lifecycle, /if\s*\(!outcome\.handled\)\s*windows\.openSettings\(\)/);
});
