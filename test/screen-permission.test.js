const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ScreenPermissionError,
  isBlockedScreenPermissionStatus,
  isScreenPermissionError,
  readScreenPermissionStatus,
  requireScreenCaptureAttempt,
} = require('../src/main/screen-permission');

test('screen permission policy only blocks explicit denied or restricted states', () => {
  for (const status of ['granted', 'not-determined', 'unknown']) {
    assert.equal(isBlockedScreenPermissionStatus(status), false);
    assert.equal(requireScreenCaptureAttempt(status), status);
  }

  for (const status of ['denied', 'restricted']) {
    assert.equal(isBlockedScreenPermissionStatus(status), true);
    assert.throws(
      () => requireScreenCaptureAttempt(status),
      (error) => error instanceof ScreenPermissionError
        && error.code === 'SCREEN_PERMISSION_DENIED'
        && error.status === status
    );
  }
});

test('screen permission reader normalizes API failures and unexpected values to unknown', () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };

  assert.equal(
    readScreenPermissionStatus({ getMediaAccessStatus: () => 'granted' }, logger),
    'granted'
  );
  assert.equal(
    readScreenPermissionStatus({ getMediaAccessStatus: () => 'future-value' }, logger),
    'unknown'
  );
  assert.equal(
    readScreenPermissionStatus({ getMediaAccessStatus: () => { throw new Error('TCC unavailable'); } }, logger),
    'unknown'
  );
  assert.equal(warnings.length, 2);
});

test('screen permission errors remain recognizable across capture layers', () => {
  const error = new ScreenPermissionError('denied', new Error('desktop capture failed'));
  assert.equal(isScreenPermissionError(error), true);
  assert.equal(isScreenPermissionError(new Error('SCREEN_PERMISSION_DENIED')), false);
  assert.equal(error.cause.message, 'desktop capture failed');
});
