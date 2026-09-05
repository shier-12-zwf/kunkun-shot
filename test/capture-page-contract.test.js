const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'capture.js'),
  'utf8',
);
const popoverHtml = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'popover', 'popover.html'),
  'utf8',
);
const popoverJs = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'popover', 'popover.js'),
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

test('long screenshot is a visible primary capture action with its configured shortcut', () => {
  assert.match(source, /key:\s*'long'[\s\S]*?label:\s*'长截图'[\s\S]*?runCapture\(aLong,\s*'long'/);
  assert.match(source, /setHint\(aLong,\s*sc\.longShot\)/);
});

test('menu-bar popover exposes long screenshot and keeps it in the busy-state contract', () => {
  assert.match(popoverHtml, /id="btnLong"[\s\S]*?>[\s\S]*?<span>长截图<\/span>/);
  assert.match(popoverJs, /btnLong:\s*document\.getElementById\('btnLong'\)/);
  assert.match(popoverJs, /bindTrigger\(el\.btnLong,\s*'long'/);
  assert.match(popoverJs, /\[el\.btnRegion,\s*el\.btnWindow,\s*el\.btnLong,\s*el\.btnRecord,\s*el\.btnFull\]/);
});
