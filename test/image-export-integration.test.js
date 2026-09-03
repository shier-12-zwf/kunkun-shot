const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG } = require('../src/shared/config-schema');
const { normalizeConfigPatch } = require('../src/main/ipc-validation');
const imageExport = require('../src/main/image-export');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const FORMAT_CASES = [
  ['png', 'png'],
  ['jpeg', 'jpg'],
  ['webp', 'webp'],
  ['bmp', 'bmp'],
  ['avif', 'avif'],
  ['pdf', 'pdf'],
];

test('image export configuration is backward-compatible and strictly schema-bound', () => {
  assert.equal(DEFAULT_CONFIG.capture.exportFormat, 'png');
  assert.equal(DEFAULT_CONFIG.capture.quality, 90);
  assert.deepEqual(
    normalizeConfigPatch({ capture: { exportFormat: 'avif', quality: 72 } }, 'main'),
    { capture: { exportFormat: 'avif', quality: 72 } },
  );

  for (const exportFormat of ['jpg', 'gif', 'PNG', '', null, 1]) {
    assert.throws(
      () => normalizeConfigPatch({ capture: { exportFormat } }, 'main'),
      /exportFormat|取值|文本/,
    );
  }
  for (const quality of [0, 101, 90.5, '90', null, NaN, Infinity]) {
    assert.throws(
      () => normalizeConfigPatch({ capture: { quality } }, 'main'),
      /quality|质量|有限数字/,
    );
  }
});

test('save dialog defaults and first filter follow configured format while advertising every format', () => {
  assert.equal(typeof imageExport.buildImageSaveDialogOptions, 'function');
  for (const [format, extension] of FORMAT_CASES) {
    const options = imageExport.buildImageSaveDialogOptions({
      config: { capture: { exportFormat: format, quality: 64 } },
      defaultDirectory: '/tmp/screenshots',
      suggestName: 'capture.png',
    });
    assert.equal(options.defaultPath, path.join('/tmp/screenshots', `capture.${extension}`));
    assert.ok(options.filters[0].extensions.includes(extension));
    const advertised = new Set(options.filters.flatMap((filter) => filter.extensions));
    for (const required of ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']) {
      assert.equal(advertised.has(required), true, `${required} must be offered`);
    }
  }
});

test('configured or dialog-selected PNG/JPEG/WebP/BMP/AVIF/PDF all route through exportImage', async () => {
  assert.equal(typeof imageExport.saveImageViaDialog, 'function');
  for (const [format, extension] of FORMAT_CASES) {
    const calls = [];
    const outputPath = path.join('/tmp', `selected.${extension}`);
    const result = await imageExport.saveImageViaDialog(
      {
        dataURL: PNG_DATA_URL,
        config: { capture: { exportFormat: 'png', quality: 67 } },
        defaultDirectory: '/tmp',
        suggestName: 'capture.png',
      },
      {
        showSaveDialog: async () => ({ canceled: false, filePath: outputPath }),
        showErrorBox: () => assert.fail('successful export must not show an error'),
        exportImage: async (options) => {
          calls.push(options);
          return { path: options.outputPath, format: options.format, quality: options.quality };
        },
      },
    );

    assert.deepEqual(calls, [{
      dataURL: PNG_DATA_URL,
      outputPath,
      format,
      quality: 67,
    }]);
    assert.deepEqual(result, { saved: true, path: outputPath, format, quality: 67 });
  }
});

test('dialog cancellation and export failure are explicit and never call a success hook', async () => {
  let exportCalls = 0;
  const common = {
    dataURL: PNG_DATA_URL,
    config: { capture: { exportFormat: 'webp', quality: 80 } },
    defaultDirectory: '/tmp',
  };
  const canceled = await imageExport.saveImageViaDialog(common, {
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => assert.fail('cancel is not an error'),
    exportImage: async () => { exportCalls += 1; },
  });
  assert.deepEqual(canceled, { saved: false, canceled: true });
  assert.equal(exportCalls, 0);

  const errors = [];
  const failed = await imageExport.saveImageViaDialog(common, {
    showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/capture.webp' }),
    showErrorBox: (title, message) => errors.push({ title, message }),
    exportImage: async () => {
      exportCalls += 1;
      throw new Error('disk full');
    },
  });
  assert.equal(failed.saved, false);
  assert.match(failed.error, /disk full/);
  assert.equal(exportCalls, 1);
  assert.equal(errors.length, 1);
});

test('quick save and main-process history contract use configured export without mutating the PNG history payload', async (t) => {
  assert.equal(typeof imageExport.quickSaveImage, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-quick-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const result = await imageExport.quickSaveImage(
    {
      dataURL: PNG_DATA_URL,
      config: { capture: { exportFormat: 'avif', quality: 76 } },
      defaultDirectory: dir,
      timestamp: 123456,
    },
    {
      exportImage: async (options) => {
        calls.push(options);
        return { path: options.outputPath, format: options.format, quality: options.quality };
      },
    },
  );
  assert.equal(result.saved, true);
  assert.equal(result.path, path.join(dir, '困困截图-123456.avif'));
  assert.deepEqual(calls, [{
    dataURL: PNG_DATA_URL,
    outputPath: path.join(dir, '困困截图-123456.avif'),
    format: 'avif',
    quality: 76,
  }]);

  const occupiedName = 'shot-region-640x480-4-123456.avif';
  fs.writeFileSync(path.join(dir, occupiedName), 'existing');
  const templated = await imageExport.quickSaveImage(
    {
      dataURL: PNG_DATA_URL,
      config: {
        capture: {
          exportFormat: 'avif',
          quality: 76,
          fileNameTemplate: 'shot-{type}-{width}x{height}-{index}-{timestamp}',
        },
      },
      defaultDirectory: dir,
      timestamp: 123456,
      type: 'region',
      index: 4,
      width: 640,
      height: 480,
    },
    {
      exportImage: async (options) => ({ path: options.outputPath, format: options.format, quality: options.quality }),
    },
  );
  assert.equal(templated.path, path.join(dir, 'shot-region-640x480-4-123456-2.avif'));

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const overlayStart = mainSource.indexOf('ipcMain.handle(C.OVERLAY_RESULT');
  const imageSaveStart = mainSource.indexOf('ipcMain.handle(C.IMAGE_SAVE', overlayStart);
  const overlayHandler = mainSource.slice(overlayStart, imageSaveStart);
  const quickStart = overlayHandler.indexOf("case 'quickSave'");
  const quickEnd = overlayHandler.indexOf("case 'pin'", quickStart);
  const quickBranch = overlayHandler.slice(quickStart, quickEnd);
  assert.match(quickBranch, /await\s+quickSaveImage\s*\(/);
  assert.doesNotMatch(quickBranch, /media\.saveImageFile\s*\(/);
  assert.ok(quickBranch.indexOf('await quickSaveImage') < quickBranch.indexOf('saveToHistory'));
  assert.match(quickBranch, /saveToHistory\s*\(\s*imageDataURL/);

  const saveStart = overlayHandler.indexOf("case 'save'");
  const saveEnd = overlayHandler.indexOf("case 'quickSave'", saveStart);
  const saveBranch = overlayHandler.slice(saveStart, saveEnd);
  assert.ok(saveBranch.indexOf('r.saved !== true') < saveBranch.indexOf('saveToHistory'));
});

test('settings expose format and quality controls and preserve quality for lossless formats', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'settings.js'),
    'utf8',
  );
  for (const format of FORMAT_CASES.map(([value]) => value)) {
    assert.match(source, new RegExp(`value:\\s*['\"]${format}['\"]`));
  }
  assert.match(source, /capture:\s*\{\s*exportFormat:/);
  assert.match(source, /capture:\s*\{\s*quality:/);
  assert.match(source, /cap\.exportFormat\s*\|\|\s*['"]png['"]/);
  assert.match(source, /cap\.quality\s*!=\s*null\s*\?\s*cap\.quality\s*:\s*90/);
  assert.match(source, /无损格式[^\n]*(?:不使用|无效)[^\n]*质量/);
  assert.match(source, /inExportQuality\.disabled\s*=\s*lossless/);
  assert.match(source, /capture:\s*\{\s*fileNameTemplate:/);
  assert.match(source, /recording:\s*\{\s*fileNameTemplate:/);
  for (const token of ['datetime', 'date', 'time', 'timestamp', 'type', 'index', 'width', 'height']) {
    assert.match(source, new RegExp(`\\{${token}\\}`));
  }
});
