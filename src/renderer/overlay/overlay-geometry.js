/* 困困截图工具 · Overlay 几何映射
 * 浏览器与 Node 测试共享的纯函数。所有选区交互先落到源图整数像素边界，
 * 再映回 CSS 坐标，避免 X/Y 缩放不同或窗口尺寸取整时出现显示/导出偏差。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KKOverlayGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function positiveNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function normalizeSpaces(viewport, source) {
    var vw = positiveNumber(viewport && viewport.width);
    var vh = positiveNumber(viewport && viewport.height);
    var sw = positiveNumber(source && source.width);
    var sh = positiveNumber(source && source.height);
    if (!vw || !vh || !sw || !sh) return null;
    return {
      vw: vw,
      vh: vh,
      sw: Math.max(1, Math.floor(sw)),
      sh: Math.max(1, Math.floor(sh)),
    };
  }

  function overlayEdgeToSource(value, overlayExtent, sourceExtent) {
    return clamp(Math.round((clamp(Number(value) || 0, 0, overlayExtent) / overlayExtent) * sourceExtent), 0, sourceExtent);
  }

  // Unlike rectangle edges, color picking addresses one concrete source pixel.
  // The far overlay edge therefore maps to the final pixel instead of the
  // exclusive `sourceExtent` edge used by crop rectangles.
  function mapOverlayPointToSource(point, viewport, source) {
    var spaces = normalizeSpaces(viewport, source);
    var x = Number(point && point.x);
    var y = Number(point && point.y);
    if (!spaces || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x > spaces.vw || y > spaces.vh) return null;
    return {
      x: clamp(Math.floor((x / spaces.vw) * spaces.sw), 0, spaces.sw - 1),
      y: clamp(Math.floor((y / spaces.vh) * spaces.sh), 0, spaces.sh - 1),
    };
  }

  function mapOverlayRectToSource(rect, viewport, source) {
    var spaces = normalizeSpaces(viewport, source);
    if (!spaces || !rect) return null;
    var rawX0 = Number(rect.x) || 0;
    var rawY0 = Number(rect.y) || 0;
    var rawX1 = rawX0 + Math.max(0, Number(rect.width) || 0);
    var rawY1 = rawY0 + Math.max(0, Number(rect.height) || 0);
    var left = overlayEdgeToSource(rawX0, spaces.vw, spaces.sw);
    var top = overlayEdgeToSource(rawY0, spaces.vh, spaces.sh);
    var right = overlayEdgeToSource(rawX1, spaces.vw, spaces.sw);
    var bottom = overlayEdgeToSource(rawY1, spaces.vh, spaces.sh);
    if (right <= left) {
      if (left >= spaces.sw) left = spaces.sw - 1;
      right = Math.min(spaces.sw, left + 1);
    }
    if (bottom <= top) {
      if (top >= spaces.sh) top = spaces.sh - 1;
      bottom = Math.min(spaces.sh, top + 1);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function normalizeSourceRect(rect, sourceWidth, sourceHeight) {
    var x = clamp(Math.round(Number(rect && rect.x) || 0), 0, Math.max(0, sourceWidth - 1));
    var y = clamp(Math.round(Number(rect && rect.y) || 0), 0, Math.max(0, sourceHeight - 1));
    var width = clamp(Math.round(Number(rect && rect.width) || 1), 1, sourceWidth - x);
    var height = clamp(Math.round(Number(rect && rect.height) || 1), 1, sourceHeight - y);
    return { x: x, y: y, width: width, height: height };
  }

  function mapSourceRectToOverlay(rect, viewport, source) {
    var spaces = normalizeSpaces(viewport, source);
    if (!spaces || !rect) return null;
    var safe = normalizeSourceRect(rect, spaces.sw, spaces.sh);
    return {
      x: (safe.x / spaces.sw) * spaces.vw,
      y: (safe.y / spaces.sh) * spaces.vh,
      width: (safe.width / spaces.sw) * spaces.vw,
      height: (safe.height / spaces.sh) * spaces.vh,
    };
  }

  function getOverlayRectSourceSize(rect, viewport, source) {
    var mapped = mapOverlayRectToSource(rect, viewport, source);
    return mapped ? { width: mapped.width, height: mapped.height } : { width: 0, height: 0 };
  }

  function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) {
      var next = a % b;
      a = b;
      b = next;
    }
    return a || 1;
  }

  function normalizeRatio(ratio) {
    if (!ratio || ratio === 'free') return null;
    var width;
    var height;
    if (typeof ratio === 'string') {
      var match = ratio.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
      if (!match) return null;
      width = Number(match[1]);
      height = Number(match[2]);
    } else if (typeof ratio === 'number') {
      width = ratio * 10000;
      height = 10000;
    } else {
      width = Number(ratio.width);
      height = Number(ratio.height);
    }
    if (!(width > 0) || !(height > 0)) return null;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    var divisor = gcd(width, height);
    return { width: width / divisor, height: height / divisor };
  }

  function fitRatioDimensions(desiredWidth, desiredHeight, ratio, maxWidth, maxHeight, primary) {
    var parts = normalizeRatio(ratio);
    if (!parts) {
      return {
        width: clamp(Math.round(Number(desiredWidth) || 1), 1, Math.max(1, Math.floor(maxWidth))),
        height: clamp(Math.round(Number(desiredHeight) || 1), 1, Math.max(1, Math.floor(maxHeight))),
      };
    }
    var maxFactor = Math.floor(Math.min(maxWidth / parts.width, maxHeight / parts.height));
    if (maxFactor < 1) {
      return {
        width: Math.max(1, Math.min(Math.floor(maxWidth), parts.width)),
        height: Math.max(1, Math.min(Math.floor(maxHeight), parts.height)),
      };
    }
    var desiredFactor;
    if (primary === 'height') desiredFactor = Math.round((Number(desiredHeight) || parts.height) / parts.height);
    else if (primary === 'width') desiredFactor = Math.round((Number(desiredWidth) || parts.width) / parts.width);
    else {
      desiredFactor = Math.round(Math.max(
        (Number(desiredWidth) || 0) / parts.width,
        (Number(desiredHeight) || 0) / parts.height
      ));
    }
    desiredFactor = clamp(Math.max(1, desiredFactor), 1, maxFactor);
    return { width: parts.width * desiredFactor, height: parts.height * desiredFactor };
  }

  function createOverlayRectFromDrag(start, end, viewport, source, ratio) {
    var spaces = normalizeSpaces(viewport, source);
    if (!spaces) return null;
    var startX = overlayEdgeToSource(start && start.x, spaces.vw, spaces.sw);
    var startY = overlayEdgeToSource(start && start.y, spaces.vh, spaces.sh);
    var endX = overlayEdgeToSource(end && end.x, spaces.vw, spaces.sw);
    var endY = overlayEdgeToSource(end && end.y, spaces.vh, spaces.sh);
    var dirX = endX < startX ? -1 : 1;
    var dirY = endY < startY ? -1 : 1;
    var rawWidth = Math.abs(endX - startX);
    var rawHeight = Math.abs(endY - startY);
    var parts = normalizeRatio(ratio);
    var width = rawWidth;
    var height = rawHeight;
    if (parts) {
      var maxWidth = dirX < 0 ? startX : spaces.sw - startX;
      var maxHeight = dirY < 0 ? startY : spaces.sh - startY;
      var fitted = fitRatioDimensions(rawWidth, rawHeight, parts, maxWidth, maxHeight);
      width = fitted.width;
      height = fitted.height;
    }
    width = Math.max(1, width);
    height = Math.max(1, height);
    var sourceRect = {
      x: dirX < 0 ? startX - width : startX,
      y: dirY < 0 ? startY - height : startY,
      width: width,
      height: height,
    };
    return mapSourceRectToOverlay(sourceRect, viewport, source);
  }

  function resizeOverlayRect(rect, handle, pointer, viewport, source, ratio) {
    var spaces = normalizeSpaces(viewport, source);
    var current = spaces && mapOverlayRectToSource(rect, viewport, source);
    if (!spaces || !current) return rect || null;
    var pos = String(handle || 'se');
    var pointerX = overlayEdgeToSource(pointer && pointer.x, spaces.vw, spaces.sw);
    var pointerY = overlayEdgeToSource(pointer && pointer.y, spaces.vh, spaces.sh);
    var hasW = pos.indexOf('w') !== -1;
    var hasE = pos.indexOf('e') !== -1;
    var hasN = pos.indexOf('n') !== -1;
    var hasS = pos.indexOf('s') !== -1;
    var left = current.x;
    var top = current.y;
    var right = current.x + current.width;
    var bottom = current.y + current.height;
    var parts = normalizeRatio(ratio);

    if (!parts) {
      if (hasW) left = pointerX;
      if (hasE) right = pointerX;
      if (hasN) top = pointerY;
      if (hasS) bottom = pointerY;
      var x0 = Math.min(left, right);
      var y0 = Math.min(top, bottom);
      var x1 = Math.max(left, right);
      var y1 = Math.max(top, bottom);
      if (x1 === x0) x1 = Math.min(spaces.sw, x0 + 1);
      if (y1 === y0) y1 = Math.min(spaces.sh, y0 + 1);
      return mapSourceRectToOverlay({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, viewport, source);
    }

    var desiredWidth = (hasW ? right - pointerX : hasE ? pointerX - left : current.width);
    var desiredHeight = (hasN ? bottom - pointerY : hasS ? pointerY - top : current.height);
    desiredWidth = Math.max(1, Math.abs(desiredWidth));
    desiredHeight = Math.max(1, Math.abs(desiredHeight));
    var anchorRight = hasW ? right : null;
    var anchorBottom = hasN ? bottom : null;
    var anchorLeft = hasW ? null : left;
    var anchorTop = hasN ? null : top;
    var maxWidth = hasW ? anchorRight : spaces.sw - anchorLeft;
    var maxHeight = hasN ? anchorBottom : spaces.sh - anchorTop;
    var primary = (hasW || hasE) && !(hasN || hasS) ? 'width'
      : (hasN || hasS) && !(hasW || hasE) ? 'height'
        : null;
    var fitted = fitRatioDimensions(desiredWidth, desiredHeight, parts, maxWidth, maxHeight, primary);
    var resized = {
      x: hasW ? anchorRight - fitted.width : anchorLeft,
      y: hasN ? anchorBottom - fitted.height : anchorTop,
      width: fitted.width,
      height: fitted.height,
    };
    return mapSourceRectToOverlay(resized, viewport, source);
  }

  function setOverlayRectSourceSize(rect, size, viewport, source, ratio) {
    var spaces = normalizeSpaces(viewport, source);
    var current = spaces && mapOverlayRectToSource(rect, viewport, source);
    if (!spaces || !current) return rect || null;
    var desiredWidth = Number(size && size.width) || current.width;
    var desiredHeight = Number(size && size.height) || current.height;
    var fitted = fitRatioDimensions(
      desiredWidth,
      desiredHeight,
      ratio,
      spaces.sw,
      spaces.sh,
      size && size.primary
    );
    var sourceRect = {
      x: clamp(current.x, 0, spaces.sw - fitted.width),
      y: clamp(current.y, 0, spaces.sh - fitted.height),
      width: fitted.width,
      height: fitted.height,
    };
    return mapSourceRectToOverlay(sourceRect, viewport, source);
  }

  function moveOverlayRect(rect, delta, viewport, source) {
    var spaces = normalizeSpaces(viewport, source);
    var current = spaces && mapOverlayRectToSource(rect, viewport, source);
    if (!spaces || !current) return rect || null;
    var dx = Math.round(((Number(delta && delta.x) || 0) / spaces.vw) * spaces.sw);
    var dy = Math.round(((Number(delta && delta.y) || 0) / spaces.vh) * spaces.sh);
    return mapSourceRectToOverlay({
      x: clamp(current.x + dx, 0, spaces.sw - current.width),
      y: clamp(current.y + dy, 0, spaces.sh - current.height),
      width: current.width,
      height: current.height,
    }, viewport, source);
  }

  function nudgeOverlayRect(rect, key, mode, viewport, source, ratio) {
    var spaces = normalizeSpaces(viewport, source);
    var current = spaces && mapOverlayRectToSource(rect, viewport, source);
    if (!spaces || !current) return rect || null;
    var direction = String(key || '');
    var operation = mode || 'move';
    var sourceRect = {
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
    };

    if (operation === 'move') {
      var dx = direction === 'ArrowLeft' ? -1 : direction === 'ArrowRight' ? 1 : 0;
      var dy = direction === 'ArrowUp' ? -1 : direction === 'ArrowDown' ? 1 : 0;
      sourceRect.x = clamp(sourceRect.x + dx, 0, spaces.sw - sourceRect.width);
      sourceRect.y = clamp(sourceRect.y + dy, 0, spaces.sh - sourceRect.height);
      return mapSourceRectToOverlay(sourceRect, viewport, source);
    }

    var parts = normalizeRatio(ratio);
    var grow = operation === 'expand' ? 1 : -1;
    if (parts) {
      var factor = Math.max(1, Math.round(Math.min(current.width / parts.width, current.height / parts.height)));
      var desiredFactor = Math.max(1, factor + grow);
      var anchorRight = current.x + current.width;
      var anchorBottom = current.y + current.height;
      var maxFactor;
      if (direction === 'ArrowLeft') maxFactor = Math.floor(Math.min(anchorRight / parts.width, (spaces.sh - current.y) / parts.height));
      else if (direction === 'ArrowUp') maxFactor = Math.floor(Math.min((spaces.sw - current.x) / parts.width, anchorBottom / parts.height));
      else maxFactor = Math.floor(Math.min((spaces.sw - current.x) / parts.width, (spaces.sh - current.y) / parts.height));
      desiredFactor = clamp(desiredFactor, 1, Math.max(1, maxFactor));
      sourceRect.width = parts.width * desiredFactor;
      sourceRect.height = parts.height * desiredFactor;
      if (direction === 'ArrowLeft') sourceRect.x = anchorRight - sourceRect.width;
      if (direction === 'ArrowUp') sourceRect.y = anchorBottom - sourceRect.height;
      return mapSourceRectToOverlay(sourceRect, viewport, source);
    }

    if (direction === 'ArrowLeft') {
      var nextLeft = operation === 'shrink' ? current.x + 1 : current.x - 1;
      nextLeft = clamp(nextLeft, 0, current.x + current.width - 1);
      sourceRect.width = current.x + current.width - nextLeft;
      sourceRect.x = nextLeft;
    } else if (direction === 'ArrowRight') {
      sourceRect.width = clamp(current.width + grow, 1, spaces.sw - current.x);
    } else if (direction === 'ArrowUp') {
      var nextTop = operation === 'shrink' ? current.y + 1 : current.y - 1;
      nextTop = clamp(nextTop, 0, current.y + current.height - 1);
      sourceRect.height = current.y + current.height - nextTop;
      sourceRect.y = nextTop;
    } else if (direction === 'ArrowDown') {
      sourceRect.height = clamp(current.height + grow, 1, spaces.sh - current.y);
    }
    return mapSourceRectToOverlay(sourceRect, viewport, source);
  }

  return {
    createOverlayRectFromDrag: createOverlayRectFromDrag,
    getOverlayRectSourceSize: getOverlayRectSourceSize,
    mapOverlayPointToSource: mapOverlayPointToSource,
    mapOverlayRectToSource: mapOverlayRectToSource,
    mapSourceRectToOverlay: mapSourceRectToOverlay,
    moveOverlayRect: moveOverlayRect,
    normalizeRatio: normalizeRatio,
    nudgeOverlayRect: nudgeOverlayRect,
    resizeOverlayRect: resizeOverlayRect,
    setOverlayRectSourceSize: setOverlayRectSourceSize,
  };
});
