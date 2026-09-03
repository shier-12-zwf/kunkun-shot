'use strict';

(function exposeRecorderOverlays(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KKRecorderOverlays = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRecorderOverlays() {
  const MOUSE_TYPES = new Set(['mouse-down', 'mouse-up', 'mouse-dragged']);

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function normalizeModifiers(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      alt: input.alt === true,
      control: input.control === true,
      meta: input.meta === true,
      shift: input.shift === true,
    };
  }

  function normalizeGeometry(value) {
    const input = value && typeof value === 'object' ? value : {};
    const rect = input.rect && typeof input.rect === 'object' ? input.rect : {};
    const bounds = input.displayBounds && typeof input.displayBounds === 'object'
      ? input.displayBounds
      : {};
    const width = finiteNumber(rect.width);
    const height = finiteNumber(rect.height);
    const pixelWidth = finiteNumber(input.pixelWidth);
    const pixelHeight = finiteNumber(input.pixelHeight);
    const nominalScale = finiteNumber(input.scaleFactor);
    if (!(width > 0) || !(height > 0)) return null;
    const scaleX = pixelWidth > 0
      ? pixelWidth / width
      : nominalScale;
    const scaleY = pixelHeight > 0
      ? pixelHeight / height
      : nominalScale;
    if (!(scaleX > 0) || !(scaleY > 0)) return null;
    return {
      left: (finiteNumber(bounds.x) || 0) + (finiteNumber(rect.x) || 0),
      top: (finiteNumber(bounds.y) || 0) + (finiteNumber(rect.y) || 0),
      width: pixelWidth > 0 ? pixelWidth : width * scaleX,
      height: pixelHeight > 0 ? pixelHeight : height * scaleY,
      scaleX,
      scaleY,
    };
  }

  // Electron exposes selection/display geometry in logical (CSS) points, while a
  // desktop MediaStream reports the pixels it actually delivers. The delivered
  // stream can be downscaled and its X/Y ratios can differ from display.scaleFactor,
  // so crop both shared edges against videoWidth/videoHeight exactly once.
  function resolveRecorderCaptureGeometry(value, sourceSize) {
    const input = value && typeof value === 'object' ? value : {};
    const rectInput = input.rect && typeof input.rect === 'object' ? input.rect : {};
    const boundsInput = input.displayBounds && typeof input.displayBounds === 'object'
      ? input.displayBounds
      : {};
    const sourceInput = sourceSize && typeof sourceSize === 'object' ? sourceSize : {};
    const rectX = finiteNumber(rectInput.x) || 0;
    const rectY = finiteNumber(rectInput.y) || 0;
    const rectWidth = finiteNumber(rectInput.width);
    const rectHeight = finiteNumber(rectInput.height);
    const boundsWidth = finiteNumber(boundsInput.width);
    const boundsHeight = finiteNumber(boundsInput.height);
    const sourceWidth = finiteNumber(sourceInput.width);
    const sourceHeight = finiteNumber(sourceInput.height);
    if (
      !(rectWidth > 0)
      || !(rectHeight > 0)
      || !(boundsWidth > 0)
      || !(boundsHeight > 0)
      || !(sourceWidth > 0)
      || !(sourceHeight > 0)
    ) return null;

    const cssLeft = clamp(rectX, 0, boundsWidth);
    const cssTop = clamp(rectY, 0, boundsHeight);
    const cssRight = clamp(rectX + rectWidth, 0, boundsWidth);
    const cssBottom = clamp(rectY + rectHeight, 0, boundsHeight);
    if (!(cssRight > cssLeft) || !(cssBottom > cssTop)) return null;

    const sourceX = clamp(Math.round(cssLeft * sourceWidth / boundsWidth), 0, Math.round(sourceWidth));
    const sourceY = clamp(Math.round(cssTop * sourceHeight / boundsHeight), 0, Math.round(sourceHeight));
    const sourceRight = clamp(
      Math.round(cssRight * sourceWidth / boundsWidth),
      sourceX,
      Math.round(sourceWidth),
    );
    const sourceBottom = clamp(
      Math.round(cssBottom * sourceHeight / boundsHeight),
      sourceY,
      Math.round(sourceHeight),
    );
    const outputWidth = sourceRight - sourceX;
    const outputHeight = sourceBottom - sourceY;
    if (!(outputWidth > 0) || !(outputHeight > 0)) return null;

    const rect = {
      x: cssLeft,
      y: cssTop,
      width: cssRight - cssLeft,
      height: cssBottom - cssTop,
    };
    const displayBounds = {
      x: finiteNumber(boundsInput.x) || 0,
      y: finiteNumber(boundsInput.y) || 0,
      width: boundsWidth,
      height: boundsHeight,
    };
    return {
      sourceX,
      sourceY,
      sourceWidth: outputWidth,
      sourceHeight: outputHeight,
      outputWidth,
      outputHeight,
      actionGeometry: {
        rect,
        displayBounds,
        pixelWidth: outputWidth,
        pixelHeight: outputHeight,
      },
    };
  }

  function normalizeKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    if (!key || key.length > 16 || /[\u0000-\u001f\u007f]/.test(key)) return null;
    return key;
  }

  function normalizeRecorderActionEvent(raw, geometry, now) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const at = finiteNumber(now);
    const type = typeof raw.type === 'string' ? raw.type : '';
    const modifiers = normalizeModifiers(raw.modifiers);
    if (type === 'key') {
      const key = normalizeKey(raw.key);
      if (!key) return null;
      return { type, key, at: at === null ? Date.now() : at, modifiers };
    }
    if (!MOUSE_TYPES.has(type)) return null;
    const normalizedGeometry = normalizeGeometry(geometry);
    const globalX = finiteNumber(raw.x);
    const globalY = finiteNumber(raw.y);
    if (!normalizedGeometry || globalX === null || globalY === null) return null;
    const x = (globalX - normalizedGeometry.left) * normalizedGeometry.scaleX;
    const y = (globalY - normalizedGeometry.top) * normalizedGeometry.scaleY;
    const inside = x >= 0 && y >= 0
      && x <= normalizedGeometry.width && y <= normalizedGeometry.height;
    // An up event just outside the selection must still be able to terminate an active stroke.
    if (!inside && type !== 'mouse-up') return null;
    return {
      type,
      button: raw.button === 'right' ? 'right' : 'left',
      x: Math.max(0, Math.min(normalizedGeometry.width, x)),
      y: Math.max(0, Math.min(normalizedGeometry.height, y)),
      at: at === null ? Date.now() : at,
      modifiers,
    };
  }

  function safeCall(context, method, ...args) {
    if (context && typeof context[method] === 'function') context[method](...args);
  }

  function roundedRect(context, x, y, width, height, radius) {
    if (context && typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, radius);
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    safeCall(context, 'moveTo', x + r, y);
    safeCall(context, 'lineTo', x + width - r, y);
    safeCall(context, 'quadraticCurveTo', x + width, y, x + width, y + r);
    safeCall(context, 'lineTo', x + width, y + height - r);
    safeCall(context, 'quadraticCurveTo', x + width, y + height, x + width - r, y + height);
    safeCall(context, 'lineTo', x + r, y + height);
    safeCall(context, 'quadraticCurveTo', x, y + height, x, y + height - r);
    safeCall(context, 'lineTo', x, y + r);
    safeCall(context, 'quadraticCurveTo', x, y, x + r, y);
  }

  function modifierPrefix(modifiers) {
    const labels = [];
    if (modifiers.control) labels.push('⌃');
    if (modifiers.alt) labels.push('⌥');
    if (modifiers.shift) labels.push('⇧');
    if (modifiers.meta) labels.push('⌘');
    return labels.join('');
  }

  function createRecorderOverlayState(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const maxActions = Math.max(1, Math.min(256, Number(opts.maxActions) || 64));
    const maxStrokes = Math.max(1, Math.min(128, Number(opts.maxStrokes) || 32));
    const maxPointsPerStroke = Math.max(2, Math.min(4096, Number(opts.maxPointsPerStroke) || 1024));
    const actionLifetimeMs = Math.max(250, Math.min(10000, Number(opts.actionLifetimeMs) || 1400));
    let actions = [];
    let strokes = [];
    let activeStroke = null;
    let penEnabled = false;

    function appendAction(event) {
      actions.push(event);
      if (actions.length > maxActions) actions = actions.slice(-maxActions);
    }

    function appendPoint(stroke, event) {
      if (!stroke || stroke.length >= maxPointsPerStroke) return;
      const previous = stroke[stroke.length - 1];
      if (previous && Math.abs(previous.x - event.x) < 0.5 && Math.abs(previous.y - event.y) < 0.5) return;
      stroke.push({ x: event.x, y: event.y });
    }

    function accept(raw, geometry, now) {
      const event = normalizeRecorderActionEvent(raw, geometry, now);
      if (!event) return false;
      if (event.type === 'key' || event.type === 'mouse-down') appendAction(event);

      if (penEnabled && event.button === 'left') {
        if (event.type === 'mouse-down') {
          activeStroke = [];
          appendPoint(activeStroke, event);
          strokes.push(activeStroke);
          if (strokes.length > maxStrokes) strokes = strokes.slice(-maxStrokes);
        } else if (event.type === 'mouse-dragged' && activeStroke) {
          appendPoint(activeStroke, event);
        } else if (event.type === 'mouse-up' && activeStroke) {
          appendPoint(activeStroke, event);
          activeStroke = null;
        }
      } else if (event.type === 'mouse-up') {
        activeStroke = null;
      }
      return true;
    }

    function setPenEnabled(value) {
      penEnabled = value === true;
      if (!penEnabled) activeStroke = null;
      return penEnabled;
    }

    function clearStrokes() {
      strokes = [];
      activeStroke = null;
    }

    function renderStrokes(context, width) {
      if (!strokes.length) return;
      safeCall(context, 'save');
      context.strokeStyle = '#ff3b30';
      context.lineWidth = Math.max(3, Math.min(12, width / 240));
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const stroke of strokes) {
        if (!stroke.length) continue;
        safeCall(context, 'beginPath');
        safeCall(context, 'moveTo', stroke[0].x, stroke[0].y);
        if (stroke.length === 1) {
          safeCall(context, 'lineTo', stroke[0].x + 0.1, stroke[0].y + 0.1);
        } else {
          for (let index = 1; index < stroke.length; index += 1) {
            safeCall(context, 'lineTo', stroke[index].x, stroke[index].y);
          }
        }
        safeCall(context, 'stroke');
      }
      safeCall(context, 'restore');
    }

    function renderActions(context, width, height, now) {
      const current = finiteNumber(now);
      const timestamp = current === null ? Date.now() : current;
      actions = actions.filter((event) => timestamp - event.at <= actionLifetimeMs);
      for (const event of actions) {
        const age = Math.max(0, timestamp - event.at);
        const opacity = Math.max(0, 1 - age / actionLifetimeMs);
        safeCall(context, 'save');
        context.globalAlpha = opacity;
        if (event.type === 'mouse-down') {
          const radius = 12 + (age / actionLifetimeMs) * 24;
          context.strokeStyle = event.button === 'right' ? '#ff9500' : '#ff3b30';
          context.lineWidth = Math.max(2, width / 400);
          safeCall(context, 'beginPath');
          safeCall(context, 'arc', event.x, event.y, radius, 0, Math.PI * 2);
          safeCall(context, 'stroke');
        } else if (event.type === 'key') {
          const label = `${modifierPrefix(event.modifiers)}${event.key}`;
          const fontSize = Math.max(15, Math.min(30, width / 35));
          const boxWidth = Math.min(width - 24, Math.max(64, label.length * fontSize * 0.72 + 32));
          const boxHeight = fontSize + 22;
          const x = (width - boxWidth) / 2;
          const y = Math.max(12, height - boxHeight - 24);
          context.fillStyle = 'rgba(20,20,24,0.82)';
          safeCall(context, 'beginPath');
          roundedRect(context, x, y, boxWidth, boxHeight, 12);
          safeCall(context, 'fill');
          context.fillStyle = '#ffffff';
          context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          safeCall(context, 'fillText', label, width / 2, y + boxHeight / 2);
        }
        safeCall(context, 'restore');
      }
    }

    function render(context, width, height, now) {
      if (!context || !(width > 0) || !(height > 0)) return;
      renderStrokes(context, width);
      renderActions(context, width, height, now);
    }

    function snapshot() {
      return {
        penEnabled,
        actions: actions.map((event) => ({ ...event, modifiers: { ...event.modifiers } })),
        strokes: strokes.map((stroke) => stroke.map((point) => ({ ...point }))),
      };
    }

    return { accept, clearStrokes, render, setPenEnabled, snapshot };
  }

  return {
    createRecorderOverlayState,
    normalizeRecorderActionEvent,
    resolveRecorderCaptureGeometry,
  };
});
