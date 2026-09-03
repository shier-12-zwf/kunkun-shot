const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCREENSHOT_TEMPLATE = '困困截图-{timestamp}';
const DEFAULT_RECORDING_TEMPLATE = '困困录屏-{timestamp}';
const MAX_TEMPLATE_BYTES = 256;
const MAX_FILENAME_BYTES = 240;
const TOKENS = Object.freeze(['datetime', 'date', 'time', 'timestamp', 'type', 'index', 'width', 'height']);
const TOKEN_SET = new Set(TOKENS);

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeFilenameTemplate(value) {
  if (typeof value !== 'string') throw new Error('文件名模板必须是文本。');
  if (!value || !value.trim()) throw new Error('文件名模板不能为空。');
  if (byteLength(value) > MAX_TEMPLATE_BYTES) throw new Error(`文件名模板过长（最多 ${MAX_TEMPLATE_BYTES} 字节）。`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('文件名模板不得包含控制字符。');
  // 模板只表示 basename，不接受任何平台的路径分隔符或便携文件系统禁用字符。
  if (/[\\/<>:"|?*]/.test(value)) throw new Error('文件名模板只能生成单个文件名，不得包含路径或非法字符。');

  value.replace(/\{([a-z]+)\}/gi, (_whole, token) => {
    const normalized = token.toLowerCase();
    if (!TOKEN_SET.has(normalized)) throw new Error(`不支持的文件名变量：{${token}}`);
    return '';
  });
  const withoutTokens = value.replace(/\{[a-z]+\}/gi, '');
  if (/[{}]/.test(withoutTokens)) throw new Error('文件名模板中的大括号不完整。');
  if (value === '.' || value === '..') throw new Error('文件名模板无效。');
  return value;
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function normalizeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value == null ? Date.now() : value);
  if (!Number.isFinite(date.getTime())) throw new Error('文件名时间无效。');
  return date;
}

function normalizeInteger(value, fallback, label, { min = 0, max = 1000000 } = {}) {
  const candidate = value == null ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) throw new Error(`${label}无效。`);
  return candidate;
}

function normalizeType(value) {
  const type = String(value == null || value === '' ? 'screenshot' : value);
  if (byteLength(type) > 64 || /[\x00-\x1f\x7f\\/<>:"|?*{}]/.test(type)) throw new Error('文件名类型无效。');
  return type;
}

function renderFilenameStem(templateValue, context = {}) {
  const template = normalizeFilenameTemplate(templateValue);
  const date = normalizeDate(context.now);
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const replacements = {
    datetime: `${datePart}_${timePart}`,
    date: datePart,
    time: timePart,
    timestamp: String(date.getTime()),
    type: normalizeType(context.type),
    index: String(normalizeInteger(context.index, 1, '文件名序号', { min: 1 })),
    width: String(normalizeInteger(context.width, 0, '文件名宽度', { max: 32768 })),
    height: String(normalizeInteger(context.height, 0, '文件名高度', { max: 32768 })),
  };
  const rendered = template.replace(/\{([a-z]+)\}/gi, (_whole, token) => replacements[token.toLowerCase()]);
  const stem = rendered.trim().replace(/[. ]+$/g, '');
  if (!stem || stem === '.' || stem === '..') throw new Error('文件名模板渲染后为空或无效。');
  if (byteLength(stem) > MAX_FILENAME_BYTES) throw new Error(`文件名过长（最多 ${MAX_FILENAME_BYTES} 字节）。`);
  if (path.basename(stem) !== stem || /[\\/\x00-\x1f\x7f]/.test(stem)) throw new Error('文件名模板渲染结果无效。');
  return stem;
}

function normalizeExtension(value) {
  const extension = String(value || '').trim().toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9]{1,10}$/.test(extension)) throw new Error('文件扩展名无效。');
  return extension;
}

function buildFilename({ template, extension, ...context } = {}) {
  const stem = renderFilenameStem(template, context);
  const ext = normalizeExtension(extension);
  const filename = `${stem}.${ext}`;
  if (byteLength(filename) > 255) throw new Error('生成的文件名过长。');
  return filename;
}

function nextAvailablePath(directory, filename, options = {}) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error('文件保存目录无效。');
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || path.basename(filename) !== filename || /[\\/]/.test(filename)) {
    throw new Error('待保存文件名必须是 basename。');
  }
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync;
  const reserved = options.reserved instanceof Set ? options.reserved : null;
  const directoryPath = path.resolve(directory);
  const parsed = path.parse(filename);
  let suffix = 1;
  let candidatePath;
  do {
    const candidateName = suffix === 1 ? filename : `${parsed.name}-${suffix}${parsed.ext}`;
    candidatePath = path.join(directoryPath, candidateName);
    suffix += 1;
  } while (existsSync(candidatePath) || (reserved && reserved.has(candidatePath)));
  if (reserved) reserved.add(candidatePath);
  return candidatePath;
}

module.exports = {
  DEFAULT_SCREENSHOT_TEMPLATE,
  DEFAULT_RECORDING_TEMPLATE,
  MAX_TEMPLATE_BYTES,
  TOKENS,
  normalizeFilenameTemplate,
  renderFilenameStem,
  buildFilename,
  nextAvailablePath,
};
