'use strict';

const STATIC_ACTIONS = new Set(['copy', 'save', 'quickSave', 'pin', 'ocr', 'ask', 'translate']);
const LIVE_ACTIONS = new Set(['record', 'long']);
const STATIC_FIELDS = new Set(['imageDataURL', 'bounds', 'sourceRect']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyRecord(value, label, { optional = false } = {}) {
  if (value == null && optional) return undefined;
  if (!isPlainObject(value)) throw new Error(`${label}无效。`);
  return { ...value };
}

function normalizeDisplayId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value && value.length <= 128 && !value.includes('\0')) return value;
  throw new Error('目标显示器标识无效。');
}

function rejectUnknownFields(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`未知截图结果字段：${key}`);
  }
}

function normalizeOverlayResultEnvelope(value) {
  if (!isPlainObject(value)) throw new Error('截图结果格式无效。');
  const { action } = value;
  if (!STATIC_ACTIONS.has(action) && !LIVE_ACTIONS.has(action)) throw new Error('截图操作无效。');

  if (LIVE_ACTIONS.has(action)) {
    for (const field of STATIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        throw new Error(`实时截取操作与静态图字段 ${field} 互斥。`);
      }
    }
    const allowed = new Set(['action', 'rect', 'displayId']);
    rejectUnknownFields(value, allowed);
    return {
      kind: 'live',
      action,
      rect: copyRecord(value.rect, '实时截取选区'),
      displayId: normalizeDisplayId(value.displayId),
    };
  }

  const allowed = new Set(['action', 'imageDataURL', 'rect', 'bounds', 'sourceRect', 'displayId']);
  rejectUnknownFields(value, allowed);
  if (typeof value.imageDataURL !== 'string' || !value.imageDataURL) throw new Error('静态截图图片数据无效。');
  const normalized = {
    kind: 'static',
    action,
    imageDataURL: value.imageDataURL,
    rect: copyRecord(value.rect, '截图选区'),
    displayId: normalizeDisplayId(value.displayId),
  };
  const bounds = copyRecord(value.bounds, '截图窗口范围', { optional: true });
  const sourceRect = copyRecord(value.sourceRect, '截图像素选区', { optional: true });
  if (bounds) normalized.bounds = bounds;
  if (sourceRect) normalized.sourceRect = sourceRect;
  return normalized;
}

module.exports = { STATIC_ACTIONS, LIVE_ACTIONS, normalizeOverlayResultEnvelope };
