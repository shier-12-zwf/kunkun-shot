const fs = require('node:fs');
const path = require('node:path');

const { MAX_PDF_PAGES, MAX_PDF_TOTAL_INPUT_BYTES } = require('./image-export');
const {
  DEFAULT_SCREENSHOT_TEMPLATE,
  buildFilename,
  nextAvailablePath,
} = require('./filename-template');

function normalizeHistoryPdfIds(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_PDF_PAGES) {
    throw new Error(`多页 PDF 历史记录数量无效（最多 ${MAX_PDF_PAGES} 页）。`);
  }
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 128 || !/^\d{10,20}-[a-f0-9]{6,64}$/i.test(value)) {
      throw new Error('历史记录标识无效。');
    }
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  if (!ids.length) throw new Error('没有可合并的历史图片。');
  return ids;
}

function resolvePdfOutputPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('PDF 目标路径无效。');
  const extension = path.extname(value).toLowerCase();
  if (!extension) return `${value}.pdf`;
  if (extension !== '.pdf') throw new Error('多页 PDF 必须使用 .pdf 扩展名。');
  return value;
}

async function exportHistoryPdf(options, dependencies) {
  const opts = options || {};
  const deps = dependencies || {};
  const ids = normalizeHistoryPdfIds(opts.ids);
  const history = deps.history;
  if (!history || typeof history.get !== 'function' || typeof history.filePathOf !== 'function') {
    throw new TypeError('历史记录服务不可用。');
  }
  if (typeof deps.showSaveDialog !== 'function' || typeof deps.exportImagesToPdf !== 'function') {
    throw new TypeError('PDF 导出依赖不完整。');
  }

  const records = [];
  let totalBytes = 0;
  for (const id of ids) {
    const filePath = history.filePathOf(id);
    if (!filePath) throw new Error('多页 PDF 只能合并可用的图片历史，不支持录屏或缺失文件。');
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      throw new Error('历史图片文件已丢失，无法合并 PDF。');
    }
    if (!stat.isFile() || stat.size <= 0) throw new Error('历史图片文件无效，无法合并 PDF。');
    totalBytes += stat.size;
    if (totalBytes > MAX_PDF_TOTAL_INPUT_BYTES) throw new Error('历史图片总大小超过 256MB 上限。');

    // 先对受管文件做磁盘尺寸约束，再让 history.get 把内容编码成 data URL，
    // 避免损坏或被意外替换的超大历史文件在校验前占用大量内存。
    const got = history.get(id);
    if (!got || !got.item || got.item.kind === 'media' || typeof got.dataURL !== 'string') {
      throw new Error('多页 PDF 只能合并可用的图片历史，不支持录屏或缺失文件。');
    }
    records.push(got);
  }

  const cfg = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const capture = cfg.capture && typeof cfg.capture === 'object' ? cfg.capture : {};
  const first = records[0].item;
  const filename = buildFilename({
    template: capture.fileNameTemplate || DEFAULT_SCREENSHOT_TEMPLATE,
    extension: 'pdf',
    now: opts.now == null ? Date.now() : opts.now,
    type: 'history-pdf',
    index: 1,
    width: first.width || 0,
    height: first.height || 0,
  });
  const defaultDirectory = opts.defaultDirectory;
  const defaultPath = nextAvailablePath(defaultDirectory, filename);
  const dialogResult = await deps.showSaveDialog({
    title: `合并为多页 PDF（${records.length} 页）`,
    defaultPath,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) return { saved: false, canceled: true };
  const outputPath = resolvePdfOutputPath(dialogResult.filePath);
  const result = await deps.exportImagesToPdf({
    dataURLs: records.map((record) => record.dataURL),
    outputPath,
    quality: capture.quality == null ? 90 : capture.quality,
  });
  return { saved: true, path: outputPath, pageCount: result.pageCount || records.length };
}

module.exports = {
  normalizeHistoryPdfIds,
  resolvePdfOutputPath,
  exportHistoryPdf,
};
