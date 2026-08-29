'use strict';

const crypto = require('node:crypto');

function createTimedCaptureScheduler({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  makeId = () => crypto.randomUUID(),
  onFire,
  onError = () => {},
} = {}) {
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function' || typeof makeId !== 'function') {
    throw new TypeError('定时截图调度器依赖无效。');
  }
  if (typeof onFire !== 'function') throw new TypeError('定时截图执行函数无效。');

  const jobs = new Map();

  function normalize(payload) {
    const delay = payload && payload.delay;
    if (!Number.isInteger(delay)) throw new Error('延时秒数必须是整数。');
    if (delay < 1 || delay > 300) throw new Error('延时秒数必须在 1 到 300 之间。');
    const mode = (payload && payload.mode) || 'region';
    if (!['region', 'fullscreen'].includes(mode)) throw new Error('定时截图模式无效。');
    return { delay, mode };
  }

  function schedule(payload) {
    const normalized = normalize(payload);
    let id;
    do {
      id = String(makeId());
    } while (!id || jobs.has(id));
    const job = Object.freeze({ id, delay: normalized.delay, mode: normalized.mode });
    const entry = {
      handle: null,
      job,
      phase: 'pending',
      controller: new AbortController(),
    };
    // 先登记再安装 timer，即使测试或特殊 timer 实现同步回调，也有可取消的任务状态。
    jobs.set(id, entry);
    try {
      entry.handle = setTimer(async () => {
        if (jobs.get(id) !== entry || entry.controller.signal.aborted) return;
        // firing 阶段仍保留在 jobs 中，cancel/cancelAll 才能中止尚在 await 抓屏的任务。
        entry.phase = 'firing';
        const control = Object.freeze({
          signal: entry.controller.signal,
          isCanceled: () => entry.controller.signal.aborted,
        });
        try {
          await onFire(job, control);
        } catch (error) {
          // 取消后下游因 AbortSignal 拒绝是预期路径，不应弹“定时截图失败”。
          if (!entry.controller.signal.aborted) {
            try { onError(error, job); } catch (_) {}
          }
        } finally {
          if (jobs.get(id) === entry) jobs.delete(id);
        }
      }, normalized.delay * 1000);
    } catch (error) {
      jobs.delete(id);
      entry.controller.abort(error);
      throw error;
    }
    return { ...job };
  }

  function cancel(id) {
    const key = String(id || '');
    const entry = jobs.get(key);
    if (!entry) return false;
    jobs.delete(key);
    if (entry.phase === 'pending' && entry.handle != null) clearTimer(entry.handle);
    entry.controller.abort('canceled');
    return true;
  }

  function cancelAll() {
    const active = [...jobs.values()];
    const count = active.length;
    jobs.clear();
    for (const entry of active) {
      if (entry.phase === 'pending' && entry.handle != null) clearTimer(entry.handle);
      entry.controller.abort('canceled-all');
    }
    return count;
  }

  return {
    schedule,
    cancel,
    cancelAll,
    // 公开 pending 仍只表示还在等候 timer 的任务；firing 只是内部可取消生命周期。
    pending: () => [...jobs.values()]
      .filter((entry) => entry.phase === 'pending')
      .map(({ job }) => ({ ...job })),
  };
}

module.exports = { createTimedCaptureScheduler };
