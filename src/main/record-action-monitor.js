'use strict';

const MAX_LINE_BYTES = 4096;
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_ABS_COORDINATE = 1_000_000;
const ALLOWED_MOUSE_TYPES = new Set(['mouse-down', 'mouse-up', 'mouse-dragged']);

function normalizeModifiers(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    alt: input.alt === true,
    control: input.control === true,
    meta: input.meta === true,
    shift: input.shift === true,
  };
}

function sanitizeEvent(raw, dependencies) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const now = dependencies.now();
  const modifiers = normalizeModifiers(raw.modifiers);
  if (raw.type === 'key') {
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key || key.length > 16 || /[\u0000-\u001f\u007f]/.test(key)) return null;
    return { type: 'key', key, at: now, modifiers };
  }
  if (!ALLOWED_MOUSE_TYPES.has(raw.type)) return null;
  const hasRawX = Object.prototype.hasOwnProperty.call(raw, 'x');
  const hasRawY = Object.prototype.hasOwnProperty.call(raw, 'y');
  let x;
  let y;
  if (hasRawX || hasRawY) {
    // 新 helper 在事件回调发生时采样坐标，避免主进程消费 pipe 时再读取光标造成偏移。
    // 一旦 helper 声明了坐标，就必须两轴都是有限且有界的 number；畸形输入不能
    // 悄悄退化为稍后的 cursorPoint，因为那会掩盖协议错误并画到错误位置。
    if (!hasRawX || !hasRawY || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    x = raw.x;
    y = raw.y;
    if (
      !Number.isFinite(x)
      || !Number.isFinite(y)
      || Math.abs(x) > MAX_ABS_COORDINATE
      || Math.abs(y) > MAX_ABS_COORDINATE
    ) return null;
  } else {
    // 兼容已经缓存/预构建的旧 helper；升级后的 helper 不走此分支。
    let point;
    try {
      point = dependencies.cursorPoint();
    } catch (_) {
      return null;
    }
    x = Number(point && point.x);
    y = Number(point && point.y);
    if (
      !Number.isFinite(x)
      || !Number.isFinite(y)
      || Math.abs(x) > MAX_ABS_COORDINATE
      || Math.abs(y) > MAX_ABS_COORDINATE
    ) return null;
  }
  return {
    type: raw.type,
    button: raw.button === 'right' ? 'right' : 'left',
    x,
    y,
    at: now,
    modifiers,
  };
}

function createRecordActionMonitor(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.ensureBinary !== 'function') throw new TypeError('ensureBinary is required');
  if (typeof opts.spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
  if (typeof opts.cursorPoint !== 'function') throw new TypeError('cursorPoint is required');
  const dependencies = {
    now: typeof opts.now === 'function' ? opts.now : Date.now,
    cursorPoint: opts.cursorPoint,
  };
  const readyTimeoutMs = Math.max(100, Math.min(10000, Number(opts.readyTimeoutMs) || 2500));
  const terminationGraceMs = Math.max(
    10,
    Math.min(5000, Number(opts.terminationGraceMs) || 1000),
  );
  let current = null;
  let generation = 0;

  function publicStatus() {
    return {
      active: Boolean(current && current.ready),
      ownerId: current ? current.ownerId : null,
    };
  }

  function settleReady(state, error) {
    if (!state || state.readySettled) return;
    state.readySettled = true;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.readyTimer = null;
    if (error) state.rejectReady(error);
    else {
      state.ready = true;
      state.resolveReady({ ok: true, active: true });
    }
  }

  function detachState(state) {
    if (!state) return;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.readyTimer = null;
    if (current === state) {
      current = null;
      generation += 1;
    }
  }

  function clearTerminationTimer(state) {
    if (!state || !state.terminationTimer) return;
    clearTimeout(state.terminationTimer);
    state.terminationTimer = null;
  }

  function terminateProcess(state) {
    if (!state || !state.child || state.childExited || state.terminationStarted) return;
    state.terminationStarted = true;
    try { state.child.kill('SIGTERM'); } catch (_) { /* already exited */ }
    state.terminationTimer = setTimeout(() => {
      state.terminationTimer = null;
      if (state.childExited) return;
      try { state.child.kill('SIGKILL'); } catch (_) { /* already exited */ }
    }, terminationGraceMs);
    if (state.terminationTimer && typeof state.terminationTimer.unref === 'function') {
      state.terminationTimer.unref();
    }
  }

  function notifyStopped(state, detail) {
    if (!state || state.stopNotified) return;
    state.stopNotified = true;
    if (typeof state.onStopped !== 'function') return;
    try {
      state.onStopped({
        ownerId: state.ownerId,
        unexpected: detail.unexpected === true,
        error: detail.error ? detail.error.message : null,
      });
    } catch (_) {
      /* owner cleanup must not destabilize the monitor state machine */
    }
  }

  function finishState(state, detail = {}) {
    if (!state || state.stopped) return;
    const wasReady = state.ready === true;
    const error = detail.error instanceof Error
      ? detail.error
      : new Error(String(detail.error || '操作提示监听器已停止。'));
    state.stopped = true;
    settleReady(state, error);
    detachState(state);

    if (detail.unexpected === true && wasReady) {
      try {
        state.send({
          type: 'monitor-error',
          error: error.message.slice(0, 500),
          at: dependencies.now(),
        });
      } catch (_) {
        /* renderer may already have closed */
      }
    }
    if (detail.terminate === true) terminateProcess(state);
    notifyStopped(state, { unexpected: detail.unexpected, error });
  }

  function failureError(state, fallback, cause) {
    const stderr = state && typeof state.stderr === 'string'
      ? state.stderr.trim().slice(-1000)
      : '';
    const causeMessage = cause && cause.message ? cause.message : String(cause || '');
    return new Error(stderr || causeMessage || fallback || '操作提示监听器启动失败。');
  }

  function failState(state, fallback, cause, { childExited = false } = {}) {
    if (!state) return;
    if (childExited) {
      state.childExited = true;
      clearTerminationTimer(state);
    }
    if (state.stopped) return;
    finishState(state, {
      error: failureError(state, fallback, cause),
      unexpected: true,
      terminate: !childExited,
    });
  }

  function consumeLine(state, line) {
    if (!state || state.stopped || current !== state) return;
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (raw && raw.type === 'ready') {
      settleReady(state, null);
      return;
    }
    if (!state.ready) return;
    const event = sanitizeEvent(raw, dependencies);
    if (!event) return;
    try { state.send(event); } catch (_) { /* renderer may have closed */ }
  }

  function consumeChunk(state, chunk) {
    if (!state || state.stopped || current !== state) return;
    state.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_BUFFER_BYTES) {
      state.buffer = '';
      return;
    }
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() || '';
    for (const line of lines) consumeLine(state, line);
  }

  async function launch(state) {
    let binaryPath;
    try {
      binaryPath = await opts.ensureBinary();
    } catch (error) {
      failState(state, '操作提示监听器准备失败。', error);
      return;
    }
    if (state.stopped || current !== state || state.token !== generation) return;

    let child;
    try {
      child = opts.spawnProcess(binaryPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      failState(
        state,
        `操作提示监听器启动失败：${(error && error.message) || String(error)}`,
        error,
      );
      return;
    }
    state.child = child;
    if (
      !child
      || !child.stdout
      || !child.stderr
      || typeof child.on !== 'function'
      || typeof child.once !== 'function'
    ) {
      failState(state, '操作提示监听器进程无效。');
      return;
    }

    child.stdout.on('data', (chunk) => consumeChunk(state, chunk));
    child.stderr.on('data', (chunk) => {
      if (state.stderr.length >= 4096) return;
      state.stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      state.stderr = state.stderr.slice(-4096);
    });
    child.once('error', (error) => {
      state.stderr += ` ${(error && error.message) || String(error)}`;
      failState(state, '操作提示监听器进程出错。', error);
    });
    child.once('exit', (code, signal) => {
      failState(
        state,
        `操作提示监听器退出（${signal || code || 0}）。`,
        null,
        { childExited: true },
      );
    });
    state.readyTimer = setTimeout(() => {
      if (current !== state || state.ready || state.stopped) return;
      failState(state, '操作提示监听器启动超时。');
    }, readyTimeoutMs);
  }

  function start(request) {
    const ownerId = Number(request && request.ownerId);
    const send = request && request.send;
    if (!Number.isInteger(ownerId) || ownerId <= 0 || typeof send !== 'function') {
      return Promise.reject(new Error('操作提示监听器参数无效。'));
    }
    if (current && current.ownerId === ownerId) {
      if (current.ready) return Promise.resolve({ ok: true, active: true });
      return current.readyPromise;
    }
    if (current) {
      finishState(current, {
        error: new Error('操作提示监听器已由新的录屏窗口接管。'),
        unexpected: false,
        terminate: true,
      });
    }

    const token = ++generation;
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state = {
      ownerId,
      token,
      child: null,
      send,
      onStopped: typeof request.onStopped === 'function' ? request.onStopped : null,
      buffer: '',
      stderr: '',
      ready: false,
      readySettled: false,
      readyPromise,
      resolveReady,
      rejectReady,
      readyTimer: null,
      terminationTimer: null,
      terminationStarted: false,
      childExited: false,
      stopNotified: false,
      stopped: false,
    };
    current = state;
    void launch(state);
    return readyPromise;
  }

  function stop(ownerId) {
    if (!current) return { ok: true, active: false };
    if (ownerId !== undefined && Number(ownerId) !== current.ownerId) {
      return { ok: false, active: Boolean(current.ready) };
    }
    finishState(current, {
      error: new Error('操作提示监听器启动已取消或已停止。'),
      unexpected: false,
      terminate: true,
    });
    return { ok: true, active: false };
  }

  function stopAll() {
    return stop();
  }

  return { start, status: publicStatus, stop, stopAll };
}

function createRecordActionOwnerRegistry(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.stop !== 'function') throw new TypeError('stop is required');
  const entries = new Map();

  function release(ownerId, sender) {
    const entry = entries.get(Number(ownerId));
    if (!entry || (sender && entry.sender !== sender)) return false;
    entries.delete(entry.ownerId);
    try { entry.sender.removeListener('destroyed', entry.onDestroyed); } catch (_) {}
    return true;
  }

  function watch(sender) {
    const ownerId = Number(sender && sender.id);
    if (
      !Number.isInteger(ownerId)
      || ownerId <= 0
      || typeof sender.once !== 'function'
      || typeof sender.removeListener !== 'function'
    ) throw new TypeError('record action owner sender is invalid');

    const existing = entries.get(ownerId);
    if (existing && existing.sender === sender) return existing.release;
    if (existing) release(ownerId);

    const entry = { ownerId, sender, onDestroyed: null, release: null };
    entry.onDestroyed = () => {
      if (entries.get(ownerId) !== entry) return;
      entries.delete(ownerId);
      try { opts.stop(ownerId); } catch (_) { /* app is already shutting down */ }
    };
    entry.release = () => release(ownerId, sender);
    entries.set(ownerId, entry);
    sender.once('destroyed', entry.onDestroyed);
    return entry.release;
  }

  return { watch, release };
}

module.exports = {
  createRecordActionMonitor,
  createRecordActionOwnerRegistry,
  sanitizeEvent,
};
