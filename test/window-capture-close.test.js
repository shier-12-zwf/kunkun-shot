const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyWindowCaptureClose,
  normalizeWindowCaptureDetail,
} = require('../src/main/window-capture-close');

test('window capture close classifier accepts only a clean result with an image', () => {
  assert.deepEqual(
    classifyWindowCaptureClose({ code: 0, signal: null, hasFile: true, stderr: '' }),
    { kind: 'success', detail: '' }
  );
});

test('window capture close classifier treats normal empty completion as cancellation', () => {
  assert.equal(
    classifyWindowCaptureClose({ code: 0, signal: null, hasFile: false, stderr: '' }).kind,
    'canceled'
  );
});

test('window capture close classifier recognizes macOS Escape cancellation', () => {
  assert.equal(
    classifyWindowCaptureClose({ code: 1, signal: null, hasFile: false, stderr: '' }).kind,
    'canceled'
  );
  assert.equal(
    classifyWindowCaptureClose({
      code: 1,
      signal: null,
      hasFile: false,
      stderr: 'No selection to capture. Cancelling',
    }).kind,
    'canceled'
  );
});

test('window capture close classifier keeps real errors diagnosable', () => {
  const result = classifyWindowCaptureClose({
    code: 1,
    signal: null,
    hasFile: false,
    stderr: 'could not create image from display',
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.detail, 'could not create image from display');
});

test('window capture close classifier never hides signal termination as cancellation', () => {
  assert.equal(
    classifyWindowCaptureClose({ code: null, signal: 'SIGTERM', hasFile: false, stderr: '' }).kind,
    'failed'
  );
});

test('window capture diagnostic detail is bounded and normalized', () => {
  const detail = normalizeWindowCaptureDetail(`  first\n\t${'x'.repeat(600)}  `);
  assert.match(detail, /^first x+$/);
  assert.equal(detail.length, 500);
});
