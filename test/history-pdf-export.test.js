const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeHistoryPdfIds,
  resolvePdfOutputPath,
  exportHistoryPdf,
} = require('../src/main/history-pdf-export');
const { MAX_PDF_TOTAL_INPUT_BYTES } = require('../src/main/image-export');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const ID1 = '1725330000000-aabbccddeeff';
const ID2 = '1725330000001-001122334455';

test('history PDF id and output validators bound pages, dedupe in first-seen order and require PDF', () => {
  assert.deepEqual(normalizeHistoryPdfIds([ID2, ID1, ID2]), [ID2, ID1]);
  assert.throws(() => normalizeHistoryPdfIds([]), /数量/);
  assert.throws(() => normalizeHistoryPdfIds(Array(101).fill(ID1)), /最多 100/);
  assert.throws(() => normalizeHistoryPdfIds(['../../etc/passwd']), /标识无效/);
  assert.equal(resolvePdfOutputPath('/tmp/merged'), '/tmp/merged.pdf');
  assert.equal(resolvePdfOutputPath('/tmp/merged.PDF'), '/tmp/merged.PDF');
  assert.throws(() => resolvePdfOutputPath('/tmp/merged.png'), /.pdf/);
});

test('history PDF reads only managed image records and preserves requested order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-history-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = new Map([[ID1, path.join(dir, 'one.png')], [ID2, path.join(dir, 'two.png')]]);
  fs.writeFileSync(paths.get(ID1), 'one');
  fs.writeFileSync(paths.get(ID2), 'two');
  const values = new Map([
    [ID1, { item: { id: ID1, kind: 'image', width: 10, height: 20 }, dataURL: `${PNG_DATA_URL}#one` }],
    [ID2, { item: { id: ID2, kind: 'image', width: 30, height: 40 }, dataURL: `${PNG_DATA_URL}#two` }],
  ]);
  let dialogOptions;
  let exportOptions;
  const result = await exportHistoryPdf({
    ids: [ID2, ID1],
    config: { capture: { fileNameTemplate: 'merged-{width}x{height}-{index}', quality: 77 } },
    defaultDirectory: dir,
    now: 123456,
  }, {
    history: { filePathOf: (id) => paths.get(id), get: (id) => values.get(id) },
    showSaveDialog: async (options) => {
      dialogOptions = options;
      return { canceled: false, filePath: path.join(dir, 'chosen') };
    },
    exportImagesToPdf: async (options) => {
      exportOptions = options;
      return { pageCount: options.dataURLs.length };
    },
  });

  assert.equal(dialogOptions.defaultPath, path.join(dir, 'merged-30x40-1.pdf'));
  assert.deepEqual(exportOptions.dataURLs, [`${PNG_DATA_URL}#two`, `${PNG_DATA_URL}#one`]);
  assert.equal(exportOptions.quality, 77);
  assert.equal(exportOptions.outputPath, path.join(dir, 'chosen.pdf'));
  assert.deepEqual(result, { saved: true, path: path.join(dir, 'chosen.pdf'), pageCount: 2 });
});

test('history PDF fails closed for media, missing files and cancellation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-history-pdf-reject-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mediaPath = path.join(dir, 'recording.webm');
  fs.writeFileSync(mediaPath, 'media');
  const deps = {
    history: {
      filePathOf: () => mediaPath,
      get: () => ({ item: { id: ID1, kind: 'media' }, dataURL: null }),
    },
    showSaveDialog: async () => assert.fail('invalid input must fail before dialog'),
    exportImagesToPdf: async () => assert.fail('invalid input must never export'),
  };
  await assert.rejects(exportHistoryPdf({ ids: [ID1], config: {}, defaultDirectory: dir }, deps), /只能合并/);

  const imagePath = path.join(dir, 'image.png');
  fs.writeFileSync(imagePath, 'image');
  const canceled = await exportHistoryPdf({ ids: [ID1], config: {}, defaultDirectory: dir }, {
    ...deps,
    history: {
      filePathOf: () => imagePath,
      get: () => ({ item: { id: ID1, kind: 'image', width: 1, height: 1 }, dataURL: PNG_DATA_URL }),
    },
    showSaveDialog: async () => ({ canceled: true }),
  });
  assert.deepEqual(canceled, { saved: false, canceled: true });
});

test('history PDF rejects oversized managed input before reading it into a data URL', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-history-pdf-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'large.png');
  fs.closeSync(fs.openSync(imagePath, 'w'));
  fs.truncateSync(imagePath, MAX_PDF_TOTAL_INPUT_BYTES + 1);
  let getCalls = 0;

  await assert.rejects(exportHistoryPdf({ ids: [ID1], config: {}, defaultDirectory: dir }, {
    history: {
      filePathOf: () => imagePath,
      get: () => { getCalls += 1; return null; },
    },
    showSaveDialog: async () => assert.fail('oversized input must fail before dialog'),
    exportImagesToPdf: async () => assert.fail('oversized input must never export'),
  }), /总大小超过 256MB/);
  assert.equal(getCalls, 0);
});

test('history multi-page PDF IPC is synchronized, role-scoped and exposed as a real bulk action', () => {
  const root = path.join(__dirname, '..');
  const channels = fs.readFileSync(path.join(root, 'src/shared/channels.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/main/pages/history.js'), 'utf8');
  assert.match(channels, /HISTORY_EXPORT_PDF:\s*'history:export-pdf'/);
  assert.match(preload, /HISTORY_EXPORT_PDF:\s*'history:export-pdf'/);
  assert.match(preload, /historyExportPdf:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\(C\.HISTORY_EXPORT_PDF, ids\)/);
  assert.match(main, /\[C\.HISTORY_EXPORT_PDF\]:\s*\['main'\]/);
  assert.match(main, /ipcMain\.handle\(C\.HISTORY_EXPORT_PDF/);
  assert.match(main, /exportHistoryPdf\([\s\S]*?history,[\s\S]*?exportImagesToPdf/);
  assert.match(renderer, /kkapi\.historyExportPdf\(ids\)/);
  assert.match(renderer, /canMergePdf[\s\S]*?every\(\(item\)\s*=>\s*item\.kind\s*!==\s*'media'\)/);
});
