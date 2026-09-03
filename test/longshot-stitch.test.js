const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasVisualContent,
  matchAdjacentFrames,
  detectFrameMotion,
  suggestFixedBands,
  createStitchTimeline,
} = require('../src/renderer/longshot/longshot-stitch');

function rowFrame(id, rows, options) {
  const opts = options || {};
  const width = opts.width || 4;
  const pixels = new Uint8ClampedArray(width * rows.length * 4);
  for (let y = 0; y < rows.length; y += 1) {
    const color = Array.isArray(rows[y]) ? rows[y] : [20, rows[y], (rows[y] * 3) % 256, 255];
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color.length > 3 ? color[3] : 255;
    }
  }
  return {
    id,
    width,
    height: rows.length,
    scaleFactor: opts.scaleFactor == null ? 2 : opts.scaleFactor,
    pixels,
  };
}

function globalRows(start, count) {
  return Array.from({ length: count }, (_, index) => (start + index) * 17);
}

function composedGreenRows(composed) {
  const rows = [];
  for (let y = 0; y < composed.height; y += 1) rows.push(composed.pixels[y * composed.width * 4 + 1]);
  return rows;
}

function timelineOptions(extra) {
  return {
    minOverlap: 2,
    matchThreshold: 0.99,
    ambiguityMargin: 0.01,
    tolerance: 1,
    idleThreshold: 1,
    maxPixels: 10_000,
    maxSourcePixels: 10_000,
    ...(extra || {}),
  };
}

test('RGB content detection does not misclassify a frame whose red plane is constant', () => {
  const frame = rowFrame('rgb', globalRows(0, 6));
  assert.equal(new Set(Array.from(frame.pixels).filter((_, index) => index % 4 === 0)).size, 1);
  assert.equal(hasVisualContent(frame, {}, { contentRange: 10 }), true);

  const next = rowFrame('next', globalRows(3, 6));
  const match = matchAdjacentFrames(frame, next, timelineOptions());
  assert.equal(match.ok, true);
  assert.equal(match.overlap, 3);
  assert.equal(match.novelHeight, 3);
});

test('the matcher exposes confidence and rejects repeated-pattern overlap ambiguity', () => {
  const first = rowFrame('first', [10, 60, 10, 60, 10, 60]);
  const second = rowFrame('second', [10, 60, 10, 60, 120, 180]);
  const match = matchAdjacentFrames(first, second, timelineOptions({ ambiguityMargin: 0.02 }));

  assert.equal(match.ok, false);
  assert.equal(match.reason, 'ambiguous-match');
  assert.equal(match.bestOverlap, 4);
  assert.equal(match.competingOverlap, 2);
  assert.equal(match.confidence, 0);
});

test('tolerance does not let a one-row near match silently win over the exact overlap', () => {
  const smoothRows = (start, count) => Array.from({ length: count }, (_, index) => {
    const row = start + index;
    return [20, 20 + row * 10, 35 + row * 7, 255];
  });
  const first = rowFrame('first', smoothRows(0, 12));
  const second = rowFrame('second', smoothRows(4, 12));
  const match = matchAdjacentFrames(first, second, timelineOptions({
    minOverlap: 8,
    tolerance: 18,
    ambiguityMargin: 0.025,
  }));

  assert.equal(match.ok, true);
  assert.equal(match.overlap, 8);
  assert.equal(match.novelHeight, 4);
  assert.equal(match.meanError, 0);
});

test('real prepend geometry produces a negative displacement and locks out later reversal', () => {
  const initial = rowFrame('initial', globalRows(4, 6));
  const earlier = rowFrame('earlier', globalRows(2, 6));
  const later = rowFrame('later', globalRows(6, 6));
  const detected = detectFrameMotion([initial], earlier, timelineOptions());

  assert.equal(detected.ok, true);
  assert.equal(detected.direction, 'prepend');
  assert.equal(detected.displacement, -2);

  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(initial).ok, true);
  assert.equal(timeline.addFrame(earlier).direction, 'prepend');
  const reversal = timeline.addFrame(later);
  assert.equal(reversal.ok, false);
  assert.equal(reversal.reason, 'reverse-direction');
  assert.equal(reversal.detectedDirection, 'append');
});

test('width and DPR changes fail explicitly without mutating retained raw frames', () => {
  const timeline = createStitchTimeline(timelineOptions());
  const initial = rowFrame('initial', globalRows(0, 6));
  assert.equal(timeline.addFrame(initial).ok, true);

  const wrongWidth = timeline.addFrame(rowFrame('wide', globalRows(3, 6), { width: 5 }));
  assert.deepEqual(
    { ok: wrongWidth.ok, reason: wrongWidth.reason, expected: wrongWidth.expected, actual: wrongWidth.actual },
    { ok: false, reason: 'width-mismatch', expected: 4, actual: 5 }
  );
  const wrongScale = timeline.addFrame(rowFrame('dpr', globalRows(3, 6), { scaleFactor: 1 }));
  assert.deepEqual(
    { ok: wrongScale.ok, reason: wrongScale.reason, expected: wrongScale.expected, actual: wrongScale.actual },
    { ok: false, reason: 'scale-mismatch', expected: 2, actual: 1 }
  );
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['initial']);
});

test('raw-frame timeline deletes first, middle, or last and transactionally restitches pixels', () => {
  const timeline = createStitchTimeline(timelineOptions());
  const frames = [
    rowFrame('a', globalRows(0, 6)),
    rowFrame('b', globalRows(2, 6)),
    rowFrame('c', globalRows(4, 6)),
    rowFrame('d', globalRows(6, 6)),
  ];
  for (const frame of frames) assert.equal(timeline.addFrame(frame).ok, true);
  assert.equal(timeline.getRawFrames().length, 4);

  assert.equal(timeline.deleteFrame('b').ok, true);
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['a', 'c', 'd']);
  assert.deepEqual(composedGreenRows(timeline.compose()), globalRows(0, 12));

  assert.equal(timeline.undo().ok, true);
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['a', 'b', 'c', 'd']);
  assert.equal(timeline.redo().ok, true);
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['a', 'c', 'd']);
  assert.equal(timeline.undo().ok, true);

  assert.equal(timeline.deleteFrame('a').ok, true);
  assert.deepEqual(composedGreenRows(timeline.compose()), globalRows(2, 10));
  assert.equal(timeline.undo().ok, true);

  assert.equal(timeline.deleteFrame('d').ok, true);
  assert.deepEqual(composedGreenRows(timeline.compose()), globalRows(0, 10));
});

test('a rejected frame preserves the last good result and a later frame can continue', () => {
  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(rowFrame('a', globalRows(0, 6))).ok, true);
  const before = composedGreenRows(timeline.compose());

  const bad = timeline.addFrame(rowFrame('bad', globalRows(30, 6)));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /no-match|ambiguous/);
  assert.deepEqual(composedGreenRows(timeline.compose()), before);

  const recovered = timeline.addFrame(rowFrame('b', globalRows(3, 6)));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'accepted');
  assert.deepEqual(composedGreenRows(timeline.compose()), globalRows(0, 9));
});

test('fixed header/footer suggestions can be applied manually and appear only once', () => {
  const header = [7, 190, 40, 255];
  const footer = [9, 230, 80, 255];
  const first = rowFrame('first', [header, 20, 40, 60, 80, footer]);
  const second = rowFrame('second', [header, 60, 80, 100, 120, footer]);
  const suggestion = suggestFixedBands(first, second, {
    ...timelineOptions(),
    minBand: 1,
    maxBandRatio: 0.4,
  });
  assert.deepEqual({ top: suggestion.top, bottom: suggestion.bottom }, { top: 1, bottom: 1 });

  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(first).ok, true);
  assert.equal(timeline.setFixedBands({ top: 1, bottom: 1 }).ok, true);
  assert.equal(timeline.addFrame(second).ok, true);
  const composed = timeline.compose();
  assert.equal(composed.ok, true);
  assert.deepEqual(composedGreenRows(composed), [190, 20, 40, 60, 80, 100, 120, 230]);
  assert.deepEqual(composed.segments.map((segment) => segment.role), [
    'fixed-top',
    'content',
    'content',
    'fixed-bottom',
  ]);
});

test('a fixed toolbar that blocks the second match pauses with actionable band values', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const second = rowFrame('second', [...header, 60, 80, 100, 120, 140, 160, ...footer]);
  const timeline = createStitchTimeline(timelineOptions());

  assert.equal(timeline.addFrame(first).ok, true);
  const blocked = timeline.addFrame(second);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'fixed-bands-suggested');
  assert.deepEqual(
    { top: blocked.suggestion.top, bottom: blocked.suggestion.bottom },
    { top: 2, bottom: 2 }
  );
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['first']);

  assert.equal(timeline.setFixedBands(blocked.suggestion).ok, true);
  assert.equal(timeline.addFrame(second).ok, true);
  assert.deepEqual(composedGreenRows(timeline.compose()), [
    180, 181, 20, 40, 60, 80, 100, 120, 140, 160, 220, 221,
  ]);
});
