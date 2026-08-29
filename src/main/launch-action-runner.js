'use strict';

const DIRECT_CAPTURE_MODES = new Set(['region', 'fullscreen', 'ocr', 'long', 'record']);
const TIMED_CAPTURE_MODES = new Set(['region', 'fullscreen']);

function createLaunchActionRunner({ startCapture, captureWindow, scheduleTimedCapture } = {}) {
  if (
    typeof startCapture !== 'function'
    || typeof captureWindow !== 'function'
    || typeof scheduleTimedCapture !== 'function'
  ) {
    throw new TypeError('启动动作执行依赖无效。');
  }

  async function run(action) {
    if (action == null) return { handled: false, result: null };
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('启动截图动作无效。');
    }

    if (action.type === 'capture') {
      if (action.mode === 'window') {
        return { handled: true, result: await captureWindow() };
      }
      if (!DIRECT_CAPTURE_MODES.has(action.mode)) throw new Error('启动截图动作无效。');
      return { handled: true, result: await startCapture(action.mode) };
    }

    if (action.type === 'timed') {
      if (
        !TIMED_CAPTURE_MODES.has(action.mode)
        || !Number.isInteger(action.delay)
        || action.delay < 1
        || action.delay > 300
      ) {
        throw new Error('启动延时截图动作无效。');
      }
      const result = scheduleTimedCapture({ mode: action.mode, delay: action.delay });
      return { handled: true, result };
    }

    throw new Error('启动截图动作无效。');
  }

  return { run };
}

module.exports = { createLaunchActionRunner };
