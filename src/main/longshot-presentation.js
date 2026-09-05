'use strict';

const { normalizeCaptureRect, requireImageDataURL } = require('./ipc-validation');

function rectanglesOverlap(a, b) {
  return !!a && !!b && a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

// 全部布局计算使用显示器局部 DIP；只有实际 BrowserWindow bounds 添加显示器原点。
// 不按 scaleFactor 再放大窗口，避免 Retina/负坐标屏幕上偏移或改变用户的截图范围。
function calculateLongshotLayout({ rect, displayBounds, expanded = false }) {
  const db = displayBounds || {};
  if (![db.x, db.y, db.width, db.height].every(Number.isFinite)
    || Math.abs(db.x) > 100000 || Math.abs(db.y) > 100000
    || db.width < 1 || db.height < 1 || db.width > 32768 || db.height > 32768) {
    throw new Error('长截图显示器区域无效。');
  }
  const width = Math.floor(db.width);
  const height = Math.floor(db.height);
  const selection = normalizeCaptureRect(rect, { width, height });
  const gap = 12;
  const barWidth = Math.min(660, width);
  const barHeight = Math.min(expanded ? 300 : 76, height);
  const toolbar = {
    x: clamp(Math.round(selection.x + selection.width / 2 - barWidth / 2), 0, width - barWidth),
    y: 0,
    width: barWidth,
    height: barHeight,
  };
  const below = selection.y + selection.height + gap;
  const above = selection.y - gap - barHeight;
  toolbar.y = below + barHeight <= height ? below
    : above >= 0 ? above : clamp(below, 0, height - barHeight);

  const zones = [
    { x: selection.x + selection.width + gap, y: gap, width: width - selection.x - selection.width - gap * 2, height: height - gap * 2 },
    { x: gap, y: gap, width: selection.x - gap * 2, height: height - gap * 2 },
    { x: gap, y: gap, width: width - gap * 2, height: selection.y - gap * 2 },
    { x: gap, y: selection.y + selection.height + gap, width: width - gap * 2, height: height - selection.y - selection.height - gap * 2 },
  ];
  let preview = null;
  for (const zone of zones) {
    if (zone.width < 128 || zone.height < 100) continue;
    const pw = Math.min(240, zone.width);
    const ph = Math.min(360, zone.height);
    const x = clamp(selection.x + selection.width + gap, zone.x, zone.x + zone.width - pw);
    const y = clamp(selection.y + selection.height - ph, zone.y, zone.y + zone.height - ph);
    const candidates = [
      { x, y, width: pw, height: ph },
      { x, y: zone.y, width: pw, height: Math.min(ph, toolbar.y - gap - zone.y) },
      { x, y: Math.max(zone.y, toolbar.y + toolbar.height + gap), width: pw,
        height: Math.min(ph, zone.y + zone.height - Math.max(zone.y, toolbar.y + toolbar.height + gap)) },
    ];
    preview = candidates.find((candidate) => candidate.height >= 100
      && !rectanglesOverlap(candidate, selection) && !rectanglesOverlap(candidate, toolbar)) || null;
    if (preview) break;
  }
  const origin = { x: Math.round(db.x), y: Math.round(db.y) };
  const nativeBounds = (local) => ({ ...local, x: local.x + origin.x, y: local.y + origin.y });
  return {
    rect: selection,
    preview,
    toolbar,
    toolbarBounds: nativeBounds(toolbar),
    captureBounds: nativeBounds(selection),
    toolbarOverlapsSelection: rectanglesOverlap(toolbar, selection),
  };
}

function normalizeLongshotPresentation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('长截图状态无效。');
  const allowed = ['previewDataURL', 'outputWidth', 'outputHeight', 'frameCount', 'capturing', 'expanded'];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error('长截图状态包含不支持的字段。');
  const next = {};
  for (const key of ['capturing', 'expanded']) {
    if (!(key in payload)) continue;
    if (typeof payload[key] !== 'boolean') throw new Error('长截图状态开关无效。');
    next[key] = payload[key];
  }
  for (const key of ['outputWidth', 'outputHeight', 'frameCount']) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (!Number.isInteger(value) || value < 0 || value > 120000) throw new Error('长截图尺寸或帧数无效。');
    next[key] = value;
  }
  if ('previewDataURL' in payload) {
    if (payload.previewDataURL === null) next.previewDataURL = null;
    else {
      const dataURL = requireImageDataURL(payload.previewDataURL, 1024 * 1024);
      if (!dataURL.startsWith('data:image/png;base64,')) throw new Error('长截图预览只支持 PNG。');
      const png = Buffer.from(dataURL.slice(22), 'base64');
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('长截图预览 PNG 无效。');
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (width < 1 || height < 1 || width > 240 || height > 480) throw new Error('长截图预览必须为不大于 240×480 的缩略图。');
      next.previewDataURL = dataURL;
    }
  }
  return next;
}

module.exports = { calculateLongshotLayout, rectanglesOverlap, normalizeLongshotPresentation };
