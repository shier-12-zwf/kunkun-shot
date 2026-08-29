'use strict';

const CAPTURE_MODES = new Set(['region', 'fullscreen', 'window', 'ocr', 'long', 'record']);
const CAPTURE_TRIGGERS = new Set(['direct', 'timed', 'automation']);

function isThenable(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function normalizeEditorState(value) {
  if (value == null || value === false) return { open: false, dirty: false };
  if (value === true) return { open: true, dirty: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) || isThenable(value)) {
    throw new TypeError('编辑器状态无效。');
  }
  if (typeof value.open !== 'boolean') throw new TypeError('编辑器状态无效。');
  if (value.dirty !== undefined && typeof value.dirty !== 'boolean') {
    throw new TypeError('编辑器 dirty 状态无效。');
  }
  return { open: value.open, dirty: value.open && value.dirty === true };
}

function normalizeAbortSignal(value) {
  if (value == null) return null;
  if (
    typeof value !== 'object'
    || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function'
  ) throw new TypeError('截图取消信号无效。');
  return value;
}

function createCaptureCoordinator({ getEditorState, captureFrame, openEditor } = {}) {
  if (
    typeof getEditorState !== 'function'
    || typeof captureFrame !== 'function'
    || typeof openEditor !== 'function'
  ) throw new TypeError('截图协调器依赖无效。');

  let generation = 0;
  let pending = null;

  function readEditorState() {
    return normalizeEditorState(getEditorState());
  }

  function blockedByEditor(mode, state) {
    return {
      ok: false,
      busy: true,
      reason: 'editor-active',
      editorDirty: state.dirty,
      // 协调器从不默认关闭编辑器；需要替换时，上层必须先得到用户确认并显式关闭。
      requiresConfirmation: true,
      mode,
    };
  }

  function canceledResult(token) {
    return {
      ok: false,
      canceled: true,
      reason: token.cancelReason || 'aborted',
      mode: token.mode,
    };
  }

  function abortToken(token, reason) {
    if (!token || token.controller.signal.aborted) return false;
    token.cancelReason = reason;
    token.controller.abort(reason);
    return true;
  }

  function cancelPending(reason = 'canceled') {
    if (!pending) return false;
    if (typeof reason !== 'string' || !reason || reason.length > 128) {
      throw new TypeError('截图取消原因无效。');
    }
    // 代数立即失效，即使底层抓屏 API 不支持 AbortSignal，迟到结果也无法提交。
    generation += 1;
    return abortToken(pending, reason);
  }

  async function cancelPendingAndWait(reason = 'canceled', timeoutMs = 2000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new TypeError('截图取消等待时间无效。');
    }
    const token = pending;
    if (!token) return true;
    cancelPending(reason);

    let timer = null;
    const completed = await Promise.race([
      token.done.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  async function start(mode, options = {}) {
    if (!CAPTURE_MODES.has(mode)) throw new Error('截图模式无效。');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('截图选项无效。');
    }
    const allowedOptions = new Set(['trigger', 'signal']);
    for (const key of Object.keys(options)) {
      if (!allowedOptions.has(key)) throw new Error(`未知截图选项：${key}`);
    }
    const trigger = options.trigger == null ? 'direct' : options.trigger;
    if (!CAPTURE_TRIGGERS.has(trigger)) throw new Error('截图触发来源无效。');
    const externalSignal = normalizeAbortSignal(options.signal);
    if (externalSignal && externalSignal.aborted) {
      return { ok: false, canceled: true, reason: 'aborted', mode };
    }

    const initialEditor = readEditorState();
    if (initialEditor.open) return blockedByEditor(mode, initialEditor);

    if (pending) {
      // 定时任务是低优先级背景动作，不得顶掉用户正在发起的截图。
      if (trigger === 'timed') {
        return { ok: false, busy: true, reason: 'capture-pending', mode };
      }
      // 用户新的直接指令可以取代尚未建立编辑器的旧请求；代数保证旧抓屏迟到也不能提交。
      abortToken(pending, 'superseded');
    }

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const token = {
      generation: ++generation,
      mode,
      trigger,
      cancelReason: null,
      controller: new AbortController(),
      done,
      resolveDone,
    };
    pending = token;

    const forwardAbort = () => abortToken(token, 'aborted');
    if (externalSignal) externalSignal.addEventListener('abort', forwardAbort, { once: true });

    try {
      let frame;
      try {
        frame = await captureFrame({
          mode,
          trigger,
          generation: token.generation,
          signal: token.controller.signal,
        });
      } catch (error) {
        if (token.controller.signal.aborted || pending !== token || generation !== token.generation) {
          return canceledResult(token);
        }
        throw error;
      }

      // 这个检查必须在所有 await 之后、创建窗口之前。
      if (token.controller.signal.aborted || pending !== token || generation !== token.generation) {
        return canceledResult(token);
      }
      // 交互式窗口截图在用户按 Esc 时没有帧；把 null/undefined 作为明确取消，不进入窗口工厂。
      if (frame == null) {
        return { ok: false, canceled: true, reason: 'user-canceled', mode };
      }

      // 抓屏期间可能有其他入口建立了编辑器；宁可拒绝迟到结果，也不无提示覆盖。
      const currentEditor = readEditorState();
      if (currentEditor.open) return blockedByEditor(mode, currentEditor);

      // 窗口工厂必须同步完成提交，避免“检查—创建”之间又出现可交错的 await。
      const editor = openEditor(frame, {
        mode,
        trigger,
        generation: token.generation,
        signal: token.controller.signal,
      });
      if (isThenable(editor)) throw new TypeError('编辑器窗口工厂必须同步返回。');
      if (!editor) throw new Error('编辑器窗口未能创建。');
      return { ok: true, editing: true, mode, generation: token.generation };
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
      if (pending === token) pending = null;
      token.resolveDone();
    }
  }

  return {
    start,
    cancelPending,
    cancelPendingAndWait,
    status: () => ({
      generation,
      pending: pending
        ? { mode: pending.mode, trigger: pending.trigger, generation: pending.generation }
        : null,
    }),
  };
}

module.exports = { CAPTURE_MODES, CAPTURE_TRIGGERS, createCaptureCoordinator };
