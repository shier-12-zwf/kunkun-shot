const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recorderSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'recorder', 'recorder.js'),
  'utf8'
);

test('renderer recording cap keeps whole-buffer IPC peak bounded', () => {
  const match = /MAX_RECORDING_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(recorderSource);
  assert.ok(match, 'recorder must declare an explicit MiB cap');
  assert.ok(Number(match[1]) <= 128, 'whole-buffer renderer/main transfer must be capped at 128 MiB or less');
});

test('failed or canceled recording saves remain retryable instead of closing the only copy', () => {
  assert.match(recorderSource, /pendingRecordingBlob/);
  assert.match(recorderSource, /showSaveRetry/);
  assert.match(recorderSource, /if\s*\(res\s*&&\s*res\.saved\s*===\s*true\)/);
  assert.doesNotMatch(recorderSource, /catch\s*\(err\)[\s\S]{0,220}setTimeout\(\(\)\s*=>\s*api\.closeSelf/);
});
