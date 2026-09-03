const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pinDir = path.join(__dirname, '..', 'src', 'renderer', 'pin');
const html = fs.readFileSync(path.join(pinDir, 'pin.html'), 'utf8');
const source = fs.readFileSync(path.join(pinDir, 'pin.js'), 'utf8');

test('pin renderer exposes the complete annotation UI and loads its model before the controller', () => {
  const contentIndex = html.indexOf('pin-content-update.js');
  const imageLoaderIndex = html.indexOf('pin-image-loader.js');
  const modelIndex = html.indexOf('pin-annotations.js');
  const controllerIndex = html.indexOf('pin.js');
  assert.ok(contentIndex >= 0 && contentIndex < controllerIndex, 'ordered content helper must load before pin.js');
  assert.ok(imageLoaderIndex >= 0 && imageLoaderIndex < controllerIndex, 'image loader must load before pin.js');
  assert.ok(modelIndex >= 0 && modelIndex < controllerIndex, 'annotation model must load before pin.js');
  assert.match(html, /id="pinAnnotationCanvas"/);
  assert.match(html, /id="btnAnnotate"/);
  for (const tool of ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'eraser']) {
    assert.match(html, new RegExp(`data-pin-tool="${tool}"`));
  }
  for (const action of ['undo', 'redo', 'clear']) {
    assert.match(html, new RegExp(`data-pin-edit="${action}"`));
  }
});

test('pin image decoding has a persistent retry state and gates image actions until ready', () => {
  assert.match(html, /id="pinImageStatus"/);
  assert.match(html, /id="btnRetryImage"/);
  assert.match(source, /createPinImageLoader/);
  assert.match(source, /state\.imageReady/);
  assert.match(source, /setImageActionsEnabled/);
  assert.match(source, /imageLoader\.retry\(\)/);
  assert.doesNotMatch(source, /state\.dataURL\s*=\s*payload\.dataURL;[\s\S]{0,160}imgEl\.src\s*=\s*payload\.dataURL/);
});

test('copy and save export the composed image rather than the original data URL', () => {
  assert.match(source, /composeAnnotatedDataURL/);
  assert.match(source, /getComposedDataURL\(\)/);
  assert.doesNotMatch(source, /k\.copyImage\(state\.dataURL\)/);
  assert.doesNotMatch(source, /k\.saveImage\(state\.dataURL\)/);
});

test('all image-content consumers wait for the ordered composed content', () => {
  assert.match(source, /createOrderedPinContentUpdater/);
  assert.match(source, /queueContentUpdate/);
  assert.match(source, /getCurrentDataURL/);
  assert.doesNotMatch(source, /openAIPanel\(\{ mode: 'ocr', dataURL: state\.dataURL \}\)/);
  assert.doesNotMatch(source, /openAIPanel\(\{ mode: 'ask', dataURL: state\.dataURL \}\)/);
  assert.doesNotMatch(source, /ocrBoxes\(\{ dataURL: state\.dataURL \}\)/);
  assert.match(source, /pinUpdateContent/);
  assert.match(source, /pinStartDrag/);
  assert.match(
    source,
    /createContentUpdater\(payload\.dataURL,\s*payload\.contentRevision\)/,
    'a reloaded renderer must continue the revision already owned by its main-process pin'
  );
});

test('application close freezes annotation edits, commits the active stroke and acknowledges only after publication', () => {
  assert.match(source, /msg\.cmd\s*===\s*['"]prepare-close['"]/);
  assert.match(source, /closeBarrierMode/);
  assert.match(source, /finishActiveAnnotationForClose/);
  assert.match(source, /annotationDoc\.commitActive\(\)/);
  assert.match(source, /if \(isCloseBarrierActive\(\)\) return;/);
  assert.match(source, /window\.prompt\(['"]输入标注文字['"]\);[\s\S]*?if \(isCloseBarrierActive\(\)\) return;/);
  assert.match(source, /queueContentUpdate\(false\)/);
  assert.doesNotMatch(source, /queueContentUpdate\(true\)/);
  assert.match(source, /Promise\.resolve\(pending\)[\s\S]*?\.then\(function \(\)/);
  assert.match(source, /closeEpoch\s*!==\s*applicationCloseEpoch/);
  assert.match(source, /sendCloseReady\(\{ requestId: requestId, ok: true \}\)/);
  assert.match(source, /msg\.cmd\s*===\s*['"]cancel-prepare-close['"]/);
});

test('ordinary and batch close keep a pin open after failed publication unless discard is explicit', () => {
  assert.doesNotMatch(source, /contentUpdater\.flush\(\)\.then\(closeNow, closeNow\)/);
  assert.match(source, /confirmDiscardClose/);
  assert.match(source, /if \(discard\) \{\s*closeNow\(\)/);
  assert.match(source, /doClose\(\{ interactive: false \}\)/);
  assert.match(source, /releaseCloseBarrier\('ordinary'\)/);
});

test('WINDOW_INIT state is applied and safe state changes prefer window.kunkun pinUpdateState', () => {
  assert.match(source, /applyWindowState\(payload\.state\)/);
  assert.match(source, /window\.kunkun/);
  assert.match(source, /pinUpdateState/);
  assert.match(source, /notifyPinState\(\{\s*opacity:/);
  assert.match(source, /notifyPinState\(\{\s*locked:/);
  assert.match(source, /notifyPinState\(\{\s*onTop:/);
  assert.match(source, /notifyPinState\(\{\s*title:/);
});
