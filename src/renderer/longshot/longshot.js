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
    return { canvas: rot, width: frame.height, height: frame.width };
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

  // ====== 创建/初始化拼接 canvas（首帧）======
  function initStitch(frame, pixelBudget) {
    if (!isFrameWithinCanvasBudget(frame.width, frame.height, pixelBudget)) {
      throw new Error('选区分辨率过高，超出长截图的安全内存上限');
    }
    stitchCanvas = document.createElement('canvas');
    stitchCanvas.width = frame.width; // = rect.width * scaleFactor
    stitchCanvas.height = frame.height; // 起始高度 = 首帧高
    stitchCtx = stitchCanvas.getContext('2d', { willReadFrequently: true });
    stitchCtx.drawImage(frame.canvas, 0, 0);
    stitchedHeight = frame.height;
  }

  // ====== 确保拼接 canvas 至少能容纳 needHeight；不够则用临时 canvas 扩高复制 ======
  function ensureCapacity(needHeight, pixelBudget) {
    if (needHeight <= stitchCanvas.height) return true;
    const maxHeight = getMaxCanvasHeight(stitchCanvas.width, pixelBudget);
    if (needHeight > maxHeight) return false;
    let target = stitchCanvas.height + GROW_STEP;
    while (target < needHeight) target += GROW_STEP;
    if (target > maxHeight) target = maxHeight;
    if (target < needHeight) return false; // 已经到上限，装不下

    const tmp = document.createElement('canvas');
    tmp.width = stitchCanvas.width;
    tmp.height = target;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    // 只复制已拼接的有效区域即可
    tctx.drawImage(stitchCanvas, 0, 0, stitchCanvas.width, stitchedHeight, 0, 0, stitchCanvas.width, stitchedHeight);
    stitchCanvas = tmp;
    stitchCtx = tctx;
    return true;
  }

  // ====== 行像素匹配核心 ======
  // 思路：新帧整体相对已拼接底部，可能向下滚动了 d 个像素（0 <= d <= frameH）。
  // 当滚动 d 像素时：新帧的第 0..(frameH-d) 行 应当与 已拼接底部的 (stitchedHeight-(frameH-d))..stitchedHeight 行 相同。
  // 我们枚举「重叠高度 overlap = frameH - d」，从大到小找：重叠越大代表滚动越少。
  // 为效率，用采样行 + 采样列比较，命中即接受。
  //
  // 返回 { overlap, hadContent } ：
  //   overlap = 新帧顶部与已拼接底部相同的像素行数
  //   hadContent = 搜索区是否有足够内容行；有内容但 overlap=0 时应暂停而不是硬接
  //   新追加的高度 = frameH - overlap
  function matchOverlap(frameCtx, frameW, frameH) {
    const stitchW = stitchCanvas.width;
    const w = Math.min(frameW, stitchW);
    // 忽略最右侧滚动条区域（约 3%），滚动条会移动、破坏匹配
    const mw = Math.max(8, Math.floor(w * 0.97));
    const stitchSampleH = Math.min(stitchedHeight, frameH);
    if (stitchSampleH < SEARCH_ROWS) return overlapResult(0, false);
    const sBottom = stitchCtx.getImageData(0, stitchedHeight - stitchSampleH, w, stitchSampleH).data;
    const fTop = frameCtx.getImageData(0, 0, w, stitchSampleH).data;
    const cols = [];
    for (let i = 0; i < SAMPLE_COLS; i++) cols.push(Math.floor(((i + 0.5) / SAMPLE_COLS) * mw));
    const ROW_RATIO = 0.82;
    // 判断某帧行是否“有内容”：采样列的明暗有明显变化（纯空白/纯色行=无内容，不参与判定）
    function isContentRow(fRow) {
      let lo = 255;
      let hi = 0;
      const base = fRow * w * 4;
      for (let k = 0; k < cols.length; k++) {
        const v = fTop[base + cols[k] * 4];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo > 24;
    }
    function rowSimilar(fRow, sRow) {
      let same = 0;
      const fBase = fRow * w * 4;
      const sBase = sRow * w * 4;
      for (let k = 0; k < cols.length; k++) {
        const x4 = cols[k] * 4;
        const fi = fBase + x4;
        const si = sBase + x4;
        if (
          Math.abs(fTop[fi] - sBottom[si]) <= MATCH_TOL &&
          Math.abs(fTop[fi + 1] - sBottom[si + 1]) <= MATCH_TOL &&
          Math.abs(fTop[fi + 2] - sBottom[si + 2]) <= MATCH_TOL
        ) same++;
      }
      return same / cols.length >= ROW_RATIO;
    }
    // 只在“内容行”上判定重叠相似度；重叠区几乎全是空白行则判为无法判定(-1)
    function scoreOverlap(overlap) {
      let ok = 0;
      let content = 0;
      for (let i = 0; i < SEARCH_ROWS; i++) {
        const fRow = Math.floor(((i + 0.5) / SEARCH_ROWS) * overlap);
        const sRow = stitchSampleH - overlap + fRow;
        if (sRow < 0 || sRow >= stitchSampleH || fRow >= stitchSampleH) continue;
        if (!isContentRow(fRow)) continue;
        content++;
        if (rowSimilar(fRow, sRow)) ok++;
      }
      if (content < 2) return -1;
      return ok / content;
    }
    const maxOverlap = stitchSampleH;
    const minOverlap = SEARCH_ROWS;
    // 取“内容行相似度”最高的 overlap；并列偏向更大 overlap（少接、避免重复）
    let bestOv = 0;
    let bestScore = 0;
    let anyContent = false;
    for (let ov = maxOverlap; ov >= minOverlap; ov -= STEP) {
      const sc = scoreOverlap(ov);
      if (sc < 0) continue;
      anyContent = true;
      if (sc > bestScore) {
        bestScore = sc;
        bestOv = ov;
      }
    }
    if (anyContent && bestScore >= 0.62 && bestOv >= minOverlap) {
      return overlapResult(bestOv, true);
    }
    // 搜索区几乎全空白 → 无法靠像素判定，整帧接上（此时重复的只会是空白，肉眼看不出）
    return overlapResult(0, anyContent);
  }

  function consumeFrame(frame, token) {
    if (!captureSession || !captureSession.isCurrent(token)) return { status: 'stale', changed: false };
    const m = matchOverlap(frame.ctx, frame.width, frame.height);
    const overlap = m.overlap;
    const appendH = frame.height - overlap;

    // 几乎完全重叠（未滚动）：appendH 很小则不追加。
    // 阈值用帧高的 0.5% 或至少 2px，避免抖动/亚像素噪声反复追加。
    const threshold = Math.max(2, Math.floor(frame.height * 0.005));
    if (appendH <= threshold) {
      displacementGate.observe(0);
      return { status: 'idle', changed: false }; // 未滚动，不追加
    }

    // 纯色/全透明等视觉空帧无法产生可靠重叠。不再把整帧硬接上去，
    // 由会话的连续失败计数进行有界重试。
    if (overlap === 0 && !m.hadContent) {
      displacementGate.resetPending();
      return { status: 'empty-frame', changed: false };
    }

    // 有内容却没能匹配上重叠（overlap=0 且本应有内容）：多半滚动过快或渲染有差异。
    // 整帧硬接会漏接或重复且无法察觉——改为「丢弃本帧、不拼接」，等用户放慢后下一帧自然能匹配上，
    // 宁可暂停也不静默产出错位长图。警告用红色持久显示，避免被后续 tick 的提示覆盖。
    if (shouldPauseForUnmatchedContent(m)) {
      $hint.textContent = '滚动过快，已暂停拼接——请放慢匀速下滚';
      $hint.style.color = '#ff5a5a';
      displacementGate.resetPending();
      return { status: 'unmatched', changed: false };
    }

    // 单帧的重叠误判不立即写入 canvas；等连续位移样本稳定后再接入当前帧。
    // 因为当前帧仍然相对已拼接底部做匹配，等待确认不会丢掉中间内容。
    const movement = displacementGate.observe(appendH);
    if (!movement.confirmed) {
      $hint.style.color = '';
      $hint.textContent = '正在确认稳定位移…';
      return { status: 'movement-pending', changed: false };
    }
    // 正常拼接：清掉可能残留的警告态
    if ($hint.style.color) {
      $hint.style.color = '';
      $hint.textContent = '滚动页面会自动拼接';
    }

    const newHeight = stitchedHeight + appendH;
    const pixelBudget = captureSession.getLimits().maxPixels;
    if (
      !captureSession.canFitCanvas(token, stitchCanvas.width, newHeight) ||
      !ensureCapacity(newHeight, pixelBudget)
    ) {
      return { status: 'terminal', reason: 'pixel-limit', changed: false };
    }

    if (!captureSession.isCurrent(token)) return { status: 'stale', changed: false };

    // 把新帧的 [overlap, frame.height) 这段，绘制到拼接 canvas 底部
    stitchCtx.drawImage(
      frame.canvas,
      0,
      overlap,
      frame.width,
      appendH, // 源区域
      0,
      stitchedHeight,
      frame.width,
      appendH // 目标区域
    );
    stitchedHeight = newHeight;
    captureSession.updateStitchedPixels(token, stitchCanvas.width, stitchedHeight);
    return { status: 'movement', changed: true };
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
      return '连续 ' + String(count || DEFAULT_MAX_CONSECUTIVE_FAILURES) + ' 次抓帧失败，已安全停止';
    }
    if (reason === 'frame-limit') return '已达会话最大帧数，请点完成';
    if (reason === 'pixel-limit') return '已达图像像素/内存安全上限，请点完成';
    return '捕获已停止，可保存已拼接内容';
  }

  function endCapture(reason, count) {
    capturing = false;
    clearCaptureTimer();
    $dot.classList.remove('live');
    if (captureSession && captureSession.isCurrent(captureToken)) captureSession.fail(captureToken, reason);
    $hint.style.color = '#b45309';
    $hint.textContent = captureTerminalMessage(reason, count);
    $btnDone.disabled = !stitchCanvas || stitchedHeight <= 0;
    $btnStart.disabled = !!stitchCanvas;
    $btnDir.disabled = !!stitchCanvas;
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

      updateCount(result.frameCount);
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
      $cropTopVal.textContent = $cropTop.value + 'px';
      $cropBottomVal.textContent = $cropBottom.value + 'px';
    }
  }

  // ====== 开始捕获 ======
  async function startCapture() {
    if (capturing || captureBusy || finishing || stitchCanvas) return;
    operationGeneration += 1;
    captureSession = createLongshotSession(sessionOptions);
    captureHorizontal = horizontal;
    captureToken = captureSession.start(captureHorizontal ? 'horizontal' : 'vertical');
    displacementGate = createDisplacementGate({ confirmations: 2, toleranceRatio: 0.65 });
    idleStreak = 0;
    failureStreak = 0;
    captureBusy = true;
    $btnStart.disabled = true;
    $btnDir.disabled = true;
    $hint.style.color = '';
    $hint.textContent = '正在抓取首帧…';
    try {
      const token = captureToken;
      const result = await runCaptureStep({
        session: captureSession,
        token,
        capture: () => grabFrame(captureHorizontal),
        consume: (first) => {
          initStitch(first, captureSession.getLimits().maxPixels);
          captureSession.updateStitchedPixels(token, first.width, first.height);
          return { status: 'initial', changed: true };
        },
      });
      if (result.status === 'stale') return;
      if (result.status !== 'ok') throw (result.error || new Error(result.reason || '首帧失败'));
      captureSession.recordSuccess(token);
      updateCount(result.frameCount);
      capturing = true;
      $dot.classList.add('live');
      $btnDone.disabled = false;
      $hint.textContent = captureHorizontal ? '水平滚动页面会自动拼接' : '滚动页面会自动拼接';
      scheduleNextTick('idle', 0);
    } catch (e) {
      // 首帧失败：恢复可重试
      if (captureSession && captureSession.isCurrent(captureToken)) captureSession.stop('first-frame-failure');
      captureToken = null;
      stitchCanvas = null;
      stitchCtx = null;
      stitchedHeight = 0;
      updateCount(0);
      $cropBox.hidden = true;
      $btnStart.disabled = false;
      $btnDir.disabled = false;
      $hint.textContent = '首帧失败，请重试';
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
  $btnStart.addEventListener('click', startCapture);
  $cropTop.addEventListener('input', () => { $cropTopVal.textContent = $cropTop.value + 'px'; });
  $cropBottom.addEventListener('input', () => { $cropBottomVal.textContent = $cropBottom.value + 'px'; });
  $btnDone.addEventListener('click', finish);
  $btnCancel.addEventListener('click', cancel);

  // Esc 取消 / Enter 完成（已捕获时）
  window.addEventListener('keydown', (e) => {
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
