const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const media = require('../src/main/media');

const {
  SUPPORTED_IMAGE_FORMATS,
  listSupportedImageFormats,
  normalizeImageExportOptions,
  normalizeMultiPdfOptions,
  buildImageConversionArgs,
  exportImagesToPdf,
  exportImage,
} = require('../src/main/image-export');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('image exporter advertises the complete stable format list', () => {
  assert.deepEqual(SUPPORTED_IMAGE_FORMATS, ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']);
  assert.deepEqual(listSupportedImageFormats(), ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']);
  assert.notEqual(listSupportedImageFormats(), SUPPORTED_IMAGE_FORMATS);
});

test('PNG, JPEG and PDF remain exportable without an external FFmpeg binary', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-native-image-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11,
    0xff, 0xd9,
  ]);
  let nativeCreates = 0;
  const nativeImage = {
    createFromBuffer() {
      nativeCreates += 1;
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from(PNG_DATA_URL.split(',')[1], 'base64'),
        toJPEG: () => jpeg,
      };
    },
  };
  const media = {
    async convertImage() { throw new Error('FFmpeg must not be used'); },
  };

  const pngPath = path.join(dir, 'capture.png');
  const jpegPath = path.join(dir, 'capture.jpg');
  const pdfPath = path.join(dir, 'capture.pdf');
  await exportImage({ dataURL: PNG_DATA_URL, outputPath: pngPath, format: 'png', quality: 90 }, { media, nativeImage });
  await exportImage({ dataURL: PNG_DATA_URL, outputPath: jpegPath, format: 'jpeg', quality: 82 }, { media, nativeImage });
  await exportImage({ dataURL: PNG_DATA_URL, outputPath: pdfPath, format: 'pdf', quality: 82 }, { media, nativeImage });

  assert.equal(fs.readFileSync(pngPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(fs.readFileSync(jpegPath).subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(nativeCreates, 2, 'PNG-to-PNG is copied directly; JPEG and PDF use Electron nativeImage');
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

test('multi-page PDF preserves page order, bounds count and atomic output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-pdf-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'merged.pdf');
  let seq = 0;
  const cleanup = [];
  function minimalJpeg(marker, width, height) {
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x11]),
      Buffer.from(marker, 'ascii'),
      Buffer.from([0xff, 0xd9]),
    ]);
  }
  const fakeTempFiles = {
    writePrivateTempFile(buffer, _prefix, ext) {
      const inputPath = path.join(dir, `input-${seq++}.${ext}`);
      fs.writeFileSync(inputPath, buffer);
      return inputPath;
    },
    createPrivateTempPath() {
      return path.join(dir, `page-${seq++}.jpg`);
    },
    cleanupTempPath(filePath) {
      cleanup.push(filePath);
      fs.rmSync(filePath, { force: true });
    },
  };
  let page = 0;
  const fakeMedia = {
    async convertImage(_input, jpegPath) {
      page += 1;
      fs.writeFileSync(jpegPath, minimalJpeg(`PAGE-${page}`, page, page + 1));
    },
  };

  const result = await exportImagesToPdf({
    dataURLs: [PNG_DATA_URL, PNG_DATA_URL],
    outputPath,
    quality: 81,
  }, { media: fakeMedia, tempFiles: fakeTempFiles });
  const pdf = fs.readFileSync(outputPath);
  const ascii = pdf.toString('binary');
  assert.deepEqual(result, { path: outputPath, format: 'pdf', quality: 81, pageCount: 2 });
  assert.match(ascii, /\/Kids \[3 0 R 6 0 R\] \/Count 2/);
  assert.equal((ascii.match(/\/Type \/Page \/Parent/g) || []).length, 2);
  assert.ok(pdf.indexOf(Buffer.from('PAGE-1')) < pdf.indexOf(Buffer.from('PAGE-2')));
  assert.equal(cleanup.length, 4);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.kkshot-export-')), false);
});

test('multi-page PDF rejects non-PDF targets, empty/oversized page lists and preserves destination on conversion failure', async (t) => {
  assert.throws(() => normalizeMultiPdfOptions({ dataURLs: [], outputPath: '/tmp/a.pdf' }), /页数/);
  assert.throws(
    () => normalizeMultiPdfOptions({ dataURLs: Array(101).fill(PNG_DATA_URL), outputPath: '/tmp/a.pdf' }),
    /最多 100/,
  );
  assert.throws(() => normalizeMultiPdfOptions({ dataURLs: [PNG_DATA_URL], outputPath: '/tmp/a.png' }), /.pdf/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-pdf-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'merged.pdf');
  fs.writeFileSync(outputPath, 'precious-pdf');
  let seq = 0;
  const fakeTempFiles = {
    writePrivateTempFile(buffer) {
      const filePath = path.join(dir, `input-${seq++}.png`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    },
    createPrivateTempPath() { return path.join(dir, `page-${seq++}.jpg`); },
    cleanupTempPath(filePath) { fs.rmSync(filePath, { force: true }); },
  };
  await assert.rejects(
    exportImagesToPdf({ dataURLs: [PNG_DATA_URL], outputPath, quality: 90 }, {
      tempFiles: fakeTempFiles,
      media: { async convertImage() { throw new Error('encoder unavailable'); } },
    }),
    /PDF 导出失败.*encoder unavailable/,
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'precious-pdf');
  assert.deepEqual(fs.readdirSync(dir), ['merged.pdf']);
});

test('every export format produces a valid container or a precise missing-encoder error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-export-formats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ffmpeg = media.resolveFfmpeg();
  if (!ffmpeg) {
    t.skip('optional system FFmpeg is not installed');
    return;
  }
  const encoderProbe = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  assert.equal(encoderProbe.status, 0, encoderProbe.stderr);
  const encoders = `${encoderProbe.stdout || ''}\n${encoderProbe.stderr || ''}`;
  const sourcePath = path.join(dir, 'source-64x64.png');
  const source = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64', '-frames:v', '1', '-c:v', 'png', sourcePath,
  ], { encoding: 'utf8' });
  assert.equal(source.status, 0, source.stderr);
  const integrationPngDataUrl = `data:image/png;base64,${fs.readFileSync(sourcePath).toString('base64')}`;
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
    const missingEncoder = format === 'webp' && !/\blibwebp(?:_anim)?\b/.test(encoders)
      ? 'libwebp'
      : format === 'avif' && !/\(codec av1\)/.test(encoders)
        ? 'av1'
        : null;
    if (missingEncoder) {
      await assert.rejects(
        exportImage({ dataURL: integrationPngDataUrl, outputPath, format, quality: 88 }),
        new RegExp(`缺少 ${missingEncoder} 编码器`),
      );
      assert.equal(fs.existsSync(outputPath), false);
      continue;
    }
    const result = await exportImage({ dataURL: integrationPngDataUrl, outputPath, format, quality: 88 });
    const bytes = fs.readFileSync(outputPath);
    assert.equal(result.path, outputPath);
    assert.ok(bytes.length > 0, `${format} output should not be empty`);
    assert.equal(recognizes(bytes), true, `${format} output signature should be valid`);
  }
});
