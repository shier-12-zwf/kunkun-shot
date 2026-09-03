const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCrop,
  transformImageData,
} = require('../src/renderer/pin/pin-image-transform');

function rgbaGrid(width, height, reds) {
  const data = new Uint8ClampedArray(width * height * 4);
  reds.forEach((red, index) => {
    data[index * 4] = red;
    data[index * 4 + 1] = red + 1;
    data[index * 4 + 2] = red + 2;
    data[index * 4 + 3] = 255;
  });
  return { width, height, data };
}

function redGrid(result) {
  const values = [];
  for (let index = 0; index < result.data.length; index += 4) values.push(result.data[index]);
  return values;
}

test('crop keeps the exact selected pixels and rejects empty or out-of-range rectangles', () => {
  const source = rgbaGrid(3, 2, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normalizeCrop({ x: 1, y: 0, width: 2, height: 2 }, 3, 2), {
    x: 1, y: 0, width: 2, height: 2,
  });
  const cropped = transformImageData(source, {
    type: 'crop',
    crop: { x: 1, y: 0, width: 2, height: 2 },
  });
  assert.deepEqual({ width: cropped.width, height: cropped.height }, { width: 2, height: 2 });
  assert.deepEqual(redGrid(cropped), [2, 3, 5, 6]);
  assert.throws(() => normalizeCrop({ x: 0, y: 0, width: 0, height: 1 }, 3, 2), /裁剪/);
  assert.throws(() => normalizeCrop({ x: 2, y: 0, width: 2, height: 1 }, 3, 2), /范围/);
});

test('90-degree rotation maps every source pixel exactly', () => {
  const source = rgbaGrid(3, 2, [1, 2, 3, 4, 5, 6]);
  const clockwise = transformImageData(source, { type: 'rotate-cw' });
  assert.deepEqual({ width: clockwise.width, height: clockwise.height }, { width: 2, height: 3 });
  assert.deepEqual(redGrid(clockwise), [4, 1, 5, 2, 6, 3]);

  const counterClockwise = transformImageData(source, { type: 'rotate-ccw' });
  assert.deepEqual({ width: counterClockwise.width, height: counterClockwise.height }, { width: 2, height: 3 });
  assert.deepEqual(redGrid(counterClockwise), [3, 6, 2, 5, 1, 4]);
});

test('horizontal and vertical flips preserve dimensions and pixel channels', () => {
  const source = rgbaGrid(3, 2, [1, 2, 3, 4, 5, 6]);
  const horizontal = transformImageData(source, { type: 'flip-horizontal' });
  const vertical = transformImageData(source, { type: 'flip-vertical' });
  assert.deepEqual(redGrid(horizontal), [3, 2, 1, 6, 5, 4]);
  assert.deepEqual(redGrid(vertical), [4, 5, 6, 1, 2, 3]);
  assert.deepEqual(Array.from(horizontal.data.slice(0, 4)), [3, 4, 5, 255]);
});

test('transform input is fail-closed for malformed pixel buffers and unknown operations', () => {
  assert.throws(() => transformImageData({ width: 2, height: 2, data: new Uint8ClampedArray(4) }, {
    type: 'flip-horizontal',
  }), /像素/);
  assert.throws(() => transformImageData(rgbaGrid(1, 1, [1]), { type: 'spin' }), /变换/);
});
