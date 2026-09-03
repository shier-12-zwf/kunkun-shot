(function (root, factory) {
  'use strict';
  var exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.PinImageTransform = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_PIXELS = 100 * 1024 * 1024;
  var OPERATIONS = new Set([
    'crop',
    'rotate-cw',
    'rotate-ccw',
    'flip-horizontal',
    'flip-vertical',
  ]);

  function requireDimension(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 32768) {
      throw new Error(label + '无效。');
    }
    return value;
  }

  function normalizeCrop(value, imageWidth, imageHeight) {
    var widthLimit = requireDimension(imageWidth, '图片宽度');
    var heightLimit = requireDimension(imageHeight, '图片高度');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('裁剪区域无效。');
    }
    var keys = Object.keys(value).sort();
    var expected = ['height', 'width', 'x', 'y'];
    if (keys.length !== expected.length || keys.some(function (key, index) { return key !== expected[index]; })) {
      throw new Error('裁剪区域字段无效。');
    }
    var x = value.x;
    var y = value.y;
    var width = value.width;
    var height = value.height;
    if (
      !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      x < 0 || y < 0 || width < 1 || height < 1
    ) {
      throw new Error('裁剪区域无效。');
    }
    if (x + width > widthLimit || y + height > heightLimit) {
      throw new Error('裁剪区域超出图片范围。');
    }
    return { x: x, y: y, width: width, height: height };
  }

  function normalizeSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('图片像素数据无效。');
    }
    var width = requireDimension(value.width, '图片宽度');
    var height = requireDimension(value.height, '图片高度');
    if (width * height > MAX_PIXELS) throw new Error('图片像素数量过大。');
    var data = value.data;
    if (!data || typeof data.length !== 'number' || data.length !== width * height * 4) {
      throw new Error('图片像素缓冲区无效。');
    }
    return { width: width, height: height, data: data };
  }

  function copyPixel(source, sourceWidth, sx, sy, target, targetWidth, tx, ty) {
    var sourceOffset = (sy * sourceWidth + sx) * 4;
    var targetOffset = (ty * targetWidth + tx) * 4;
    target[targetOffset] = source[sourceOffset];
    target[targetOffset + 1] = source[sourceOffset + 1];
    target[targetOffset + 2] = source[sourceOffset + 2];
    target[targetOffset + 3] = source[sourceOffset + 3];
  }

  function transformImageData(rawSource, rawOperation) {
    var source = normalizeSource(rawSource);
    var operation = rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation)
      ? rawOperation
      : {};
    var type = operation.type;
    if (!OPERATIONS.has(type)) throw new Error('图片变换类型无效。');

    var crop = null;
    var targetWidth = source.width;
    var targetHeight = source.height;
    if (type === 'crop') {
      crop = normalizeCrop(operation.crop, source.width, source.height);
      targetWidth = crop.width;
      targetHeight = crop.height;
    } else if (type === 'rotate-cw' || type === 'rotate-ccw') {
      targetWidth = source.height;
      targetHeight = source.width;
    }

    var target = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    for (var sy = 0; sy < source.height; sy += 1) {
      for (var sx = 0; sx < source.width; sx += 1) {
        var tx = sx;
        var ty = sy;
        if (type === 'crop') {
          if (sx < crop.x || sy < crop.y || sx >= crop.x + crop.width || sy >= crop.y + crop.height) continue;
          tx = sx - crop.x;
          ty = sy - crop.y;
        } else if (type === 'rotate-cw') {
          tx = source.height - 1 - sy;
          ty = sx;
        } else if (type === 'rotate-ccw') {
          tx = sy;
          ty = source.width - 1 - sx;
        } else if (type === 'flip-horizontal') {
          tx = source.width - 1 - sx;
        } else if (type === 'flip-vertical') {
          ty = source.height - 1 - sy;
        }
        copyPixel(source.data, source.width, sx, sy, target, targetWidth, tx, ty);
      }
    }
    return { width: targetWidth, height: targetHeight, data: target };
  }

  return {
    normalizeCrop: normalizeCrop,
    transformImageData: transformImageData,
  };
});
