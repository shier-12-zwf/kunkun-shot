'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMediaPermissionPolicy,
  installMediaPermissionPolicy,
} = require('../src/main/media-permission-policy');

const RECORDER_URL = 'file:///Applications/Test.app/Contents/Resources/app.asar/src/renderer/recorder/recorder.html';

function contents(id, url = RECORDER_URL) {
  return { id, getURL: () => url };
}

test('media permission policy only allows the trusted recorder main frame', () => {
  const roles = new Map([[7, 'recorder'], [8, 'main']]);
  const policy = createMediaPermissionPolicy({
    allowedRecorderUrl: RECORDER_URL,
    getTrustedRole: (id) => roles.get(id) || null,
  });
  const details = {
    isMainFrame: true,
    requestingUrl: RECORDER_URL,
    mediaTypes: ['video', 'audio'],
  };
  let allowed = null;
  policy.requestHandler(contents(7), 'media', (value) => { allowed = value; }, details);
  assert.equal(allowed, true);

  policy.requestHandler(contents(8), 'media', (value) => { allowed = value; }, details);
  assert.equal(allowed, false);
  policy.requestHandler(contents(7), 'geolocation', (value) => { allowed = value; }, details);
  assert.equal(allowed, false);
  policy.requestHandler(contents(7), 'media', (value) => { allowed = value; }, {
    ...details,
    isMainFrame: false,
  });
  assert.equal(allowed, false);
});

test('media permission policy rejects navigation, spoofed URLs and unknown media types', () => {
  const policy = createMediaPermissionPolicy({
    allowedRecorderUrl: RECORDER_URL,
    getTrustedRole: () => 'recorder',
  });
  const trusted = contents(7);
  assert.equal(policy.checkHandler(trusted, 'media', 'file://', {
    isMainFrame: true,
    requestingUrl: RECORDER_URL,
    mediaType: 'video',
  }), true);
  assert.equal(policy.checkHandler(contents(7, 'https://evil.example/'), 'media', 'https://evil.example', {
    isMainFrame: true,
    requestingUrl: RECORDER_URL,
    mediaType: 'video',
  }), false);
  assert.equal(policy.checkHandler(trusted, 'media', 'file://', {
    isMainFrame: true,
    requestingUrl: 'file:///tmp/recorder.html',
    mediaType: 'video',
  }), false);
  assert.equal(policy.checkHandler(trusted, 'media', 'file://', {
    isMainFrame: true,
    requestingUrl: RECORDER_URL,
    mediaType: 'unknown',
  }), false);
});

test('install wires both Electron permission handlers and defaults every other capability to deny', () => {
  const installed = {};
  const fakeSession = {
    setPermissionRequestHandler(value) { installed.request = value; },
    setPermissionCheckHandler(value) { installed.check = value; },
  };
  installMediaPermissionPolicy(fakeSession, {
    allowedRecorderUrl: RECORDER_URL,
    getTrustedRole: () => 'recorder',
  });
  assert.equal(typeof installed.request, 'function');
  assert.equal(typeof installed.check, 'function');
  let result;
  installed.request(contents(7), 'notifications', (value) => { result = value; }, {
    isMainFrame: true,
    requestingUrl: RECORDER_URL,
  });
  assert.equal(result, false);
});
