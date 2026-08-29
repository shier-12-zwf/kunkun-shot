const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const recorderLifecycle = require('../src/shared/recorder-lifecycle');

const recorderSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'recorder', 'recorder.js'),
  'utf8'
);

function createElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    value: '0',
    style: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event = {}) {
      const listener = listeners.get(type);
      return listener && listener(event);
    },
  };
}

function createTrack(kind, id) {
  return {
    kind,
    id,
    enabled: true,
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
    },
  };
}

function createStream({ videoTracks = [], audioTracks = [] } = {}) {
  const tracks = [...videoTracks, ...audioTracks];
  return {
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    addTrack(track) {
      tracks.push(track);
    },
  };
}

function createDeferredBlobClass(arrayBufferPromise) {
  return class DeferredBlob {
    constructor(parts) {
      this.size = (parts || []).reduce((total, part) => total + Number(part && part.size || 0), 0);
      this.type = 'video/webm';
    }

    arrayBuffer() {
      return arrayBufferPromise;
    }
  };
}

async function createRecorderHarness(options = {}) {
  const ids = [
    'bar',
    'btnStart',
    'btnStop',
    'btnPause',
    'btnRetry',
    'btnCancel',
    'status',
    'timer',
    'toast',
    'trimStart',
    'trimEnd',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));
  const intervals = new Map();
  const timeouts = new Map();
  let nextIntervalId = 1;
  let nextTimeoutId = 1;
  let now = 0;
  let initListener = null;
  let mediaRecorder = null;
  const mediaCalls = [];
  const saveCalls = [];
  const stateReports = [];
  let closeCalls = 0;
  let cancelCalls = 0;
  const windowListeners = new Map();
  const audioSourceStreams = [];
  const screenVideoTrack = options.screenVideoTrack || createTrack('video', 'screen-video');
  const systemAudioTrack = options.systemAudioTrack || createTrack('audio', 'system-audio');
  const microphoneTrack = options.microphoneTrack || createTrack('audio', 'microphone-audio');
  const mixedAudioTrack = options.mixedAudioTrack || createTrack('audio', 'mixed-audio');
  const captureStream = options.captureStream || createStream({
    videoTracks: [screenVideoTrack],
    audioTracks: options.systemAudioAvailable === true ? [systemAudioTrack] : [],
  });
  const microphoneStream = options.microphoneStream || createStream({
    audioTracks: options.microphoneAvailable === false ? [] : [microphoneTrack],
  });
  const canvasStream = options.canvasStream || createStream({
    videoTracks: [createTrack('video', 'canvas-video')],
  });
  const mixedStream = createStream({ audioTracks: [mixedAudioTrack] });
  let audioContext = null;

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(stream) {
      this.state = 'inactive';
      this.pauseCalls = 0;
      this.resumeCalls = 0;
      this.requestDataCalls = 0;
      this.stopCalls = 0;
      this.stream = stream;
      mediaRecorder = this;
    }

    start() {
      this.state = 'recording';
    }

    pause() {
      this.pauseCalls += 1;
      this.state = 'paused';
    }

    resume() {
      this.resumeCalls += 1;
      this.state = 'recording';
    }

    requestData() {
      this.requestDataCalls += 1;
    }

    stop() {
      this.stopCalls += 1;
      this.state = 'inactive';
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.resumeCalls = 0;
      this.closeCalls = 0;
      audioContext = this;
    }

    createMediaStreamDestination() {
      return { stream: mixedStream };
    }

    createMediaStreamSource(stream) {
      audioSourceStreams.push(stream);
      return {
        connect() {},
        disconnect() {},
      };
    }

    async resume() {
      this.resumeCalls += 1;
      this.state = 'running';
    }

    async close() {
      this.closeCalls += 1;
      this.state = 'closed';
    }
  }

  const api = {
    getSources: async () => options.sources || [{ id: 'screen:1', display_id: '1', screen_index: 0 }],
    saveRecording: async (payload) => {
      saveCalls.push(payload);
      return typeof options.saveRecording === 'function'
        ? options.saveRecording(payload)
        : { saved: true };
    },
    closeSelf() {
      closeCalls += 1;
      return Promise.resolve();
    },
    cancelCapture() { cancelCalls += 1; },
    reportRecordingState(snapshot) {
      stateReports.push({ ...snapshot });
      return Promise.resolve({ ok: true });
    },
    onInit(listener) {
      initListener = listener;
    },
  };

  const context = {
    Blob: options.Blob || Blob,
    MediaRecorder: FakeMediaRecorder,
    console,
    Date: { now: () => now },
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          mediaCalls.push(constraints);
          if (constraints && constraints.video === false) {
            if (options.microphoneError) throw options.microphoneError;
            if (typeof options.acquireMicrophone === 'function') {
              return options.acquireMicrophone(constraints);
            }
            return microphoneStream;
          }
          if (options.desktopError) throw options.desktopError;
          return captureStream;
        },
      },
    },
    document: {
      getElementById: (id) => elements[id],
      createElement(type) {
        if (type === 'video') {
          const video = {
            muted: false,
            playsInline: false,
            srcObject: null,
            play: async () => {},
            pause() {},
          };
          Object.defineProperty(video, 'onloadedmetadata', {
            set(listener) {
              listener();
            },
          });
          return video;
        }
        if (type === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage() {} }),
            captureStream: () => canvasStream,
          };
        }
        throw new Error(`unexpected element type: ${type}`);
      },
    },
    window: {
      kkapi: api,
      KKRecorderLifecycle: recorderLifecycle,
      AudioContext: options.audioContextUnavailable ? undefined : FakeAudioContext,
      addEventListener(type, listener) {
        windowListeners.set(type, listener);
      },
    },
    setInterval(listener, delay) {
      const id = nextIntervalId++;
      intervals.set(id, { listener, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(listener, delay = 0) {
      const id = nextTimeoutId++;
      if (delay <= 0 && options.deferZeroTimeouts !== true) {
        listener();
      } else {
        timeouts.set(id, { listener, delay });
      }
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
  };

  vm.runInNewContext(recorderSource, context, { filename: 'recorder.js' });
  initListener({
    rect: { x: 0, y: 0, width: 320, height: 180 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    displayId: '1',
    displayIndex: 0,
    scaleFactor: 1,
    fps: 15,
    ...(options.init || {}),
  });
  if (options.autoStart !== false) await elements.btnStart.dispatch('click');

  return {
    elements,
    getMediaRecorder: () => mediaRecorder,
    getMediaConstraints: () => mediaCalls[0] || null,
    getMediaCalls: () => [...mediaCalls],
    getAudioContext: () => audioContext,
    getAudioSourceStreams: () => [...audioSourceStreams],
    getSaveCalls: () => [...saveCalls],
    getStateReports: () => [...stateReports],
    getCloseCalls: () => closeCalls,
    getCancelCalls: () => cancelCalls,
    dispatchWindow(type, event = {}) {
      const listener = windowListeners.get(type);
      return listener && listener(event);
    },
    captureStream,
    microphoneStream,
    canvasStream,
    tracks: {
      screenVideoTrack,
      systemAudioTrack,
      microphoneTrack,
      mixedAudioTrack,
    },
    start: () => elements.btnStart.dispatch('click'),
    getPendingTimeouts: () => [...timeouts.values()].map(({ delay }) => delay),
    async runTimeouts(delay) {
      const due = [...timeouts.entries()].filter(([, timer]) => (
        delay === undefined || timer.delay === delay
      ));
      for (const [id] of due) timeouts.delete(id);
      await Promise.all(due.map(([, timer]) => Promise.resolve(timer.listener())));
    },
    setNow(value) {
      now = value;
    },
    tickTimer() {
      const timer = [...intervals.values()].find(({ delay }) => delay === 200);
      assert.ok(timer, 'recording timer interval must be active');
      timer.listener();
    },
  };
}

test('recorder matches serialized screen_index instead of relying on source array order', async () => {
  const harness = await createRecorderHarness({
    sources: [
      { id: 'screen:1:0', display_id: '', screen_index: 1 },
      { id: 'screen:0:0', display_id: '', screen_index: 0 },
    ],
    init: { displayId: '101', displayIndex: 0 },
  });

  assert.equal(
    harness.getMediaConstraints().video.mandatory.chromeMediaSourceId,
    'screen:0:0'
  );
});

test('recorder fails closed when multiple sources cannot identify the target display', async () => {
  const harness = await createRecorderHarness({
    sources: [
      { id: 'opaque-a', display_id: '', screen_index: null },
      { id: 'opaque-b', display_id: '', screen_index: null },
    ],
    init: { displayId: '101', displayIndex: 0 },
  });

  assert.equal(harness.getMediaConstraints(), null);
  assert.match(harness.elements.toast.textContent, /无法可靠匹配|未找到可录制/);
  assert.equal(harness.elements.btnStart.hidden, false);
});

test('renderer recording cap keeps whole-buffer IPC peak bounded', () => {
  const match = /MAX_RECORDING_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(recorderSource);
  assert.ok(match, 'recorder must declare an explicit MiB cap');
  assert.ok(Number(match[1]) <= 128, 'whole-buffer renderer/main transfer must be capped at 128 MiB or less');
});

test('failed or canceled recording saves remain retryable instead of closing the only copy', () => {
  assert.match(recorderSource, /pendingRecordingBlob/);
  assert.match(recorderSource, /showSaveRetry/);
  assert.match(recorderSource, /if\s*\(completion\.saved\s*===\s*true\)/);
  assert.match(recorderSource, /lifecycle\.isCurrentSave\(saveToken\)/);
  assert.doesNotMatch(recorderSource, /catch\s*\(err\)[\s\S]{0,220}setTimeout\(\(\)\s*=>\s*api\.closeSelf/);
});

test('pausing keeps the stop control available while exposing the resume action', async () => {
  const harness = await createRecorderHarness();

  await harness.elements.btnPause.dispatch('click');

  assert.equal(harness.getMediaRecorder().pauseCalls, 1);
  assert.equal(harness.elements.btnPause.textContent, '▶');
  assert.equal(harness.elements.btnStop.hidden, false, 'pause must not hide the only save/stop action');
  assert.equal(harness.elements.btnStop.disabled, false);
  assert.equal(harness.elements.status.hidden, false);
  assert.equal(harness.elements.toast.hidden, true, 'pause status must not cover the recording controls');
});

test('resuming preserves elapsed recording time and excludes time spent paused', async () => {
  const harness = await createRecorderHarness();
  harness.setNow(5200);
  harness.tickTimer();
  assert.equal(harness.elements.timer.textContent, '00:05');

  await harness.elements.btnPause.dispatch('click');
  harness.setNow(15200);
  await harness.elements.btnPause.dispatch('click');

  assert.equal(harness.getMediaRecorder().resumeCalls, 1);
  assert.equal(harness.elements.timer.textContent, '00:05', 'resume must retain pre-pause elapsed time');

  harness.setNow(18300);
  harness.tickTimer();
  assert.equal(harness.elements.timer.textContent, '00:08');
});

test('save progress keeps its blocking toast semantics', async () => {
  const saving = await createRecorderHarness();
  await saving.elements.btnStop.dispatch('click');

  assert.equal(saving.elements.toast.hidden, false);
  assert.equal(saving.elements.toast.textContent, '正在保存…');
  assert.equal(saving.elements.toast.style.color, '#1f2329');
  assert.equal(saving.elements.btnStop.hidden, true);
});

test('MediaRecorder errors preserve existing chunks as a retryable partial recording', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });

  mediaRecorder.onerror({ error: new Error('encoder failed') });

  assert.equal(mediaRecorder.requestDataCalls, 1, 'error recovery should request the encoder\'s latest data');
  assert.equal(mediaRecorder.stopCalls, 1, 'error recovery should stop the recorder exactly once');
  assert.equal(harness.getStateReports().at(-1).state, 'stopping');
  assert.equal(harness.elements.toast.textContent, '录制过程出错，正在整理可恢复内容…');

  await mediaRecorder.onstop();

  assert.equal(harness.getSaveCalls().length, 0, '部分录屏必须由用户明确选择保存');
  assert.equal(harness.getCloseCalls(), 0);
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.equal(harness.elements.btnRetry.hidden, false);
  assert.match(harness.elements.toast.textContent, /已保留.*部分录屏.*保存/);

  await harness.elements.btnRetry.dispatch('click', { type: 'click' });
  assert.equal(harness.getSaveCalls().length, 1);
  assert.equal(harness.getStateReports().at(-1).state, 'saved');
  assert.equal(harness.getCloseCalls(), 1);
});

test('MediaRecorder errors without chunks report failure and never claim a save', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();

  mediaRecorder.onerror({ error: new Error('encoder failed') });
  await mediaRecorder.onstop();

  assert.equal(harness.getSaveCalls().length, 0);
  assert.equal(harness.getCloseCalls(), 0);
  assert.equal(harness.getStateReports().at(-1).state, 'error');
  assert.equal(harness.getStateReports().some((item) => item.state === 'saved'), false);
  assert.equal(harness.elements.btnRetry.hidden, true);
  assert.equal(harness.elements.toast.hidden, false);
  assert.match(harness.elements.toast.textContent, /录制过程出错.*未能恢复/);
  assert.equal(harness.elements.toast.style.color, '#ef4444');
});

test('an error received after user stop downgrades the recording to partial instead of auto-saving', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });

  await harness.elements.btnStop.dispatch('click');
  assert.equal(harness.getPendingTimeouts().filter((delay) => delay === 4000).length, 1);
  mediaRecorder.onerror({ error: new Error('encoder failed during stop') });
  assert.equal(
    harness.getPendingTimeouts().filter((delay) => delay === 4000).length,
    1,
    'normal-stop and error recovery must share one finite watchdog'
  );
  await mediaRecorder.onstop();

  assert.equal(harness.getSaveCalls().length, 0, '已报错的截断内容不得当作完整录屏自动保存');
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.match(harness.elements.toast.textContent, /部分录屏/);
  assert.equal(harness.getCloseCalls(), 0);
  assert.equal(harness.getPendingTimeouts().includes(4000), false);
});

test('an error during user-stop Blob serialization is downgraded before save IPC submission', async () => {
  let resolveBuffer;
  const bufferReady = new Promise((resolve) => { resolveBuffer = resolve; });
  const harness = await createRecorderHarness({ Blob: createDeferredBlobClass(bufferReady) });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: { size: 16 } });

  await harness.elements.btnStop.dispatch('click');
  const saving = mediaRecorder.onstop();
  await Promise.resolve();
  mediaRecorder.onerror({ error: new Error('encoder failed during serialization') });
  resolveBuffer(new ArrayBuffer(16));
  await saving;

  assert.equal(harness.getSaveCalls().length, 0, '提交 IPC 前收到 error 必须降级为部分录屏');
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.match(harness.elements.toast.textContent, /部分录屏/);

  await harness.elements.btnRetry.dispatch('click');
  assert.equal(harness.getSaveCalls().length, 1, '用户确认后才允许提交部分录屏');
});

test('duplicate stop events cannot serialize or save the same partial recording twice', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });
  mediaRecorder.onerror({ error: new Error('encoder failed') });

  await mediaRecorder.onstop();
  const saveAttemptAfterFirstStop = harness.getStateReports().at(-1).saveAttempt;
  await mediaRecorder.onstop();

  assert.equal(harness.getSaveCalls().length, 0);
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.equal(harness.getStateReports().at(-1).saveAttempt, saveAttemptAfterFirstStop);

  await harness.elements.btnRetry.dispatch('click', { type: 'click' });
  assert.equal(harness.getSaveCalls().length, 1, '用户的唯一一次重试才能提交保存');
});

test('error watchdog finalizes existing chunks when the browser omits the stop event', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });

  mediaRecorder.onerror({ error: new Error('encoder failed') });
  mediaRecorder.onerror({ error: new Error('duplicate encoder error') });
  assert.equal(harness.getPendingTimeouts().includes(4000), true);
  assert.equal(harness.getPendingTimeouts().filter((delay) => delay === 4000).length, 1);
  await harness.runTimeouts(4000);

  assert.equal(harness.getSaveCalls().length, 0);
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.equal(harness.elements.btnRetry.hidden, false);
  assert.equal(harness.getPendingTimeouts().includes(4000), false);
  assert.ok(harness.canvasStream.getTracks().every((track) => track.stopCalls > 0));

  await mediaRecorder.onstop();
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry', '迟到的 stop 事件必须幂等');
});

test('error watchdog fails closed when there are no chunks and cancel clears the timer', async () => {
  const empty = await createRecorderHarness();
  empty.getMediaRecorder().onerror({ error: new Error('encoder failed') });
  await empty.runTimeouts(4000);

  assert.equal(empty.getStateReports().at(-1).state, 'error');
  assert.equal(empty.getSaveCalls().length, 0);
  assert.equal(empty.getStateReports().some((item) => item.state === 'saved'), false);
  assert.match(empty.elements.toast.textContent, /未能恢复/);

  const canceled = await createRecorderHarness();
  canceled.getMediaRecorder().onerror({ error: new Error('encoder failed') });
  assert.equal(canceled.getPendingTimeouts().includes(4000), true);
  await canceled.elements.btnCancel.dispatch('click');
  assert.equal(canceled.getPendingTimeouts().includes(4000), false);
  await canceled.runTimeouts(4000);
  assert.equal(canceled.getSaveCalls().length, 0);
  assert.equal(canceled.getStateReports().at(-1).state, 'canceled');
});

test('normal stop watchdog retains existing chunks as partial when stop and error events are both missing', async () => {
  const harness = await createRecorderHarness();
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });

  await harness.elements.btnStop.dispatch('click');
  assert.equal(harness.getPendingTimeouts().filter((delay) => delay === 4000).length, 1);
  await harness.runTimeouts(4000);

  assert.equal(harness.getSaveCalls().length, 0, '未收到 stop 确认时不得把 chunks 当作完整录屏自动保存');
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');
  assert.equal(harness.elements.btnRetry.hidden, false);
  assert.match(harness.elements.toast.textContent, /未收到.*停止.*部分录屏/);
  assert.equal(harness.getPendingTimeouts().includes(4000), false);

  const saveAttemptAfterWatchdog = harness.getStateReports().at(-1).saveAttempt;
  await mediaRecorder.onstop();
  assert.equal(harness.getStateReports().at(-1).saveAttempt, saveAttemptAfterWatchdog);
  assert.equal(harness.getSaveCalls().length, 0, '迟到 stop 事件必须被一次性 gate 忽略');

  await harness.elements.btnRetry.dispatch('click');
  assert.equal(harness.getSaveCalls().length, 1, '用户确认后才能保存未确认完整性的录屏');
});

test('normal stop watchdog fails closed when no chunks and no terminal recorder events arrive', async () => {
  const harness = await createRecorderHarness();

  await harness.elements.btnStop.dispatch('click');
  await harness.runTimeouts(4000);

  assert.equal(harness.getSaveCalls().length, 0);
  assert.equal(harness.getCloseCalls(), 0);
  assert.equal(harness.getStateReports().at(-1).state, 'error');
  assert.equal(harness.getStateReports().some((item) => item.state === 'saved'), false);
  assert.equal(harness.elements.btnRetry.hidden, true);
  assert.match(harness.elements.toast.textContent, /未收到.*停止.*未能恢复/);
});

test('concurrent cancel clicks close the recorder window at most once', async () => {
  const harness = await createRecorderHarness();

  const firstCancel = harness.elements.btnCancel.dispatch('click');
  const secondCancel = harness.elements.btnCancel.dispatch('click');
  await Promise.all([firstCancel, secondCancel]);

  assert.equal(harness.getCloseCalls(), 1);
  assert.equal(
    harness.getStateReports().filter((item) => item.state === 'canceled').length,
    1,
    'already-canceled must be a no-op rather than starting a second close flow'
  );
});

test('audio capture is opt-in and remains disabled for existing init payloads', async () => {
  const harness = await createRecorderHarness();

  assert.equal(harness.getMediaCalls().length, 1);
  assert.equal(harness.getMediaCalls()[0].audio, false);
  assert.equal(harness.getMediaRecorder().stream.getAudioTracks().length, 0);
});

test('requested system audio is acquired from the desktop source and recorded', async () => {
  const harness = await createRecorderHarness({
    init: { systemAudio: true },
    systemAudioAvailable: true,
  });

  const desktopAudio = harness.getMediaCalls()[0].audio;
  assert.equal(desktopAudio.mandatory.chromeMediaSource, 'desktop');
  assert.equal(desktopAudio.mandatory.chromeMediaSourceId, 'screen:1');
  assert.deepEqual(harness.getMediaRecorder().stream.getAudioTracks(), [harness.tracks.systemAudioTrack]);
});

test('requested microphone is acquired separately and recorded', async () => {
  const harness = await createRecorderHarness({ init: { microphone: true } });

  assert.equal(harness.getMediaCalls().length, 2);
  assert.equal(harness.getMediaCalls()[0].audio, false);
  assert.equal(harness.getMediaCalls()[1].audio, true);
  assert.equal(harness.getMediaCalls()[1].video, false);
  assert.deepEqual(harness.getMediaRecorder().stream.getAudioTracks(), [harness.tracks.microphoneTrack]);
});

test('system audio and microphone are mixed into one deterministic recorder track', async () => {
  const harness = await createRecorderHarness({
    init: { systemAudio: true, microphone: true },
    systemAudioAvailable: true,
  });

  assert.deepEqual(harness.getAudioSourceStreams(), [harness.captureStream, harness.microphoneStream]);
  assert.deepEqual(harness.getMediaRecorder().stream.getAudioTracks(), [harness.tracks.mixedAudioTrack]);
});

test('requested system audio without an audio track fails closed with a retryable explanation', async () => {
  const harness = await createRecorderHarness({ init: { systemAudio: true } });

  assert.equal(harness.getMediaRecorder(), null);
  assert.match(harness.elements.toast.textContent, /系统音频.*(?:未提供|不可用|不支持)/);
  assert.equal(harness.elements.btnStart.hidden, false);
  assert.equal(harness.tracks.screenVideoTrack.stopCalls, 1);
});

test('microphone permission denial fails closed and releases the already-open desktop stream', async () => {
  const error = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const harness = await createRecorderHarness({
    init: { microphone: true },
    microphoneError: error,
  });

  assert.equal(harness.getMediaRecorder(), null);
  assert.match(harness.elements.toast.textContent, /麦克风.*(?:权限|拒绝)/);
  assert.equal(harness.elements.btnStart.hidden, false);
  assert.equal(harness.tracks.screenVideoTrack.stopCalls, 1);
});

test('missing microphone fails closed instead of silently producing a video-only recording', async () => {
  const error = Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
  const harness = await createRecorderHarness({
    init: { microphone: true },
    microphoneError: error,
  });

  assert.equal(harness.getMediaRecorder(), null);
  assert.match(harness.elements.toast.textContent, /未找到可用麦克风/);
  assert.equal(harness.elements.btnStart.hidden, false);
});

test('pause keeps audio sources resumable and stop releases every requested source track', async () => {
  const harness = await createRecorderHarness({
    init: { systemAudio: true, microphone: true },
    systemAudioAvailable: true,
  });

  await harness.elements.btnPause.dispatch('click');
  assert.equal(harness.tracks.systemAudioTrack.stopCalls, 0);
  assert.equal(harness.tracks.microphoneTrack.stopCalls, 0);

  await harness.elements.btnPause.dispatch('click');
  await harness.elements.btnStop.dispatch('click');
  assert.equal(harness.tracks.systemAudioTrack.stopCalls, 1);
  assert.equal(harness.tracks.microphoneTrack.stopCalls, 1);
});

test('dual-audio capture fails explicitly when the runtime cannot mix tracks', async () => {
  const harness = await createRecorderHarness({
    init: { systemAudio: true, microphone: true },
    systemAudioAvailable: true,
    audioContextUnavailable: true,
  });

  assert.equal(harness.getMediaRecorder(), null);
  assert.match(harness.elements.toast.textContent, /无法混合系统音频和麦克风/);
  assert.equal(harness.elements.btnStart.hidden, false);
});

test('system-audio permission errors name both required permissions and remain retryable', async () => {
  const error = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const harness = await createRecorderHarness({
    init: { systemAudio: true },
    desktopError: error,
  });

  assert.equal(harness.getMediaRecorder(), null);
  assert.match(harness.elements.toast.textContent, /屏幕或系统音频.*(?:拒绝|权限)/);
  assert.equal(harness.elements.btnStart.hidden, false);
  assert.equal(harness.elements.btnStart.disabled, false);
});

test('cancel releases mixed audio output and closes its AudioContext', async () => {
  const harness = await createRecorderHarness({
    init: { systemAudio: true, microphone: true },
    systemAudioAvailable: true,
  });

  await harness.elements.btnCancel.dispatch('click');

  assert.equal(harness.tracks.systemAudioTrack.stopCalls, 1);
  assert.equal(harness.tracks.microphoneTrack.stopCalls, 1);
  assert.equal(harness.tracks.mixedAudioTrack.stopCalls, 1);
  assert.equal(harness.getAudioContext().closeCalls, 1);
});

test('cancel while microphone permission is pending stops the late stream without starting a recorder', async () => {
  let resolveMicrophone;
  const microphoneReady = new Promise((resolve) => { resolveMicrophone = resolve; });
  const harness = await createRecorderHarness({
    autoStart: false,
    init: { microphone: true },
    acquireMicrophone: () => microphoneReady,
  });

  const starting = harness.start();
  while (harness.getMediaCalls().length < 2) await Promise.resolve();
  await harness.elements.btnCancel.dispatch('click');
  resolveMicrophone(harness.microphoneStream);
  await starting;

  assert.equal(harness.getMediaRecorder(), null);
  assert.equal(harness.tracks.microphoneTrack.stopCalls, 1);
  assert.equal(harness.tracks.screenVideoTrack.stopCalls, 1);
});

test('cancel during Blob serialization invalidates the attempt before save IPC', async () => {
  let resolveBuffer;
  const bufferReady = new Promise((resolve) => { resolveBuffer = resolve; });
  const harness = await createRecorderHarness({ Blob: createDeferredBlobClass(bufferReady) });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: { size: 16 } });
  await harness.elements.btnStop.dispatch('click');

  const saving = mediaRecorder.onstop();
  await Promise.resolve();
  await harness.elements.btnCancel.dispatch('click');
  resolveBuffer(new ArrayBuffer(16));
  await saving;

  assert.equal(harness.getSaveCalls().length, 0, 'a canceled serialization must never cross into main-process save');
  assert.equal(harness.getCloseCalls(), 1);
  assert.equal(harness.getStateReports().at(-1).state, 'canceled');
});

test('cancel is refused after save IPC submission until the commit result is known', async () => {
  let resolveSave;
  const saveReady = new Promise((resolve) => { resolveSave = resolve; });
  const harness = await createRecorderHarness({
    saveRecording: () => saveReady,
  });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });
  await harness.elements.btnStop.dispatch('click');

  const saving = mediaRecorder.onstop();
  while (harness.getSaveCalls().length === 0) await Promise.resolve();
  await harness.elements.btnCancel.dispatch('click');

  assert.equal(harness.getCloseCalls(), 0, 'the recorder must stay open while disk commit outcome is unknown');
  assert.match(harness.elements.toast.textContent, /保存请求已提交.*等待保存结果/);
  assert.equal(harness.getStateReports().some((item) => item.state === 'canceled'), false);

  resolveSave({ saved: true, path: '/tmp/already-written.webm' });
  await saving;
  assert.equal(harness.getCloseCalls(), 1);
  assert.equal(harness.getStateReports().at(-1).state, 'saved');
});

test('forced detach makes a late save result UI-inert without calling it canceled', async () => {
  let resolveSave;
  const saveReady = new Promise((resolve) => { resolveSave = resolve; });
  const harness = await createRecorderHarness({ saveRecording: () => saveReady });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });
  await harness.elements.btnStop.dispatch('click');
  const saving = mediaRecorder.onstop();
  while (harness.getSaveCalls().length === 0) await Promise.resolve();

  harness.dispatchWindow('beforeunload');
  const messageAtDetach = harness.elements.toast.textContent;
  resolveSave({ saved: false, error: 'late result must be ignored' });
  await saving;

  assert.equal(harness.elements.toast.textContent, messageAtDetach);
  assert.equal(harness.elements.btnRetry.hidden, true, 'late failure must not expose retry UI on a closing page');
  assert.equal(harness.getCloseCalls(), 0);
  assert.equal(harness.getStateReports().some((item) => item.state === 'canceled'), false);
});

test('dialog cancellation keeps the only Blob retryable until the user explicitly discards it', async () => {
  const harness = await createRecorderHarness({
    saveRecording: async () => ({ saved: false, canceled: true }),
  });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });
  await harness.elements.btnStop.dispatch('click');
  await mediaRecorder.onstop();
  for (let i = 0; i < 20 && !harness.getStateReports().some((item) => item.state === 'save-retry'); i += 1) {
    await Promise.resolve();
  }

  assert.equal(harness.elements.btnRetry.hidden, false);
  assert.match(harness.elements.toast.textContent, /录屏仍完整保留/);
  assert.equal(harness.getStateReports().some((item) => item.state === 'save-retry'), true);
  assert.equal(harness.getCloseCalls(), 0);

  await harness.elements.btnCancel.dispatch('click');
  assert.equal(harness.getCloseCalls(), 1);
  assert.equal(harness.getStateReports().at(-1).state, 'canceled');
});

test('retry button starts a fresh save attempt instead of treating the click event as a token', async () => {
  let attempt = 0;
  const harness = await createRecorderHarness({
    saveRecording: async () => {
      attempt += 1;
      return attempt === 1
        ? { saved: false, canceled: true }
        : { saved: true, path: '/tmp/retried.webm' };
    },
  });
  const mediaRecorder = harness.getMediaRecorder();
  mediaRecorder.ondataavailable({ data: new Blob([new Uint8Array(16)]) });
  await harness.elements.btnStop.dispatch('click');
  await mediaRecorder.onstop();

  assert.equal(harness.getSaveCalls().length, 1);
  assert.equal(harness.getStateReports().at(-1).state, 'save-retry');

  await harness.elements.btnRetry.dispatch('click', { type: 'click' });

  assert.equal(harness.getSaveCalls().length, 2, 'retry must submit the retained Blob again');
  assert.equal(harness.getStateReports().at(-1).state, 'saved');
  assert.equal(harness.getCloseCalls(), 1);
});

test('recorder page and preload expose the lifecycle state contract', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'recorder', 'recorder.html'),
    'utf8',
  );
  const channels = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'channels.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');

  assert.match(html, /recorder-lifecycle\.js[\s\S]*recorder\.js/);
  assert.match(channels, /RECORD_STATE:\s*'record:state'/);
  assert.match(preload, /RECORD_STATE:\s*'record:state'/);
  assert.match(preload, /reportRecordingState:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(C\.RECORD_STATE,\s*payload\)/);
});
