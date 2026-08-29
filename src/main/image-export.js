const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('./media');
const tempFiles = require('./temp-files');

const SUPPORTED_IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf']);
const EXTENSION_FORMATS = Object.freeze({
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.bmp': 'bmp',
  '.avif': 'avif',
  '.pdf': 'pdf',
});
const FORMAT_EXTENSIONS = Object.freeze({
  png: new Set(['.png']),
  jpeg: new Set(['.jpg', '.jpeg']),
  webp: new Set(['.webp']),
  bmp: new Set(['.bmp']),
  avif: new Set(['.avif']),
  pdf: new Set(['.pdf']),
});
const IMAGE_FORMAT_SPECS = Object.freeze([
  Object.freeze({ format: 'png', name: 'PNG 图片（无损，支持透明）', extensions: Object.freeze(['png']), preferredExtension: 'png' }),
  Object.freeze({ format: 'jpeg', name: 'JPEG 图片（更小，不支持透明）', extensions: Object.freeze(['jpg', 'jpeg']), preferredExtension: 'jpg' }),
  Object.freeze({ format: 'webp', name: 'WebP 图片（体积小）', extensions: Object.freeze(['webp']), preferredExtension: 'webp' }),
  Object.freeze({ format: 'bmp', name: 'BMP 图片（无损，兼容性好）', extensions: Object.freeze(['bmp']), preferredExtension: 'bmp' }),
  Object.freeze({ format: 'avif', name: 'AVIF 图片（高压缩率）', extensions: Object.freeze(['avif']), preferredExtension: 'avif' }),
  Object.freeze({ format: 'pdf', name: 'PDF 文档（单页图片）', extensions: Object.freeze(['pdf']), preferredExtension: 'pdf' }),
]);
const FORMAT_SPEC_BY_NAME = Object.freeze(Object.fromEntries(IMAGE_FORMAT_SPECS.map((spec) => [spec.format, spec])));
const MIME_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
});

function listSupportedImageFormats() {
  return [...SUPPORTED_IMAGE_FORMATS];
}

function normalizeFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (!SUPPORTED_IMAGE_FORMATS.includes(format)) throw new Error(`不支持的图片格式：${format || '(空)'}`);
  return format;
}

function normalizeQuality(value) {
  const quality = value == null ? 90 : value;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('图片质量必须是 1 到 100 的整数。');
  return quality;
}

// Renderer 无法直接引用本模块，且磁盘上可能是新增字段之前的旧配置。因此导出边界仍自行
// 提供 PNG/90 默认值；无损格式也保留 quality，方便切回有损格式时恢复用户选择。
function normalizeImageExportPreferences(config) {
  const capture = config && config.capture && typeof config.capture === 'object' ? config.capture : {};
  const rawFormat = capture.exportFormat == null || capture.exportFormat === '' ? 'png' : capture.exportFormat;
  if (typeof rawFormat !== 'string' || !SUPPORTED_IMAGE_FORMATS.includes(rawFormat)) {
    throw new Error(`不支持的图片格式：${String(rawFormat || '(空)')}`);
  }
  return { format: rawFormat, quality: normalizeQuality(capture.quality) };
}

function preferredExtensionForFormat(formatValue) {
  const format = normalizeFormat(formatValue);
  return FORMAT_SPEC_BY_NAME[format].preferredExtension;
}

function replaceSuggestedExtension(suggestName, format) {
  const fallback = `困困截图-${Date.now()}`;
  const safeName = path.basename(typeof suggestName === 'string' && suggestName.trim() ? suggestName.trim() : fallback);
  const currentExtension = path.extname(safeName);
  const stem = currentExtension ? safeName.slice(0, -currentExtension.length) : safeName;
  return `${stem || '困困截图'}.${preferredExtensionForFormat(format)}`;
}

function buildImageSaveDialogOptions({ config, defaultDirectory, suggestName } = {}) {
  if (typeof defaultDirectory !== 'string' || !defaultDirectory || defaultDirectory.includes('\0')) {
    throw new Error('默认保存目录无效。');
  }
  const preferences = normalizeImageExportPreferences(config);
  const ordered = [
    FORMAT_SPEC_BY_NAME[preferences.format],
    ...IMAGE_FORMAT_SPECS.filter((spec) => spec.format !== preferences.format),
  ];
  return {
    title: '保存图片',
    defaultPath: path.join(defaultDirectory, replaceSuggestedExtension(suggestName, preferences.format)),
    // Electron 默认选中第一个过滤器；把配置格式置顶，保证过滤器与默认扩展名一致。
    filters: ordered.map((spec) => ({ name: spec.name, extensions: [...spec.extensions] })),
  };
}

function resolveImageExportTarget(filePath, configuredFormat) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw new Error('目标路径无效。');
  const extension = path.extname(filePath).toLowerCase();
  if (!extension) {
    const format = normalizeFormat(configuredFormat || 'png');
    return { outputPath: `${filePath}.${preferredExtensionForFormat(format)}`, format };
  }
  const format = EXTENSION_FORMATS[extension];
  if (!format) throw new Error(`不支持的目标扩展名：${extension}`);
  return { outputPath: filePath, format };
}

async function saveImageViaDialog(options, dependencies) {
  const opts = options || {};
  const deps = dependencies || {};
  if (typeof deps.showSaveDialog !== 'function') throw new TypeError('缺少保存对话框依赖。');
  const exportImageApi = deps.exportImage || exportImage;
  if (typeof exportImageApi !== 'function') throw new TypeError('缺少图片导出依赖。');
  const preferences = normalizeImageExportPreferences(opts.config);
  try {
    const dialogResult = await deps.showSaveDialog(buildImageSaveDialogOptions(opts));
    if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
      return { saved: false, canceled: true };
    }
    // 用户切换过滤器后 Electron 只返回路径；以最终扩展名为准，质量沿用配置。
    const target = resolveImageExportTarget(dialogResult.filePath, preferences.format);
    await exportImageApi({
      dataURL: opts.dataURL,
      outputPath: target.outputPath,
      format: target.format,
      quality: preferences.quality,
    });
    return {
      saved: true,
      path: target.outputPath,
      format: target.format,
      quality: preferences.quality,
    };
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (typeof deps.showErrorBox === 'function') deps.showErrorBox('保存图片失败', message);
    return { saved: false, error: message };
  }
}

async function quickSaveImage(options, dependencies) {
  const opts = options || {};
  const deps = dependencies || {};
  const exportImageApi = deps.exportImage || exportImage;
  if (typeof exportImageApi !== 'function') throw new TypeError('缺少图片导出依赖。');
  if (typeof opts.defaultDirectory !== 'string' || !opts.defaultDirectory || opts.defaultDirectory.includes('\0')) {
    throw new Error('快速保存目录无效。');
  }
  const preferences = normalizeImageExportPreferences(opts.config);
  const timestamp = Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now();
  const outputPath = path.join(
    opts.defaultDirectory,
    `困困截图-${timestamp}.${preferredExtensionForFormat(preferences.format)}`,
  );
  await exportImageApi({
    dataURL: opts.dataURL,
    outputPath,
    format: preferences.format,
    quality: preferences.quality,
  });
  return { saved: true, path: outputPath, format: preferences.format, quality: preferences.quality };
}

function hasImageSignature(buffer, mime) {
  if (mime === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') {
    return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  if (mime === 'image/bmp') return buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM';
  if (mime === 'image/avif') {
    return buffer.length >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp'
      && (buffer.subarray(8, Math.min(buffer.length, 64)).includes(Buffer.from('avif'))
        || buffer.subarray(8, Math.min(buffer.length, 64)).includes(Buffer.from('avis')));
  }
  return false;
}

function decodeImageDataURL(dataURL) {
  if (typeof dataURL !== 'string') throw new Error('图片数据必须是 base64 data URL。');
  const match = /^data:(image\/(?:png|jpeg|webp|bmp|avif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataURL);
  if (!match || !match[2] || match[2].length % 4 !== 0) throw new Error('图片数据不是有效的 base64 data URL。');
  // Bound a single IPC payload while leaving ample room for large multi-display screenshots.
  if (match[2].length > 700 * 1024 * 1024) throw new Error('图片数据过大。');
  const mime = match[1].toLowerCase();
  const inputBuffer = Buffer.from(match[2], 'base64');
  if (!inputBuffer.length || !hasImageSignature(inputBuffer, mime)) throw new Error('图片数据与声明的图片格式不一致。');
  return { mime, inputBuffer, inputExtension: MIME_EXTENSIONS[mime] };
}

function normalizeImageExportOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('图片导出参数无效。');
  const outputPath = options.outputPath;
  if (typeof outputPath !== 'string' || !outputPath.trim() || outputPath.includes('\0')) throw new Error('目标路径无效。');
  const extension = path.extname(outputPath).toLowerCase();
  const inferredFormat = EXTENSION_FORMATS[extension];
  if (!inferredFormat) throw new Error(`不支持的目标扩展名：${extension || '(空)'}`);
  const format = options.format == null || options.format === '' ? inferredFormat : normalizeFormat(options.format);
  if (!FORMAT_EXTENSIONS[format].has(extension)) {
    throw new Error(`目标扩展名 ${extension} 与 ${format.toUpperCase()} 格式不一致。`);
  }
  const quality = normalizeQuality(options.quality);
  const decoded = decodeImageDataURL(options.dataURL);
  return { outputPath, format, quality, ...decoded };
}

function buildImageConversionArgs(formatValue, qualityValue) {
  const format = normalizeFormat(formatValue);
  const quality = normalizeQuality(qualityValue);
  if (format === 'png') return ['-frames:v', '1', '-c:v', 'png'];
  if (format === 'bmp') return ['-frames:v', '1', '-c:v', 'bmp'];
  if (format === 'jpeg') {
    const qscale = Math.round(31 - ((quality - 1) / 99) * 29);
    return ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', String(qscale), '-pix_fmt', 'yuvj444p'];
  }
  if (format === 'webp') return ['-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(quality)];
  if (format === 'avif') {
    const crf = Math.round(63 - ((quality - 1) / 99) * 63);
    return ['-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(crf), '-cpu-used', '6', '-pix_fmt', 'yuv444p'];
  }
  // PDF uses an embedded JPEG generated with the same quality mapping.
  return buildImageConversionArgs('jpeg', quality);
}

function createOutputStage(outputPath, format) {
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  const extension = format === 'jpeg' ? path.extname(outputPath) : `.${format}`;
  const stage = path.join(parent, `.kkshot-export-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp${extension}`);
  const fd = fs.openSync(stage, 'wx', 0o600);
  fs.closeSync(fd);
  return stage;
}

function cleanupFile(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch (_) {}
}

function commitOutputStage(stage, outputPath) {
  const stat = fs.statSync(stage);
  if (!stat.isFile() || stat.size <= 0) throw new Error('编码器未生成有效输出。');
  const fd = fs.openSync(stage, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(stage, outputPath);
  try { fs.chmodSync(outputPath, 0o600); } catch (_) {}
}

function readJpegDimensions(jpeg) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('PDF 中间图像不是有效的 JPEG。');
  }
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1;
    const marker = jpeg[offset++];
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > jpeg.length) break;
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > jpeg.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      const height = jpeg.readUInt16BE(offset + 3);
      const width = jpeg.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  throw new Error('无法读取 PDF 中间图像尺寸。');
}

function pdfObject(id, body) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'binary');
  return Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'ascii'), bodyBuffer, Buffer.from('\nendobj\n', 'ascii')]);
}

function createSingleImagePdf(jpeg) {
  const { width, height } = readJpegDimensions(jpeg);
  const draw = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`, 'ascii');
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    pdfObject(4, Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'ascii'),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ])),
    pdfObject(5, Buffer.concat([
      Buffer.from(`<< /Length ${draw.length} >>\nstream\n`, 'ascii'),
      draw,
      Buffer.from('endstream', 'ascii'),
    ])),
  ];
  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary');
  const offsets = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xrefOffset = cursor;
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      + offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'ascii'
  );
  return Buffer.concat([header, ...objects, xref]);
}

async function exportImage(options, dependencies) {
  const normalized = normalizeImageExportOptions(options);
  const deps = dependencies || {};
  const mediaApi = deps.media || media;
  const tempApi = deps.tempFiles || tempFiles;
  let inputPath = null;
  let pdfJpegPath = null;
  let outputStage = null;
  try {
    inputPath = tempApi.writePrivateTempFile(
      normalized.inputBuffer,
      'kkshot-image-export',
      normalized.inputExtension
    );
    outputStage = createOutputStage(normalized.outputPath, normalized.format);
    if (normalized.format === 'pdf') {
      if (typeof tempApi.createPrivateTempPath !== 'function') throw new Error('临时文件服务不支持 PDF 导出。');
      pdfJpegPath = tempApi.createPrivateTempPath('kkshot-pdf-export', 'jpg');
      await mediaApi.convertImage(inputPath, pdfJpegPath, buildImageConversionArgs('jpeg', normalized.quality));
      fs.writeFileSync(outputStage, createSingleImagePdf(fs.readFileSync(pdfJpegPath)), { mode: 0o600 });
    } else {
      await mediaApi.convertImage(
        inputPath,
        outputStage,
        buildImageConversionArgs(normalized.format, normalized.quality)
      );
    }
    commitOutputStage(outputStage, normalized.outputPath);
    outputStage = null;
    return { path: normalized.outputPath, format: normalized.format, quality: normalized.quality };
  } catch (err) {
    cleanupFile(outputStage);
    const label = normalized.format.toUpperCase();
    throw new Error(`${label} 导出失败：${err && err.message ? err.message : String(err)}`);
  } finally {
    if (inputPath) tempApi.cleanupTempPath(inputPath);
    if (pdfJpegPath) tempApi.cleanupTempPath(pdfJpegPath);
  }
}

module.exports = {
  SUPPORTED_IMAGE_FORMATS,
  IMAGE_FORMAT_SPECS,
  listSupportedImageFormats,
  normalizeImageExportPreferences,
  preferredExtensionForFormat,
  buildImageSaveDialogOptions,
  resolveImageExportTarget,
  saveImageViaDialog,
  quickSaveImage,
  normalizeImageExportOptions,
  buildImageConversionArgs,
  createSingleImagePdf,
  exportImage,
};
