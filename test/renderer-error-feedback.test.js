const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const historySource = fs.readFileSync(
  path.join(root, 'src/renderer/main/pages/history.js'),
  'utf8',
);
const captureSource = fs.readFileSync(
  path.join(root, 'src/renderer/main/pages/capture.js'),
  'utf8',
);
const translatePopupSource = fs.readFileSync(
  path.join(root, 'src/renderer/translate-popup/translate-popup.js'),
  'utf8',
);

test('history loading failure has a retryable error state instead of becoming empty history', () => {
  assert.match(historySource, /let\s+historyLoadError\s*=\s*''/);
  assert.match(historySource, /function\s+buildLoadErrorState\s*\(/);
  assert.match(historySource, /历史记录加载失败/);
  assert.match(historySource, /retry[^\n]*addEventListener\(['"]click['"],\s*\(\)\s*=>\s*reload\(\)\)/);
  assert.doesNotMatch(
    historySource,
    /list\s*=\s*await\s+kkapi\.historyList\([\s\S]*?catch\s*\([^)]*\)\s*\{\s*list\s*=\s*\[\]/,
  );
});

test('history mutations and exports validate resolved failure results and announce errors', () => {
  assert.match(historySource, /cleared\s*=\s*await\s+kkapi\.historyClear\(\)/);
  assert.match(historySource, /cleared\s*!==\s*true[\s\S]*?清空失败/);
  assert.match(historySource, /copied\s*=\s*await\s+kkapi\.copyImage\(dataURL\)/);
  assert.match(historySource, /copied\s*!==\s*true[\s\S]*?复制失败/);
  assert.match(historySource, /deleted\s*=\s*await\s+kkapi\.historyDelete\(id\)/);
  assert.match(historySource, /deleted\s*!==\s*true[\s\S]*?删除失败/);
  assert.match(historySource, /res\s*&&\s*res\.error[\s\S]*?导出失败/);
  assert.match(historySource, /function\s+showFeedback\s*\(kind,\s*text\)/);
  assert.match(historySource, /setAttribute\(['"]aria-live['"],\s*['"]polite['"]\)/);
});

test('history AI actions await the window-open result and surface failures', () => {
  assert.match(historySource, /function\s+confirmAIPanelOpened\s*\(outcome\)/);
  assert.match(historySource, /outcome\.ok\s*!==\s*true/);
  assert.equal(
    (historySource.match(/await\s+kkapi\.openAIPanel\(/g) || []).length,
    2,
    'OCR and image translation must both await the invoke promise',
  );
  assert.match(
    historySource,
    /btnOCR\.addEventListener\(['"]click['"],\s*async\s*\(\)\s*=>[\s\S]*?confirmAIPanelOpened\(opened\)[\s\S]*?showFeedback\(['"]err['"]/,
  );
  assert.match(
    historySource,
    /btnTrans\.addEventListener\(['"]click['"],\s*async\s*\(\)\s*=>[\s\S]*?confirmAIPanelOpened\(opened\)[\s\S]*?showFeedback\(['"]err['"]/,
  );
});

test('primary capture actions await triggerCapture and surface ok false results', () => {
  assert.match(captureSource, /async\s+function\s+runCapture\s*\(refs,\s*mode/);
  assert.match(captureSource, /result\s*=\s*await\s+api\.triggerCapture\(mode\)/);
  assert.match(captureSource, /result\s*&&\s*result\.ok\s*===\s*true/);
  assert.match(captureSource, /result\s*&&\s*result\.error/);
  assert.match(captureSource, /runCapture\(aRegion,\s*'region'/);
  assert.match(captureSource, /runCapture\(aLong,\s*'long'/);
  assert.match(captureSource, /runCapture\(aRecord,\s*'record'/);
});

test('translate popup only reports copied after copyText resolves successfully', () => {
  assert.match(translatePopupSource, /btnCopy\.addEventListener\(['"]click['"],\s*async\s+function/);
  assert.match(translatePopupSource, /copied\s*=\s*await\s+api\.copyText\(text\)/);
  assert.match(translatePopupSource, /copied\s*!==\s*true/);
  assert.match(translatePopupSource, /复制失败/);
  assert.ok(
    translatePopupSource.indexOf('await api.copyText(text)')
      < translatePopupSource.indexOf("btnCopy.textContent = '已复制'"),
    'the clipboard write must settle before the success label is rendered',
  );
});
