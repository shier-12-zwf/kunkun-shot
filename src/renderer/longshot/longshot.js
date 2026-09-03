// 长截图控制条逻辑：定时抓取选区帧，用「行像素匹配」找垂直重叠量，把新内容追加到离屏拼接 canvas。
// 渲染层禁止 require / import，所有与主进程交互都走 window.kkapi。

(function () {
  'use strict';

  // Canvas 像素通常以 RGBA 常驻内存，扩容/导出时还会短暂同时保留两份。
  // 20M 像素约 80 MiB/份，既给 128 MiB 图片 IPC 上限留出 PNG/base64 余量，
  // 也避免只按高度放行 4K×120000 这类会稳定耗尽内存的尺寸。
  const MAX_CANVAS_H = 120000;
  const MAX_CANVAS_PIXELS = 20 * 1024 * 1024;
  const DEFAULT_MAX_FRAMES = 1000;
  const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
  const GROW_STEP = 4000;

  function positiveInteger(value, fallback, maximum) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, maximum);
  }

  function normalizeDirection(value) {
    if (value === 'horizontal' || value === 'vertical') return value;
    return null;
  }

  function getMaxCanvasHeight(width, pixelBudget) {
    const w = Math.floor(Number(width));
    if (!Number.isFinite(w) || w <= 0) return 0;
    const budget = positiveInteger(pixelBudget, MAX_CANVAS_PIXELS, MAX_CANVAS_PIXELS);
    return Math.max(0, Math.min(MAX_CANVAS_H, Math.floor(budget / w)));
  }

  function isFrameWithinCanvasBudget(width, height, pixelBudget) {
    const h = Math.floor(Number(height));
    return Number.isFinite(h) && h > 0 && h <= getMaxCanvasHeight(width, pixelBudget);
  }

  // Renderer 的异步抓帧不能靠几个全局布尔量表达生命周期。每次 start 生成新 token，
  // stop/超限会立即使 token 失效，这样在途 capture Promise 即使稍后成功也不能触发拼接。
  function createLongshotSession(options) {
    const opts = options || {};
    const limits = {
      maxFrames: positiveInteger(opts.maxFrames, DEFAULT_MAX_FRAMES, 100000),
      maxPixels: positiveInteger(opts.maxPixels, MAX_CANVAS_PIXELS, MAX_CANVAS_PIXELS),
      maxConsecutiveFailures: positiveInteger(
        opts.maxConsecutiveFailures,
        DEFAULT_MAX_CONSECUTIVE_FAILURES,
        100
      ),
    };
    const directionConfirmations = positiveInteger(opts.directionConfirmations, 2, 10);
    let generation = 0;
    let active = false;
    let direction = null;
    let directionCandidate = null;
    let directionCandidateCount = 0;
    let frameCount = 0;
    let consecutiveFailures = 0;
    let stitchedPixels = 0;
    let terminalReason = null;

    function terminate(reason) {
      active = false;
      terminalReason = reason || 'stopped';
      generation += 1;
    }

    function start(requestedDirection) {
      generation += 1;
      active = true;
      direction = normalizeDirection(requestedDirection);
      directionCandidate = null;
      directionCandidateCount = 0;
      frameCount = 0;
      consecutiveFailures = 0;
      stitchedPixels = 0;
      terminalReason = null;
      return generation;
    }

    function isCurrent(token) {
      return active && token === generation;
    }

    function stop(reason) {
      if (active) terminate(reason || 'stopped');
      else if (!terminalReason) terminalReason = reason || 'stopped';
    }

    function observeDirection(token, observedDirection) {
      if (!isCurrent(token)) return direction;
      const observed = normalizeDirection(observedDirection);
      if (!observed || direction) return direction;
      if (directionCandidate === observed) directionCandidateCount += 1;
      else {
        directionCandidate = observed;
        directionCandidateCount = 1;
      }
      if (directionCandidateCount >= directionConfirmations) direction = observed;
      return direction;
    }

    function recordFailure(token) {
      if (!isCurrent(token)) {
        return {
          accepted: false,
          terminal: true,
          consecutiveFailures,
          reason: terminalReason || 'stale',
        };
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= limits.maxConsecutiveFailures) {
        const count = consecutiveFailures;
        terminate('capture-failures');
        return {
          accepted: true,
          terminal: true,
          consecutiveFailures: count,
          reason: 'capture-failures',
        };
      }
      return { accepted: true, terminal: false, consecutiveFailures };
    }

    function recordSuccess(token) {
      if (!isCurrent(token)) return false;
      consecutiveFailures = 0;
      return true;
    }

    function admitFrame(token, frame) {
      if (!isCurrent(token)) {
        return { accepted: false, terminal: true, reason: terminalReason || 'stale' };
      }
      const width = Math.floor(Number(frame && frame.width));
      const height = Math.floor(Number(frame && frame.stitchedHeight));
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        return { accepted: false, terminal: false, reason: 'invalid-frame' };
      }
      if (frameCount >= limits.maxFrames) {
        terminate('frame-limit');
        return { accepted: false, terminal: true, reason: 'frame-limit' };
      }
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
        terminate('pixel-limit');
        return { accepted: false, terminal: true, reason: 'pixel-limit' };
      }
      frameCount += 1;
      stitchedPixels = Math.max(stitchedPixels, pixels);
      return { accepted: true, terminal: false, frameCount, stitchedPixels };
    }

    function canFitCanvas(token, width, height) {
      if (!isCurrent(token)) return false;
      const pixels = Math.floor(Number(width)) * Math.floor(Number(height));
      return Number.isSafeInteger(pixels) && pixels > 0 && pixels <= limits.maxPixels;
    }

    function updateStitchedPixels(token, width, height) {
      if (!canFitCanvas(token, width, height)) return false;
      stitchedPixels = Math.max(stitchedPixels, Math.floor(Number(width)) * Math.floor(Number(height)));
      return true;
    }

    function fail(token, reason) {
      if (!isCurrent(token)) return false;
      terminate(reason);
      return true;
    }

    function getState() {
      return {
        active,
        direction,
        frameCount,
        consecutiveFailures,
        stitchedPixels,
        terminalReason,
      };
    }

    return {
      start,
      stop,
      fail,
      isCurrent,
      observeDirection,
      recordFailure,
      recordSuccess,
      admitFrame,
      canFitCanvas,
      updateStitchedPixels,
      getState,
      getLimits: () => ({ ...limits }),
    };
  }

  async function runCaptureStep(args) {
    const session = args.session;
    const token = args.token;
    try {
      const frame = await args.capture();
      if (!session.isCurrent(token)) return { status: 'stale' };
      if (!frame || !Number.isFinite(Number(frame.width)) || !Number.isFinite(Number(frame.height))) {
        const emptyFailure = session.recordFailure(token, 'empty-frame');
        return {
          status: emptyFailure.terminal ? 'terminal' : 'failure',
          reason: emptyFailure.reason || 'empty-frame',
          consecutiveFailures: emptyFailure.consecutiveFailures,
        };
      }
      const admission = session.admitFrame(token, {
        width: frame.width,
        stitchedHeight: frame.stitchedHeight || frame.height,
      });
      if (!admission.accepted) {
        if (admission.reason === 'invalid-frame') {
          const invalidFailure = session.recordFailure(token, 'invalid-frame');
          return {
            status: invalidFailure.terminal ? 'terminal' : 'failure',
            reason: invalidFailure.reason || 'invalid-frame',
            consecutiveFailures: invalidFailure.consecutiveFailures,
          };
        }
        return { status: admission.terminal ? 'terminal' : 'failure', reason: admission.reason };
      }
      const value = args.consume ? await args.consume(frame, token) : undefined;
      if (!session.isCurrent(token)) return { status: 'stale' };
      return { status: 'ok', value, frameCount: admission.frameCount };
    } catch (error) {
      if (!session.isCurrent(token)) return { status: 'stale' };
      const failure = session.recordFailure(token, 'capture-error');
      return {
        status: failure.terminal ? 'terminal' : 'failure',
        reason: failure.reason || 'capture-error',
        consecutiveFailures: failure.consecutiveFailures,
        error,
      };
    }
  }

  // 位移需要连续稳定样本才确认；方向一旦锁定，反向的单帧噪声只会被丢弃。
  function createDisplacementGate(options) {
    const opts = options || {};
    const confirmations = positiveInteger(opts.confirmations, 2, 10);
    const toleranceRatio = Math.max(0, Math.min(2, Number(opts.toleranceRatio) || 0.65));
    let direction = null;
    let candidateDirection = null;
    let candidateMagnitude = 0;
    let candidateCount = 0;

    function resetPending() {
      candidateDirection = null;
      candidateMagnitude = 0;
      candidateCount = 0;
    }

    function observe(delta) {
      const amount = Number(delta);
      if (!Number.isFinite(amount) || Math.abs(amount) < 1) {
        resetPending();
        return { confirmed: false, reason: 'idle', direction };
      }
      const observedDirection = amount > 0 ? 'forward' : 'backward';
      const magnitude = Math.abs(amount);
      if (direction && observedDirection !== direction) {
        resetPending();
        return { confirmed: false, reason: 'opposite-direction', direction };
      }
      if (candidateDirection !== observedDirection) {
        candidateDirection = observedDirection;
        candidateMagnitude = magnitude;
        candidateCount = 1;
      } else {
        const tolerance = Math.max(2, candidateMagnitude * toleranceRatio);
        if (Math.abs(magnitude - candidateMagnitude) > tolerance) {
          candidateMagnitude = magnitude;
          candidateCount = 1;
          return { confirmed: false, reason: 'unstable-displacement', direction };
        }
        candidateCount += 1;
        candidateMagnitude = (candidateMagnitude + magnitude) / 2;
      }
      if (candidateCount < confirmations) {
        return { confirmed: false, reason: 'awaiting-confirmation', direction };
      }
      if (!direction) direction = observedDirection;
      resetPending();
      return { confirmed: true, direction, displacement: Math.round(magnitude) };
    }

    return {
      observe,
      resetPending,
      getState: () => ({ direction, candidateDirection, candidateMagnitude, candidateCount }),
    };
  }

  function getNextCaptureDelay(status, streak) {
    const n = Math.max(0, Math.floor(Number(streak) || 0));
    if (status === 'movement') return 180;
    if (status === 'movement-pending' || status === 'unmatched') return 240;
    if (status === 'failure') return Math.min(2000, 400 * Math.pow(2, Math.max(0, n - 1)));
    if (status === 'idle') return Math.min(1000, 320 + n * 120);
    return 320;
  }

  // 把「异步解码 + 横向转置」保留为可独立测试的边界。横向分支必须等图片解码
  // 完成后才能读取 width/height/canvas；否则拿到的是 Promise，首帧会直接失败。
  async function loadFrameForDirection(loadFrame, dataURL, isHorizontal, createCanvas) {
    const frame = await loadFrame(dataURL);
    if (!isHorizontal) return frame;

    const rot = createCanvas();
    rot.width = frame.height;
    rot.height = frame.width;
    const rctx = rot.getContext('2d', { willReadFrequently: true });
    rctx.translate(frame.height / 2, frame.width / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(frame.canvas, -frame.width / 2, -frame.height / 2);
    return { canvas: rot, ctx: rctx, width: frame.height, height: frame.width };
  }

  function overlapResult(overlap, hadContent) {
    return { overlap: overlap, hadContent: !!hadContent };
  }

  function shouldPauseForUnmatchedContent(match) {
    return !!match && match.overlap === 0 && match.hadContent === true;
  }

  async function saveLongshotAndClose(api, dataURL, shouldContinue) {
    const isCurrent = typeof shouldContinue === 'function' ? shouldContinue : () => true;
    if (!isCurrent()) return { stale: true };
    const result = await api.saveImage(dataURL);
    if (!isCurrent()) return { stale: true };
    if (!result || result.saved !== true) {
      throw new Error('保存已取消或失败');
    }
    await api.copyImage(dataURL);
    if (!isCurrent()) return { stale: true };
    await api.closeSelf();
    return { saved: true };
  }

  // Node 回归测试只加载上面的纯函数，不初始化 renderer DOM。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      loadFrameForDirection,
      overlapResult,
      shouldPauseForUnmatchedContent,
      MAX_CANVAS_PIXELS,
      DEFAULT_MAX_FRAMES,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
      getMaxCanvasHeight,
      isFrameWithinCanvasBudget,
      saveLongshotAndClose,
      createLongshotSession,
      runCaptureStep,
      createDisplacementGate,
      getNextCaptureDelay,
    };
    return;
  }

  // ====== 初始化数据（由主进程通过 onInit 注入）======
  // payload: { rect, displayBounds, scaleFactor, displayId }
  let RECT = null; // 选区，CSS px：{ x, y, width, height }
  let DISPLAY_ID = null; // 显示器 id
  let SCALE = 1; // 设备像素比

  // ====== 拼接状态 ======
  // 离屏拼接 canvas：宽 = rect.width * scaleFactor（设备像素），高度随拼接动态增长。
  let stitchCanvas = null;
  let stitchCtx = null;
  let stitchedHeight = 0; // 当前已拼接的实际像素高度（canvas 可能比它高，预留空间）
  let stitchTimeline = null; // 保留原始帧 + 可重建的片段计划
  let rawFrameSequence = 0;
  let fixedSuggestionShown = false;
  let suggestedFixedBands = null;

  let timer = null; // 单次 setTimeout 句柄；每帧结束后按状态自适应调度下一帧
  let capturing = false; // 是否处于捕获中
  let captureBusy = false; // 单帧处理中，避免并发
  let finishing = false; // 导出/保存中
  let horizontal = false; // 横向滚动模式（帧转置复用纵向拼接）
  let captureHorizontal = false; // 会话开始时锁定，捕获中不再读取可变 UI 值
  let frameCount = 0; // 已捕获帧数（含首帧）
  let captureSession = null;
  let captureToken = null;
  let sessionOptions = {};
  let displacementGate = null;
  let idleStreak = 0;
  let failureStreak = 0;
  let operationGeneration = 0; // 保存/取消也需要抵御迟到回调

  const stitchApi = window.LongshotStitch;

  // ====== 算法参数 ======
  const SAMPLE_COLS = 24; // 每行横向采样点数
  const SEARCH_ROWS = 8; // 用于匹配的「行块」高度（采样多少行做指纹）
  const STEP = 2; // offset 搜索步长（先粗搜，命中后细化）
  const MATCH_TOL = 18; // 单通道像素差阈值，低于视为相同
  // 上一帧的 ImageData，用于「行像素匹配」时取已拼接底部的像素来源。
  // 实际匹配直接从 stitchCtx 取底部行，从新帧 frameCtx 取顶部行。

  // ====== DOM ======
  const $bar = document.getElementById('bar');
  const $hint = document.getElementById('hint');
  const $count = document.getElementById('count');
  const $dot = document.getElementById('liveDot');
  const $btnStart = document.getElementById('btnStart');
  const $btnDone = document.getElementById('btnDone');
  const $cropBox = document.getElementById('cropBox');
  const $cropTop = document.getElementById('cropTop');
  const $cropBottom = document.getElementById('cropBottom');
  const $cropTopVal = document.getElementById('cropTopVal');
  const $cropBottomVal = document.getElementById('cropBottomVal');
  const $btnDir = document.getElementById('btnDir');
  const $btnCancel = document.getElementById('btnCancel');
  const $editBox = document.getElementById('editBox');
  const $segmentSelect = document.getElementById('segmentSelect');
  const $btnDeleteSegment = document.getElementById('btnDeleteSegment');
  const $btnUndo = document.getElementById('btnUndo');
  const $btnRedo = document.getElementById('btnRedo');
  const $fixedTop = document.getElementById('fixedTop');
  const $fixedBottom = document.getElementById('fixedBottom');
  const $btnSuggestFixed = document.getElementById('btnSuggestFixed');
  const $btnApplyFixed = document.getElementById('btnApplyFixed');

  // ====== 工具：把 dataURL 画到一个临时 canvas，拿到 ctx + 尺寸 ======
  function loadDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve({ canvas: c, ctx, width: c.width, height: c.height });
      };
      img.onerror = () => reject(new Error('帧图片解码失败'));
      img.src = dataURL;
    });
  }

  // ====== 抓一帧 ======
  async function grabFrame(isHorizontal) {
    const dataURL = await kkapi.captureRegion({
      rect: RECT,
      displayId: DISPLAY_ID,
      scaleFactor: SCALE,
    });
    if (!dataURL) throw new Error('captureRegion 返回空');
    return loadFrameForDirection(
      loadDataURL,
      dataURL,
      isHorizontal,
      () => document.createElement('canvas')
    );
  }

  function timelineError(reason, fallback) {
    const error = new Error(fallback || reason || '长截图拼接失败');
    error.code = reason || 'stitch-error';
    return error;
  }

  function capturedGeometry(frame) {
    const sourceWidth = Math.max(1, Math.round(Number(RECT && RECT.width) * SCALE));
    const sourceHeight = Math.max(1, Math.round(Number(RECT && RECT.height) * SCALE));
    const expectedWidth = captureHorizontal ? sourceHeight : sourceWidth;
    const expectedHeight = captureHorizontal ? sourceWidth : sourceHeight;
    // macOS 的选区边界可因非整数 DPR 有1px取整差；更大差异表示显示器/DPR
    // 已改变，继续拼接会必然错位，必须明确拒绝。
    if (Math.abs(frame.width - expectedWidth) > 1 || Math.abs(frame.height - expectedHeight) > 1) {
      return {
        ok: false,
        reason: 'scale-mismatch',
        expectedWidth,
        expectedHeight,
        actualWidth: frame.width,
        actualHeight: frame.height,
      };
    }
    return { ok: true };
  }

  function rawFrameFromCanvas(frame) {
    const geometry = capturedGeometry(frame);
    if (!geometry.ok) return geometry;
    let pixels;
    try {
      pixels = frame.ctx.getImageData(0, 0, frame.width, frame.height).data;
    } catch (error) {
      return { ok: false, reason: 'pixel-read-failed', error };
    }
    rawFrameSequence += 1;
    return {
      ok: true,
      frame: {
        id: 'frame-' + rawFrameSequence,
        width: frame.width,
        height: frame.height,
        scaleFactor: SCALE,
        pixels,
      },
    };
  }

  // Rebuild into a fresh canvas and swap only after every segment succeeded. The old
  // canvas therefore remains exportable if an edit/recomposition ever throws.
  function renderTimeline() {
    if (!stitchTimeline) return false;
    const composed = stitchTimeline.compose();
    if (!composed.ok) return false;
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = composed.width;
    nextCanvas.height = composed.height;
    const nextContext = nextCanvas.getContext('2d', { willReadFrequently: true });
    if (!nextContext) return false;
    const imageData = nextContext.createImageData(composed.width, composed.height);
    imageData.data.set(composed.pixels);
    nextContext.putImageData(imageData, 0, 0);
    stitchCanvas = nextCanvas;
    stitchCtx = nextContext;
    stitchedHeight = composed.height;
    return true;
  }

  function refreshEditControls() {
    const state = stitchTimeline && stitchTimeline.getState();
    const frames = state ? state.frames : [];
    $editBox.hidden = frames.length === 0;
    const selected = $segmentSelect.value;
    $segmentSelect.replaceChildren();
    frames.forEach((frame, index) => {
      const option = document.createElement('option');
      option.value = frame.id;
      option.textContent = '帧 ' + String(index + 1) + ' · ' + frame.id;
      $segmentSelect.appendChild(option);
    });
    if (frames.some((frame) => frame.id === selected)) $segmentSelect.value = selected;
    else if (frames.length) $segmentSelect.value = frames[frames.length - 1].id;
    $btnDeleteSegment.disabled = frames.length <= 1 || capturing || finishing;
    $segmentSelect.disabled = frames.length === 0 || capturing || finishing;
    $btnUndo.disabled = !state || !state.canUndo || capturing || finishing;
    $btnRedo.disabled = !state || !state.canRedo || capturing || finishing;
    $btnSuggestFixed.disabled = frames.length < 2 || capturing || finishing;
    $btnApplyFixed.disabled = frames.length < 1 || capturing || finishing;
    $fixedTop.disabled = frames.length < 1 || capturing || finishing;
    $fixedBottom.disabled = frames.length < 1 || capturing || finishing;
    if (state) {
      $fixedTop.max = String(Math.max(0, Math.min(...frames.map((frame) => frame.height)) - 1));
      $fixedBottom.max = $fixedTop.max;
      const displayedBands = suggestedFixedBands && state.fixedBands.top === 0 && state.fixedBands.bottom === 0
        ? suggestedFixedBands
        : state.fixedBands;
      $fixedTop.value = String(displayedBands.top);
      $fixedBottom.value = String(displayedBands.bottom);
    }
  }

  function maybeOfferFixedSuggestion() {
    if (!stitchTimeline || fixedSuggestionShown) return false;
    const state = stitchTimeline.getState();
    if (state.frames.length < 2 || state.fixedBands.top || state.fixedBands.bottom) return false;
    const suggestion = stitchTimeline.suggestFixedBands({ minBand: 3 });
    if (!suggestion.top && !suggestion.bottom) return false;
    fixedSuggestionShown = true;
    suggestedFixedBands = { top: suggestion.top, bottom: suggestion.bottom };
    $fixedTop.value = String(suggestion.top);
    $fixedBottom.value = String(suggestion.bottom);
    $hint.style.color = '#2563eb';
    $hint.textContent = '检测到固定区域建议，确认后点「应用」';
    return true;
  }

  // ====== 初始化原始帧时间线（首帧）======
  function initStitch(frame, pixelBudget) {
    if (!stitchApi || typeof stitchApi.createStitchTimeline !== 'function') {
      throw timelineError('stitch-helper-missing', '长截图拼接模块未加载');
    }
    if (!isFrameWithinCanvasBudget(frame.width, frame.height, pixelBudget)) {
      throw timelineError('pixel-limit', '选区分辨率过高，超出长截图的安全内存上限');
    }
    const raw = rawFrameFromCanvas(frame);
    if (!raw.ok) throw timelineError(raw.reason, '抓帧尺寸或像素无效');
    stitchTimeline = stitchApi.createStitchTimeline({
      maxFrames: captureSession.getLimits().maxFrames,
      maxPixels: pixelBudget,
      // 原始帧和输出各自上限 20M 像素，防止高重叠抓帧无界占用内存。
      maxSourcePixels: pixelBudget,
      minOverlap: SEARCH_ROWS,
      matchThreshold: 0.9,
      ambiguityMargin: 0.025,
      tolerance: MATCH_TOL,
    });
    const added = stitchTimeline.addFrame(raw.frame);
    if (!added.ok) {
      stitchTimeline = null;
      throw timelineError(added.reason, '首帧无法用于可靠拼接');
    }
    if (!renderTimeline()) {
      stitchTimeline = null;
      throw timelineError('render-failed', '首帧渲染失败');
    }
    refreshEditControls();
  }

  function unmatchedMessage(reason) {
    if (reason === 'ambiguous-match' || reason === 'ambiguous-direction') {
      return '重叠候选不唯一，已保留上一版——请小段慢速滚动';
    }
    if (reason === 'reverse-direction') {
      return '检测到反向滚动，本帧未接入——请沿原方向继续';
    }
    return '未找到可靠重叠，已保留上一版——请放慢滚动';
  }

  function consumeFrame(frame, token) {
    if (!captureSession || !captureSession.isCurrent(token)) return { status: 'stale', changed: false };
    if (!stitchTimeline) return { status: 'terminal', reason: 'stitch-helper-missing', changed: false };
    const raw = rawFrameFromCanvas(frame);
    if (!raw.ok) return { status: 'terminal', reason: raw.reason, changed: false };
    const added = stitchTimeline.addFrame(raw.frame);
    if (!added.ok) {
      if (added.reason === 'blank-frame') return { status: 'empty-frame', changed: false };
      if (added.reason === 'fixed-bands-suggested') {
        suggestedFixedBands = { top: added.suggestion.top, bottom: added.suggestion.bottom };
        fixedSuggestionShown = true;
        $fixedTop.value = String(suggestedFixedBands.top);
        $fixedBottom.value = String(suggestedFixedBands.bottom);
        return { status: 'terminal', reason: 'fixed-bands-suggested', changed: false };
      }
      if (['width-mismatch', 'scale-mismatch', 'pixel-read-failed'].includes(added.reason)) {
        return { status: 'terminal', reason: added.reason, changed: false };
      }
      if (['pixel-limit', 'source-pixel-limit', 'frame-limit'].includes(added.reason)) {
        return { status: 'terminal', reason: added.reason, changed: false };
      }
      $hint.style.color = '#ff5a5a';
      $hint.textContent = unmatchedMessage(added.reason);
      return { status: 'unmatched', reason: added.reason, changed: false };
    }
    if (added.status === 'idle') return { status: 'idle', changed: false };
    if (!captureSession.isCurrent(token)) return { status: 'stale', changed: false };
    if (!renderTimeline()) return { status: 'terminal', reason: 'render-failed', changed: false };
    captureSession.updateStitchedPixels(token, stitchCanvas.width, stitchedHeight);
    refreshEditControls();
    const offeredSuggestion = maybeOfferFixedSuggestion();
    if (!offeredSuggestion) {
      $hint.style.color = '';
      $hint.textContent = captureHorizontal ? '水平滚动页面会自动拼接' : '滚动页面会自动拼接';
    }
    return { status: 'movement', changed: true, direction: added.direction };
  }

  function clearCaptureTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function scheduleNextTick(status, streak) {
    clearCaptureTimer();
    if (!capturing || !captureSession || !captureSession.isCurrent(captureToken)) return;
    timer = setTimeout(tick, getNextCaptureDelay(status, streak));
  }

  function captureTerminalMessage(reason, count) {
    if (reason === 'capture-failures') {
      return '连续 ' + String(count || DEFAULT_MAX_CONSECUTIVE_FAILURES) + ' 次抓帧失败，已保留原始帧，可点「继续」';
    }
    if (reason === 'frame-limit') return '已达会话最大帧数，可完成或删除片段后继续';
    if (reason === 'pixel-limit' || reason === 'source-pixel-limit') return '已达图像/原始帧内存上限，可删除片段或完成';
    if (reason === 'width-mismatch') return '抓帧宽度已变化，为避免错位已拒绝；恢复原窗口尺寸后可继续';
    if (reason === 'scale-mismatch') return '显示器或 DPR 已变化，为避免错位已拒绝；恢复后可继续';
    if (reason === 'fixed-bands-suggested') return '检测到固定顶部/底部建议；确认数值并点「应用」后继续';
    if (reason === 'render-failed') return '重新拼接失败，旧图与原始帧仍保留';
    return '捕获已停止，内容已保留，可继续或完成';
  }

  function endCapture(reason, count) {
    capturing = false;
    clearCaptureTimer();
    $dot.classList.remove('live');
    if (captureSession && captureSession.isCurrent(captureToken)) captureSession.fail(captureToken, reason);
    $hint.style.color = '#b45309';
    $hint.textContent = captureTerminalMessage(reason, count);
    $btnDone.disabled = !stitchCanvas || stitchedHeight <= 0;
    $btnStart.disabled = false;
    $btnStart.querySelector('.label').textContent = stitchCanvas ? '继续' : '开始';
    $btnDir.disabled = !!stitchCanvas;
    refreshEditControls();
  }

  // ====== 单次自适应 tick ======
  async function tick() {
    if (!capturing || captureBusy || finishing || !captureSession) return;
    const token = captureToken;
    captureBusy = true;
    let cadenceStatus = 'idle';
    let cadenceStreak = idleStreak;
    try {
      const result = await runCaptureStep({
        session: captureSession,
        token,
        capture: () => grabFrame(captureHorizontal),
        consume: (frame) => consumeFrame(frame, token),
      });
      if (result.status === 'stale') return;
      if (result.status === 'terminal') {
        endCapture(result.reason, result.consecutiveFailures);
        return;
      }
      if (result.status === 'failure') {
        failureStreak = result.consecutiveFailures || failureStreak + 1;
        idleStreak = 0;
        cadenceStatus = 'failure';
        cadenceStreak = failureStreak;
        $hint.style.color = '#b45309';
        $hint.textContent = '抓帧失败（' + failureStreak + '），将自动重试…';
        return;
      }

      const outcome = result.value || { status: 'idle', changed: false };
      if (outcome.status === 'terminal') {
        endCapture(outcome.reason);
        return;
      }
      if (outcome.status === 'empty-frame') {
        const failure = captureSession.recordFailure(token, 'empty-frame');
        failureStreak = failure.consecutiveFailures;
        idleStreak = 0;
        if (failure.terminal) {
          endCapture(failure.reason, failure.consecutiveFailures);
          return;
        }
        cadenceStatus = 'failure';
        cadenceStreak = failureStreak;
        $hint.style.color = '#b45309';
        $hint.textContent = '抓到空帧（' + failureStreak + '），将自动重试…';
        return;
      }

      captureSession.recordSuccess(token);
      failureStreak = 0;
      updateCount(stitchTimeline ? stitchTimeline.getState().frames.length : 0);
      cadenceStatus = outcome.status;
      if (outcome.status === 'idle') {
        idleStreak += 1;
        cadenceStreak = idleStreak;
      } else {
        idleStreak = 0;
        cadenceStreak = 0;
      }
    } finally {
      captureBusy = false;
      scheduleNextTick(cadenceStatus, cadenceStreak);
    }
  }

  function updateCount(n) {
    frameCount = n;
    $count.textContent = String(n);
    // 有内容后显示裁剪控件，并把范围上限对齐当前拼接高度
    if (stitchedHeight > 0) {
      $cropBox.hidden = false;
      var maxCrop = Math.max(0, stitchedHeight - 8);
      $cropTop.max = String(maxCrop);
      $cropBottom.max = String(maxCrop);
      if ((parseInt($cropTop.value, 10) || 0) > maxCrop) $cropTop.value = String(maxCrop);
      if ((parseInt($cropBottom.value, 10) || 0) > maxCrop) $cropBottom.value = String(maxCrop);
      $cropTopVal.textContent = $cropTop.value + 'px';
      $cropBottomVal.textContent = $cropBottom.value + 'px';
    }
  }

  // ====== 开始捕获 ======
  async function startCapture() {
    if (capturing || captureBusy || finishing) return;
    const hadExistingTimeline = !!stitchTimeline;
    operationGeneration += 1;
    captureSession = createLongshotSession(sessionOptions);
    captureHorizontal = horizontal;
    captureToken = captureSession.start(captureHorizontal ? 'horizontal' : 'vertical');
    idleStreak = 0;
    failureStreak = 0;
    captureBusy = true;
    $btnStart.disabled = true;
    $btnDir.disabled = true;
    $hint.style.color = '';
    $hint.textContent = hadExistingTimeline ? '正在恢复捕获…' : '正在抓取首帧…';
    try {
      const token = captureToken;
      const result = await runCaptureStep({
        session: captureSession,
        token,
        capture: () => grabFrame(captureHorizontal),
        consume: (first) => {
          if (stitchTimeline) return consumeFrame(first, token);
          initStitch(first, captureSession.getLimits().maxPixels);
          captureSession.updateStitchedPixels(token, first.width, first.height);
          return { status: 'initial', changed: true };
        },
      });
      if (result.status === 'stale') return;
      if (result.status === 'terminal') {
        endCapture(result.reason, result.consecutiveFailures);
        return;
      }
      if (result.status !== 'ok') throw (result.error || timelineError(result.reason, '首帧失败'));
      const outcome = result.value || { status: 'idle', changed: false };
      if (outcome.status === 'terminal') {
        endCapture(outcome.reason);
        return;
      }
      captureSession.recordSuccess(token);
      updateCount(stitchTimeline ? stitchTimeline.getState().frames.length : 0);
      capturing = true;
      $dot.classList.add('live');
      $btnDone.disabled = false;
      $btnStart.disabled = false;
      $btnStart.querySelector('.label').textContent = '暂停';
      if (outcome.status !== 'unmatched') {
        $hint.textContent = captureHorizontal ? '水平滚动页面会自动拼接' : '滚动页面会自动拼接';
      }
      refreshEditControls();
      scheduleNextTick('idle', 0);
    } catch (e) {
      // 失败时只丢弃本轮在途捕获；既有时间线与上次可导出画布不动。
      if (captureSession && captureSession.isCurrent(captureToken)) captureSession.stop('first-frame-failure');
      captureToken = null;
      if (!hadExistingTimeline) {
        stitchTimeline = null;
        stitchCanvas = null;
        stitchCtx = null;
        stitchedHeight = 0;
        updateCount(0);
        $cropBox.hidden = true;
      }
      $btnStart.disabled = false;
      $btnDir.disabled = !!stitchTimeline;
      $btnStart.querySelector('.label').textContent = stitchTimeline ? '继续' : '开始';
      $hint.style.color = '#b45309';
      $hint.textContent = (hadExistingTimeline ? '继续捕获失败，原始帧已保留' : '首帧失败，请重试') +
        (e && e.code ? '（' + e.code + '）' : '');
      refreshEditControls();
    } finally {
      captureBusy = false;
    }
  }

  // ====== 停止定时器（仍保留已拼接内容）======
  function stopCapture(reason) {
    capturing = false;
    $dot.classList.remove('live');
    clearCaptureTimer();
    if (captureSession && captureSession.isCurrent(captureToken)) {
      captureSession.stop(reason || 'stopped');
    }
  }

  function pauseCaptureForUser() {
    if (!capturing) return;
    stopCapture('paused');
    $btnStart.disabled = false;
    $btnStart.querySelector('.label').textContent = '继续';
    $btnDir.disabled = !!stitchTimeline;
    $hint.style.color = '';
    $hint.textContent = '已暂停：可删除片段、调整固定区域，或继续捕获';
    refreshEditControls();
  }

  function timelineMutationMessage(result) {
    if (!result) return '操作失败';
    if (result.reason === 'ambiguous-match') return '删除后相邻帧有多个重叠候选，已取消操作';
    if (result.reason === 'no-match') return '删除后相邻帧无法可靠衔接，已取消操作';
    if (result.reason === 'last-frame') return '至少需保留一帧';
    if (result.reason === 'pixel-limit' || result.reason === 'source-pixel-limit') return '重新拼接超出内存安全上限';
    if (result.reason === 'nothing-to-undo') return '没有可撤销的操作';
    if (result.reason === 'nothing-to-redo') return '没有可重做的操作';
    return '操作失败：' + (result.reason || '未知原因');
  }

  function finishTimelineEdit(result, successMessage) {
    if (!result || !result.ok) {
      $hint.style.color = '#ff5a5a';
      $hint.textContent = timelineMutationMessage(result);
      return false;
    }
    if (!renderTimeline()) {
      $hint.style.color = '#ff5a5a';
      $hint.textContent = '重新拼接失败，上一版导出图仍保留';
      return false;
    }
    updateCount(stitchTimeline.getState().frames.length);
    refreshEditControls();
    $hint.style.color = '';
    $hint.textContent = successMessage;
    return true;
  }

  function deleteSelectedSegment() {
    if (!stitchTimeline || capturing || finishing) return;
    const id = $segmentSelect.value;
    finishTimelineEdit(stitchTimeline.deleteFrame(id), '已删除选中帧并从原始帧重新拼接');
  }

  function undoTimelineEdit() {
    if (!stitchTimeline || capturing || finishing) return;
    suggestedFixedBands = null;
    finishTimelineEdit(stitchTimeline.undo(), '已撤销并重新拼接');
  }

  function redoTimelineEdit() {
    if (!stitchTimeline || capturing || finishing) return;
    suggestedFixedBands = null;
    finishTimelineEdit(stitchTimeline.redo(), '已重做并重新拼接');
  }

  function suggestFixedRegions() {
    if (!stitchTimeline || capturing || finishing) return;
    const suggestion = stitchTimeline.suggestFixedBands({ minBand: 2 });
    if (!suggestion.top && !suggestion.bottom) {
      $hint.style.color = '#b45309';
      $hint.textContent = '未检测到稳定固定区域，可手动输入像素值';
      return;
    }
    suggestedFixedBands = { top: suggestion.top, bottom: suggestion.bottom };
    fixedSuggestionShown = true;
    $fixedTop.value = String(suggestion.top);
    $fixedBottom.value = String(suggestion.bottom);
    $hint.style.color = '#2563eb';
    $hint.textContent = '建议顶部 ' + suggestion.top + 'px、底部 ' + suggestion.bottom + 'px；确认后点「应用」';
  }

  function applyFixedRegions() {
    if (!stitchTimeline || capturing || finishing) return;
    const top = Math.max(0, parseInt($fixedTop.value, 10) || 0);
    const bottom = Math.max(0, parseInt($fixedBottom.value, 10) || 0);
    const result = stitchTimeline.setFixedBands({ top, bottom });
    if (result.ok) suggestedFixedBands = null;
    finishTimelineEdit(result, '已应用固定顶部/底部并重新拼接');
  }

  // ====== 完成：导出 -> 保存 + 复制 -> 关窗 ======
  async function finish() {
    if (finishing) return;
    stopCapture('finished');
    const finishGeneration = ++operationGeneration;

    if (!stitchCanvas || stitchedHeight <= 0) {
      // 还没开始捕获就点完成：直接关闭
      finishing = true;
      await kkapi.closeSelf();
      return;
    }

    finishing = true;
    $bar.classList.add('busy');
    $hint.style.color = '';
    $hint.textContent = '正在拼接并保存…';

    try {
      // P2-3：手动裁剪（上/下裁掉多余区域）
      const cropT = Math.max(0, Math.min(parseInt($cropTop.value, 10) || 0, stitchedHeight - 8));
      const cropB = Math.max(0, Math.min(parseInt($cropBottom.value, 10) || 0, stitchedHeight - 8 - cropT));
      const finalH = stitchedHeight - cropT - cropB;
      let exportCanvas = stitchCanvas;

      // 裁剪和横向还原最多只创建一个额外 canvas，避免“预留裁剪 + 手动裁剪 +
      // 旋转”连续保留三份完整 RGBA 位图造成峰值内存倍增。
      if (captureHorizontal) {
        const rot = document.createElement('canvas');
        rot.width = finalH;
        rot.height = stitchCanvas.width;
        const rctx = rot.getContext('2d');
        rctx.translate(rot.width / 2, rot.height / 2);
        rctx.rotate(-Math.PI / 2);
        rctx.drawImage(
          stitchCanvas,
          0,
          cropT,
          stitchCanvas.width,
          finalH,
          -stitchCanvas.width / 2,
          -finalH / 2,
          stitchCanvas.width,
          finalH
        );
        exportCanvas = rot;
      } else if (cropT > 0 || cropB > 0 || stitchCanvas.height !== stitchedHeight) {
        const out = document.createElement('canvas');
        out.width = stitchCanvas.width;
        out.height = finalH;
        const octx = out.getContext('2d');
        octx.drawImage(
          stitchCanvas,
          0,
          cropT,
          stitchCanvas.width,
          finalH,
          0,
          0,
          stitchCanvas.width,
          finalH
        );
        exportCanvas = out;
      }

      const dataURL = exportCanvas.toDataURL('image/png');
      if (!dataURL || dataURL.length < 32 || dataURL === 'data:,') {
        throw new Error('导出失败：拼接图过大或为空，无法生成 PNG');
      }
      // 只有主进程明确返回 saved:true 才复制并关窗；取消保存或失败时保留拼接图供重试。
      await saveLongshotAndClose(
        kkapi,
        dataURL,
        () => finishing && finishGeneration === operationGeneration
      );
    } catch (e) {
      if (finishGeneration !== operationGeneration) return;
      // 不要静默关窗丢图：唯一一份拼接图在内存里，关窗即丢失。给出可见提示并保留控制条供重试。
      console.error('[longshot] 保存失败', e);
      finishing = false;
      $bar.classList.remove('busy');
      $hint.textContent = '保存失败：' + ((e && e.message) || e) + '，可点「完成」重试或「取消」放弃';
      $btnStart.disabled = false;
      $btnStart.querySelector('.label').textContent = '继续';
      refreshEditControls();
    }
  }

  // ====== 取消 ======
  async function cancel() {
    operationGeneration += 1;
    finishing = false;
    stopCapture('cancelled');
    await kkapi.closeSelf();
  }

  // ====== 绑定 UI ======
  $btnDir.addEventListener('click', () => {
    if (capturing || captureBusy || finishing || stitchCanvas) return;
    horizontal = !horizontal;
    $btnDir.querySelector('.label').textContent = horizontal ? '横向' : '纵向';
    $btnDir.title = '切换滚动方向（当前：' + (horizontal ? '横向' : '纵向') + '）';
    $hint.textContent = horizontal ? '水平滚动页面会自动拼接' : '滚动页面会自动拼接';
  });
  $btnStart.addEventListener('click', () => {
    if (capturing) pauseCaptureForUser();
    else startCapture();
  });
  $btnDeleteSegment.addEventListener('click', deleteSelectedSegment);
  $btnUndo.addEventListener('click', undoTimelineEdit);
  $btnRedo.addEventListener('click', redoTimelineEdit);
  $btnSuggestFixed.addEventListener('click', suggestFixedRegions);
  $btnApplyFixed.addEventListener('click', applyFixedRegions);
  $cropTop.addEventListener('input', () => { $cropTopVal.textContent = $cropTop.value + 'px'; });
  $cropBottom.addEventListener('input', () => { $cropBottomVal.textContent = $cropBottom.value + 'px'; });
  $btnDone.addEventListener('click', finish);
  $btnCancel.addEventListener('click', cancel);

  // Esc 取消 / Enter 完成（已捕获时）
  window.addEventListener('keydown', (e) => {
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && e.key.toLowerCase() === 'z' && stitchTimeline && !capturing && !finishing) {
      e.preventDefault();
      if (e.shiftKey) redoTimelineEdit();
      else undoTimelineEdit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      if (!$btnDone.disabled) {
        e.preventDefault();
        finish();
      }
    }
  });

  // ====== 接收初始化 payload ======
  kkapi.onInit((payload) => {
    if (!payload) return;
    if (!stitchApi || typeof stitchApi.createStitchTimeline !== 'function') {
      $hint.textContent = '长截图拼接模块加载失败，请重启应用';
      $hint.style.color = '#ff5a5a';
      $btnStart.disabled = true;
      return;
    }
    RECT = payload.rect;
    DISPLAY_ID = payload.displayId;
    SCALE = payload.scaleFactor || 1;
    const limits = payload.longshotLimits || {};
    sessionOptions = {
      maxFrames: limits.maxFrames,
      maxPixels: limits.maxPixels,
      maxConsecutiveFailures: limits.maxConsecutiveFailures,
    };
    // 兜底：rect 缺失时禁用开始
    if (!RECT || !RECT.width || !RECT.height) {
      $hint.textContent = '选区无效，请取消重来';
      $btnStart.disabled = true;
    }
  });
})();
