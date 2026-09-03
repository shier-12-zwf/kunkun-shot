const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_SCREENSHOT_TEMPLATE,
  DEFAULT_RECORDING_TEMPLATE,
  normalizeFilenameTemplate,
  renderFilenameStem,
  buildFilename,
  nextAvailablePath,
} = require('../src/main/filename-template');
const { DEFAULT_CONFIG } = require('../src/shared/config-schema');
const { normalizeConfigPatch } = require('../src/main/ipc-validation');

test('filename templates keep legacy defaults and render every supported token in local time', () => {
  assert.equal(DEFAULT_SCREENSHOT_TEMPLATE, '困困截图-{timestamp}');
  assert.equal(DEFAULT_RECORDING_TEMPLATE, '困困录屏-{timestamp}');
  assert.equal(DEFAULT_CONFIG.capture.fileNameTemplate, DEFAULT_SCREENSHOT_TEMPLATE);
  assert.equal(DEFAULT_CONFIG.recording.fileNameTemplate, DEFAULT_RECORDING_TEMPLATE);
  const now = new Date(2026, 8, 3, 7, 8, 9, 123);
  assert.equal(
    renderFilenameStem('{datetime}_{date}_{time}_{timestamp}_{type}_{index}_{width}x{height}', {
      now,
      type: 'region',
      index: 7,
      width: 1440,
      height: 900,
    }),
    `2026-09-03_07-08-09_2026-09-03_07-08-09_${now.getTime()}_region_7_1440x900`,
  );
});

test('config IPC validates screenshot and recording templates with the central policy', () => {
  assert.deepEqual(
    normalizeConfigPatch({ capture: { fileNameTemplate: 'shot-{date}-{index}' } }, 'main'),
    { capture: { fileNameTemplate: 'shot-{date}-{index}' } },
  );
  assert.deepEqual(
    normalizeConfigPatch({ recording: { fileNameTemplate: 'record-{width}x{height}' } }, 'main'),
    { recording: { fileNameTemplate: 'record-{width}x{height}' } },
  );
  assert.throws(
    () => normalizeConfigPatch({ capture: { fileNameTemplate: '../escape' } }, 'main'),
    /单个文件名/,
  );
});

test('exporter-provided extension wins and the template cannot smuggle a path', () => {
  assert.equal(buildFilename({ template: 'capture.final-{index}', extension: '.webp', index: 2 }), 'capture.final-2.webp');
  for (const bad of ['../secret', '..\\secret', '/tmp/x', 'a\0b', 'a\nb', 'a:b', '{unknown}', '{date']) {
    assert.throws(() => normalizeFilenameTemplate(bad));
  }
  assert.throws(() => normalizeFilenameTemplate('x'.repeat(257)), /过长/);
  assert.throws(() => renderFilenameStem('{type}', { type: '../escape' }), /类型无效/);
  assert.throws(() => buildFilename({ template: 'ok', extension: '../png' }), /扩展名无效/);
});

test('collision allocation keeps basename in the target directory and starts at -2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-name-'));
  try {
    fs.writeFileSync(path.join(dir, 'capture.png'), 'one');
    fs.writeFileSync(path.join(dir, 'capture-2.png'), 'two');
    assert.equal(nextAvailablePath(dir, 'capture.png'), path.join(dir, 'capture-3.png'));

    const reserved = new Set();
    assert.equal(nextAvailablePath(dir, 'fresh.webp', { reserved }), path.join(dir, 'fresh.webp'));
    assert.equal(nextAvailablePath(dir, 'fresh.webp', { reserved }), path.join(dir, 'fresh-2.webp'));
    assert.throws(() => nextAvailablePath(dir, '../escape.png'), /basename/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every screenshot, recording and history export path is wired to the central template allocator', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const recorder = fs.readFileSync(path.join(root, 'src/renderer/recorder/recorder.js'), 'utf8');

  assert.match(main, /function saveImageWithDialog[\s\S]*?fileNameTemplate[\s\S]*?buildFilename\([\s\S]*?nextAvailablePath\(/);
  assert.match(main, /case 'quickSave'[\s\S]*?quickSaveImage\([\s\S]*?type:\s*captureType[\s\S]*?width:[\s\S]*?height:/);
  assert.match(main, /ipcMain\.handle\(C\.RECORD_SAVE[\s\S]*?DEFAULT_RECORDING_TEMPLATE[\s\S]*?nextAvailablePath\(/);
  assert.match(main, /ipcMain\.handle\(C\.HISTORY_EXPORT[\s\S]*?DEFAULT_RECORDING_TEMPLATE[\s\S]*?saveImageWithDialog\(/);
  assert.match(main, /ipcMain\.handle\(C\.HISTORY_EXPORT_MANY[\s\S]*?reservedPaths[\s\S]*?DEFAULT_RECORDING_TEMPLATE[\s\S]*?DEFAULT_SCREENSHOT_TEMPLATE/);
  assert.match(recorder, /saveRecording\([\s\S]*?width:[\s\S]*?height:/);
});
