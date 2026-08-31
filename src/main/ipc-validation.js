// IPC 边界校验：所有来自 renderer 的数据都按不可信输入处理。
// 保持纯 Node 模块，便于不启动 Electron 就做回归测试。
const path = require('node:path');
const { DEFAULT_CONFIG, SUPPORTED_OCR_LANGUAGES } = require('../shared/config-schema');

const MAX_IMAGE_DATA_URL_CHARS = 128 * 1024 * 1024;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_CHAT_MESSAGES = 100;
const MAX_TRANSLATION_LINES = 2000;
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requireImageDataURL(value, maxChars = MAX_IMAGE_DATA_URL_CHARS) {
  if (typeof value !== 'string') throw new Error('图片数据无效。');
  if (value.length > maxChars) throw new Error('图片数据过大。');
  const m = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,([\s\S]+)$/i.exec(value);
  if (!m) throw new Error('图片数据无效。');
  const b64 = m[1].replace(/\s/g, '');
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('图片数据无效。');
  }
  return value;
}

function normalizeCaptureRect(rect, displaySize) {
  const dw = finiteNumber(displaySize && displaySize.width);
  const dh = finiteNumber(displaySize && displaySize.height);
  const x0 = finiteNumber(rect && rect.x);
  const y0 = finiteNumber(rect && rect.y);
  const w0 = finiteNumber(rect && rect.width);
  const h0 = finiteNumber(rect && rect.height);
  if (!(dw > 0) || !(dh > 0) || x0 === null || y0 === null || !(w0 > 0) || !(h0 > 0)) {
    throw new Error('截图选区无效。');
  }
  if (x0 < 0 || y0 < 0 || x0 + w0 > dw + 0.001 || y0 + h0 > dh + 0.001) {
    throw new Error('截图选区超出显示器边界。');
  }
  const x = Math.round(x0);
  const y = Math.round(y0);
  const width = Math.min(Math.round(dw) - x, Math.max(1, Math.round(w0)));
  const height = Math.min(Math.round(dh) - y, Math.max(1, Math.round(h0)));
  if (!(width > 0) || !(height > 0)) throw new Error('截图选区无效。');
  return { x, y, width, height };
}

function normalizePinBounds(bounds) {
  const x = finiteNumber(bounds && bounds.x);
  const y = finiteNumber(bounds && bounds.y);
  const width = finiteNumber(bounds && bounds.width);
  const height = finiteNumber(bounds && bounds.height);
  if (x === null || y === null || Math.abs(x) > 100000 || Math.abs(y) > 100000) {
    throw new Error('贴图窗口位置无效。');
  }
  if (width === null || height === null) throw new Error('贴图窗口尺寸无效。');
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(40, Math.min(8000, Math.round(width))),
    height: Math.max(40, Math.min(8000, Math.round(height))),
  };
}

function normalizeWindowResize(payload) {
  const width = finiteNumber(payload && payload.width);
  const height = finiteNumber(payload && payload.height);
  if (width === null || height === null) throw new Error('窗口尺寸无效。');
  return {
    width: Math.max(48, Math.min(8000, Math.round(width))),
    height: Math.max(48, Math.min(8000, Math.round(height))),
  };
}

function normalizeWindowMove(payload) {
  const dx = finiteNumber(payload && payload.dx);
  const dy = finiteNumber(payload && payload.dy);
  if (dx === null || dy === null) throw new Error('窗口移动参数无效。');
  return {
    dx: Math.max(-8000, Math.min(8000, Math.round(dx))),
    dy: Math.max(-8000, Math.min(8000, Math.round(dy))),
  };
}

function boundedString(value, label, maxChars, { trim = false, allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`);
  const out = trim ? value.trim() : value;
  if (!allowEmpty && !out) throw new Error(`${label}不能为空。`);
  if (out.length > maxChars) throw new Error(`${label}过长。`);
  return out;
}

function normalizeTranslationRequest(payload) {
  const lines = payload && payload.lines;
  if (!Array.isArray(lines) || lines.length > MAX_TRANSLATION_LINES) {
    throw new Error(`翻译行数量无效（最多 ${MAX_TRANSLATION_LINES} 行）。`);
  }
  let total = 0;
  const normalizedLines = lines.map((line) => {
    const out = boundedString(line, '翻译行', 32768);
    total += out.length;
    if (total > MAX_TEXT_CHARS) throw new Error('翻译文本过长。');
    return out;
  });
  const rawTarget = payload && payload.target != null ? payload.target : '中文';
  const target = boundedString(rawTarget, '目标语言', 64, { trim: true }) || '中文';
  return { lines: normalizedLines, target };
}

function normalizeStreamId(value) {
  return boundedString(value, '流标识', 256, { trim: true, allowEmpty: false });
}

function normalizeChatRequest(payload) {
  const messages = payload && payload.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_CHAT_MESSAGES) {
    throw new Error(`AI 消息数量无效（1–${MAX_CHAT_MESSAGES} 条）。`);
  }
  let total = 0;
  const normalizedMessages = messages.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('AI 消息无效。');
    const role = boundedString(message.role, '消息角色', 16, { trim: true, allowEmpty: false });
    if (!['system', 'user', 'assistant'].includes(role)) throw new Error('消息角色无效。');
    const content = boundedString(message.content, '消息内容', 256 * 1024);
    total += content.length;
    if (total > MAX_TEXT_CHARS) throw new Error('AI 消息总长度过大。');
    return { role, content };
  });
  const streamId = normalizeStreamId(payload && payload.streamId);
  const model = boundedString(String((payload && payload.model) || ''), '模型名称', 256, { trim: true });
  return { messages: normalizedMessages, streamId, model, think: !!(payload && payload.think) };
}

function normalizeProviderBaseUrl(value) {
  const raw = boundedString(String(value || ''), 'API Base URL', 2048, { trim: true, allowEmpty: false });
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('API Base URL 不是有效 URL。');
  }
  if (url.username || url.password) throw new Error('API Base URL 不得包含用户名或密码凭据。');
  const serializedUrl = url.toString();
  if (serializedUrl.includes('?') || serializedUrl.includes('#')) {
    throw new Error('API Base URL 不得包含查询参数或片段。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('API Base URL 只允许 HTTPS，或本机回环 HTTP。');
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error('远程 API Base URL 必须使用 HTTPS。');
  }
  return serializedUrl.replace(/\/$/, '');
}

function normalizeExternalHttpUrl(value) {
  if (typeof value !== 'string') throw new Error('外部链接无效。');
  if (value.length > 4096) throw new Error('外部链接过长。');
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('外部链接不是有效 URL。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('外部链接只允许 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('外部链接不得包含用户名或密码凭据。');
  }
  return url.toString();
}

function normalizePinStateFlags(value) {
  if (!isPlainObject(value)) throw new Error('贴图状态格式无效。');
  const allowed = new Set(['onTop', 'ignoreMouse', 'opacity', 'locked', 'title']);
  const out = {};
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`未知贴图状态：${key}`);
    if (key === 'opacity') {
      const opacity = Number(value[key]);
      if (!Number.isFinite(opacity)) throw new Error('opacity 必须是有限数字。');
      out.opacity = Math.max(0.3, Math.min(1, opacity));
    } else if (key === 'title') {
      if (typeof value[key] !== 'string' || value[key].length > 512 || value[key].includes('\0')) {
        throw new Error('贴图标题无效或过长。');
      }
      out.title = value[key];
    } else {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
      out[key] = value[key];
    }
  }
  return out;
}

function normalizeProviderTestTarget(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !['deepseek', 'minimax', 'openai'].includes(value)) {
    throw new Error('AI 提供方无效。');
  }
  return value;
}

function normalizeRecordingPayload(value) {
  if (!isPlainObject(value)) throw new Error('录制数据格式无效。');
  const allowed = new Set(['buffer', 'mime', 'toGif', 'fps', 'trimStart', 'trimEnd']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`未知录制参数：${key}`);
  }

  const { buffer } = value;
  const isBinary = buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer);
  const byteLen = isBinary ? buffer.byteLength : 0;
  if (!isBinary || byteLen < 4 || byteLen > MAX_RECORDING_BYTES) {
    throw new Error('录制数据为空、格式无效或超过 128MB 上限。');
  }
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    throw new Error('录制数据不是有效的 WebM 文件。');
  }
  if (value.mime !== undefined && value.mime !== 'video/webm') throw new Error('录制 MIME 类型无效。');
  if (value.toGif !== undefined && typeof value.toGif !== 'boolean') throw new Error('toGif 必须是布尔值。');

  const boundedNumber = (raw, label, fallback, min, max, round = false) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${label}必须是有限数字。`);
    const bounded = Math.max(min, Math.min(max, raw));
    return round ? Math.round(bounded) : bounded;
  };
  return {
    buffer,
    toGif: value.toGif,
    fps: boundedNumber(value.fps, '录制帧率', null, 1, 60, true),
    trimStart: boundedNumber(value.trimStart, '裁剪起点', 0, 0, 24 * 60 * 60),
    trimEnd: boundedNumber(value.trimEnd, '裁剪终点', 0, 0, 24 * 60 * 60),
  };
}

function normalizeOCRLanguage(value) {
  if (typeof value !== 'string' || !SUPPORTED_OCR_LANGUAGES.includes(value)) {
    throw new Error(`OCR 语言选择无效。仅支持：${SUPPORTED_OCR_LANGUAGES.join('、')}`);
  }
  return value;
}

const CONFIG_ENUMS = {
  'ai.provider': ['deepseek', 'minimax', 'openai', 'auto'],
  'openai.preset': ['siliconflow', 'qwen', 'kimi', 'custom'],
  'ocr.engine': ['local', 'model'],
  'ocr.lang': SUPPORTED_OCR_LANGUAGES,
  'capture.exportFormat': ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf'],
  'general.theme': ['light', 'dark'],
};

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function configStringLimit(keyPath) {
  if (/\.apiKey$/.test(keyPath)) return 16384;
  if (/Prompt$/.test(keyPath)) return 65536;
  if (keyPath === 'general.saveDir') return 8192;
  if (keyPath.startsWith('shortcuts.') || keyPath.startsWith('builtinKeys.')) return 128;
  if (/Model$/.test(keyPath) || keyPath === 'openai.model') return 256;
  if (keyPath.endsWith('.baseUrl')) return 2048;
  return 256;
}

function normalizeConfigValue(value, defaultValue, keyPath) {
  if (typeof defaultValue === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${keyPath} 必须是布尔值。`);
    return value;
  }
  if (typeof defaultValue === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${keyPath} 必须是有限数字。`);
    const n = value;
    if (keyPath === 'recording.fps') return Math.max(1, Math.min(60, Math.round(n)));
    if (keyPath === 'capture.quality') {
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('capture.quality 必须是 1 到 100 的整数。');
      return n;
    }
    return n;
  }
  if (typeof defaultValue === 'string') {
    if (typeof value !== 'string') throw new Error(`${keyPath} 必须是文本。`);
    if (value.length > configStringLimit(keyPath) || value.includes('\0')) throw new Error(`${keyPath} 文本无效或过长。`);
    if (keyPath === 'ocr.lang') return normalizeOCRLanguage(value);
    const enums = CONFIG_ENUMS[keyPath];
    if (enums && !enums.includes(value)) throw new Error(`${keyPath} 取值无效。`);
    if (keyPath.endsWith('.baseUrl')) return normalizeProviderBaseUrl(value);
    if (keyPath === 'general.saveDir' && value && !path.isAbsolute(value)) throw new Error('保存目录必须是绝对路径。');
    return value;
  }
  throw new Error(`${keyPath} 配置类型不受支持。`);
}

function normalizeConfigObject(patch, schema, prefix, leafPaths) {
  if (!isPlainObject(patch)) throw new Error(`${prefix || '配置'}格式无效。`);
  const out = {};
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) throw new Error(`未知配置项：${prefix ? prefix + '.' : ''}${key}`);
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const defaultValue = schema[key];
    if (isPlainObject(defaultValue)) {
      out[key] = normalizeConfigObject(patch[key], defaultValue, keyPath, leafPaths);
    } else {
      out[key] = normalizeConfigValue(patch[key], defaultValue, keyPath);
      leafPaths.push(keyPath);
    }
  }
  return out;
}

function normalizeConfigPatch(patch, role) {
  if (!isPlainObject(patch)) throw new Error('配置更新格式无效。');
  let serialized;
  try { serialized = JSON.stringify(patch); } catch (_) { throw new Error('配置更新无法序列化。'); }
  if (!serialized || serialized.length > 512 * 1024) throw new Error('配置更新过大。');
  const leafPaths = [];
  const out = normalizeConfigObject(patch, DEFAULT_CONFIG, '', leafPaths);
  const roleFields = {
    overlay: new Set(['translate.target']),
    popover: new Set(['capture.copyAfterCapture']),
  };
  if (role !== 'main') {
    const allowed = roleFields[role];
    if (!allowed || leafPaths.some((keyPath) => !allowed.has(keyPath))) {
      throw new Error('当前窗口没有修改该配置项的权限。');
    }
  }
  return out;
}

module.exports = {
  MAX_IMAGE_DATA_URL_CHARS,
  requireImageDataURL,
  normalizeCaptureRect,
  normalizePinBounds,
  normalizeWindowResize,
  normalizeWindowMove,
  normalizeTranslationRequest,
  normalizeStreamId,
  normalizeChatRequest,
  normalizeProviderBaseUrl,
  normalizeExternalHttpUrl,
  normalizeOCRLanguage,
  normalizeConfigPatch,
  normalizePinStateFlags,
  normalizeProviderTestTarget,
  normalizeRecordingPayload,
};
