const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadFrameForDirection,
  overlapResult,
  shouldPauseForUnmatchedContent,
  MAX_CANVAS_PIXELS,
  getMaxCanvasHeight,
  isFrameWithinCanvasBudget,
  saveLongshotAndClose,
} = require('../src/renderer/longshot/longshot');

test('horizontal longshot waits for frame decoding before rotating it', async () => {
  const sourceCanvas = { id: 'decoded-frame' };
  const decodedFrame = { canvas: sourceCanvas, width: 320, height: 180 };
  let resolveFrame;
  let canvasCreated = false;
  const calls = [];
  const rotatedContext = {
    translate: (...args) => calls.push(['translate', ...args]),
    rotate: (...args) => calls.push(['rotate', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
  };
  const rotatedCanvas = {
    width: 0,
    height: 0,
    getContext: () => rotatedContext,
  };

  const resultPromise = loadFrameForDirection(
    () => new Promise((resolve) => { resolveFrame = resolve; }),
    'data:image/png;base64,test',
    true,
    () => {
      canvasCreated = true;
      return rotatedCanvas;
    }
  );

  assert.equal(canvasCreated, false, 'rotation must not start while the decoder promise is pending');
  resolveFrame(decodedFrame);
  const result = await resultPromise;

  assert.equal(canvasCreated, true);
  assert.deepEqual(result, { canvas: rotatedCanvas, width: 180, height: 320 });
  assert.equal(rotatedCanvas.width, 180);
  assert.equal(rotatedCanvas.height, 320);
  assert.deepEqual(calls, [
    ['translate', 90, 160],
    ['rotate', Math.PI / 2],
    ['drawImage', sourceCanvas, -160, -90],
  ]);
});

test('unmatched content is marked so the stitcher pauses instead of appending a whole frame', () => {
  const unmatchedContent = overlapResult(0, true);
  const blankFrame = overlapResult(0, false);
  const matchedContent = overlapResult(96, true);

  assert.deepEqual(unmatchedContent, { overlap: 0, hadContent: true });
  assert.equal(shouldPauseForUnmatchedContent(unmatchedContent), true);
  assert.equal(shouldPauseForUnmatchedContent(blankFrame), false);
  assert.equal(shouldPauseForUnmatchedContent(matchedContent), false);
});

test('longshot canvas height is bounded by total pixels instead of height alone', () => {
  const hdLimit = getMaxCanvasHeight(1920);
  const fourKLimit = getMaxCanvasHeight(3840);

  assert.ok(hdLimit < 120000);
  assert.ok(fourKLimit < hdLimit);
  assert.ok(1920 * hdLimit <= MAX_CANVAS_PIXELS);
  assert.ok(3840 * fourKLimit <= MAX_CANVAS_PIXELS);
  assert.equal(isFrameWithinCanvasBudget(3840, 2160), true);
  assert.equal(isFrameWithinCanvasBudget(7680, 4320), false);
});

test('canceled or failed longshot saves keep the image retryable and never copy or close', async () => {
  for (const saveResult of [{ saved: false }, null, undefined]) {
    const calls = [];
    const api = {
      saveImage: async () => {
        calls.push('save');
        return saveResult;
      },
      copyImage: async () => calls.push('copy'),
      closeSelf: async () => calls.push('close'),
    };

    await assert.rejects(
      saveLongshotAndClose(api, 'data:image/png;base64,test'),
      /保存已取消或失败/
    );
    assert.deepEqual(calls, ['save']);
  }
});

test('longshot copies and closes only after an explicit saved:true response', async () => {
  const calls = [];
  const api = {
    saveImage: async () => {
      calls.push('save');
      return { saved: true };
    },
    copyImage: async () => calls.push('copy'),
    closeSelf: async () => calls.push('close'),
  };

  await saveLongshotAndClose(api, 'data:image/png;base64,test');
  assert.deepEqual(calls, ['save', 'copy', 'close']);
});
