// 录屏控制条逻辑（渲染层，纯浏览器环境，仅通过 window.kkapi 与主进程交互）
(function () {
  'use strict';

  const api = window.kkapi;

  // ---- DOM 引用 ----
  const elBar = document.getElementById('bar');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnStop = document.getElementById('btnStop');
  const elBtnPause = document.getElementById('btnPause');
  const elBtnRetry = document.getElementById('btnRetry');
  const elBtnCancel = document.getElementById('btnCancel');
  const elStatus = document.getElementById('status');
  const elTimer = document.getElementById('timer');
  const elToast = document.getElementById('toast');

  // ---- 初始化 payload（由主进程通过 onInit 注入）----
  // 结构: { rect, displayBounds, scaleFactor, displayId, fps, toGif }
  let init = {
    rect: { x: 0, y: 0, width: 0, height: 0 },
    displayBounds: { x: 0, y: 0, width: 0, height: 0 },
    scaleFactor: 1,
    displayId: '',
    fps: 15,
    toGif: false,
  };

  // ---- 录制运行时状态 ----
  let captureStream = null; // getUserMedia 拿到的整屏流
  let canvasStream = null; // canvas.captureStream 产出的裁剪流
  let recorder = null; // MediaRecorder 实例
  let videoEl = null; // 隐藏的 <video>
  let canvasEl = null; // 离屏绘制用 canvas
  let drawTimer = null; // setInterval 句柄
  let chunks = []; // 录制数据块
  let recordedBytes = 0;
  let sizeLimitReached = false;
  // 当前保存协议需要 Blob → ArrayBuffer → IPC 的整包传输；把单次上限控制在 128 MiB，
  // 避免 renderer、structured clone 与主进程副本叠加成数 GiB 内存峰值。
  const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
  let pendingRecordingBlob = null; // 保存失败时保留唯一副本，允许用户重试或主动放弃
  let saveInProgress = false;
  let timerInterval = null; // 计时器句柄
  let startedAt = 0; // 录制开始时间戳
  let isRecording = false;
  let isPaused = false; // 是否正在录制
  let isFinishing = false; // 是否正在停止保存（防重复触发）
  let toastTimer = null;

  // ====== 工具函数 ======

  // 显示提示信息（error 为 true 用危险色，否则用普通色）
  function showToast(msg, isError) {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    elToast.textContent = msg;
    elToast.style.color = isError ? '#ef4444' : '#1f2329';
    elToast.hidden = false;
    elToast.classList.remove('with-action');
    elBtnRetry.hidden = true;
    // 隐藏其余控件，让提示占满胶囊
    elBtnStart.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
  }

  // 隐藏提示，恢复正常控件
  function hideToast() {
    elToast.hidden = true;
    elToast.classList.remove('with-action');
    elBtnRetry.hidden = true;
    elBtnStart.hidden = isRecording;
    elStatus.hidden = false;
    elBtnStop.hidden = !isRecording;
  }

  // 可恢复错误：显示红色错误文案，但保留「开始」按钮可点（不像 showToast 那样隐藏全部控件导致只能关窗重来），
  // 数秒后自动恢复控件。用于 startRecording 失败后让用户原地重试。
  function showRecoverableError(msg) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    elToast.textContent = msg;
    elToast.style.color = '#ef4444';
    elToast.hidden = false;
    elToast.classList.remove('with-action');
    elBtnRetry.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
    elBtnStart.hidden = false; // 关键：保留开始按钮，允许原地重试
    toastTimer = setTimeout(hideToast, 4000);
  }

  function showSaveRetry(msg) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    elToast.textContent = msg;
    elToast.style.color = '#ef4444';
    elToast.hidden = false;
    elToast.classList.add('with-action');
    elBtnStart.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
    elBtnPause.hidden = true;
    elBtnRetry.hidden = false;
    elBtnRetry.disabled = false;
  }

  // 格式化计时 mm:ss（超过一小时显示 hh:mm:ss）
  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // 计时器：每 200ms 刷新一次显示
  function startTimer() {
    startedAt = Date.now();
    elTimer.textContent = '00:00';
    timerInterval = setInterval(() => {
      elTimer.textContent = formatTime(Date.now() - startedAt);
    }, 200);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ====== 资源清理：停掉所有流、定时器、video ======
  function teardown() {
    if (drawTimer) {
      clearInterval(drawTimer);
      drawTimer = null;
    }
    stopTimer();
    // 停 MediaRecorder
    if (recorder) {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (e) {
        /* 忽略 */
      }
    }
    // 停所有 track（整屏流 + canvas 流）
    const stopTracks = (stream) => {
      if (!stream) return;
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        /* 忽略 */
      }
    };
    stopTracks(captureStream);
    stopTracks(canvasStream);
    captureStream = null;
    canvasStream = null;
    // 释放 video
    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.srcObject = null;
      } catch (e) {
        /* 忽略 */
      }
      videoEl = null;
    }
  }

  // ====== 开始录制 ======
  async function startRecording() {
    if (isRecording || isFinishing) return;

    const scale = init.scaleFactor || 1;
    const rect = init.rect || {};
    const db = init.displayBounds || {};

    // 计算裁剪后画布尺寸（设备像素），保证 >=1 且为整数
    const canvasW = Math.max(1, Math.round((rect.width || 0) * scale));
    const canvasH = Math.max(1, Math.round((rect.height || 0) * scale));

    try {
      // 1. 找到目标显示器对应的采集源
      const sources = await api.getSources();
      if (!sources || !sources.length) {
        throw new Error('未找到可录制的屏幕源');
      }
      let source = sources.find((s) => String(s.display_id) === String(init.displayId));
      // macOS 上 source.display_id 可能为空串，直接匹配会失败 → 按主进程传来的显示器序号兜底，避免录错屏。
      if (!source && init.displayIndex != null && init.displayIndex >= 0 && sources[init.displayIndex]) {
        source = sources[init.displayIndex];
      }
      if (!source) source = sources[0]; // 仍找不到则退回第一个

      // 2. 整屏媒体流（Electron desktop 采集，需用 mandatory 约束）
      const maxW = Math.max(1, Math.round((db.width || 0) * scale));
      const maxH = Math.max(1, Math.round((db.height || 0) * scale));
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: maxW,
            maxHeight: maxH,
          },
        },
      });
    } catch (err) {
      // 权限被拒 / 无可用源 等
      const msg = (err && (err.message || err.name)) || '获取屏幕流失败';
      let hint = '录制失败：' + msg;
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        hint = '录屏被拒绝，请在系统设置中授予屏幕录制权限';
      } else if (/NotFound|no.*source/i.test(msg)) {
        hint = '未找到可录制的屏幕源';
      }
      teardown();
      showRecoverableError(hint); // 保留开始按钮，允许原地重试（而非隐藏全部控件只能关窗）
      return;
    }

    try {
      // 3. 隐藏 video 播放整屏流
      videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.srcObject = captureStream;
      // 等待元数据，确保有有效帧
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        videoEl.onloadedmetadata = finish;
        // 兜底：1s 后无论如何继续
        setTimeout(finish, 1000);
      });
      try {
        await videoEl.play();
      } catch (e) {
        /* 自动播放可能被忽略，但 srcObject 已就绪，可继续绘制 */
      }

      // 4. 离屏 canvas，按裁剪区域绘制
      canvasEl = document.createElement('canvas');
      canvasEl.width = canvasW;
      canvasEl.height = canvasH;
      const ctx = canvasEl.getContext('2d');

      // 源裁剪坐标（设备像素）
      const sx = Math.round((rect.x || 0) * scale);
      const sy = Math.round((rect.y || 0) * scale);
      const sw = canvasW;
      const sh = canvasH;
      const fps = init.fps && init.fps > 0 ? init.fps : 15;

      // 把 video 的裁剪区域逐帧画到 canvas
      drawTimer = setInterval(() => {
        if (!videoEl) return;
        try {
          ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
        } catch (e) {
          /* 帧未就绪时忽略 */
        }
      }, Math.max(1, Math.round(1000 / fps)));

      // 5. 从 canvas 取流并录制
      canvasStream = canvasEl.captureStream(fps);

      // 优先 vp9，失败退 vp8，再退默认
      const candidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      let chosen = '';
      for (const t of candidates) {
        if (
          typeof MediaRecorder !== 'undefined' &&
          MediaRecorder.isTypeSupported &&
          MediaRecorder.isTypeSupported(t)
        ) {
          chosen = t;
          break;
        }
      }

      chunks = [];
      recordedBytes = 0;
      sizeLimitReached = false;
      pendingRecordingBlob = null;
      try {
        recorder = chosen
          ? new MediaRecorder(canvasStream, { mimeType: chosen })
          : new MediaRecorder(canvasStream);
      } catch (e) {
        // 指定 mimeType 失败时，退回不带参数
        recorder = new MediaRecorder(canvasStream);
      }

      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size <= 0) return;
        if (recordedBytes + ev.data.size > MAX_RECORDING_BYTES) {
          sizeLimitReached = true;
          if (isRecording && !isFinishing) setTimeout(stopRecording, 0);
          return;
        }
        chunks.push(ev.data);
        recordedBytes += ev.data.size;
      };
      recorder.onstop = onRecorderStop;
      recorder.onerror = () => {
        if (!isFinishing) {
          teardown();
          showToast('录制过程出错', true);
          isRecording = false;
          elBar.classList.remove('recording');
        }
      };

      // 每秒切一个数据块，避免单块过大
      recorder.start(1000);

      // 6. 进入录制状态，更新 UI + 计时
      isRecording = true;
      isPaused = false;
      elBar.classList.add('recording');
      hideToast();
      elBtnStart.hidden = true;
      elBtnPause.hidden = false;
      elBtnPause.textContent = '⏸';
      elBtnPause.title = '暂停录制';
      elBtnStop.hidden = false;
      elBtnStop.disabled = false;
      startTimer();
    } catch (err) {
      const msg = (err && (err.message || err.name)) || '初始化录制失败';
      teardown();
      isRecording = false;
      elBar.classList.remove('recording');
      showRecoverableError('录制失败：' + msg); // 保留开始按钮，允许原地重试
    }
  }

  // ====== MediaRecorder 停止后的回调：组装 blob 并保存 ======
  async function savePendingRecording() {
    if (!pendingRecordingBlob || saveInProgress) return;
    saveInProgress = true;
    try {
      showToast('正在保存…', false);
      const buffer = await pendingRecordingBlob.arrayBuffer();
      const res = await api.saveRecording({
        buffer,
        mime: 'video/webm',
        toGif: !!init.toGif,
        fps: init.fps && init.fps > 0 ? init.fps : 15,
        trimStart: parseInt(document.getElementById('trimStart').value, 10) || 0,
        trimEnd: parseInt(document.getElementById('trimEnd').value, 10) || 0,
      });

      if (res && res.saved === true) {
        pendingRecordingBlob = null;
        chunks = [];
        recordedBytes = 0;
        api.closeSelf();
        return;
      }
      const detail = res && res.error ? `保存失败：${res.error}` : '录屏尚未保存，可重试或点 × 放弃';
      showSaveRetry(detail);
    } catch (err) {
      const msg = (err && (err.message || err.name)) || '保存失败';
      showSaveRetry('保存失败：' + msg);
    } finally {
      saveInProgress = false;
    }
  }

  async function onRecorderStop() {
    // 仅在用户主动停止时保存（取消时 isFinishing 为 false）
    if (!isFinishing) return;
    try {
      pendingRecordingBlob = new Blob(chunks, { type: 'video/webm' });
    } catch (err) {
      showSaveRetry('整理录屏失败：' + ((err && err.message) || String(err)));
      return;
    } finally {
      teardown();
    }
    if (!pendingRecordingBlob.size) {
      pendingRecordingBlob = null;
      chunks = [];
      recordedBytes = 0;
      showToast('录制内容为空', true);
      return;
    }
    await savePendingRecording();
  }

  // ====== 停止并保存 ======
  // ====== 暂停 / 继续（P2-4：录制中间暂停，最终仍导出一段连续视频）======
  function togglePause() {
    if (!isRecording || isFinishing || !recorder) return;
    if (recorder.state !== 'recording' && recorder.state !== 'paused') return;
    try {
      if (isPaused) {
        recorder.resume();
        isPaused = false;
        elBar.classList.remove('paused');
        elBtnPause.textContent = '⏸';
        elBtnPause.title = '暂停录制';
        startTimer();
        showToast('继续录制', false);
      } else {
        recorder.pause();
        isPaused = true;
        elBar.classList.add('paused');
        elBtnPause.textContent = '▶';
        elBtnPause.title = '继续录制';
        stopTimer();
        showToast('已暂停（点 ▶ 继续）', false);
      }
    } catch (e) {
      showToast('暂停/继续失败：' + (e && e.message ? e.message : e), true);
    }
  }
  elBtnPause.addEventListener('click', togglePause);

  function stopRecording() {
    if (!isRecording || isFinishing) return;
    isFinishing = true;
    isRecording = false;
    isPaused = false;
    elBar.classList.remove('recording');
    elBar.classList.remove('paused');
    elBtnStop.disabled = true;
    elBtnPause.hidden = true;
    stopTimer();

    // 先停绘制，再停 recorder（其 onstop 会触发保存）
    if (drawTimer) {
      clearInterval(drawTimer);
      drawTimer = null;
    }
    showToast(sizeLimitReached ? '已达到 128MB 上限，正在保存…' : '正在保存…', false);

    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        // recorder 已停或不存在，直接走保存流程
        onRecorderStop();
      }
    } catch (e) {
      onRecorderStop();
    }

    // 停掉采集 track（保留 chunks，已在 stop 前收集）
    const stopTracks = (stream) => {
      if (!stream) return;
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        /* 忽略 */
      }
    };
    // 整屏流可立即停；canvas 流由 recorder.stop 触发 onstop 后无需保留
    stopTracks(captureStream);
  }

  // ====== 取消录制：停一切，不保存，关窗 ======
  function cancelRecording() {
    isFinishing = false; // 确保 onstop 不触发保存
    isRecording = false;
    elBar.classList.remove('recording');
    chunks = [];
    recordedBytes = 0;
    sizeLimitReached = false;
    pendingRecordingBlob = null;
    saveInProgress = false;
    teardown();
    api.cancelCapture && api.cancelCapture(); // 通知主进程取消（若实现则生效）
    api.closeSelf();
  }

  // ====== 事件绑定 ======
  elBtnStart.addEventListener('click', startRecording);
  elBtnStop.addEventListener('click', stopRecording);
  elBtnRetry.addEventListener('click', savePendingRecording);
  elBtnCancel.addEventListener('click', cancelRecording);

  // Esc 取消
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelRecording();
    }
  });

  // 接收主进程注入的初始化数据
  api.onInit((payload) => {
    if (payload && typeof payload === 'object') {
      init = Object.assign(init, payload);
    }
    // 初始 UI：等待开始
    elBtnStop.hidden = true;
    elBtnStop.disabled = true;
    elBtnStart.hidden = false;
  });
})();
