'use strict';

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`OCR 在 ${timeoutMs}ms 后超时。`);
      error.code = 'OCR_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createOCRWorkerPool(options) {
  const createWorker = options && options.createWorker;
  if (typeof createWorker !== 'function') throw new TypeError('createWorker is required');

  const buildWorkerOptions =
    options && typeof options.buildWorkerOptions === 'function'
      ? options.buildWorkerOptions
      : () => ({});
  const timeoutMs = Math.max(1, Number(options && options.timeoutMs) || 60000);
  // createWorker() 在 tesseract.js 返回 Worker 之前没有可取消句柄。允许一次恢复
  // bootstrap，但严格限制永不 settle 的启动 Promise 数量，避免每次超时都再泄漏一个。
  const maxPendingBootstraps = Math.max(
    1,
    Math.min(8, Number.isInteger(options && options.maxPendingBootstraps)
      ? options.maxPendingBootstraps
      : 2),
  );

  let current = null;
  let queue = Promise.resolve();
  const pendingBootstraps = new Set();

  function dispose(entry) {
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    if (current === entry) current = null;
    void entry.promise
      .then((worker) => {
        if (worker && typeof worker.terminate === 'function') return worker.terminate();
        return undefined;
      })
      .catch(() => {});
  }

  function entryFor(language) {
    if (current && current.language === language && !current.disposed) return current;
    if (current) dispose(current);

    if (pendingBootstraps.size >= maxPendingBootstraps) {
      const error = new Error('OCR Worker 仍在启动，已达到恢复上限；请稍后重试或重启应用。');
      error.code = 'OCR_BOOTSTRAP_LIMIT';
      throw error;
    }

    const entry = {
      language,
      disposed: false,
      promise: null
    };
    entry.promise = Promise.resolve().then(() =>
      createWorker(language, undefined, buildWorkerOptions(language))
    );
    pendingBootstraps.add(entry);
    void entry.promise.then(
      () => pendingBootstraps.delete(entry),
      () => pendingBootstraps.delete(entry),
    );
    current = entry;

    void entry.promise.catch(() => {
      if (current === entry) current = null;
    });
    return entry;
  }

  async function run(dataURL, language) {
    const entry = entryFor(language);
    const recognition = entry.promise.then(async (worker) => {
      const result = await worker.recognize(dataURL);
      const data = result && result.data;
      return (data && data.text ? data.text : '').trim();
    });

    try {
      return await withTimeout(recognition, timeoutMs);
    } catch (error) {
      dispose(entry);
      throw error;
    }
  }

  function recognize(dataURL, language) {
    const normalizedLanguage = language || 'chi_sim+eng';
    const pending = queue.then(
      () => run(dataURL, normalizedLanguage),
      () => run(dataURL, normalizedLanguage)
    );
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  function close() {
    if (current) dispose(current);
  }

  function stats() {
    return {
      pendingBootstraps: pendingBootstraps.size,
      maxPendingBootstraps,
      hasCurrentWorker: !!(current && !current.disposed),
    };
  }

  return { recognize, close, stats };
}

module.exports = { createOCRWorkerPool, withTimeout };
