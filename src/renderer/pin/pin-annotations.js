(function (root, factory) {
  'use strict';
  var exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.PinAnnotations = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DRAW_TOOLS = new Set(['pen', 'line', 'arrow', 'rect', 'ellipse', 'eraser']);
  var SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizePoint(point) {
    point = point && typeof point === 'object' ? point : {};
    return {
      x: clamp(point.x, 0, 1, 0),
      y: clamp(point.y, 0, 1, 0),
    };
  }

  function normalizeBoolean(value, fallback) {
    if (value === true || value === 1 || value === 'true') return true;
    if (value === false || value === 0 || value === 'false') return false;
    return fallback;
  }

  function normalizeTitle(value, fallback) {
    if (typeof value !== 'string') return fallback;
    return value.trim().slice(0, 120);
  }

  function normalizePinWindowState(input) {
    input = input && typeof input === 'object' ? input : {};
    return {
      opacity: clamp(input.opacity, 0.3, 1, 1),
      locked: normalizeBoolean(input.locked, false),
      onTop: normalizeBoolean(input.onTop, true),
      title: normalizeTitle(input.title, ''),
    };
  }

  function mergePinWindowState(current, update) {
    var safeCurrent = normalizePinWindowState(current);
    update = update && typeof update === 'object' ? update : {};
    var candidate = {
      opacity: Object.prototype.hasOwnProperty.call(update, 'opacity') ? update.opacity : safeCurrent.opacity,
      locked: Object.prototype.hasOwnProperty.call(update, 'locked') ? update.locked : safeCurrent.locked,
      onTop: Object.prototype.hasOwnProperty.call(update, 'onTop') ? update.onTop : safeCurrent.onTop,
      title: Object.prototype.hasOwnProperty.call(update, 'title') ? update.title : safeCurrent.title,
    };
    return normalizePinWindowState(candidate);
  }

  function normalizeStyle(style, tool) {
    style = style && typeof style === 'object' ? style : {};
    var fallbackColor = tool === 'eraser' ? '#000000' : '#ff3b30';
    return {
      color: typeof style.color === 'string' && SAFE_COLOR.test(style.color) ? style.color : fallbackColor,
      width: clamp(style.width, 0.0005, 0.05, tool === 'eraser' ? 0.03 : 0.008),
      fontSize: clamp(style.fontSize, 0.01, 0.2, 0.05),
    };
  }

  function cloneCommands(commands) {
    return commands.map(function (command) {
      return JSON.parse(JSON.stringify(command));
    });
  }

  function AnnotationDocument() {
    this.commands = [];
    this.undoStack = [];
    this.redoStack = [];
    this.active = null;
  }

  AnnotationDocument.prototype._remember = function () {
    this.undoStack.push(cloneCommands(this.commands));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  };

  AnnotationDocument.prototype.begin = function (tool, point, style) {
    if (!DRAW_TOOLS.has(tool)) return false;
    var start = normalizePoint(point);
    this.active = {
      type: tool,
      style: normalizeStyle(style, tool),
      points: tool === 'pen' || tool === 'eraser' ? [start] : undefined,
      start: tool === 'pen' || tool === 'eraser' ? undefined : start,
      end: tool === 'pen' || tool === 'eraser' ? undefined : start,
    };
    return true;
  };

  AnnotationDocument.prototype.update = function (point) {
    if (!this.active) return false;
    var next = normalizePoint(point);
    if (this.active.points) {
      var last = this.active.points[this.active.points.length - 1];
      if (!last || last.x !== next.x || last.y !== next.y) this.active.points.push(next);
    } else {
      this.active.end = next;
    }
    return true;
  };

  AnnotationDocument.prototype.finish = function (point) {
    if (!this.active) return false;
    this.update(point);
    return this.commitActive();
  };

  AnnotationDocument.prototype.commitActive = function () {
    if (!this.active) return false;
    var command = this.active;
    this.active = null;
    if (command.points && command.points.length === 1) {
      command.points.push({ x: command.points[0].x, y: command.points[0].y });
    }
    this._remember();
    this.commands.push(command);
    return true;
  };

  AnnotationDocument.prototype.cancel = function () {
    var hadActive = Boolean(this.active);
    this.active = null;
    return hadActive;
  };

  AnnotationDocument.prototype.addText = function (point, text, style) {
    if (typeof text !== 'string' || !text.trim()) return false;
    this._remember();
    this.commands.push({
      type: 'text',
      point: normalizePoint(point),
      text: text.trim().slice(0, 500),
      style: normalizeStyle(style, 'text'),
    });
    return true;
  };

  AnnotationDocument.prototype.undo = function () {
    this.cancel();
    if (!this.undoStack.length) return false;
    this.redoStack.push(cloneCommands(this.commands));
    this.commands = this.undoStack.pop();
    return true;
  };

  AnnotationDocument.prototype.redo = function () {
    this.cancel();
    if (!this.redoStack.length) return false;
    this.undoStack.push(cloneCommands(this.commands));
    this.commands = this.redoStack.pop();
    return true;
  };

  AnnotationDocument.prototype.clear = function () {
    this.cancel();
    if (!this.commands.length) return false;
    this._remember();
    this.commands = [];
    return true;
  };

  AnnotationDocument.prototype.isEmpty = function () {
    return this.commands.length === 0 && !this.active;
  };

  AnnotationDocument.prototype.snapshot = function (includeActive) {
    var commands = this.commands.slice();
    // Cmd+Q 可能在指针尚未抬起时到达。退出准备会把当前这一笔
    // 作为最终画面合成，避免工作区落盘时丢掉用户眼前可见的内容。
    if (includeActive === true && this.active) commands.push(this.active);
    return cloneCommands(commands);
  };

  function px(point, width, height) {
    return { x: point.x * width, y: point.y * height };
  }

  function drawPolyline(ctx, points, width, height) {
    if (!points || !points.length) return;
    var first = px(points[0], width, height);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (var i = 1; i < points.length; i += 1) {
      var next = px(points[i], width, height);
      ctx.lineTo(next.x, next.y);
    }
    ctx.stroke();
  }

  function drawCommand(ctx, command, width, height) {
    var style = command.style || normalizeStyle({}, command.type);
    var unit = Math.max(1, Math.min(width, height));
    ctx.save();
    ctx.globalCompositeOperation = command.type === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = Math.max(1, style.width * unit);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (command.type === 'pen' || command.type === 'eraser') {
      drawPolyline(ctx, command.points, width, height);
    } else if (command.type === 'text') {
      var textPoint = px(command.point, width, height);
      ctx.font = Math.max(10, style.fontSize * unit) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(command.text, textPoint.x, textPoint.y);
    } else {
      var start = px(command.start, width, height);
      var end = px(command.end, width, height);
      var left = Math.min(start.x, end.x);
      var top = Math.min(start.y, end.y);
      var boxWidth = Math.abs(end.x - start.x);
      var boxHeight = Math.abs(end.y - start.y);
      ctx.beginPath();
      if (command.type === 'rect') {
        ctx.rect(left, top, boxWidth, boxHeight);
      } else if (command.type === 'ellipse') {
        ctx.ellipse(left + boxWidth / 2, top + boxHeight / 2, boxWidth / 2, boxHeight / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();
      if (command.type === 'arrow') {
        var angle = Math.atan2(end.y - start.y, end.x - start.x);
        var head = Math.max(8, ctx.lineWidth * 3);
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  AnnotationDocument.prototype.render = function (ctx, width, height, includeActive) {
    var commands = this.commands.slice();
    if (includeActive !== false && this.active) commands.push(this.active);
    commands.forEach(function (command) {
      drawCommand(ctx, command, width, height);
    });
  };

  function defaultCreateCanvas() {
    return document.createElement('canvas');
  }

  function defaultLoadImage(dataURL) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('无法读取贴图图像')); };
      image.src = dataURL;
    });
  }

  async function composeAnnotatedDataURL(dataURL, annotationDocument, options) {
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
      throw new Error('缺少可导出的贴图图像');
    }
    if (!annotationDocument || annotationDocument.isEmpty()) return dataURL;
    options = options || {};
    var createCanvas = options.createCanvas || defaultCreateCanvas;
    var loadImage = options.loadImage || defaultLoadImage;
    var image = await loadImage(dataURL);
    var width = Math.round(image.naturalWidth || image.width || 0);
    var height = Math.round(image.naturalHeight || image.height || 0);
    if (!width || !height) throw new Error('贴图图像尺寸无效');

    var base = createCanvas();
    var overlay = createCanvas();
    base.width = overlay.width = width;
    base.height = overlay.height = height;
    var baseContext = base.getContext('2d');
    var overlayContext = overlay.getContext('2d');
    if (!baseContext || !overlayContext) throw new Error('无法创建标注画布');
    baseContext.drawImage(image, 0, 0, width, height);
    annotationDocument.render(overlayContext, width, height, false);
    baseContext.drawImage(overlay, 0, 0, width, height);
    return base.toDataURL('image/png');
  }

  return {
    AnnotationDocument: AnnotationDocument,
    composeAnnotatedDataURL: composeAnnotatedDataURL,
    normalizePinWindowState: normalizePinWindowState,
    mergePinWindowState: mergePinWindowState,
  };
});
