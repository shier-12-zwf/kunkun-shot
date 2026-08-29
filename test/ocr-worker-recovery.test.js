const test = require('node:test');
const assert = require('node:assert/strict');

const { createOCRWorkerPool } = require('../src/main/ocr-worker');

test('OCR worker creation failure is not cached for later requests', async () => {
  let attempts = 0;
  const pool = createOCRWorkerPool({
    timeoutMs: 100,
    createWorker: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('worker bootstrap failed');
      return {
        recognize: async () => ({ data: { text: ' recovered ' } }),
        terminate: async () => {}
      };
    }
  });

  await assert.rejects(pool.recognize('first', 'chi_sim'), /worker bootstrap failed/);
  assert.equal(await pool.recognize('second', 'chi_sim'), 'recovered');
  assert.equal(attempts, 2);
});

test('timed out OCR releases the queue and rebuilds the worker', async () => {
  let attempts = 0;
  let terminated = 0;
  const never = new Promise(() => {});
  const pool = createOCRWorkerPool({
    timeoutMs: 20,
    createWorker: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          recognize: async () => never,
          terminate: async () => { terminated += 1; }
        };
      }
      return {
        recognize: async () => ({ data: { text: 'next request works' } }),
        terminate: async () => { terminated += 1; }
      };
    }
  });

  await assert.rejects(pool.recognize('hung', 'eng'), /OCR.*20.*超时/);
  assert.equal(await pool.recognize('next', 'eng'), 'next request works');
  assert.equal(attempts, 2);
  assert.equal(terminated, 1);
});

test('language changes do not wait for a stuck previous worker', async () => {
  const never = new Promise(() => {});
  const pool = createOCRWorkerPool({
    timeoutMs: 20,
    createWorker: async (language) => {
      if (language === 'eng') return never;
      return {
        recognize: async () => ({ data: { text: language } }),
        terminate: async () => {}
      };
    }
  });

  await assert.rejects(pool.recognize('hung-bootstrap', 'eng'), /OCR.*20.*超时/);
  assert.equal(await pool.recognize('image', 'chi_sim'), 'chi_sim');
});

test('repeated hung bootstraps are bounded instead of accumulating without limit', async () => {
  let attempts = 0;
  const never = new Promise(() => {});
  const pool = createOCRWorkerPool({
    timeoutMs: 10,
    maxPendingBootstraps: 2,
    createWorker: async () => {
      attempts += 1;
      return never;
    },
  });

  await assert.rejects(pool.recognize('first', 'eng'), /OCR.*10.*超时/);
  await assert.rejects(pool.recognize('second', 'chi_sim'), /OCR.*10.*超时/);
  await assert.rejects(pool.recognize('third', 'chi_sim+eng'), (error) => {
    assert.equal(error.code, 'OCR_BOOTSTRAP_LIMIT');
    assert.match(error.message, /恢复上限|仍在启动/);
    return true;
  });
  assert.equal(attempts, 2);
  assert.deepEqual(pool.stats(), {
    pendingBootstraps: 2,
    maxPendingBootstraps: 2,
    hasCurrentWorker: false,
  });
});
