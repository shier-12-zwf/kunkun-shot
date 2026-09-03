// 录屏控制条逻辑（渲染层，纯浏览器环境，仅通过 window.kkapi 与主进程交互）
(function () {
  'use strict';

  const api = window.kkapi;
  const lifecycleContract = window.KKRecorderLifecycle;
  const overlayContract = window.KKRecorderOverlays;
  if (!lifecycleContract || typeof lifecycleContract.createRecorderLifecycle !== 'function') {
    throw new Error('录屏生命周期模块未加载');
  }
  if (
    !overlayContract
    || typeof overlayContract.createRecorderOverlayState !== 'function'
    || typeof overlayContract.resolveRecorderCaptureGeometry !== 'function'
  ) {
    throw new Error('录屏操作提示模块未加载');
  }
  const { RECORDER_STATES, createRecorderLifecycle } = lifecycleContract;
  const overlayState = overlayContract.createRecorderOverlayState();
  const stateReportsInFlight = new Set();

  function reportLifecycleState(snapshot) {
    if (typeof api.reportRecordingState !== 'function') return;
    let report;
    try {
      // invoke 在这里同步发出 IPC，同一 renderer 的状态顺序由 Electron 保持；
      // 不把 starting 排在较慢的 idle 响应后，缩小二次启动误关窗的窗口期。
      report = Promise.resolve(api.reportRecordingState(snapshot)).catch(() => {});
    } catch (_) {
      return;
    }
    stateReportsInFlight.add(report);
    report.then(() => stateReportsInFlight.delete(report));
  }

  const lifecycle = createRecorderLifecycle({
    onChange: reportLifecycleState,
  });

  function flushLifecycleState() {
    return Promise.all([...stateReportsInFlight]).then(() => undefined, () => undefined);
  }

  // ---- DOM 引用 ----
  const elBar = document.getElementById('bar');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnStop = document.getElementById('btnStop');
  const elBtnPause = document.getElementById('btnPause');
  const elBtnCamera = document.getElementById('btnCamera');
  const elBtnActions = document.getElementById('btnActions');
  const elBtnPen = document.getElementById('btnPen');
  const elBtnClearPen = document.getElementById('btnClearPen');
  const elBtnRetry = document.getElementById('btnRetry');
  const elBtnCancel = document.getElementById('btnCancel');
  const elStatus = document.getElementById('status');
  const elTimer = document.getElementById('timer');
  const elToast = document.getElementById('toast');

  // ---- 初始化 payload（由主进程通过 onInit 注入）----
  // 结构: { rect, displayBounds, scaleFactor, displayId, fps, toGif, systemAudio, microphone }
  // 音频选项只有严格为 true 时才开启，保证旧版 WINDOW_INIT payload 默认仍为静音录屏。
  let init = {
    rect: { x: 0, y: 0, width: 0, height: 0 },
    displayBounds: { x: 0, y: 0, width: 0, height: 0 },
    scaleFactor: 1,
    displayId: '',
    fps: 15,
    toGif: false,
    systemAudio: false,
    microphone: false,
  };

  // ---- 录制运行时状态 ----
  let captureStream = null; // getUserMedia 拿到的整屏流
  let microphoneStream = null; // 可选麦克风流（与整屏流分开申请）
  let cameraStream = null; // 用户显式开启的摄像头画中画流（不采集相机音频）
  let canvasStream = null; // canvas.captureStream 产出的裁剪流
  let audioMixContext = null; // 系统音频 + 麦克风同时开启时的 Web Audio 混音器
  let audioMixNodes = [];
  let recorder = null; // MediaRecorder 实例
  let videoEl = null; // 隐藏的 <video>
  let cameraVideoEl = null; // 隐藏的摄像头 <video>
  let canvasEl = null; // 离屏绘制用 canvas
  let recordingPixelWidth = 0; // 实际桌面流裁剪后的输出像素（保留至保存）
  let recordingPixelHeight = 0;
  let actionGeometry = init; // 输入坐标与实际录制像素的映射
  let drawTimer = null; // setInterval 句柄
  let chunks = []; // 录制数据块
  let recordedBytes = 0;
  let sizeLimitReached = false;
  // 当前保存协议需要 Blob → ArrayBuffer → IPC 的整包传输；把单次上限控制在 128 MiB，
  // 避免 renderer、structured clone 与主进程副本叠加成数 GiB 内存峰值。
  const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
  const RECORDER_STOP_WATCHDOG_MS = 4000;
  const PARTIAL_RECORDING_CAUSES = Object.freeze({
    RECORDER_ERROR: 'recorder-error',
    STOP_TIMEOUT: 'stop-timeout',
  });
  let pendingRecordingBlob = null; // 保存失败时保留唯一副本，允许用户重试或主动放弃
  let saveInProgress = false;
  let timerInterval = null; // 计时器句柄
  let startedAt = 0; // 当前活跃录制段的开始时间戳
  let elapsedBeforePause = 0; // 暂停前已完成的录制时长（不含暂停时间）
  let isRecording = false;
  let isStarting = false; // 防止双击并发申请媒体权限/设备
  let isPaused = false; // 是否正在录制
  let isFinishing = false; // 是否正在停止保存（防重复触发）
  let partialRecordingCause = null; // 编码器出错/停止确认超时后，只允许用户确认保存部分录屏
  let hasFinalizedRecorderStop = false; // 每次录制只允许一个 stop/watchdog 进入序列化
  let recorderStopWatchdog = null;
  let terminalCloseRequested = false; // 只有已保存/已确认放弃才能正常关窗
  let toastTimer = null;
  let cameraRequested = false;
  let cameraTrackDisposers = [];
  let cameraStartupFailure = null;
  let actionsRequested = false;
  let actionMonitorActive = false;
  let actionMonitorStartPending = false;
  let actionMonitorGeneration = 0;
  let penRequested = false;

  // ====== 工具函数 ======

  function setPressed(element, value) {
    element.classList.toggle
      ? element.classList.toggle('active', value === true)
      : (value === true ? element.classList.add('active') : element.classList.remove('active'));
    if (element.setAttribute) element.setAttribute('aria-pressed', value === true ? 'true' : 'false');
  }

  function setOptionControlsVisible(visible) {
    elBtnCamera.hidden = !visible;
    elBtnActions.hidden = !visible;
    elBtnPen.hidden = !visible;
    elBtnClearPen.hidden = !visible;
  }

  function syncOptionControls() {
    setPressed(elBtnCamera, cameraRequested);
    setPressed(elBtnActions, actionsRequested);
    setPressed(elBtnPen, penRequested);
    const optionsLocked = isStarting || isRecording || isFinishing;
    elBtnCamera.disabled = optionsLocked;
    elBtnActions.disabled = optionsLocked;
    // 画笔可在录制进行时开关，但媒体初始化期间不接受操作，
    // 避免用户在 helper 尚未 ready 时看到虚假的“已开启”状态。
    elBtnPen.disabled = !actionsRequested || isStarting || isFinishing;
    elBtnClearPen.disabled = !actionsRequested || isStarting || isFinishing;
  }

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
    elToast.classList.remove('runtime-warning');
    elBtnRetry.hidden = true;
    // 隐藏其余控件，让提示占满胶囊
    elBtnStart.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
    setOptionControlsVisible(false);
  }

  // 隐藏提示，恢复正常控件
  function hideToast() {
    elToast.hidden = true;
    elToast.classList.remove('with-action');
    elToast.classList.remove('runtime-warning');
    elBtnRetry.hidden = true;
    elBtnStart.hidden = isRecording;
    elStatus.hidden = false;
    elBtnStop.hidden = !isRecording;
    setOptionControlsVisible(true);
    syncOptionControls();
  }

  // 可恢复错误：显示红色错误文案，但保留「开始」按钮可点（不像 showToast 那样隐藏全部控件导致只能关窗重来），
  // 数秒后自动恢复控件。用于 startRecording 失败后让用户原地重试。
  function showRecoverableError(msg) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    elToast.textContent = msg;
    elToast.style.color = '#ef4444';
    elToast.hidden = false;
    elToast.classList.remove('with-action');
    elToast.classList.remove('runtime-warning');
    elBtnRetry.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
    elBtnStart.hidden = false; // 关键：保留开始按钮，允许原地重试
    elBtnStart.disabled = false;
    setOptionControlsVisible(true);
    syncOptionControls();
    toastTimer = setTimeout(hideToast, 4000);
  }

  function showSaveRetry(msg) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    elToast.textContent = msg;
    elToast.style.color = '#ef4444';
    elToast.hidden = false;
    elToast.classList.add('with-action');
    elToast.classList.remove('runtime-warning');
    elBtnStart.hidden = true;
    elStatus.hidden = true;
    elBtnStop.hidden = true;
    elBtnPause.hidden = true;
    elBtnRetry.hidden = false;
    elBtnRetry.disabled = false;
    setOptionControlsVisible(false);
    elBtnCancel.title = '放弃未保存的录屏';
    elBtnCancel.setAttribute && elBtnCancel.setAttribute('aria-label', '放弃未保存的录屏');
  }

  function showRuntimeWarning(msg) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    elToast.textContent = msg;
    elToast.style.color = '#ef4444';
    elToast.hidden = false;
    elToast.classList.remove('with-action');
    elToast.classList.add('runtime-warning');
    // 摄像头/操作提示都是增强层；它们异常退出时录屏本身继续，停止按钮必须始终可用。
    toastTimer = setTimeout(() => {
      toastTimer = null;
      elToast.hidden = true;
      elToast.classList.remove('runtime-warning');
    }, 4000);
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
  function startTimer(reset) {
    if (reset) elapsedBeforePause = 0;
    startedAt = Date.now();
    elTimer.textContent = formatTime(elapsedBeforePause);
    timerInterval = setInterval(() => {
      elTimer.textContent = formatTime(elapsedBeforePause + Math.max(0, Date.now() - startedAt));
    }, 200);
  }

  function stopTimer() {
    if (timerInterval) {
      elapsedBeforePause += Math.max(0, Date.now() - startedAt);
      clearInterval(timerInterval);
      timerInterval = null;
      elTimer.textContent = formatTime(elapsedBeforePause);
    }
  }

  function getTracks(stream, kind) {
    if (!stream) return [];
    try {
      const method = kind === 'audio' ? 'getAudioTracks' : 'getVideoTracks';
      if (typeof stream[method] === 'function') return stream[method]();
      if (typeof stream.getTracks === 'function') {
        return stream.getTracks().filter((track) => track && track.kind === kind);
      }
    } catch (e) {
      /* 无效流统一当作无 track，由上层给出可操作错误 */
    }
    return [];
  }

  function stopStreamTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    try {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) { /* 忽略单 track 清理错误 */ }
      });
    } catch (e) {
      /* 忽略已失效的 MediaStream */
    }
  }

  function closeAudioMixer() {
    const context = audioMixContext;
    const nodes = audioMixNodes;
    audioMixContext = null;
    audioMixNodes = [];
    nodes.forEach((node) => {
      try { node.disconnect(); } catch (e) { /* 忽略 */ }
    });
    if (context && context.state !== 'closed' && typeof context.close === 'function') {
      try {
        const closing = context.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch (e) {
        /* 忽略关闭已失效 context 的错误 */
      }
    }
  }

  function captureFailure(code, message) {
    const error = new Error(message);
    error.captureCode = code;
    return error;
  }

  function errorDetail(error, fallback) {
    return (error && (error.message || error.name)) || fallback;
  }

  function isPermissionError(error) {
    const detail = `${error && error.name ? error.name : ''} ${errorDetail(error, '')}`;
    return /NotAllowed|Permission|Security|denied|refused/i.test(detail);
  }

  function isMissingDeviceError(error) {
    const detail = `${error && error.name ? error.name : ''} ${errorDetail(error, '')}`;
    return /NotFound|DevicesNotFound|Overconstrained|device.*not.*found|no.*device/i.test(detail);
  }

  async function acquireMicrophoneStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!getTracks(stream, 'audio').length) {
        stopStreamTracks(stream);
        throw captureFailure('MICROPHONE_UNAVAILABLE', '未找到可用麦克风，请连接或启用麦克风后重试');
      }
      return stream;
    } catch (error) {
      if (error && error.captureCode) throw error;
      if (isPermissionError(error)) {
        throw captureFailure('MICROPHONE_PERMISSION_DENIED', '麦克风权限被拒绝，请在系统设置中允许麦克风访问后重试');
      }
      if (isMissingDeviceError(error)) {
        throw captureFailure('MICROPHONE_UNAVAILABLE', '未找到可用麦克风，请连接或启用麦克风后重试');
      }
      throw captureFailure(
        'MICROPHONE_CAPTURE_FAILED',
        `获取麦克风失败：${errorDetail(error, '未知错误')}，请检查设备后重试`
      );
    }
  }

  async function acquireCameraStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
      });
      if (!getTracks(stream, 'video').length) {
        stopStreamTracks(stream);
        throw captureFailure('CAMERA_UNAVAILABLE', '未找到可用摄像头，请连接或启用摄像头后重试');
      }
      return stream;
    } catch (error) {
      if (error && error.captureCode) throw error;
      if (isPermissionError(error)) {
        throw captureFailure('CAMERA_PERMISSION_DENIED', '摄像头权限被拒绝，请在系统设置中允许摄像头访问后重试');
      }
      if (isMissingDeviceError(error)) {
        throw captureFailure('CAMERA_UNAVAILABLE', '未找到可用摄像头，请连接或启用摄像头后重试');
      }
      throw captureFailure(
        'CAMERA_CAPTURE_FAILED',
        `获取摄像头失败：${errorDetail(error, '未知错误')}，请关闭摄像头画中画或检查设备后重试`
      );
    }
  }

  function detachCameraTrackListeners() {
    const disposers = cameraTrackDisposers;
    cameraTrackDisposers = [];
    disposers.forEach((dispose) => {
      try { dispose(); } catch (_) { /* track may already have been destroyed */ }
    });
  }

  function releaseCameraResources() {
    // Detach before stop(): implementations are inconsistent about whether a
    // programmatic stop can synchronously surface an ended-like notification.
    detachCameraTrackListeners();
    const stream = cameraStream;
    const video = cameraVideoEl;
    cameraStream = null;
    cameraVideoEl = null;
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch (_) { /* ignore an already-detached media element */ }
    }
    stopStreamTracks(stream);
  }

  function cameraDisconnectedFailure() {
    return captureFailure(
      'CAMERA_DISCONNECTED',
      '摄像头已断开或停止，请检查设备后重新开启摄像头画中画'
    );
  }

  function handleCameraTrackEnded(expectedStream) {
    if (!expectedStream || expectedStream !== cameraStream) return;
    const failure = cameraDisconnectedFailure();
    const failedDuringStart = isStarting && !isRecording;
    cameraRequested = false;
    releaseCameraResources();
    elBtnCamera.classList.add('unavailable');
    elBtnCamera.title = failure.message;
    syncOptionControls();
    if (failedDuringStart) {
      cameraStartupFailure = failure;
      return;
    }
    if (isRecording && !isFinishing) {
      // Camera is an optional enhancement. Keep the screen encoder and stop/save
      // controls alive, but remove the stale last camera frame immediately.
      showRuntimeWarning('摄像头已断开；屏幕录制仍在继续');
    }
  }

  function watchCameraTracks(stream) {
    detachCameraTrackListeners();
    const tracks = getTracks(stream, 'video');
    for (const track of tracks) {
      if (!track) continue;
      const onEnded = () => handleCameraTrackEnded(stream);
      if (typeof track.addEventListener === 'function') {
        track.addEventListener('ended', onEnded);
        cameraTrackDisposers.push(() => track.removeEventListener('ended', onEnded));
      } else {
        const previous = track.onended;
        track.onended = onEnded;
        cameraTrackDisposers.push(() => {
          if (track.onended === onEnded) track.onended = previous || null;
        });
      }
      if (track.readyState === 'ended') {
        onEnded();
        break;
      }
    }
  }

  function throwIfCameraStartupFailed() {
    if (!cameraStartupFailure) return;
    const failure = cameraStartupFailure;
    cameraStartupFailure = null;
    throw failure;
  }

  async function startActionMonitor() {
    if (!actionsRequested) return;
    if (typeof api.startRecordingActions !== 'function') {
      throw captureFailure('ACTION_MONITOR_UNAVAILABLE', '当前版本无法启动鼠标/按键提示监听');
    }
    const generation = ++actionMonitorGeneration;
    actionMonitorStartPending = true;
    let result;
    try {
      result = await api.startRecordingActions();
    } catch (error) {
      if (generation !== actionMonitorGeneration) return false;
      actionMonitorStartPending = false;
      throw captureFailure(
        'ACTION_MONITOR_FAILED',
        `无法启动鼠标/按键提示：${errorDetail(error, '未知错误')}`
      );
    }
    if (generation !== actionMonitorGeneration) {
      // cancel/teardown 已在 invoke 等待期间发过 STOP。若旧主进程仍回报晚到成功，
      // 再发一次幂等 STOP，避免关闭 renderer 后留下全局输入监听器。
      if (result && result.ok === true && result.active === true) {
        requestActionMonitorStop();
      }
      return false;
    }
    actionMonitorStartPending = false;
    if (!result || result.ok !== true || result.active !== true) {
      const detail = result && result.error ? result.error : '系统未允许输入事件监听';
      throw captureFailure('ACTION_MONITOR_FAILED', `无法启动鼠标/按键提示：${detail}`);
    }
    actionMonitorActive = true;
    elBtnActions.classList.remove('unavailable');
    syncOptionControls();
    return true;
  }

  function requestActionMonitorStop() {
    if (typeof api.stopRecordingActions === 'function') {
      try {
        const stopping = api.stopRecordingActions();
        if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {});
      } catch (_) { /* renderer/main may already be gone */ }
    }
  }

  function stopActionMonitor() {
    const shouldStop = actionMonitorActive || actionMonitorStartPending;
    actionMonitorGeneration += 1;
    actionMonitorStartPending = false;
    actionMonitorActive = false;
    if (shouldStop) requestActionMonitorStop();
  }

  function handleActionMonitorFailure(payload) {
    if (!actionMonitorActive) return;
    actionMonitorGeneration += 1;
    actionMonitorStartPending = false;
    actionMonitorActive = false;
    actionsRequested = false;
    penRequested = false;
    overlayState.setPenEnabled(false);
    const detail = payload && typeof payload.error === 'string'
      ? payload.error.slice(0, 300)
      : '监听器意外停止';
    elBtnActions.classList.add('unavailable');
    elBtnActions.title = detail;
    syncOptionControls();
    showRuntimeWarning(`操作提示已停止：${detail}`);
  }

  function toggleCameraOption() {
    if (isStarting || isRecording || isFinishing) return;
    cameraRequested = !cameraRequested;
    elBtnCamera.classList.remove('unavailable');
    elBtnCamera.title = '摄像头画中画（开始前设置）';
    syncOptionControls();
  }

  function toggleActionPrompts() {
    if (isStarting || isRecording || isFinishing) return;
    actionsRequested = !actionsRequested;
    elBtnActions.classList.remove('unavailable');
    elBtnActions.title = '将鼠标点击与按键提示写入录屏（开始前设置）';
    if (!actionsRequested) {
      penRequested = false;
      overlayState.setPenEnabled(false);
      overlayState.clearStrokes();
    }
    syncOptionControls();
  }

  function toggleLivePen() {
    if (!actionsRequested || isStarting || isFinishing) return;
    penRequested = !penRequested;
    overlayState.setPenEnabled(penRequested);
    syncOptionControls();
  }

  function clearLivePen() {
    if (!actionsRequested || isStarting || isFinishing) return;
    overlayState.clearStrokes();
  }

  async function attachRequestedAudio(targetStream) {
    const inputStreams = [];
    if (init.systemAudio === true) inputStreams.push(captureStream);
    if (init.microphone === true) inputStreams.push(microphoneStream);
    if (!inputStreams.length) return;

    if (!targetStream || typeof targetStream.addTrack !== 'function') {
      throw captureFailure('AUDIO_STREAM_UNSUPPORTED', '当前环境无法将音频加入录屏，请关闭音频选项后重试');
    }

    const audioTracks = inputStreams.flatMap((stream) => getTracks(stream, 'audio'));
    if (audioTracks.length === 1) {
      targetStream.addTrack(audioTracks[0]);
      return;
    }

    // MediaRecorder 对多条音轨的容器行为并不稳定，因此双音源先混成唯一音轨。
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw captureFailure(
        'AUDIO_MIX_UNSUPPORTED',
        '当前运行环境无法混合系统音频和麦克风，请只选择一种音频后重试'
      );
    }

    try {
      audioMixContext = new AudioContextCtor();
      if (audioMixContext.state === 'suspended' && typeof audioMixContext.resume === 'function') {
        await audioMixContext.resume();
      }
      const destination = audioMixContext.createMediaStreamDestination();
      audioMixNodes = inputStreams.map((stream) => {
        const node = audioMixContext.createMediaStreamSource(stream);
        node.connect(destination);
        return node;
      });
      const mixedTracks = getTracks(destination.stream, 'audio');
      if (!mixedTracks.length) throw new Error('混音器未产生音轨');
      targetStream.addTrack(mixedTracks[0]);
    } catch (error) {
      throw captureFailure(
        'AUDIO_MIX_FAILED',
        `无法混合系统音频和麦克风：${errorDetail(error, '未知错误')}，请只选择一种音频后重试`
      );
    }
  }

  function clearRecorderStopWatchdog() {
    if (recorderStopWatchdog === null) return;
    clearTimeout(recorderStopWatchdog);
    recorderStopWatchdog = null;
  }

  function armRecorderStopWatchdog(targetRecorder) {
    if (recorderStopWatchdog !== null) return;
    recorderStopWatchdog = setTimeout(() => {
      recorderStopWatchdog = null;
      if (
        targetRecorder !== recorder
        || hasFinalizedRecorderStop
        || !isFinishing
      ) return;
      // 正常 stop 后若既没有 stop 也没有 error，chunks 的完整性不可证明。
      // 若已收到 encoder error，保留更具体的原因，两条路径共用同一个 deadline。
      if (!partialRecordingCause) {
        partialRecordingCause = PARTIAL_RECORDING_CAUSES.STOP_TIMEOUT;
      }
      // 某些 MediaRecorder 实现在 error 后不再派发 stop。
      // 有限等待后用已收到的 chunks 收尾，迟到的 stop 会被一次性 gate 忽略。
      Promise.resolve(onRecorderStop(targetRecorder)).catch(() => {});
    }, RECORDER_STOP_WATCHDOG_MS);
  }

  // ====== 资源清理：停掉所有流、定时器、video ======
  function teardown() {
    clearRecorderStopWatchdog();
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
    // 停所有 track（整屏流 + 麦克风 + canvas/混音流）
    stopStreamTracks(captureStream);
    stopStreamTracks(microphoneStream);
    releaseCameraResources();
    stopStreamTracks(canvasStream);
    captureStream = null;
    microphoneStream = null;
    canvasStream = null;
    closeAudioMixer();
    stopActionMonitor();
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
    if (isRecording || isStarting || isFinishing) return;
    const startToken = lifecycle.beginStart();
    if (!startToken) return;
    isStarting = true;
    elBtnStart.disabled = true;
    syncOptionControls();

    const scale = init.scaleFactor || 1;
    const rect = init.rect || {};
    const db = init.displayBounds || {};
    let captureGeometry = null;
    let canvasW = 0;
    let canvasH = 0;
    recordingPixelWidth = 0;
    recordingPixelHeight = 0;
    actionGeometry = init;
    cameraStartupFailure = null;

    try {
      // 1. 找到目标显示器对应的采集源
      const sources = await api.getSources();
      if (!lifecycle.isCurrentGeneration(startToken)) {
        isStarting = false;
        return;
      }
      if (!sources || !sources.length) {
        throw new Error('未找到可录制的屏幕源');
      }
      const directMatches = sources.filter((s) => (
        s.display_id != null && String(s.display_id) !== '' && String(s.display_id) === String(init.displayId)
      ));
      let source = directMatches.length === 1 ? directMatches[0] : null;
      if (!source && sources.length === 1) source = sources[0];
      // source 数组顺序不是 Electron 的稳定契约。主进程已把 screen:<index>:… 解析成
      // screen_index，必须按该字段匹配，而不能拿 displayIndex 直接索引 sources。
      if (!source && Number.isInteger(init.displayIndex) && init.displayIndex >= 0) {
        const indexedMatches = sources.filter((s) => {
          const parsed = Number.isInteger(s.screen_index)
            ? s.screen_index
            : (() => {
                const match = /^screen:(\d+):/i.exec(String(s.id || ''));
                return match ? Number(match[1]) : null;
              })();
          return parsed === init.displayIndex;
        });
        if (indexedMatches.length === 1) source = indexedMatches[0];
      }
      if (!source) throw new Error('无法可靠匹配目标显示器，请重新选择录制区域');

      // 2. 整屏媒体流（Electron desktop 采集，需用 mandatory 约束）
      const maxW = Math.max(1, Math.round((db.width || 0) * scale));
      const maxH = Math.max(1, Math.round((db.height || 0) * scale));
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: init.systemAudio === true
          ? {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: source.id,
              },
            }
          : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: maxW,
            maxHeight: maxH,
          },
        },
      });
      if (!lifecycle.isCurrentGeneration(startToken)) {
        teardown();
        isStarting = false;
        return;
      }

      if (init.systemAudio === true && !getTracks(captureStream, 'audio').length) {
        throw captureFailure(
          'SYSTEM_AUDIO_UNAVAILABLE',
          '当前屏幕源未提供系统音频；当前 macOS/运行环境可能不支持，请关闭“系统音频”后重试'
        );
      }

      if (init.microphone === true) {
        microphoneStream = await acquireMicrophoneStream();
        if (!lifecycle.isCurrentGeneration(startToken)) {
          teardown();
          isStarting = false;
          return;
        }
      }
      if (cameraRequested) {
        cameraStream = await acquireCameraStream();
        if (!lifecycle.isCurrentGeneration(startToken)) {
          teardown();
          isStarting = false;
          return;
        }
        watchCameraTracks(cameraStream);
        throwIfCameraStartupFailed();
      }
    } catch (err) {
      if (!lifecycle.isCurrentGeneration(startToken)) {
        teardown();
        isStarting = false;
        return;
      }
      // 权限被拒 / 无可用源 等
      const msg = errorDetail(err, '获取屏幕流失败');
      let hint = err && err.captureCode ? msg : '录制失败：' + msg;
      if (!(err && err.captureCode) && init.systemAudio === true) {
        if (isPermissionError(err)) {
          hint = '屏幕或系统音频访问被拒绝，请检查系统录屏/音频权限后重试';
        } else if (isMissingDeviceError(err)) {
          hint = '屏幕源或系统音频不可用，请重新选择区域，或关闭“系统音频”后重试';
        } else {
          hint = `无法获取屏幕和系统音频：${msg}；当前系统可能不支持，可关闭“系统音频”后重试`;
        }
      } else if (!(err && err.captureCode) && isPermissionError(err)) {
        hint = '录屏被拒绝，请在系统设置中授予屏幕录制权限';
      } else if (!(err && err.captureCode) && isMissingDeviceError(err)) {
        hint = '未找到可录制的屏幕源';
      }
      teardown();
      isStarting = false;
      if (err && String(err.captureCode || '').startsWith('CAMERA_')) {
        cameraRequested = false;
        elBtnCamera.classList.add('unavailable');
        elBtnCamera.title = msg;
      }
      lifecycle.markError();
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
      if (!lifecycle.isCurrentGeneration(startToken)) {
        teardown();
        isStarting = false;
        return;
      }
      try {
        await videoEl.play();
      } catch (e) {
        /* 自动播放可能被忽略，但 srcObject 已就绪，可继续绘制 */
      }

      const desktopTrack = getTracks(captureStream, 'video')[0];
      let desktopTrackSettings = {};
      try {
        desktopTrackSettings = desktopTrack && typeof desktopTrack.getSettings === 'function'
          ? (desktopTrack.getSettings() || {})
          : {};
      } catch (_) { /* video metadata remains the authoritative fallback */ }
      const desktopPixelWidth = Number(videoEl.videoWidth) || Number(desktopTrackSettings.width) || 0;
      const desktopPixelHeight = Number(videoEl.videoHeight) || Number(desktopTrackSettings.height) || 0;
      captureGeometry = overlayContract.resolveRecorderCaptureGeometry(init, {
        width: desktopPixelWidth,
        height: desktopPixelHeight,
      });
      if (!captureGeometry) {
        throw captureFailure(
          'SCREEN_GEOMETRY_UNAVAILABLE',
          '无法确认桌面流的实际像素尺寸，请重新选择录制区域'
        );
      }
      canvasW = captureGeometry.outputWidth;
      canvasH = captureGeometry.outputHeight;
      recordingPixelWidth = canvasW;
      recordingPixelHeight = canvasH;
      actionGeometry = captureGeometry.actionGeometry;
      throwIfCameraStartupFailed();

      if (cameraStream) {
        cameraVideoEl = document.createElement('video');
        cameraVideoEl.muted = true;
        cameraVideoEl.playsInline = true;
        cameraVideoEl.srcObject = cameraStream;
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          cameraVideoEl.onloadedmetadata = finish;
          setTimeout(finish, 1000);
        });
        if (!lifecycle.isCurrentGeneration(startToken)) {
          teardown();
          isStarting = false;
          return;
        }
        try { await cameraVideoEl.play(); } catch (_) { /* 首帧到达后定时绘制会自动恢复 */ }
        throwIfCameraStartupFailed();
      }

      await startActionMonitor();
      if (!lifecycle.isCurrentGeneration(startToken)) {
        teardown();
        isStarting = false;
        return;
      }
      throwIfCameraStartupFailed();

      // 4. 离屏 canvas，按裁剪区域绘制
      canvasEl = document.createElement('canvas');
      canvasEl.width = canvasW;
      canvasEl.height = canvasH;
      const ctx = canvasEl.getContext('2d');

      // 源裁剪坐标来自实际 desktop video 像素，不假定等于 display.scaleFactor。
      const sx = captureGeometry.sourceX;
      const sy = captureGeometry.sourceY;
      const sw = captureGeometry.sourceWidth;
      const sh = captureGeometry.sourceHeight;
      const fps = init.fps && init.fps > 0 ? init.fps : 15;

      function drawCameraPictureInPicture() {
        if (!cameraVideoEl) return;
        const diameter = Math.max(72, Math.min(canvasW, canvasH) * 0.24);
        const margin = Math.max(16, Math.min(canvasW, canvasH) * 0.035);
        const x = Math.max(0, canvasW - diameter - margin);
        const y = Math.max(0, canvasH - diameter - margin);
        const sourceW = Number(cameraVideoEl.videoWidth) || 640;
        const sourceH = Number(cameraVideoEl.videoHeight) || 480;
        const sourceSize = Math.min(sourceW, sourceH);
        const sourceX = Math.max(0, (sourceW - sourceSize) / 2);
        const sourceY = Math.max(0, (sourceH - sourceSize) / 2);
        try {
          if (typeof ctx.save === 'function') ctx.save();
          if (typeof ctx.beginPath === 'function' && typeof ctx.arc === 'function' && typeof ctx.clip === 'function') {
            ctx.beginPath();
            ctx.arc(x + diameter / 2, y + diameter / 2, diameter / 2, 0, Math.PI * 2);
            ctx.clip();
          }
          ctx.drawImage(
            cameraVideoEl,
            sourceX,
            sourceY,
            sourceSize,
            sourceSize,
            x,
            y,
            diameter,
            diameter
          );
          if (typeof ctx.restore === 'function') ctx.restore();
          if (typeof ctx.save === 'function') ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(3, diameter / 32);
          if (typeof ctx.beginPath === 'function' && typeof ctx.arc === 'function' && typeof ctx.stroke === 'function') {
            ctx.beginPath();
            ctx.arc(x + diameter / 2, y + diameter / 2, Math.max(1, diameter / 2 - ctx.lineWidth / 2), 0, Math.PI * 2);
            ctx.stroke();
          }
          if (typeof ctx.restore === 'function') ctx.restore();
        } catch (_) {
          // 摄像头首帧尚未就绪时不影响主屏录制。
        }
      }

      // 把 video 的裁剪区域逐帧画到 canvas
      drawTimer = setInterval(() => {
        if (!videoEl) return;
        try {
          ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
          drawCameraPictureInPicture();
          overlayState.render(ctx, canvasW, canvasH, Date.now());
        } catch (e) {
          /* 帧未就绪时忽略 */
        }
      }, Math.max(1, Math.round(1000 / fps)));

      // 5. 从 canvas 取流并录制
      canvasStream = canvasEl.captureStream(fps);
      await attachRequestedAudio(canvasStream);
      throwIfCameraStartupFailed();

      // 优先 vp9，失败退 vp8，再退默认
      const candidates = getTracks(canvasStream, 'audio').length
        ? [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
          ]
        : [
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
      partialRecordingCause = null;
      clearRecorderStopWatchdog();
      hasFinalizedRecorderStop = false;
      try {
        recorder = chosen
          ? new MediaRecorder(canvasStream, { mimeType: chosen })
          : new MediaRecorder(canvasStream);
      } catch (e) {
        // 指定 mimeType 失败时，退回不带参数
        recorder = new MediaRecorder(canvasStream);
      }

      const recordingRecorder = recorder;
      recordingRecorder.ondataavailable = (ev) => {
        if (recordingRecorder !== recorder || hasFinalizedRecorderStop) return;
        if (!ev.data || ev.data.size <= 0) return;
        if (recordedBytes + ev.data.size > MAX_RECORDING_BYTES) {
          sizeLimitReached = true;
          if (isRecording && !isFinishing) setTimeout(stopRecording, 0);
          return;
        }
        chunks.push(ev.data);
        recordedBytes += ev.data.size;
      };
      recordingRecorder.onstop = () => onRecorderStop(recordingRecorder);
      recordingRecorder.onerror = () => {
        if (recordingRecorder !== recorder || partialRecordingCause) return;
        const stateBeforeError = lifecycle.snapshot().state;
        if (!isFinishing) {
          // error 后 MediaRecorder 通常还会产生最后的 dataavailable/stop。
          // 先进入正常 stopping 代次，再尽力请求最后分片；不能先 teardown。
          if (!lifecycle.beginStop().accepted) return;
          isFinishing = true;
        } else if (![
          RECORDER_STATES.STOPPING,
          RECORDER_STATES.SERIALIZING,
        ].includes(stateBeforeError)) {
          // save IPC 一旦提交就不能诚实地撤回；终态/重试态的迟到 error 也不得回退。
          return;
        }
        partialRecordingCause = PARTIAL_RECORDING_CAUSES.RECORDER_ERROR;
        isRecording = false;
        isPaused = false;
        elBar.classList.remove('recording');
        elBar.classList.remove('paused');
        elBtnStop.disabled = true;
        elBtnPause.hidden = true;
        stopTimer();
        if (drawTimer) {
          clearInterval(drawTimer);
          drawTimer = null;
        }
        showToast('录制过程出错，正在整理可恢复内容…', true);
        if (!hasFinalizedRecorderStop) armRecorderStopWatchdog(recordingRecorder);

        const failedRecorder = recordingRecorder;
        if (failedRecorder && failedRecorder.state !== 'inactive') {
          if (typeof failedRecorder.requestData === 'function') {
            try { failedRecorder.requestData(); } catch (_) { /* 编码器可能已自行停止 */ }
          }
          try { failedRecorder.stop(); } catch (_) { /* 等待 MediaRecorder 的 stop 事件 */ }
        }
        // 不再继续采集新内容；canvas/混音输出在 onstop 组装 Blob 后统一清理。
        stopStreamTracks(captureStream);
        stopStreamTracks(microphoneStream);
        releaseCameraResources();
        stopActionMonitor();
      };

      // 每秒切一个数据块，避免单块过大
      throwIfCameraStartupFailed();
      recorder.start(1000);

      if (!lifecycle.markActive(startToken).accepted) {
        teardown();
        isStarting = false;
        return;
      }

      // 6. 进入录制状态，更新 UI + 计时
      isStarting = false;
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
      syncOptionControls();
      startTimer(true);
    } catch (err) {
      if (!lifecycle.isCurrentGeneration(startToken)) {
        teardown();
        isStarting = false;
        return;
      }
      const msg = (err && (err.message || err.name)) || '初始化录制失败';
      teardown();
      isStarting = false;
      isRecording = false;
      if (err && String(err.captureCode || '').startsWith('ACTION_')) {
        elBtnActions.classList.add('unavailable');
        elBtnActions.title = msg;
      }
      if (err && String(err.captureCode || '').startsWith('CAMERA_')) {
        cameraRequested = false;
        elBtnCamera.classList.add('unavailable');
        elBtnCamera.title = msg;
      }
      lifecycle.markError();
      elBar.classList.remove('recording');
      showRecoverableError('录制失败：' + msg); // 保留开始按钮，允许原地重试
    }
  }

  // ====== MediaRecorder 停止后的回调：组装 blob 并保存 ======
  function retainPartialRecording(saveToken) {
    const retained = lifecycle.failSerialization(saveToken);
    if (!retained.accepted) return false;
    showSaveRetry(partialRecordingCause === PARTIAL_RECORDING_CAUSES.STOP_TIMEOUT
      ? '未收到录制停止确认；已保留可用的部分录屏，点击“重试保存”即可保存'
      : '录制过程出错；已保留可用的部分录屏，点击“重试保存”即可保存');
    return true;
  }

  async function savePendingRecording(existingToken) {
    if (!pendingRecordingBlob || saveInProgress) return;
    const isAutomaticStopSave = !!existingToken;
    const saveToken = existingToken || lifecycle.beginSerialization();
    if (!saveToken || !lifecycle.isCurrentSave(saveToken)) return;
    const blobToSave = pendingRecordingBlob;
    saveInProgress = true;
    try {
      showToast('正在保存…', false);
      const buffer = await blobToSave.arrayBuffer();
      // Blob.arrayBuffer() 可能很慢。若用户已在这期间放弃，不得再提交 IPC。
      if (!lifecycle.isCurrentSave(saveToken)) return;
      // 用户 stop 后、自动保存提交前仍可能收到编码器 error，
      // 或 watchdog 已证明停止确认缺失。这时必须降级为“部分录屏”等待用户确认。
      if (isAutomaticStopSave && partialRecordingCause) {
        retainPartialRecording(saveToken);
        return;
      }
      if (!lifecycle.markSaveSubmitted(saveToken).accepted) return;
      const res = await api.saveRecording({
        buffer,
        mime: 'video/webm',
        toGif: !!init.toGif,
        fps: init.fps && init.fps > 0 ? init.fps : 15,
        width: recordingPixelWidth,
        height: recordingPixelHeight,
        trimStart: parseInt(document.getElementById('trimStart').value, 10) || 0,
        trimEnd: parseInt(document.getElementById('trimEnd').value, 10) || 0,
      });

      // 强制关窗/detach 会使 token 失效。主进程仍可能已写盘，
      // 但迟到结果不能再操作已销毁页面、弹出重试或二次关窗。
      if (!lifecycle.isCurrentSave(saveToken)) return;
      const completion = lifecycle.completeSave(saveToken, res);
      if (!completion.accepted) return;

      if (completion.saved === true) {
        pendingRecordingBlob = null;
        chunks = [];
        recordedBytes = 0;
        terminalCloseRequested = true;
        await flushLifecycleState();
        await api.closeSelf();
        return;
      }
      const detail = res && res.error
        ? `保存失败：${res.error}`
        : '已取消保存对话框；录屏仍完整保留，可重试或点 × 放弃';
      showSaveRetry(detail);
    } catch (err) {
      if (!lifecycle.isCurrentSave(saveToken)) return;
      const snapshot = lifecycle.snapshot();
      if (snapshot.state === RECORDER_STATES.SERIALIZING) {
        lifecycle.failSerialization(saveToken);
      } else if (snapshot.state === RECORDER_STATES.SAVING) {
        lifecycle.completeSave(saveToken, { saved: false });
      } else {
        return;
      }
      const msg = (err && (err.message || err.name)) || '保存失败';
      showSaveRetry('保存失败：' + msg);
    } finally {
      saveInProgress = false;
    }
  }

  async function onRecorderStop(sourceRecorder) {
    // 仅在用户主动停止或编码器错误恢复时保留录屏（取消时 isFinishing 为 false）
    if (sourceRecorder && sourceRecorder !== recorder) return;
    if (!isFinishing || hasFinalizedRecorderStop) return;
    hasFinalizedRecorderStop = true;
    clearRecorderStopWatchdog();
    const saveToken = lifecycle.beginSerialization();
    if (!saveToken) return;
    try {
      pendingRecordingBlob = new Blob(chunks, { type: 'video/webm' });
    } catch (err) {
      lifecycle.markError();
      showToast('整理录屏失败：' + ((err && err.message) || String(err)), true);
      return;
    } finally {
      teardown();
    }
    if (!pendingRecordingBlob.size) {
      pendingRecordingBlob = null;
      chunks = [];
      recordedBytes = 0;
      lifecycle.markError();
      const emptyRecordingMessage = partialRecordingCause === PARTIAL_RECORDING_CAUSES.RECORDER_ERROR
        ? '录制过程出错，且未能恢复任何录制内容'
        : partialRecordingCause === PARTIAL_RECORDING_CAUSES.STOP_TIMEOUT
          ? '未收到录制停止确认，且未能恢复任何录制内容'
          : '录制内容为空';
      showToast(emptyRecordingMessage, true);
      return;
    }
    if (partialRecordingCause) {
      retainPartialRecording(saveToken);
      return;
    }
    await savePendingRecording(saveToken);
  }

  // ====== 停止并保存 ======
  // ====== 暂停 / 继续（P2-4：录制中间暂停，最终仍导出一段连续视频）======
  function togglePause() {
    if (!isRecording || isFinishing || !recorder) return;
    if (recorder.state !== 'recording' && recorder.state !== 'paused') return;
    try {
      if (isPaused) {
        recorder.resume();
        if (!lifecycle.markResumed().accepted) return;
        isPaused = false;
        elBar.classList.remove('paused');
        elBtnPause.textContent = '⏸';
        elBtnPause.title = '暂停录制';
        startTimer(false);
      } else {
        recorder.pause();
        if (!lifecycle.markPaused().accepted) return;
        isPaused = true;
        elBar.classList.add('paused');
        elBtnPause.textContent = '▶';
        elBtnPause.title = '继续录制';
        stopTimer();
      }
      // 暂停状态由橙色指示点和 ▶/⏸ 按钮表达；不复用会覆盖整个控制条的保存/错误 toast。
      hideToast();
    } catch (e) {
      showToast('暂停/继续失败：' + (e && e.message ? e.message : e), true);
    }
  }
  elBtnPause.addEventListener('click', togglePause);

  function stopRecording() {
    if (!isRecording || isFinishing) return;
    if (!lifecycle.beginStop().accepted) return;
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

    const stoppingRecorder = recorder;
    if (stoppingRecorder) armRecorderStopWatchdog(stoppingRecorder);
    try {
      if (stoppingRecorder && stoppingRecorder.state !== 'inactive') {
        stoppingRecorder.stop();
      } else {
        // recorder 已停或不存在，直接走保存流程
        onRecorderStop(stoppingRecorder);
      }
    } catch (e) {
      onRecorderStop(stoppingRecorder);
    }

    // 停掉采集 track（保留 chunks，已在 stop 前收集）
    // 源流可立即停；canvas/混音输出由 recorder.stop 触发 onstop 后清理。
    stopStreamTracks(captureStream);
    stopStreamTracks(microphoneStream);
    releaseCameraResources();
    stopActionMonitor();
  }

  // ====== 取消录制：停一切，不保存，关窗 ======
  async function cancelRecording() {
    if (terminalCloseRequested) return;
    const cancellation = lifecycle.requestCancel();
    if (cancellation.outcome === 'already-canceled') return;
    if (!cancellation.accepted) {
      if (cancellation.outcome === 'save-outcome-pending') {
        showToast('保存请求已提交，文件可能正在写入；请等待保存结果，以免误报“已取消”', false);
      }
      return;
    }
    if (cancellation.outcome === 'already-saved') {
      terminalCloseRequested = true;
      await flushLifecycleState();
      await api.closeSelf();
      return;
    }
    isStarting = false;
    isFinishing = false; // 确保 onstop 不触发保存
    hasFinalizedRecorderStop = true;
    isRecording = false;
    elBar.classList.remove('recording');
    chunks = [];
    recordedBytes = 0;
    sizeLimitReached = false;
    pendingRecordingBlob = null;
    partialRecordingCause = null;
    teardown();
    terminalCloseRequested = true;
    await flushLifecycleState();
    await api.closeSelf();
  }

  // ====== 事件绑定 ======
  elBtnStart.addEventListener('click', startRecording);
  elBtnStop.addEventListener('click', stopRecording);
  elBtnCamera.addEventListener('click', toggleCameraOption);
  elBtnActions.addEventListener('click', toggleActionPrompts);
  elBtnPen.addEventListener('click', toggleLivePen);
  elBtnClearPen.addEventListener('click', clearLivePen);
  // DOM listener receives a MouseEvent; never pass it through as the lifecycle token.
  elBtnRetry.addEventListener('click', () => savePendingRecording());
  elBtnCancel.addEventListener('click', cancelRecording);

  let disposeRecordingActionListener = null;
  if (typeof api.onRecordingAction === 'function') {
    try {
      disposeRecordingActionListener = api.onRecordingAction((payload) => {
        if (payload && payload.type === 'monitor-error') {
          handleActionMonitorFailure(payload);
          return;
        }
        if (!actionMonitorActive || !isRecording) return;
        overlayState.accept(payload, actionGeometry, payload && payload.at);
      });
    } catch (_) {
      // 预加载契约不完整时由用户真正开启“操作提示”时给出可恢复错误。
    }
  }

  // Esc 取消
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelRecording();
    }
  });

  // 如果主进程/系统强制销毁窗口，使所有未完成的 async 代次失效。
  // saving 阶段只标记“结果未知”，不宣称已取消，因为主进程可能已写盘。
  window.addEventListener('beforeunload', () => {
    if (!terminalCloseRequested) lifecycle.detach();
    if (typeof disposeRecordingActionListener === 'function') {
      try { disposeRecordingActionListener(); } catch (_) { /* renderer is already unloading */ }
      disposeRecordingActionListener = null;
    }
    teardown();
  });

  // 接收主进程注入的初始化数据
  api.onInit((payload) => {
    if (payload && typeof payload === 'object') {
      init = Object.assign(init, payload);
      cameraRequested = payload.camera === true;
      actionsRequested = payload.actionPrompts === true;
      penRequested = actionsRequested && payload.livePen === true;
      overlayState.setPenEnabled(penRequested);
    }
    // 初始 UI：等待开始
    elBtnStop.hidden = true;
    elBtnStop.disabled = true;
    elBtnStart.hidden = false;
    elBtnStart.disabled = false;
    setOptionControlsVisible(true);
    syncOptionControls();
    // 覆盖主进程创建窗口时的 opening 状态。
    reportLifecycleState(lifecycle.snapshot());
  });
})();
