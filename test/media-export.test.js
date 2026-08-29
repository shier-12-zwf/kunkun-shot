const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SUPPORTED_IMAGE_FORMATS,
  listSupportedImageFormats,
  normalizeImageExportOptions,
  buildImageConversionArgs,
  exportImage,
} = require('../src/main/image-export');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('image exporter advertises the complete stable format list', () => {
  assert.deepEqual(SUPPORTED_IMAGE_FORMATS, ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']);
  assert.deepEqual(listSupportedImageFormats(), ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']);
  assert.notEqual(listSupportedImageFormats(), SUPPORTED_IMAGE_FORMATS);
});

test('export options strictly validate image data URLs, target extensions and quality', () => {
  const normalized = normalizeImageExportOptions({
    dataURL: PNG_DATA_URL,
    outputPath: '/tmp/capture.JPG',
    format: 'jpg',
    quality: 82,
  });
  assert.equal(normalized.format, 'jpeg');
  assert.equal(normalized.quality, 82);
  assert.equal(normalized.outputPath, '/tmp/capture.JPG');
  assert.ok(Buffer.isBuffer(normalized.inputBuffer));

  const invalid = [
    { dataURL: 'not-a-data-url', outputPath: '/tmp/a.png' },
    { dataURL: 'data:text/plain;base64,aGVsbG8=', outputPath: '/tmp/a.png' },
    { dataURL: 'data:image/png;base64,%%%%', outputPath: '/tmp/a.png' },
    { dataURL: 'data:image/png;base64,aGVsbG8=', outputPath: '/tmp/a.png' },
    { dataURL: PNG_DATA_URL, outputPath: '/tmp/a.exe', format: 'png' },
    { dataURL: PNG_DATA_URL, outputPath: '/tmp/a.png', format: 'jpeg' },
    { dataURL: PNG_DATA_URL, outputPath: '/tmp/a.jpg', quality: 0 },
    { dataURL: PNG_DATA_URL, outputPath: '/tmp/a.jpg', quality: 101 },
    { dataURL: PNG_DATA_URL, outputPath: '/tmp/a.jpg', quality: 80.5 },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeImageExportOptions(value), /数据|格式|扩展名|质量|路径/);
  }
});

test('lossy format quality has explicit bounded ffmpeg mappings', () => {
  const jpegLow = buildImageConversionArgs('jpeg', 1);
  const jpegHigh = buildImageConversionArgs('jpeg', 100);
  assert.ok(Number(jpegLow[jpegLow.indexOf('-q:v') + 1]) > Number(jpegHigh[jpegHigh.indexOf('-q:v') + 1]));

  const webp = buildImageConversionArgs('webp', 73);
  assert.deepEqual(webp.slice(webp.indexOf('-q:v'), webp.indexOf('-q:v') + 2), ['-q:v', '73']);

  const avifLow = buildImageConversionArgs('avif', 1);
  const avifHigh = buildImageConversionArgs('avif', 100);
  assert.ok(Number(avifLow[avifLow.indexOf('-crf') + 1]) > Number(avifHigh[avifHigh.indexOf('-crf') + 1]));

  for (const format of ['png', 'bmp']) {
    assert.ok(!buildImageConversionArgs(format, 1).includes('-q:v'));
    assert.ok(!buildImageConversionArgs(format, 100).includes('-crf'));
  }
});

test('conversion writes through a same-directory private stage and commits only a non-empty result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-export-stage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'capture.webp');
  const calls = [];
  let cleanedInput = false;
  const fakeMedia = {
    async convertImage(input, output, args) {
      calls.push({ input, output, args });
      fs.writeFileSync(output, 'converted-image');
    },
  };
  const fakeTempFiles = {
    writePrivateTempFile(buffer, prefix, ext) {
      assert.ok(Buffer.isBuffer(buffer));
      assert.equal(prefix, 'kkshot-image-export');
      const input = path.join(dir, `input.${ext}`);
      fs.writeFileSync(input, buffer);
      return input;
    },
    cleanupTempPath(input) {
      cleanedInput = true;
      fs.rmSync(input, { force: true });
    },
  };

  const result = await exportImage(
    { dataURL: PNG_DATA_URL, outputPath, format: 'webp', quality: 73 },
    { media: fakeMedia, tempFiles: fakeTempFiles }
  );

  assert.equal(result.path, outputPath);
  assert.equal(result.format, 'webp');
  assert.equal(result.quality, 73);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'converted-image');
  assert.equal(cleanedInput, true);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].output, outputPath);
  assert.equal(path.dirname(calls[0].output), dir);
  assert.equal(path.extname(calls[0].output), '.webp');
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.kkshot-export-')), false);
});

test('unsupported or failed encoders preserve an existing destination and remove stages', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-export-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'capture.avif');
  fs.writeFileSync(outputPath, 'precious-original');
  const inputPath = path.join(dir, 'input.png');
  const fakeMedia = {
    async convertImage(_input, stage) {
      fs.writeFileSync(stage, '');
      throw new Error('Unknown encoder libaom-av1');
    },
  };
  const fakeTempFiles = {
    writePrivateTempFile(buffer) {
      fs.writeFileSync(inputPath, buffer);
      return inputPath;
    },
    cleanupTempPath(input) { fs.rmSync(input, { force: true }); },
  };

  await assert.rejects(
    exportImage(
      { dataURL: PNG_DATA_URL, outputPath, format: 'avif', quality: 80 },
      { media: fakeMedia, tempFiles: fakeTempFiles }
    ),
    /AVIF.*失败.*Unknown encoder/i
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'precious-original');
  assert.deepEqual(fs.readdirSync(dir), ['capture.avif']);
});

test('all advertised formats produce non-empty files with recognizable containers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-export-formats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ['png', '.png', (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
    ['jpeg', '.jpg', (b) => b[0] === 0xff && b[1] === 0xd8],
    ['webp', '.webp', (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
    ['bmp', '.bmp', (b) => b.toString('ascii', 0, 2) === 'BM'],
    ['avif', '.avif', (b) => b.toString('ascii', 4, 8) === 'ftyp' && b.subarray(8, 32).includes(Buffer.from('avif'))],
    ['pdf', '.pdf', (b) => b.toString('ascii', 0, 5) === '%PDF-' && b.toString('ascii').includes('%%EOF')],
  ];

  for (const [format, ext, recognizes] of cases) {
    const outputPath = path.join(dir, `capture${ext}`);
    const result = await exportImage({ dataURL: PNG_DATA_URL, outputPath, format, quality: 88 });
    const bytes = fs.readFileSync(outputPath);
    assert.equal(result.path, outputPath);
    assert.ok(bytes.length > 0, `${format} output should not be empty`);
    assert.equal(recognizes(bytes), true, `${format} output signature should be valid`);
  }
});
