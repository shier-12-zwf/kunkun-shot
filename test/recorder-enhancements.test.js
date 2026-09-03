'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('recording UI exposes camera, action prompts, and encoded annotation at first level', () => {
  const html = read('src/renderer/recorder/recorder.html');
  assert.match(html, /id="btnCamera"/);
  assert.match(html, /id="btnActions"/);
  assert.match(html, /id="btnPen"/);
  assert.match(html, /id="btnClearPen"/);
  assert.match(html, /recorder-overlays\.js[\s\S]*recorder\.js/);
  assert.match(html, /btnActions[^>]+title="[^"]*写入录屏/);
  assert.match(html, /btnPen[^>]+title="[^"]*写入录屏文件[^"]*不覆盖桌面/);
  assert.doesNotMatch(html, /aria-label="实时画笔"/);
});

test('record action monitor IPC contract stays synchronized across channel copies and preload', () => {
  const channels = read('src/shared/channels.js');
  const preload = read('src/preload/preload.js');
  const main = read('src/main/main.js');
  for (const name of ['RECORD_ACTION_START', 'RECORD_ACTION_STOP', 'RECORD_ACTION_EVENT']) {
    assert.match(channels, new RegExp(`${name}:`));
    assert.match(preload, new RegExp(`${name}:`));
  }
  assert.match(preload, /startRecordingActions/);
  assert.match(preload, /stopRecordingActions/);
  assert.match(preload, /onRecordingAction/);
  assert.match(main, /createRecordActionOwnerRegistry/);
  assert.match(main, /recordActionOwners\.watch\(e\.sender\)/);
  assert.match(main, /onStopped:\s*releaseOwner/);
});

test('mac package declares camera access and packages the global action helper', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.build.mac.extendInfo.NSCameraUsageDescription, /摄像头/);
  const entitlements = read('build/entitlements.mac.plist');
  assert.match(entitlements, /com\.apple\.security\.device\.camera/);
  const helpers = require('../src/main/swift-helper-sources');
  const actionHelper = helpers.SWIFT_HELPERS.find((item) => item.name === 'record-actions');
  assert.equal(actionHelper && actionHelper.language, 'c');
  assert.match(helpers.RECORD_ACTIONS_SOURCE, /CGEventTapCreate/);
  assert.match(helpers.RECORD_ACTIONS_SOURCE, /CGEventGetLocation/);
  assert.match(helpers.RECORD_ACTIONS_SOURCE, /\\\"x\\\"/);
  assert.match(helpers.RECORD_ACTIONS_SOURCE, /\\\"y\\\"/);
  assert.match(helpers.RECORD_ACTIONS_SOURCE, /allowShortcutCharacter/);
});
