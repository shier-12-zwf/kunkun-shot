const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

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

test('a short blank margin cannot compete with an overlap containing real document content', () => {
  const first = rowFrame('first', [10, 20, 30, 40, 200, 200, 70, 80, 200, 200]);
  const second = rowFrame('second', [200, 200, 70, 80, 200, 200, 130, 140, 150, 160]);
  const match = matchAdjacentFrames(first, second, timelineOptions());
  assert.equal(match.ok, true);
  assert.equal(match.overlap, 6);
  assert.equal(match.novelHeight, 4);
});

test('thin text rows between broad whitespace are verified instead of lost between grid samples', () => {
  const rows = Array.from({ length: 240 }, (_, index) => {
    const line = Math.floor(index / 37);
    return index % 37 === 20 || index % 37 === 21 ? 10 + line * 29 : 240;
  });
  const first = rowFrame('first', rows.slice(0, 140));
  const second = rowFrame('second', rows.slice(30, 170));
  const match = matchAdjacentFrames(first, second);
  assert.equal(match.ok, true);
  assert.equal(match.overlap, 110);
  assert.equal(match.novelHeight, 30);
});

test('an unchanged repeated-pattern viewport is idle, not an ambiguous fixed toolbar', () => {
  const rows = Array.from({ length: 758 }, (_, index) => index % 2 ? 60 : 10);
  const first = rowFrame('first', rows);
  const second = rowFrame('second', rows);
  const timeline = createStitchTimeline(timelineOptions());

  assert.equal(timeline.addFrame(first).ok, true);
  const unchanged = timeline.addFrame(second);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.status, 'idle');
  assert.equal(timeline.getState().frames.length, 1);
  assert.deepEqual(timeline.getState().fixedBands, { top: 0, bottom: 0 });
});

test('stationary edges around a changing animation do not prove fixed header/footer bands', () => {
  const rows = Array.from({ length: 758 }, (_, index) => index % 2 ? 60 : 10);
  const changedRows = rows.map((value, index) => index >= 250 && index < 508 ? 180 : value);
  const first = rowFrame('first', rows);
  const second = rowFrame('animation', changedRows);
  const suggestion = suggestFixedBands(first, second, timelineOptions());

  assert.deepEqual({ top: suggestion.top, bottom: suggestion.bottom }, { top: 0, bottom: 0 });
  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(first).ok, true);
  const rejected = timeline.addFrame(second);
  assert.notEqual(rejected.reason, 'fixed-bands-suggested');
  assert.deepEqual(timeline.getState().fixedBands, { top: 0, bottom: 0 });
  assert.equal(timeline.getState().frames.length, 1);
});

test('an unchanged viewport never suggests arbitrary 30-percent fixed bands', () => {
  const first = rowFrame('first', globalRows(0, 12));
  const second = rowFrame('second', globalRows(0, 12));
  const suggestion = suggestFixedBands(first, second, timelineOptions());

  assert.deepEqual({ top: suggestion.top, bottom: suggestion.bottom }, { top: 0, bottom: 0 });
  assert.equal(suggestion.confidence, 0);
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

test('a settled one- or two-pixel scroll tail is retained after an intermediate fixed-header frame', () => {
  let seed = 0x13579;
  const body = Array.from({ length: 1000 }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255];
  });
  const header = Array.from({ length: 64 }, () => [210, 210, 210, 255]);
  for (const positions of [[0, 120, 238, 240], [0, 120, 239, 240], [0, 1, 2, 3]]) {
    const timeline = createStitchTimeline();
    for (const top of positions) {
      const frame = rowFrame('at-' + top, [...header, ...body.slice(top, top + 586)]);
      const added = timeline.addFrame(frame);
      assert.equal(added.ok, true, `scroll ${top}: ${JSON.stringify(added)}`);
      assert.equal(added.status, top === 0 ? 'initial' : 'accepted', `the actual ${top}-pixel source position must not be treated as idle`);
      assert.equal(timeline.getState().height, 650 + top);
    }
    const top = positions[positions.length - 1];
    const expected = rowFrame('expected', [...header, ...body.slice(0, 586 + top)]);
    const composed = timeline.compose();
    assert.equal(composed.height, expected.height);
    assert.deepEqual(composed.pixels, expected.pixels, 'an intermediate capture must not lose the final source rows');
    assert.equal(timeline.addFrame(rowFrame('unchanged', [...header, ...body.slice(top, top + 586)])).status, 'idle');
  }
});

test('a pale fixed header at the color-tolerance boundary is not matching foreground evidence', () => {
  const fixture = require('./fixtures/longshot-fractional-scroll.json');
  const frames = [fixture.initialFrame, fixture.frames[0]].map((frame) => {
    const pixels = new Uint8ClampedArray(zlib.inflateSync(Buffer.from(frame.rgbaDeflateBase64, 'base64')));
    // NativeImage -> sRGB canvas shifts this pale header's R channel by one.
    // A distance of 18 cannot count as both foreground and a matching background.
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 238 && pixels[offset + 1] === 241 && pixels[offset + 2] === 246) pixels[offset] = 237;
    }
    return { id: 'header-' + frame.captureLabel, width: fixture.width, height: fixture.height, scaleFactor: 1, pixels };
  });
  assert.equal(matchAdjacentFrames(frames[0], frames[1], { ignoreRightRatio: 0 }).ok, false,
    'a 24-row gray-header/white-margin match must not jump 626 rows');
  const timeline = createStitchTimeline({ ignoreRightRatio: 0 });
  timeline.addFrame(frames[0]);
  const accepted = timeline.addFrame(frames[1]);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.motion.novelHeight, 120);
  const expected = new Uint8ClampedArray(fixture.width * 770 * 4);
  expected.set(frames[0].pixels);
  expected.set(frames[1].pixels.subarray(fixture.width * 530 * 4), frames[0].pixels.length);
  assert.deepEqual(timeline.compose().pixels, expected);
});

test('white margins cannot turn a transient fractional-scroll text mismatch into a confident overlap', () => {
  const fixture = require('./fixtures/longshot-fractional-scroll.json');
  const [first, transient, settled] = fixture.frames.map((frame) => ({
    id: 'capture-' + frame.captureLabel,
    width: fixture.width,
    height: fixture.height,
    scaleFactor: 1,
    pixels: new Uint8ClampedArray(zlib.inflateSync(Buffer.from(frame.rgbaDeflateBase64, 'base64'))),
  }));
  const options = { fixedBands: { top: fixture.fixedTop, bottom: 0 }, ignoreRightRatio: 0 };
  const wrong = matchAdjacentFrames(first, transient, options);
  assert.equal(wrong.ok, false,
    'the old 17-row match agreed on white margins, but all 17 sampled foreground pixels disagreed');

  const timeline = createStitchTimeline({ ignoreRightRatio: 0 });
  assert.equal(timeline.addFrame(first).ok, true);
  assert.equal(timeline.setFixedBands(options.fixedBands).ok, true);
  const before = timeline.getState();
  assert.equal(timeline.addFrame(transient).ok, false);
  assert.deepEqual(timeline.getState(), before, 'a transient raster must preserve all accepted pixels and geometry');
  const accepted = timeline.addFrame(settled);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.motion.novelHeight, 120);
  const composed = timeline.compose();
  const expected = new Uint8ClampedArray(fixture.width * (fixture.height + 120) * 4);
  expected.set(first.pixels);
  expected.set(settled.pixels.subarray(fixture.width * (fixture.height - 120) * 4), first.pixels.length);
  assert.equal(composed.height, 770);
  assert.deepEqual(composed.pixels, expected, 'the settled frame must append exactly the final 120 source rows');
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

test('a repeated short footnote is insufficient overlap evidence for a full-size viewport', () => {
  const fixture = require('./fixtures/longshot-fractional-scroll.json');
  const [first, second] = [fixture.frames[2], fixture.nextSettledFrame].map((frame) => ({
    id: 'footer-' + frame.captureLabel, width: fixture.width, height: fixture.height, scaleFactor: 1,
    pixels: new Uint8ClampedArray(zlib.inflateSync(Buffer.from(frame.rgbaDeflateBase64, 'base64'))),
  }));
  const matched = matchAdjacentFrames(first, second, { ignoreRightRatio: 0, fixedBands: { top: 64, bottom: 0 } });
  assert.equal(matched.ok, true, '46 repeated footer rows alone cannot justify a 540px jump in a 586px body');
  assert.equal(matched.overlap, 466);
  assert.equal(matched.novelHeight, 120);
  assert.equal(matchAdjacentFrames(first, second, {
    ignoreRightRatio: 0, minOverlap: 1, fixedBands: { top: 64, bottom: 0 },
  }).novelHeight, 120, 'an explicit pixel floor cannot disable minimum viewport evidence');
});

test('exact low-contrast textures remain matchable even when every color is near the dominant background', () => {
  const width = 240;
  let seed = 1234;
  const document = new Uint8ClampedArray(width * 1000 * 4);
  for (let offset = 0; offset < document.length; offset += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const ratio = seed / 0x100000000;
    const gray = ratio < 0.5 ? 238 : ratio < 0.75 ? 221 : 255;
    document.set([gray, gray, gray, 255], offset);
  }
  const frame = (top) => ({ id: 'low-contrast-' + top, width, height: 650, scaleFactor: 1,
    pixels: document.slice(top * width * 4, (top + 650) * width * 4) });
  const matched = matchAdjacentFrames(frame(0), frame(120), { ignoreRightRatio: 0 });
  assert.equal(matched.ok, true, 'an exact textured strip is evidence even without a high-contrast foreground');
  assert.equal(matched.overlap, 530);
  assert.equal(matched.meanError, 0);
});

test('large repeated content remains ambiguous above the minimum overlap evidence floor', () => {
  const colors = [[30, 20, 180, 255], [60, 170, 10, 255], [210, 60, 70, 255], [100, 210, 240, 255]];
  const frame = (top) => rowFrame('periodic-' + top, Array.from({ length: 100 }, (_, index) => colors[(top + index) % colors.length]));
  const matched = matchAdjacentFrames(frame(0), frame(2), { minOverlap: 1 });
  assert.equal(matched.ok, false);
  assert.equal(matched.reason, 'ambiguous-match', 'the evidence floor does not authorize guessing among valid repeated overlaps');
});

test('foreground verification tolerates minor color drift in a full-size textured screenshot', () => {
  const width = 1100;
  let seed = 9123;
  const document = new Uint8ClampedArray(width * 800 * 4);
  for (let offset = 0; offset < document.length; offset += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    document.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], offset);
  }
  const frame = (top) => ({ id: 'photo-' + top, width, height: 650, scaleFactor: 1,
    pixels: document.slice(top * width * 4, (top + 650) * width * 4) });
  const first = frame(0);
  const second = frame(120);
  for (let offset = 0; offset < second.pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) second.pixels[offset + channel] += 1;
  }
  const matched = matchAdjacentFrames(first, second);
  assert.equal(matched.ok, true, 'ordinary rendering color drift must not prevent matching image content');
  assert.equal(matched.novelHeight, 120);
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

test('raw-frame memory stays within budget across repeated delete and capture cycles', () => {
  const timeline = createStitchTimeline(timelineOptions({
    historyLimit: 1,
    maxSourcePixels: 48,
  }));
  assert.equal(timeline.addFrame(rowFrame('anchor', globalRows(0, 6))).ok, true);

  for (let index = 0; index < 40; index += 1) {
    const id = 'moving-' + index;
    const added = timeline.addFrame(rowFrame(id, globalRows(3, 6)));
    assert.equal(added.ok, true, 'capture cycle ' + index + ' should remain usable');
    assert.ok(timeline.getState().retainedSourcePixels <= 48);
    assert.equal(timeline.deleteFrame(id).ok, true);
    assert.ok(timeline.getState().retainedSourcePixels <= 48);
  }

  // moving-0 disappeared from current/history/future many cycles ago. Its id must
  // therefore be reusable, proving that its RGBA buffer is no longer retained.
  const reused = timeline.addFrame(rowFrame('moving-0', globalRows(3, 6)));
  assert.equal(reused.ok, true);
  assert.ok(timeline.getState().retainedSourcePixels <= 48);
});

test('a timeline transaction can restore frames, pixels, and edit history atomically', () => {
  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(rowFrame('a', globalRows(0, 6))).ok, true);
  assert.equal(timeline.addFrame(rowFrame('b', globalRows(3, 6))).ok, true);
  const beforeRows = composedGreenRows(timeline.compose());
  const beforeState = timeline.getState();

  const transaction = timeline.beginTransaction();
  assert.equal(timeline.deleteFrame('b').ok, true);
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['a']);
  assert.equal(transaction.rollback().ok, true);

  assert.deepEqual(timeline.getState(), beforeState);
  assert.deepEqual(composedGreenRows(timeline.compose()), beforeRows);
  assert.equal(timeline.deleteFrame('b').ok, true, 'the restored frame remains editable');
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

test('proven fixed header/footer bands are applied while admitting the second scrolled frame', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const second = rowFrame('second', [...header, 60, 80, 100, 120, 140, 160, ...footer]);
  const timeline = createStitchTimeline(timelineOptions());

  assert.equal(timeline.addFrame(first).ok, true);
  const accepted = timeline.addFrame(second);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.autoFixedBands, { top: 2, bottom: 2 });
  assert.deepEqual(timeline.getState().fixedBands, { top: 2, bottom: 2 });
  assert.deepEqual(timeline.getState().frames.map((frame) => frame.id), ['first', 'second']);
  assert.deepEqual(composedGreenRows(timeline.compose()), [
    180, 181, 20, 40, 60, 80, 100, 120, 140, 160, 220, 221,
  ]);
});

test('a fixed-band candidate that reaches the scanning cap has no verified boundary', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255], [5, 182, 32, 255], [6, 183, 33, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120]);
  const second = rowFrame('second', [...header, 60, 80, 100, 120, 140, 160]);
  const suggestion = suggestFixedBands(first, second, timelineOptions());

  assert.deepEqual({ top: suggestion.top, bottom: suggestion.bottom }, { top: 0, bottom: 0 });
});

test('fixed-band detection requires translated content, not just unchanged screen edges', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const second = rowFrame('animation', [...header, 140, 160, 180, 200, 220, 240, ...footer]);
  const suggestion = suggestFixedBands(first, second, timelineOptions());

  assert.deepEqual({ top: suggestion.top, bottom: suggestion.bottom }, { top: 0, bottom: 0 });
});

test('automatic fixed bands remain transactional on memory rejection and renderer rollback', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const second = rowFrame('second', [...header, 60, 80, 100, 120, 140, 160, ...footer]);
  const constrained = createStitchTimeline(timelineOptions({ maxSourcePixels: 40 }));
  assert.equal(constrained.addFrame(first).ok, true);
  const before = constrained.getState();
  const rejected = constrained.addFrame(second);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'source-pixel-limit');
  assert.deepEqual(constrained.getState(), before);

  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(first).ok, true);
  const initial = timeline.getState();
  const transaction = timeline.beginTransaction();
  assert.equal(timeline.addFrame(second).ok, true);
  assert.deepEqual(timeline.getState().fixedBands, { top: 2, bottom: 2 });
  assert.equal(transaction.rollback().ok, true);
  assert.deepEqual(timeline.getState(), initial);
  assert.deepEqual(composedGreenRows(timeline.compose()), composedGreenRows(first));
});

test('automatic fixed bands retain prepend geometry and reject subsequent direction reversal', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 60, 80, 100, 120, 140, 160, ...footer]);
  const earlier = rowFrame('earlier', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const later = rowFrame('later', [...header, 100, 120, 140, 160, 180, 200, ...footer]);
  const timeline = createStitchTimeline(timelineOptions());
  assert.equal(timeline.addFrame(first).ok, true);
  const accepted = timeline.addFrame(earlier);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.direction, 'prepend');
  assert.equal(accepted.motion.displacement, -2);
  assert.deepEqual(accepted.autoFixedBands, { top: 2, bottom: 2 });
  assert.deepEqual(composedGreenRows(timeline.compose()), [
    180, 181, 20, 40, 60, 80, 100, 120, 140, 160, 220, 221,
  ]);
  const rejected = timeline.addFrame(later);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'reverse-direction');
});

test('automatic fixed-band admission verifies the composed pixel budget before committing', () => {
  const header = [[3, 180, 30, 255], [4, 181, 31, 255]];
  const footer = [[8, 220, 70, 255], [9, 221, 71, 255]];
  const first = rowFrame('first', [...header, 20, 40, 60, 80, 100, 120, ...footer]);
  const second = rowFrame('second', [...header, 60, 80, 100, 120, 140, 160, ...footer]);
  const timeline = createStitchTimeline(timelineOptions({ maxPixels: 40 }));
  assert.equal(timeline.addFrame(first).ok, true);
  const before = timeline.getState();
  const rejected = timeline.addFrame(second);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'pixel-limit');
  assert.deepEqual(timeline.getState(), before);
});
