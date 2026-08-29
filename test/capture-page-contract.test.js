const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'capture.js'),
  'utf8',
);

test('custom timed capture input is parsed strictly instead of accepting numeric prefixes', () => {
  assert.doesNotMatch(source, /parseInt\(cCustom\.value/);
  assert.match(source, /\^\\d\+\$/);
  assert.match(source, /Number\.isInteger\(v\)/);
});

test('timed cancellation reports the scheduler result instead of claiming every request was canceled', () => {
  assert.match(source, /cancelResult\s*=\s*await\s+api\.cancelTimedCapture/);
  assert.match(source, /cancelResult\s*&&\s*cancelResult\.ok\s*===\s*true/);
});
