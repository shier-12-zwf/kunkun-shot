'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_CONFIG } = require('../src/shared/config-schema');
const { normalizeConfigPatch } = require('../src/main/ipc-validation');

const root = path.join(__dirname, '..');

test('recording audio is backward-compatible, opt-in, and strictly typed', () => {
  assert.equal(DEFAULT_CONFIG.recording.systemAudio, false);
  assert.equal(DEFAULT_CONFIG.recording.microphone, false);
  assert.deepEqual(
    normalizeConfigPatch({ recording: { systemAudio: true, microphone: true } }, 'main'),
    { recording: { systemAudio: true, microphone: true } },
  );
  assert.throws(
    () => normalizeConfigPatch({ recording: { systemAudio: 1 } }, 'main'),
    /systemAudio|布尔/,
  );
  assert.throws(
    () => normalizeConfigPatch({ recording: { microphone: 'yes' } }, 'main'),
    /microphone|布尔/,
  );
  assert.throws(
    () => normalizeConfigPatch({ recording: { microphone: true } }, 'popover'),
    /权限/,
  );
});

test('settings expose independent system-audio and microphone switches', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/main/pages/settings.js'),
    'utf8',
  );
  assert.match(source, /recording:\s*\{\s*systemAudio:/);
  assert.match(source, /recording:\s*\{\s*microphone:/);
  assert.match(source, /rec\.systemAudio/);
  assert.match(source, /rec\.microphone/);
  assert.match(source, /系统声音/);
  assert.match(source, /麦克风/);
});

test('main process forwards both audio choices into every real recorder init', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const start = source.indexOf("case 'record':");
  const end = source.indexOf("case 'long':", start);
  assert.ok(start >= 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /systemAudio:\s*cfg\.recording\.systemAudio/);
  assert.match(branch, /microphone:\s*cfg\.recording\.microphone/);
});

test('packaged mac app declares the two audio usage descriptions and hardened-runtime input entitlement', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const info = pkg.build && pkg.build.mac && pkg.build.mac.extendInfo;
  assert.equal(typeof info.NSMicrophoneUsageDescription, 'string');
  assert.ok(info.NSMicrophoneUsageDescription.trim().length > 0);
  assert.equal(typeof info.NSAudioCaptureUsageDescription, 'string');
  assert.ok(info.NSAudioCaptureUsageDescription.trim().length > 0);

  const entitlements = fs.readFileSync(path.join(root, 'build/entitlements.mac.plist'), 'utf8');
  assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
});
