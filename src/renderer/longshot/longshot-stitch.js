// Pure long-shot frame matcher and editable segment timeline.
// It deliberately has no DOM/Electron dependency so matching and composition can be
// verified pixel-by-pixel in Node before the renderer is allowed to use it.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LongshotStitch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_PIXELS = 20 * 1024 * 1024;
  const DEFAULT_MAX_FRAMES = 1000;

  function finiteInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? number : fallback;
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Math.max(minimum, Math.min(maximum, finiteInteger(value, fallback)));
  }

  function normalizeScaleFactor(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 1;
  }

  function normalizeFrame(input, fallbackId) {
    const frame = input && typeof input === 'object' ? input : {};
    const width = finiteInteger(frame.width, 0);
    const height = finiteInteger(frame.height, 0);
    if (width < 1 || height < 1) {
      return { ok: false, reason: 'invalid-frame-size' };
    }
    const expectedLength = width * height * 4;
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 4) {
      return { ok: false, reason: 'invalid-frame-size' };
    }
    let pixels = frame.pixels;
    if (Array.isArray(pixels)) pixels = Uint8ClampedArray.from(pixels);
    if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== expectedLength) {
      return { ok: false, reason: 'invalid-frame-pixels' };
    }
    const id = String(frame.id == null ? fallbackId : frame.id);
    if (!id) return { ok: false, reason: 'invalid-frame-id' };
    return {
      ok: true,
      frame: {
        id,
        width,
        height,
        scaleFactor: normalizeScaleFactor(frame.scaleFactor),
        // ImageData already owns this array. Retaining it is the raw-frame recovery
        // source; another eager copy would double peak memory for no safety benefit.
        pixels,
      },
    };
  }

  function normalizeBands(bands, frameHeight) {
    const height = Math.max(1, finiteInteger(frameHeight, 1));
    const top = clampInteger(bands && bands.top, 0, height - 1, 0);
    const bottom = clampInteger(bands && bands.bottom, 0, height - 1, 0);
    if (top + bottom >= height) return { ok: false, reason: 'invalid-fixed-bands' };
    return { ok: true, top, bottom };
  }

  function bodyBounds(frame, bands) {
    const normalized = normalizeBands(bands, frame.height);
    if (!normalized.ok) return normalized;
    return {
      ok: true,
      start: normalized.top,
      end: frame.height - normalized.bottom,
      height: frame.height - normalized.top - normalized.bottom,
      top: normalized.top,
      bottom: normalized.bottom,
    };
  }

  function samplePositions(length, desired) {
    const count = Math.max(1, Math.min(length, finiteInteger(desired, length)));
    const positions = [];
    let previous = -1;
    for (let index = 0; index < count; index += 1) {
      const position = Math.min(length - 1, Math.floor(((index + 0.5) / count) * length));
      if (position !== previous) positions.push(position);
      previous = position;
    }
    return positions;
  }

  function sampledColumns(width, desired, ignoreRightRatio) {
    const ratio = Math.max(0, Math.min(0.2, Number(ignoreRightRatio) || 0));
    const usableWidth = Math.max(1, Math.min(width, Math.floor(width * (1 - ratio))));
    return samplePositions(usableWidth, desired);
  }

  function hasVisualContent(frame, bands, options) {
    const bounds = bodyBounds(frame, bands || {});
    if (!bounds.ok || bounds.height < 1) return false;
    const opts = options || {};
    // Scan every row but only a bounded set of columns. Thin text/divider rows are
    // common in screenshots and must not disappear between a sparse vertical grid.
    const rows = samplePositions(bounds.height, opts.contentSampleRows || bounds.height);
    const columns = sampledColumns(frame.width, opts.sampleColumns || 24, opts.ignoreRightRatio == null ? 0.03 : opts.ignoreRightRatio);
    const low = [255, 255, 255, 255];
    const high = [0, 0, 0, 0];
    for (const rowOffset of rows) {
      const row = bounds.start + rowOffset;
      for (const column of columns) {
        const offset = (row * frame.width + column) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          const value = frame.pixels[offset + channel];
          if (value < low[channel]) low[channel] = value;
          if (value > high[channel]) high[channel] = value;
        }
      }
    }
    const minimumRange = Math.max(1, Number(opts.contentRange) || 18);
    // Crucially inspect G/B/alpha as well as R. A screenshot whose red plane is
    // constant but whose green/blue plane contains text is not an empty frame.
    return high.some((value, channel) => value - low[channel] >= minimumRange);
  }

  function stripMetrics(first, firstStart, second, secondStart, height, options) {
    const opts = options || {};
    if (height < 1 || first.width !== second.width) return { score: 0, meanError: Infinity };
    const rows = samplePositions(height, opts.sampleRows || 14);
    const columns = sampledColumns(first.width, opts.sampleColumns || 24, opts.ignoreRightRatio == null ? 0.03 : opts.ignoreRightRatio);
    const tolerance = Math.max(0, Number(opts.tolerance) || 18);
    let same = 0;
    let total = 0;
    let errorTotal = 0;
    for (const rowOffset of rows) {
      const firstRow = firstStart + rowOffset;
      const secondRow = secondStart + rowOffset;
      for (const column of columns) {
        const firstOffset = (firstRow * first.width + column) * 4;
        const secondOffset = (secondRow * second.width + column) * 4;
        total += 1;
        let withinTolerance = true;
        for (let channel = 0; channel < 4; channel += 1) {
          const difference = Math.abs(first.pixels[firstOffset + channel] - second.pixels[secondOffset + channel]);
          errorTotal += difference;
          if (difference > tolerance) withinTolerance = false;
        }
        if (
          withinTolerance
        ) same += 1;
      }
    }
    return {
      score: total ? same / total : 0,
      // The threshold score is intentionally tolerant, but it cannot distinguish
      // an exact alignment from a neighbouring row whose colours merely fall
      // inside that threshold. Mean error is the deterministic tie-breaker that
      // prevents a larger, off-by-one overlap from silently dropping content.
      meanError: total ? errorTotal / (total * 4) : Infinity,
    };
  }

  function stripSimilarity(first, firstStart, second, secondStart, height, options) {
    return stripMetrics(first, firstStart, second, secondStart, height, options).score;
  }

  function dimensionMismatch(first, second, scaleTolerance) {
    if (first.width !== second.width) {
      return { ok: false, reason: 'width-mismatch', expected: first.width, actual: second.width };
    }
    const tolerance = Math.max(0, Number(scaleTolerance) || 0.001);
    if (Math.abs(first.scaleFactor - second.scaleFactor) > tolerance) {
      return {
        ok: false,
        reason: 'scale-mismatch',
        expected: first.scaleFactor,
        actual: second.scaleFactor,
      };
    }
    return null;
  }

  // Match two frames already ordered in document direction: `earlier` must be
  // above/left of `later`. The returned overlap is between earlier's body tail and
  // later's body head. Near-equal competing offsets are rejected instead of guessed.
  function matchAdjacentFrames(earlier, later, options) {
    const opts = options || {};
    const mismatch = dimensionMismatch(earlier, later, opts.scaleTolerance);
    if (mismatch) return mismatch;
    const bands = opts.fixedBands || { top: 0, bottom: 0 };
    const earlierBody = bodyBounds(earlier, bands);
    const laterBody = bodyBounds(later, bands);
    if (!earlierBody.ok || !laterBody.ok) return { ok: false, reason: 'invalid-fixed-bands' };
    if (!hasVisualContent(later, bands, opts)) return { ok: false, reason: 'blank-frame' };

    const maxOverlap = Math.min(earlierBody.height, laterBody.height);
    const minimum = Math.max(1, Math.min(maxOverlap, finiteInteger(opts.minOverlap, 8)));
    const threshold = Math.max(0.5, Math.min(1, Number(opts.matchThreshold) || 0.9));
    const ambiguityMargin = Math.max(0, Math.min(0.2, Number(opts.ambiguityMargin) || 0.025));
    const idleThreshold = Math.max(1, finiteInteger(opts.idleThreshold, Math.max(2, Math.floor(laterBody.height * 0.005))));
    const candidates = [];

    for (let overlap = maxOverlap; overlap >= minimum; overlap -= 1) {
      const metrics = stripMetrics(
        earlier,
        earlierBody.end - overlap,
        later,
        laterBody.start,
        overlap,
        opts
      );
      if (metrics.score >= threshold - ambiguityMargin) {
        candidates.push({ overlap, score: metrics.score, meanError: metrics.meanError });
      }
    }
    candidates.sort((left, right) => (
      right.score - left.score || left.meanError - right.meanError || right.overlap - left.overlap
    ));
    const best = candidates[0];
    if (!best || best.score < threshold) {
      return {
        ok: false,
        reason: 'no-match',
        bestScore: best ? best.score : 0,
        meanError: best ? best.meanError : Infinity,
        confidence: 0,
      };
    }

    // An adjacent offset is also dangerous when both its threshold score and
    // absolute error are effectively equal: choosing either would lose or repeat
    // a row. If the errors clearly differ, prefer the exact/closer candidate.
    const equivalentError = Math.max(0.25, (Math.max(0, Number(opts.tolerance) || 18)) * 0.05);
    const competing = candidates.find((candidate) => (
      candidate.overlap !== best.overlap &&
      best.score - candidate.score <= ambiguityMargin &&
      Math.abs(candidate.meanError - best.meanError) <= equivalentError
    ));
    const confidence = competing ? best.score - competing.score : best.score - threshold;
    if (competing) {
      return {
        ok: false,
        reason: 'ambiguous-match',
        bestOverlap: best.overlap,
        competingOverlap: competing.overlap,
        bestScore: best.score,
        meanError: best.meanError,
        competingMeanError: competing.meanError,
        confidence,
      };
    }

    const novelHeight = laterBody.height - best.overlap;
    return {
      ok: true,
      idle: novelHeight <= idleThreshold,
      overlap: best.overlap,
      novelHeight,
      score: best.score,
      meanError: best.meanError,
      confidence,
    };
  }

  function chooseFailure(first, second) {
    const failures = [first, second].filter(Boolean);
    for (const reason of ['width-mismatch', 'scale-mismatch', 'invalid-fixed-bands', 'blank-frame', 'ambiguous-match']) {
      const found = failures.find((failure) => failure.reason === reason);
      if (found) return found;
    }
    return failures[0] || { ok: false, reason: 'no-match' };
  }

  // Compare both real geometric hypotheses. A prepend match yields a negative
  // displacement and therefore detects upward/leftward capture instead of feeding
  // an always-positive append height into a direction gate.
  function detectFrameMotion(frames, candidate, options) {
    const opts = options || {};
    if (!Array.isArray(frames) || frames.length === 0) {
      return { ok: true, direction: 'initial', displacement: 0 };
    }
    const locked = opts.lockedDirection === 'append' || opts.lockedDirection === 'prepend'
      ? opts.lockedDirection
      : null;
    const first = frames[0];
    const last = frames[frames.length - 1];

    if (locked === 'append') {
      const expected = matchAdjacentFrames(last, candidate, opts);
      if (expected.ok) return { ...expected, direction: expected.idle ? 'idle' : 'append', displacement: expected.novelHeight };
      const opposite = matchAdjacentFrames(candidate, first, opts);
      if (opposite.ok && !opposite.idle) {
        return { ok: false, reason: 'reverse-direction', detectedDirection: 'prepend', displacement: -opposite.novelHeight };
      }
      return chooseFailure(expected, opposite);
    }
    if (locked === 'prepend') {
      const expected = matchAdjacentFrames(candidate, first, opts);
      if (expected.ok) return { ...expected, direction: expected.idle ? 'idle' : 'prepend', displacement: -expected.novelHeight };
      const opposite = matchAdjacentFrames(last, candidate, opts);
      if (opposite.ok && !opposite.idle) {
        return { ok: false, reason: 'reverse-direction', detectedDirection: 'append', displacement: opposite.novelHeight };
      }
      return chooseFailure(expected, opposite);
    }

    const append = matchAdjacentFrames(last, candidate, opts);
    const prepend = matchAdjacentFrames(candidate, first, opts);
    if (append.ok && append.idle) return { ...append, direction: 'idle', displacement: 0 };
    if (prepend.ok && prepend.idle) return { ...prepend, direction: 'idle', displacement: 0 };
    if (append.ok && !prepend.ok) return { ...append, direction: 'append', displacement: append.novelHeight };
    if (prepend.ok && !append.ok) return { ...prepend, direction: 'prepend', displacement: -prepend.novelHeight };
    if (!append.ok && !prepend.ok) return chooseFailure(append, prepend);

    const ambiguityMargin = Math.max(0, Math.min(0.2, Number(opts.ambiguityMargin) || 0.025));
    if (Math.abs(append.score - prepend.score) <= ambiguityMargin) {
      return {
        ok: false,
        reason: 'ambiguous-direction',
        appendScore: append.score,
        prependScore: prepend.score,
        confidence: Math.abs(append.score - prepend.score),
      };
    }
    return append.score > prepend.score
      ? { ...append, direction: 'append', displacement: append.novelHeight }
      : { ...prepend, direction: 'prepend', displacement: -prepend.novelHeight };
  }

  function rowSimilarity(first, firstRow, second, secondRow, options) {
    return stripSimilarity(first, firstRow, second, secondRow, 1, options);
  }

  function suggestFixedBands(first, second, options) {
    const opts = options || {};
    const mismatch = dimensionMismatch(first, second, opts.scaleTolerance);
    if (mismatch || first.height !== second.height) {
      return { top: 0, bottom: 0, confidence: 0, reason: mismatch ? mismatch.reason : 'height-mismatch' };
    }
    const maximum = Math.max(0, Math.floor(first.height * Math.max(0, Math.min(0.45, Number(opts.maxBandRatio) || 0.3))));
    const threshold = Math.max(0.5, Math.min(1, Number(opts.bandThreshold) || 0.96));
    const minimum = Math.max(1, finiteInteger(opts.minBand, 2));
    let top = 0;
    let bottom = 0;
    let scoreTotal = 0;

    for (let row = 0; row < maximum; row += 1) {
      const score = rowSimilarity(first, row, second, row, opts);
      if (score < threshold) break;
      top += 1;
      scoreTotal += score;
    }
    for (let offset = 0; offset < maximum; offset += 1) {
      const row = first.height - 1 - offset;
      const score = rowSimilarity(first, row, second, row, opts);
      if (score < threshold) break;
      bottom += 1;
      scoreTotal += score;
    }
    if (top < minimum) top = 0;
    if (bottom < minimum) bottom = 0;
    if (top + bottom >= first.height) bottom = Math.max(0, first.height - top - 1);
    return {
      top,
      bottom,
      confidence: top + bottom ? scoreTotal / Math.max(1, top + bottom) : 0,
    };
  }

  function buildPlan(frames, bands, options) {
    if (!frames.length) return { ok: true, width: 0, height: 0, segments: [], overlaps: [] };
    const opts = { ...(options || {}), fixedBands: bands };
    const firstBounds = bodyBounds(frames[0], bands);
    if (!firstBounds.ok) return firstBounds;
    const segments = [];
    const overlaps = [];
    let height = 0;

    if (firstBounds.top > 0) {
      segments.push({ frameId: frames[0].id, role: 'fixed-top', sourceY: 0, height: firstBounds.top, overlap: 0 });
      height += firstBounds.top;
    }
    segments.push({
      frameId: frames[0].id,
      role: 'content',
      sourceY: firstBounds.start,
      height: firstBounds.height,
      overlap: 0,
    });
    height += firstBounds.height;

    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      const match = matchAdjacentFrames(previous, current, opts);
      if (!match.ok) return { ...match, pair: [previous.id, current.id] };
      const currentBounds = bodyBounds(current, bands);
      const segmentHeight = Math.max(0, currentBounds.height - match.overlap);
      overlaps.push({ firstId: previous.id, secondId: current.id, overlap: match.overlap, score: match.score, confidence: match.confidence });
      if (segmentHeight > 0) {
        segments.push({
          frameId: current.id,
          role: 'content',
          sourceY: currentBounds.start + match.overlap,
          height: segmentHeight,
          overlap: match.overlap,
        });
        height += segmentHeight;
      }
    }

    const last = frames[frames.length - 1];
    const lastBounds = bodyBounds(last, bands);
    if (lastBounds.bottom > 0) {
      segments.push({
        frameId: last.id,
        role: 'fixed-bottom',
        sourceY: last.height - lastBounds.bottom,
        height: lastBounds.bottom,
        overlap: 0,
      });
      height += lastBounds.bottom;
    }
    return { ok: true, width: frames[0].width, height, segments, overlaps };
  }

  function createStitchTimeline(options) {
    const opts = options || {};
    const maxPixels = Math.max(1, finiteInteger(opts.maxPixels, DEFAULT_MAX_PIXELS));
    const maxSourcePixels = Math.max(1, finiteInteger(opts.maxSourcePixels, maxPixels));
    const maxFrames = Math.max(1, finiteInteger(opts.maxFrames, DEFAULT_MAX_FRAMES));
    const historyLimit = Math.max(1, finiteInteger(opts.historyLimit, 100));
    const matchOptions = {
      minOverlap: opts.minOverlap,
      matchThreshold: opts.matchThreshold,
      ambiguityMargin: opts.ambiguityMargin,
      tolerance: opts.tolerance,
      sampleRows: opts.sampleRows,
      sampleColumns: opts.sampleColumns,
      contentRange: opts.contentRange,
      scaleTolerance: opts.scaleTolerance,
      ignoreRightRatio: opts.ignoreRightRatio,
      idleThreshold: opts.idleThreshold,
    };
    let frames = [];
    let fixedBands = { top: 0, bottom: 0 };
    let direction = null;
    let plan = buildPlan(frames, fixedBands, matchOptions);
    let nextId = 1;
    let history = [];
    let future = [];
    const rawFrames = new Map();

    function snapshot() {
      return {
        frameIds: frames.map((frame) => frame.id),
        fixedBands: { ...fixedBands },
        direction,
      };
    }

    function remember() {
      history.push(snapshot());
      if (history.length > historyLimit) history.shift();
      future = [];
    }

    function sourcePixels(candidateFrames) {
      return candidateFrames.reduce((total, frame) => total + frame.width * frame.height, 0);
    }

    function validateCandidateFrames(candidateFrames, candidatePlan) {
      if (candidateFrames.length > maxFrames) return { ok: false, reason: 'frame-limit' };
      if (sourcePixels(candidateFrames) > maxSourcePixels) return { ok: false, reason: 'source-pixel-limit' };
      if (!candidatePlan.ok) return candidatePlan;
      const pixels = candidatePlan.width * candidatePlan.height;
      if (!Number.isSafeInteger(pixels) || pixels > maxPixels) return { ok: false, reason: 'pixel-limit' };
      return { ok: true };
    }

    function addFrame(input) {
      const normalized = normalizeFrame(input, 'frame-' + nextId);
      if (!normalized.ok) return normalized;
      const frame = normalized.frame;
      if (rawFrames.has(frame.id) || frames.some((existing) => existing.id === frame.id)) {
        return { ok: false, reason: 'duplicate-frame-id' };
      }
      if (frames.length === 0) {
        if (!hasVisualContent(frame, fixedBands, matchOptions)) return { ok: false, reason: 'blank-frame' };
        const candidatePlan = buildPlan([frame], fixedBands, matchOptions);
        const validation = validateCandidateFrames([frame], candidatePlan);
        if (!validation.ok) return validation;
        frames = [frame];
        rawFrames.set(frame.id, frame);
        plan = candidatePlan;
        nextId += 1;
        future = [];
        return { ok: true, status: 'initial', frameId: frame.id, direction: null, plan };
      }

      const reference = frames[0];
      const mismatch = dimensionMismatch(reference, frame, matchOptions.scaleTolerance);
      if (mismatch) return mismatch;
      const motion = detectFrameMotion(frames, frame, {
        ...matchOptions,
        fixedBands,
        lockedDirection: direction,
      });
      if (!motion.ok) {
        // A fixed toolbar breaks the ordinary tail→head hypothesis before a
        // second frame can be admitted. Detect same-position repeated bands from
        // this rejected candidate and hand the values to the UI for confirmation.
        if (fixedBands.top === 0 && fixedBands.bottom === 0) {
          const suggestion = suggestFixedBands(frames[frames.length - 1], frame, {
            ...matchOptions,
            minBand: 2,
          });
          if (suggestion.top || suggestion.bottom) {
            return {
              ok: false,
              reason: 'fixed-bands-suggested',
              cause: motion.reason,
              suggestion,
            };
          }
        }
        return motion;
      }
      if (motion.direction === 'idle') return { ok: true, status: 'idle', frameId: null, motion, plan };

      const candidateFrames = motion.direction === 'prepend' ? [frame, ...frames] : [...frames, frame];
      const candidatePlan = buildPlan(candidateFrames, fixedBands, matchOptions);
      const validation = validateCandidateFrames(candidateFrames, candidatePlan);
      if (!validation.ok) return validation;
      frames = candidateFrames;
      rawFrames.set(frame.id, frame);
      plan = candidatePlan;
      direction = direction || motion.direction;
      nextId += 1;
      future = [];
      return { ok: true, status: 'accepted', frameId: frame.id, direction, motion, plan };
    }

    function deleteFrame(frameId) {
      const id = String(frameId);
      const index = frames.findIndex((frame) => frame.id === id);
      if (index < 0) return { ok: false, reason: 'frame-not-found' };
      if (frames.length <= 1) return { ok: false, reason: 'last-frame' };
      const candidateFrames = frames.filter((frame) => frame.id !== id);
      const candidatePlan = buildPlan(candidateFrames, fixedBands, matchOptions);
      const validation = validateCandidateFrames(candidateFrames, candidatePlan);
      if (!validation.ok) return validation;
      remember();
      frames = candidateFrames;
      plan = candidatePlan;
      return { ok: true, deletedId: id, plan };
    }

    function setFixedBands(value) {
      if (!frames.length) return { ok: false, reason: 'no-frames' };
      const normalized = normalizeBands(value, Math.min(...frames.map((frame) => frame.height)));
      if (!normalized.ok) return normalized;
      const candidateBands = { top: normalized.top, bottom: normalized.bottom };
      if (candidateBands.top === fixedBands.top && candidateBands.bottom === fixedBands.bottom) {
        return { ok: true, unchanged: true, plan };
      }
      const candidatePlan = buildPlan(frames, candidateBands, matchOptions);
      const validation = validateCandidateFrames(frames, candidatePlan);
      if (!validation.ok) return validation;
      remember();
      fixedBands = candidateBands;
      plan = candidatePlan;
      return { ok: true, fixedBands: { ...fixedBands }, plan };
    }

    function suggestBands(suggestionOptions) {
      if (frames.length < 2) return { top: 0, bottom: 0, confidence: 0, reason: 'not-enough-frames' };
      const first = direction === 'prepend' ? frames[0] : frames[frames.length - 2];
      const second = direction === 'prepend' ? frames[1] : frames[frames.length - 1];
      return suggestFixedBands(first, second, { ...matchOptions, ...(suggestionOptions || {}) });
    }

    function restore(state) {
      const restoredFrames = state.frameIds.map((id) => rawFrames.get(id)).filter(Boolean);
      if (restoredFrames.length !== state.frameIds.length) return { ok: false, reason: 'history-frame-missing' };
      const restoredPlan = buildPlan(restoredFrames, state.fixedBands, matchOptions);
      if (!restoredPlan.ok) return restoredPlan;
      frames = restoredFrames;
      fixedBands = { ...state.fixedBands };
      direction = state.direction;
      plan = restoredPlan;
      return { ok: true, plan };
    }

    function undo() {
      if (!history.length) return { ok: false, reason: 'nothing-to-undo' };
      const previous = history[history.length - 1];
      const current = snapshot();
      const restored = restore(previous);
      if (!restored.ok) return restored;
      history.pop();
      future.push(current);
      return { ok: true, plan };
    }

    function redo() {
      if (!future.length) return { ok: false, reason: 'nothing-to-redo' };
      const next = future[future.length - 1];
      const current = snapshot();
      const restored = restore(next);
      if (!restored.ok) return restored;
      future.pop();
      history.push(current);
      if (history.length > historyLimit) history.shift();
      return { ok: true, plan };
    }

    function compose() {
      if (!plan.ok || plan.width < 1 || plan.height < 1) {
        return { ok: false, reason: plan.reason || 'no-frames' };
      }
      const pixels = new Uint8ClampedArray(plan.width * plan.height * 4);
      let targetY = 0;
      for (const segment of plan.segments) {
        const frame = rawFrames.get(segment.frameId) || frames.find((item) => item.id === segment.frameId);
        if (!frame) return { ok: false, reason: 'segment-frame-missing' };
        const rowBytes = frame.width * 4;
        for (let row = 0; row < segment.height; row += 1) {
          const sourceStart = (segment.sourceY + row) * rowBytes;
          const targetStart = (targetY + row) * rowBytes;
          pixels.set(frame.pixels.subarray(sourceStart, sourceStart + rowBytes), targetStart);
        }
        targetY += segment.height;
      }
      return { ok: true, width: plan.width, height: plan.height, pixels, segments: plan.segments.map((segment) => ({ ...segment })) };
    }

    function getState() {
      return {
        frames: frames.map((frame) => ({ id: frame.id, width: frame.width, height: frame.height, scaleFactor: frame.scaleFactor })),
        fixedBands: { ...fixedBands },
        direction,
        width: plan.width,
        height: plan.height,
        segments: plan.segments.map((segment) => ({ ...segment })),
        overlaps: plan.overlaps.map((overlap) => ({ ...overlap })),
        canUndo: history.length > 0,
        canRedo: future.length > 0,
        sourcePixels: sourcePixels(frames),
      };
    }

    return {
      addFrame,
      deleteFrame,
      setFixedBands,
      suggestFixedBands: suggestBands,
      undo,
      redo,
      compose,
      getState,
      getRawFrames: () => frames.slice(),
    };
  }

  return {
    DEFAULT_MAX_PIXELS,
    DEFAULT_MAX_FRAMES,
    normalizeFrame,
    hasVisualContent,
    stripSimilarity,
    matchAdjacentFrames,
    detectFrameMotion,
    suggestFixedBands,
    createStitchTimeline,
  };
});
