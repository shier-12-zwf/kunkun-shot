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
    const rows = opts.rowOffsets || samplePositions(height, opts.sampleRows || 14);
    const columns = sampledColumns(first.width, opts.sampleColumns || 24, opts.ignoreRightRatio == null ? 0.03 : opts.ignoreRightRatio);
    const tolerance = Math.max(0, Number(opts.tolerance) || 18);
    let same = 0;
    let total = 0;
    let errorTotal = 0;
    let foregroundSame = 0;
    let foregroundTotal = 0;
    // A pixel still inside the background's match tolerance cannot also count
    // as independent foreground evidence (notably pale fixed navigation bars).
    const foregroundThreshold = Math.max(tolerance, (Number(opts.contentRange) || 18) - 1);
    const low = [255, 255, 255, 255];
    const high = [0, 0, 0, 0];
    const secondLow = [255, 255, 255, 255];
    const secondHigh = [0, 0, 0, 0];
    for (const rowOffset of rows) {
      const firstRow = firstStart + rowOffset;
      const secondRow = secondStart + rowOffset;
      for (const column of columns) {
        const firstOffset = (firstRow * first.width + column) * 4;
        const secondOffset = (secondRow * second.width + column) * 4;
        total += 1;
        let withinTolerance = true;
        let foreground = false;
        for (let channel = 0; channel < 4; channel += 1) {
          if (opts.firstBackground && opts.secondBackground &&
              (Math.abs(first.pixels[firstOffset + channel] - opts.firstBackground[channel]) > foregroundThreshold ||
               Math.abs(second.pixels[secondOffset + channel] - opts.secondBackground[channel]) > foregroundThreshold)) {
            foreground = true;
          }
          if (opts.requireContent) {
            const value = first.pixels[firstOffset + channel];
            if (value < low[channel]) low[channel] = value;
            if (value > high[channel]) high[channel] = value;
            const secondValue = second.pixels[secondOffset + channel];
            if (secondValue < secondLow[channel]) secondLow[channel] = secondValue;
            if (secondValue > secondHigh[channel]) secondHigh[channel] = secondValue;
          }
          const difference = Math.abs(first.pixels[firstOffset + channel] - second.pixels[secondOffset + channel]);
          errorTotal += difference;
          if (difference > tolerance) withinTolerance = false;
        }
        if (
          withinTolerance
        ) same += 1;
        if (foreground) {
          foregroundTotal += 1;
          if (withinTolerance) foregroundSame += 1;
        }
      }
    }
    if (opts.requireContent && (!high.some((value, channel) => value - low[channel] >= (Number(opts.contentRange) || 18)) ||
        !secondHigh.some((value, channel) => value - secondLow[channel] >= (Number(opts.contentRange) || 18)))) {
      return { score: 0, meanError: Infinity };
    }
    return {
      // Large white/dark margins are not evidence that text lines align. Require
      // the same agreement among visible foreground pixels as across the strip.
      // Otherwise a transient subpixel text frame can match a completely wrong
      // short overlap merely because almost every sampled pixel is background.
      score: Math.min(total ? same / total : 0,
        opts.firstBackground && opts.secondBackground
          ? (foregroundTotal ? foregroundSame / foregroundTotal : (errorTotal === 0 ? 1 : 0)) : 1),
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

  function bodiesAreIdentical(first, firstBody, second, secondBody) {
    if (first.width !== second.width || firstBody.height !== secondBody.height) return false;
    const rowBytes = first.width * 4;
    const firstStart = firstBody.start * rowBytes;
    const secondStart = secondBody.start * rowBytes;
    const length = firstBody.height * rowBytes;
    // Exact comparison is intentional: a sparse sample can miss both thin text
    // and a local animation. An unchanged periodic/blank-heavy body is idle even
    // when many alternative overlaps would otherwise tie for the best score.
    for (let offset = 0; offset < length; offset += 1) {
      if (first.pixels[firstStart + offset] !== second.pixels[secondStart + offset]) return false;
    }
    return true;
  }

  function informativeRows(frame, bounds, options) {
    const opts = options || {};
    const columns = sampledColumns(frame.width, opts.sampleColumns || 24, opts.ignoreRightRatio == null ? 0.03 : opts.ignoreRightRatio);
    const threshold = Math.max(1, Number(opts.contentRange) || 18);
    const rows = [];
    // Discover thin text/edges once in a few columns, not by reading every pixel
    // for every possible overlap. Uniform margins carry no alignment evidence.
    for (let row = bounds.start; row < bounds.end; row += 1) {
      const anchor = (row * frame.width + columns[0]) * 4;
      let informative = false;
      for (const column of columns) {
        const offset = (row * frame.width + column) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          const value = frame.pixels[offset + channel];
          if (Math.abs(value - frame.pixels[anchor + channel]) >= threshold ||
              (row > bounds.start && Math.abs(value - frame.pixels[offset - frame.width * 4 + channel]) >= threshold)) {
            informative = true;
            break;
          }
        }
        if (informative) break;
      }
      if (informative) rows.push(row);
    }
    return rows;
  }

  function dominantBackground(frame, bounds, options) {
    const opts = options || {};
    const columns = sampledColumns(frame.width, opts.sampleColumns || 24, opts.ignoreRightRatio == null ? 0.03 : opts.ignoreRightRatio);
    const counts = new Map();
    let mostFrequent = 0;
    let background = 0;
    // One bounded-column scan per body, not a full-pixel scan per candidate.
    for (let row = bounds.start; row < bounds.end; row += 1) {
      for (const column of columns) {
        const offset = (row * frame.width + column) * 4;
        const color = ((frame.pixels[offset] << 24) | (frame.pixels[offset + 1] << 16) |
          (frame.pixels[offset + 2] << 8) | frame.pixels[offset + 3]) >>> 0;
        const count = (counts.get(color) || 0) + 1;
        counts.set(color, count);
        if (count > mostFrequent) {
          mostFrequent = count;
          background = color;
        }
      }
    }
    return [background >>> 24, (background >>> 16) & 255, (background >>> 8) & 255, background & 255];
  }

  function featureOffsets(rows, start, height) {
    function lowerBound(value) {
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (rows[middle] < value) low = middle + 1;
        else high = middle;
      }
      return low;
    }
    const begin = lowerBound(start);
    const end = lowerBound(start + height);
    // Bound each candidate to at most 32 evidence rows from each image even for
    // large Retina frames. Sampling feature rows keeps text visible between gaps.
    return end > begin ? samplePositions(end - begin, 32).map((index) => rows[begin + index] - start) : [];
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
    if (bodiesAreIdentical(earlier, earlierBody, later, laterBody)) {
      return { ok: true, idle: true, overlap: laterBody.height, novelHeight: 0, score: 1, meanError: 0, confidence: 1 };
    }

    const maxOverlap = Math.min(earlierBody.height, laterBody.height);
    // A few repeated footer/text rows cannot justify jumping almost a whole
    // viewport. Require at least 10% body overlap; an explicit minOverlap can
    // make that floor stricter, but cannot disable this evidence requirement.
    const minimum = Math.min(maxOverlap, Math.max(1, Math.ceil(maxOverlap * 0.1), finiteInteger(opts.minOverlap, 8)));
    const threshold = Math.max(0.5, Math.min(1, Number(opts.matchThreshold) || 0.9));
    const ambiguityMargin = Math.max(0, Math.min(0.2, Number(opts.ambiguityMargin) || 0.025));
    // Inertial scrolling often leaves a final one- or two-pixel step. A uniquely
    // matched positive displacement is real content, regardless of viewport size.
    const idleThreshold = Math.max(0, finiteInteger(opts.idleThreshold, 0));
    const candidates = [];
    const earlierFeatures = informativeRows(earlier, earlierBody, opts);
    const laterFeatures = informativeRows(later, laterBody, opts);
    const firstBackground = dominantBackground(earlier, earlierBody, opts);
    const secondBackground = dominantBackground(later, laterBody, opts);

    for (let overlap = maxOverlap; overlap >= minimum; overlap -= 1) {
      let metrics = stripMetrics(
        earlier,
        earlierBody.end - overlap,
        later,
        laterBody.start,
        overlap,
        opts
      );
      if (metrics.score >= threshold - ambiguityMargin) {
        const earlierStart = earlierBody.end - overlap;
        const rowOffsets = Array.from(new Set([
          ...samplePositions(overlap, opts.sampleRows || 14),
          ...featureOffsets(earlierFeatures, earlierStart, overlap),
          ...featureOffsets(laterFeatures, laterBody.start, overlap),
        ]));
        metrics = stripMetrics(earlier, earlierStart, later, laterBody.start, overlap, {
          ...opts, rowOffsets, requireContent: true, firstBackground, secondBackground,
        });
        if (metrics.score >= threshold - ambiguityMargin) {
          candidates.push({ overlap, score: metrics.score, meanError: metrics.meanError });
        }
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
    let topScore = 0;
    let bottomScore = 0;

    for (let row = 0; row < maximum; row += 1) {
      const score = rowSimilarity(first, row, second, row, opts);
      if (score < threshold) break;
      top += 1;
      topScore += score;
    }
    for (let offset = 0; offset < maximum; offset += 1) {
      const row = first.height - 1 - offset;
      const score = rowSimilarity(first, row, second, row, opts);
      if (score < threshold) break;
      bottom += 1;
      bottomScore += score;
    }

    // Reaching the scan limit is not evidence of a real boundary. In particular,
    // an idle 758px viewport used to suggest arbitrary 227px bands at both ends.
    // Only accept a boundary at the limit if the next row actually differs.
    const unboundedTop = maximum > 0 && top === maximum &&
      rowSimilarity(first, top, second, top, opts) >= threshold;
    const bottomBoundaryRow = first.height - bottom - 1;
    const unboundedBottom = maximum > 0 && bottom === maximum &&
      rowSimilarity(first, bottomBoundaryRow, second, bottomBoundaryRow, opts) >= threshold;
    if (unboundedTop || unboundedBottom) {
      return { top: 0, bottom: 0, confidence: 0, reason: 'fixed-band-boundary-unknown' };
    }
    if (top < minimum) { top = 0; topScore = 0; }
    if (bottom < minimum) { bottom = 0; bottomScore = 0; }
    if (!top && !bottom) return { top: 0, bottom: 0, confidence: 0 };

    // Same-position rows alone also describe a stationary page with a blinking
    // cursor/carousel. Require a unique, non-idle translation of the remaining
    // body before treating those rows as fixed page chrome.
    const motion = detectFrameMotion([first], second, { ...opts, fixedBands: { top, bottom } });
    if (!motion.ok || motion.direction === 'idle') {
      return { top: 0, bottom: 0, confidence: 0, reason: 'no-fixed-band-motion' };
    }
    return {
      top,
      bottom,
      confidence: Math.min((topScore + bottomScore) / (top + bottom), motion.score),
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

    function cloneSnapshot(value) {
      return {
        frameIds: value.frameIds.slice(),
        fixedBands: { ...value.fixedBands },
        direction: value.direction,
      };
    }

    function captureInternalState() {
      return {
        frames: frames.slice(),
        fixedBands: { ...fixedBands },
        direction,
        plan,
        nextId,
        history: history.map(cloneSnapshot),
        future: future.map(cloneSnapshot),
        rawFrames: new Map(rawFrames),
      };
    }

    function restoreInternalState(state) {
      frames = state.frames.slice();
      fixedBands = { ...state.fixedBands };
      direction = state.direction;
      plan = state.plan;
      nextId = state.nextId;
      history = state.history.map(cloneSnapshot);
      future = state.future.map(cloneSnapshot);
      rawFrames.clear();
      for (const [id, frame] of state.rawFrames) rawFrames.set(id, frame);
    }

    // Renderer recomposition uses a fresh canvas and only swaps it on success.
    // Keep the model equally transactional so a canvas allocation/render failure
    // cannot leave the timeline ahead of the still-exportable old canvas.
    function beginTransaction() {
      let checkpoint = captureInternalState();
      let active = true;
      return {
        commit() {
          if (!active) return { ok: false, reason: 'transaction-closed' };
          active = false;
          checkpoint = null;
          return { ok: true };
        },
        rollback() {
          if (!active) return { ok: false, reason: 'transaction-closed' };
          restoreInternalState(checkpoint);
          active = false;
          checkpoint = null;
          return { ok: true, plan };
        },
      };
    }

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

    function reachableFrameIds(candidateFrames, candidateHistory, candidateFuture) {
      const ids = new Set(candidateFrames.map((frame) => frame.id));
      for (const state of candidateHistory) {
        for (const id of state.frameIds) ids.add(id);
      }
      for (const state of candidateFuture) {
        for (const id of state.frameIds) ids.add(id);
      }
      return ids;
    }

    function reachableSourcePixels(candidateFrames, candidateHistory, candidateFuture) {
      const candidatesById = new Map(candidateFrames.map((frame) => [frame.id, frame]));
      let total = 0;
      for (const id of reachableFrameIds(candidateFrames, candidateHistory, candidateFuture)) {
        const frame = candidatesById.get(id) || rawFrames.get(id);
        if (!frame) return Number.POSITIVE_INFINITY;
        total += frame.width * frame.height;
        if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
      }
      return total;
    }

    function pruneRawFrames() {
      const reachable = reachableFrameIds(frames, history, future);
      for (const id of rawFrames.keys()) {
        if (!reachable.has(id)) rawFrames.delete(id);
      }
    }

    // Capturing a new frame invalidates redo. If retained undo snapshots alone
    // would push RGBA memory above the source budget, discard the oldest undo
    // snapshots until the new current timeline fits. Current frames are never
    // evicted, so the capture either stays usable or fails the ordinary budget.
    function prepareAcceptedFrame(candidateFrames) {
      const candidateHistory = history.slice();
      const candidateFuture = [];
      while (
        candidateHistory.length > 0 &&
        reachableSourcePixels(candidateFrames, candidateHistory, candidateFuture) > maxSourcePixels
      ) {
        candidateHistory.shift();
      }
      if (reachableSourcePixels(candidateFrames, candidateHistory, candidateFuture) > maxSourcePixels) {
        return { ok: false, reason: 'source-pixel-limit' };
      }
      history = candidateHistory;
      future = candidateFuture;
      return { ok: true };
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
        const retained = prepareAcceptedFrame([frame]);
        if (!retained.ok) return retained;
        frames = [frame];
        rawFrames.set(frame.id, frame);
        plan = candidatePlan;
        nextId += 1;
        pruneRawFrames();
        return { ok: true, status: 'initial', frameId: frame.id, direction: null, plan };
      }

      const reference = frames[0];
      const mismatch = dimensionMismatch(reference, frame, matchOptions.scaleTolerance);
      if (mismatch) return mismatch;
      let candidateBands = fixedBands;
      let autoFixedBands = null;
      let motion = detectFrameMotion(frames, frame, {
        ...matchOptions,
        fixedBands,
        lockedDirection: direction,
      });
      if (!motion.ok) {
        // A real fixed toolbar can block the ordinary tail→head hypothesis. The
        // detector proves both the boundary and body motion before we retry with
        // candidate bands. Nothing is committed until the entire candidate plan
        // passes the normal matching and memory checks below.
        if (fixedBands.top === 0 && fixedBands.bottom === 0) {
          const edge = direction === 'prepend' ? frames[0] : frames[frames.length - 1];
          const suggestion = suggestFixedBands(edge, frame, {
            ...matchOptions,
            minBand: 2,
            lockedDirection: direction,
          });
          if (suggestion.top || suggestion.bottom) {
            candidateBands = { top: suggestion.top, bottom: suggestion.bottom };
            autoFixedBands = candidateBands;
            motion = detectFrameMotion(frames, frame, {
              ...matchOptions,
              fixedBands: candidateBands,
              lockedDirection: direction,
            });
          }
        }
        if (!motion.ok) return motion;
      }
      if (motion.direction === 'idle') return { ok: true, status: 'idle', frameId: null, motion, plan };

      const candidateFrames = motion.direction === 'prepend' ? [frame, ...frames] : [...frames, frame];
      const candidatePlan = buildPlan(candidateFrames, candidateBands, matchOptions);
      const validation = validateCandidateFrames(candidateFrames, candidatePlan);
      if (!validation.ok) return validation;
      const retained = prepareAcceptedFrame(candidateFrames);
      if (!retained.ok) return retained;
      frames = candidateFrames;
      fixedBands = candidateBands;
      rawFrames.set(frame.id, frame);
      plan = candidatePlan;
      direction = direction || motion.direction;
      nextId += 1;
      pruneRawFrames();
      return { ok: true, status: 'accepted', frameId: frame.id, direction, motion, plan, ...(autoFixedBands ? { autoFixedBands: { ...autoFixedBands } } : {}) };
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
      pruneRawFrames();
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
      pruneRawFrames();
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
      pruneRawFrames();
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
      pruneRawFrames();
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
        retainedSourcePixels: sourcePixels(Array.from(rawFrames.values())),
      };
    }

    return {
      addFrame,
      beginTransaction,
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
