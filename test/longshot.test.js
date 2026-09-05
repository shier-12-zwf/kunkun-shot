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
  createLongshotSession,
  runCaptureStep,
  createDisplacementGate,
  getNextCaptureDelay,
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
  assert.deepEqual(result, { canvas: rotatedCanvas, ctx: rotatedContext, width: 180, height: 320 });
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
    const workflow = { saveConfirmed: false };
    const api = {
      saveImage: async () => {
        calls.push('save');
        return saveResult;
      },
      copyImage: async () => calls.push('copy'),
      closeSelf: async () => calls.push('close'),
    };

    await assert.rejects(
      saveLongshotAndClose(api, 'data:image/png;base64,test', undefined, workflow),
      /保存已取消或失败/
    );
    assert.deepEqual(calls, ['save']);
    assert.equal(workflow.saveConfirmed, false);
  }
});

test('longshot closes only after explicit save and clipboard success responses', async () => {
  const calls = [];
  const api = {
    saveImage: async () => {
      calls.push('save');
      return { saved: true };
    },
    copyImage: async () => {
      calls.push('copy');
      return true;
    },
    closeSelf: async () => calls.push('close'),
  };

  await saveLongshotAndClose(api, 'data:image/png;base64,test');
  assert.deepEqual(calls, ['save', 'copy', 'close']);
});

test('longshot keeps the window open unless clipboard copy explicitly resolves true', async () => {
  const cases = [
    { name: 'false', copyImage: async () => false },
    { name: 'undefined', copyImage: async () => undefined },
    { name: 'rejection', copyImage: async () => { throw new Error('clipboard unavailable'); } },
  ];

  for (const scenario of cases) {
    const calls = [];
    const api = {
      saveImage: async () => {
        calls.push('save');
        return { saved: true };
      },
      copyImage: async () => {
        calls.push('copy');
        return scenario.copyImage();
      },
      closeSelf: async () => calls.push('close'),
    };

    await assert.rejects(
      saveLongshotAndClose(api, 'data:image/png;base64,test'),
      /复制到剪贴板失败/,
      scenario.name
    );
    assert.deepEqual(calls, ['save', 'copy'], scenario.name);
  }
});

test('clipboard retry reuses an explicit successful save checkpoint', async () => {
  const calls = [];
  const workflow = { saveConfirmed: false };
  let copySucceeds = false;
  const api = {
    saveImage: async () => {
      calls.push('save');
      return { saved: true };
    },
    copyImage: async () => {
      calls.push('copy');
      return copySucceeds;
    },
    closeSelf: async () => calls.push('close'),
  };

  await assert.rejects(
    saveLongshotAndClose(api, 'data:image/png;base64,test', undefined, workflow),
    /复制到剪贴板失败/
  );
  assert.equal(workflow.saveConfirmed, true);

  copySucceeds = true;
  await saveLongshotAndClose(api, 'data:image/png;base64,test', undefined, workflow);
  assert.deepEqual(calls, ['save', 'copy', 'copy', 'close']);
});

test('capture direction is locked for the whole session and one opposite sample cannot reverse it', () => {
  const session = createLongshotSession({ directionConfirmations: 2 });
  const token = session.start('vertical');

  assert.equal(session.getState().direction, 'vertical');
  assert.equal(session.observeDirection(token, 'horizontal'), 'vertical');
  assert.equal(session.getState().direction, 'vertical');
});

test('consecutive empty or failed captures terminate after a bounded retry count', () => {
  const session = createLongshotSession({ maxConsecutiveFailures: 3 });
  const token = session.start('vertical');

  session.admitFrame(token, { width: 10, stitchedHeight: 10 });
  assert.deepEqual(session.recordFailure(token, 'empty-frame'), {
    accepted: true,
    terminal: false,
    consecutiveFailures: 1,
  });
  // A decoded-but-visually-empty frame is admitted for dimensions first; admission
  // must not accidentally reset the consecutive empty-frame counter.
  session.admitFrame(token, { width: 10, stitchedHeight: 10 });
  assert.equal(session.recordFailure(token, 'capture-error').terminal, false);

  session.admitFrame(token, { width: 10, stitchedHeight: 10 });
  const terminal = session.recordFailure(token, 'empty-frame');
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.reason, 'capture-failures');
  assert.equal(session.isCurrent(token), false);
  assert.equal(session.getState().terminalReason, 'capture-failures');
});

test('session rejects work that exceeds configurable frame or stitched-pixel budgets', () => {
  const frameLimited = createLongshotSession({ maxFrames: 2, maxPixels: 1_000 });
  const frameToken = frameLimited.start('vertical');
  assert.equal(frameLimited.admitFrame(frameToken, { width: 10, stitchedHeight: 10 }).accepted, true);
  assert.equal(frameLimited.admitFrame(frameToken, { width: 10, stitchedHeight: 20 }).accepted, true);
  const tooMany = frameLimited.admitFrame(frameToken, { width: 10, stitchedHeight: 30 });
  assert.equal(tooMany.accepted, false);
  assert.equal(tooMany.reason, 'frame-limit');

  const pixelLimited = createLongshotSession({ maxFrames: 10, maxPixels: 100 });
  const pixelToken = pixelLimited.start('horizontal');
  const tooLarge = pixelLimited.admitFrame(pixelToken, { width: 11, stitchedHeight: 10 });
  assert.equal(tooLarge.accepted, false);
  assert.equal(tooLarge.reason, 'pixel-limit');
  assert.equal(pixelLimited.getState().terminalReason, 'pixel-limit');
});

test('a capture that resolves after stop is stale and cannot reach the stitch callback', async () => {
  const session = createLongshotSession();
  const token = session.start('vertical');
  let resolveCapture;
  let consumed = 0;

  const pending = runCaptureStep({
    session,
    token,
    capture: () => new Promise((resolve) => { resolveCapture = resolve; }),
    consume: async () => { consumed += 1; },
  });

  session.stop('cancelled');
  resolveCapture({ width: 20, height: 20 });
  const result = await pending;

  assert.equal(result.status, 'stale');
  assert.equal(consumed, 0);
});

test('canceling while save is pending prevents late copy and close side effects', async () => {
  let active = true;
  let resolveSave;
  const calls = [];
  const api = {
    saveImage: () => {
      calls.push('save');
      return new Promise((resolve) => { resolveSave = resolve; });
    },
    copyImage: async () => calls.push('copy'),
    closeSelf: async () => calls.push('close'),
  };

  const pending = saveLongshotAndClose(api, 'data:image/png;base64,test', () => active);
  active = false;
  resolveSave({ saved: true });
  const result = await pending;

  assert.deepEqual(result, { stale: true });
  assert.deepEqual(calls, ['save']);
});

test('displacement requires stable confirmation and an opposite noise frame cannot reverse a locked direction', () => {
  const gate = createDisplacementGate({ confirmations: 2, toleranceRatio: 0.25 });

  assert.equal(gate.observe(100).confirmed, false);
  const confirmed = gate.observe(110);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.direction, 'forward');

  const oppositeNoise = gate.observe(-105);
  assert.equal(oppositeNoise.confirmed, false);
  assert.equal(oppositeNoise.reason, 'opposite-direction');
  assert.equal(gate.getState().direction, 'forward');
});

test('capture cadence adapts to movement, idle frames, and repeated failures', () => {
  const movingDelay = getNextCaptureDelay('movement', 0);
  const idleDelay = getNextCaptureDelay('idle', 4);
  const firstFailureDelay = getNextCaptureDelay('failure', 1);
  const repeatedFailureDelay = getNextCaptureDelay('failure', 4);

  assert.ok(movingDelay < idleDelay);
  assert.ok(firstFailureDelay < repeatedFailureDelay);
  assert.ok(repeatedFailureDelay <= 2000);
});
