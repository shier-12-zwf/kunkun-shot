// 长截图控制条逻辑：定时抓取选区帧，用「行像素匹配」找垂直重叠量，把新内容追加到离屏拼接 canvas。
// 渲染层禁止 require / import，所有与主进程交互都走 window.kkapi。

(function () {
  'use strict';

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

  let timer = null; // setInterval 句柄
  let capturing = false; // 是否处于捕获中
  let busy = false; // 完成/单帧处理中，避免并发
  let frameCount = 0; // 已捕获帧数（含首帧）

  // ====== 算法参数 ======
  const TICK_MS = 700; // 抓帧间隔
  const SAMPLE_COLS = 24; // 每行横向采样点数
  const SEARCH_ROWS = 8; // 用于匹配的「行块」高度（采样多少行做指纹）
  const STEP = 2; // offset 搜索步长（先粗搜，命中后细化）
  const MATCH_TOL = 18; // 单通道像素差阈值，低于视为相同
  const MAX_CANVAS_H = 120000; // 拼接 canvas 最大高度（P2-3：30k→120k 像素，向 PixPin 超长截图靠拢；仍受内存兜底）
  const GROW_STEP = 4000; // canvas 扩容步长（一次性多给一些，减少复制次数）

  // 上一帧的 ImageData，用于「行像素匹配」时取已拼接底部的像素来源。
  // 实际匹配直接从 stitchCtx 取底部行，从新帧 frameCtx 取顶部行。

  // ====== DOM ======
  const $bar = document.getElementById('bar');
  const $hint = document.getElementById('hint');
  const $count = document.getElementById('count');
  const $dot = document.getElementById('liveDot');
  const $btnStart = document.getElementById('btnStart');
  const $btnDone = document.getElementById('btnDone');
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
  async function grabFrame() {
    const dataURL = await kkapi.captureRegion({
      rect: RECT,
      displayId: DISPLAY_ID,
      scaleFactor: SCALE,
    });
    if (!dataURL) throw new Error('captureRegion 返回空');
    return loadDataURL(dataURL);
  }

  // ====== 创建/初始化拼接 canvas（首帧）======
  function initStitch(frame) {
    stitchCanvas = document.createElement('canvas');
    stitchCanvas.width = frame.width; // = rect.width * scaleFactor
    stitchCanvas.height = frame.height; // 起始高度 = 首帧高
    stitchCtx = stitchCanvas.getContext('2d', { willReadFrequently: true });
    stitchCtx.drawImage(frame.canvas, 0, 0);
    stitchedHeight = frame.height;
  }

  // ====== 确保拼接 canvas 至少能容纳 needHeight；不够则用临时 canvas 扩高复制 ======
  function ensureCapacity(needHeight) {
    if (needHeight <= stitchCanvas.height) return true;
    let target = stitchCanvas.height + GROW_STEP;
    while (target < needHeight) target += GROW_STEP;
    if (target > MAX_CANVAS_H) target = MAX_CANVAS_H;
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
  // 返回 { overlap, scrolled } ：
  //   overlap = 新帧顶部与已拼接底部相同的像素行数
  //   新追加的高度 = frameH - overlap
  function matchOverlap(frameCtx, frameW, frameH) {
    const stitchW = stitchCanvas.width;
    const w = Math.min(frameW, stitchW);
    // 忽略最右侧滚动条区域（约 3%），滚动条会移动、破坏匹配
    const mw = Math.max(8, Math.floor(w * 0.97));
    const stitchSampleH = Math.min(stitchedHeight, frameH);
    if (stitchSampleH < SEARCH_ROWS) return { overlap: 0 };
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
      return { overlap: bestOv };
    }
    // 搜索区几乎全空白 → 无法靠像素判定，整帧接上（此时重复的只会是空白，肉眼看不出）
    return { overlap: 0 };
  }

  async function consumeFrame(frame) {
    const m = matchOverlap(frame.ctx, frame.width, frame.height);
    const overlap = m.overlap;
    const appendH = frame.height - overlap;

    // 几乎完全重叠（未滚动）：appendH 很小则不追加。
    // 阈值用帧高的 0.5% 或至少 2px，避免抖动/亚像素噪声反复追加。
    const threshold = Math.max(2, Math.floor(frame.height * 0.005));
    if (appendH <= threshold) {
      return false; // 未滚动，不追加
    }

    // 有内容却没能匹配上重叠（overlap=0 且本应有内容）：多半滚动过快或渲染有差异。
    // 整帧硬接会漏接或重复且无法察觉——改为「丢弃本帧、不拼接」，等用户放慢后下一帧自然能匹配上，
    // 宁可暂停也不静默产出错位长图。警告用红色持久显示，避免被后续 tick 的提示覆盖。
    if (overlap === 0 && m.hadContent) {
      $hint.textContent = '滚动过快，已暂停拼接——请放慢匀速下滚';
      $hint.style.color = '#ff5a5a';
      return false;
    }
    // 正常拼接：清掉可能残留的警告态
    if ($hint.style.color) {
      $hint.style.color = '';
      $hint.textContent = '滚动页面会自动拼接';
    }

    const newHeight = stitchedHeight + appendH;
    if (!ensureCapacity(newHeight)) {
      // 到达 canvas 高度上限：停止继续捕获，提示用户完成。
      stopCapture();
      $hint.textContent = '已达最大长度，请点完成';
      return false;
    }

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
    return true;
  }

  // ====== 定时 tick ======
  async function tick() {
    if (!capturing || busy) return;
    busy = true;
    try {
      const frame = await grabFrame();
      // 帧宽和拼接宽应一致；若不一致（罕见，缩放抖动）按较小宽处理，matchOverlap 已做兼容。
      const changed = await consumeFrame(frame);
      if (changed) updateCount(frameCount + 1);
    } catch (e) {
      // 单帧失败不致命，下个 tick 重试
      // 仅在 hint 上轻提示
      $hint.textContent = '抓帧失败，重试中…';
    } finally {
      busy = false;
    }
  }

  function updateCount(n) {
    frameCount = n;
    $count.textContent = String(n);
  }

  // ====== 开始捕获 ======
  async function startCapture() {
    if (capturing || busy) return;
    busy = true;
    $btnStart.disabled = true;
    $hint.textContent = '正在抓取首帧…';
    try {
      const first = await grabFrame();
      initStitch(first);
      updateCount(1);
      capturing = true;
      $dot.classList.add('live');
      $btnDone.disabled = false;
      $hint.textContent = '滚动页面会自动拼接';
      timer = setInterval(tick, TICK_MS);
    } catch (e) {
      // 首帧失败：恢复可重试
      $btnStart.disabled = false;
      $hint.textContent = '首帧失败，请重试';
    } finally {
      busy = false;
    }
  }

  // ====== 停止定时器（仍保留已拼接内容）======
  function stopCapture() {
    capturing = false;
    $dot.classList.remove('live');
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ====== 完成：导出 -> 保存 + 复制 -> 关窗 ======
  async function finish() {
    if (busy) return;
    stopCapture();

    if (!stitchCanvas || stitchedHeight <= 0) {
      // 还没开始捕获就点完成：直接关闭
      await kkapi.closeSelf();
      return;
    }

    busy = true;
    $bar.classList.add('busy');
    $hint.textContent = '正在拼接并保存…';

    try {
      // 若 canvas 预留高度大于实际拼接高度，先裁到实际高度再导出。
      let exportCanvas = stitchCanvas;
      if (stitchCanvas.height !== stitchedHeight) {
        const out = document.createElement('canvas');
        out.width = stitchCanvas.width;
        out.height = stitchedHeight;
        const octx = out.getContext('2d');
        octx.drawImage(
          stitchCanvas,
          0,
          0,
          stitchCanvas.width,
          stitchedHeight,
          0,
          0,
          stitchCanvas.width,
          stitchedHeight
        );
        exportCanvas = out;
      }

      const dataURL = exportCanvas.toDataURL('image/png');
      if (!dataURL || dataURL.length < 32 || dataURL === 'data:,') {
        throw new Error('导出失败：拼接图过大或为空，无法生成 PNG');
      }
      // 先保存再复制（都等待完成，避免窗口提前关闭打断 IPC）
      await kkapi.saveImage(dataURL);
      await kkapi.copyImage(dataURL);
      await kkapi.closeSelf(); // 成功才关窗
    } catch (e) {
      // 不要静默关窗丢图：唯一一份拼接图在内存里，关窗即丢失。给出可见提示并保留控制条供重试。
      console.error('[longshot] 保存失败', e);
      busy = false;
      $bar.classList.remove('busy');
      $hint.textContent = '保存失败：' + ((e && e.message) || e) + '，可点「完成」重试或「取消」放弃';
    }
  }

  // ====== 取消 ======
  async function cancel() {
    stopCapture();
    await kkapi.closeSelf();
  }

  // ====== 绑定 UI ======
  $btnStart.addEventListener('click', startCapture);
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
    // 兜底：rect 缺失时禁用开始
    if (!RECT || !RECT.width || !RECT.height) {
      $hint.textContent = '选区无效，请取消重来';
      $btnStart.disabled = true;
    }
  });
})();
