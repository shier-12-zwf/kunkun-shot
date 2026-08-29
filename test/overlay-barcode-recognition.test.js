const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beginBarcodeScan,
  commitBarcodeScan,
  calculateBarcodeScanSize,
  detectBarcodeResults,
  formatBarcodeResultsForCopy,
  normalizeBarcodeResults,
} = require('../src/renderer/overlay/overlay.js');

test('barcode results are deduplicated, position-sorted, and bounded', () => {
  const input = [
    { rawValue: 'second', format: 'code_128', boundingBox: { x: 80, y: 40 } },
    { rawValue: 'first', format: 'qr_code', boundingBox: { x: 30, y: 10 } },
    { rawValue: 'second', format: 'code_128', boundingBox: { x: 81, y: 41 } },
    { rawValue: 'third', format: 'ean_13', boundingBox: { x: 10, y: 40 } },
  ];

  assert.deepEqual(normalizeBarcodeResults(input, 2), [
    { value: 'first', format: 'qr_code', x: 30, y: 10 },
    { value: 'third', format: 'ean_13', x: 10, y: 40 },
  ]);
});

test('copy text stays raw for one result and labels each item for multiple results', () => {
  assert.equal(formatBarcodeResultsForCopy([
    { value: 'only one', format: 'qr_code' },
  ]), 'only one');
  assert.equal(formatBarcodeResultsForCopy([
    { value: 'https://example.com', format: 'qr_code', x: 0, y: 0 },
    { value: '6901234567892', format: 'ean_13', x: 0, y: 20 },
  ]), '[QR CODE] https://example.com\n[EAN 13] 6901234567892');
});

test('native BarcodeDetector is preferred and returns multiple common barcode formats', async () => {
  const calls = [];
  class FakeDetector {
    static async getSupportedFormats() {
      return ['qr_code', 'code_128', 'ean_13'];
    }
    constructor(options) {
      calls.push(['construct', options]);
    }
    async detect(source) {
      calls.push(['detect', source]);
      return [
        { rawValue: 'https://example.com', format: 'qr_code', boundingBox: { x: 5, y: 5 } },
        { rawValue: '6901234567892', format: 'ean_13', boundingBox: { x: 5, y: 60 } },
      ];
    }
  }
  let fallbackCalls = 0;
  const result = await detectBarcodeResults({
    source: { id: 'bounded-canvas' },
    BarcodeDetectorCtor: FakeDetector,
    jsQRFn() { fallbackCalls += 1; },
    imageData: { data: new Uint8ClampedArray(16) },
    width: 2,
    height: 2,
  });

  assert.equal(result.engine, 'barcode-detector');
  assert.deepEqual(result.results.map((item) => item.format), ['qr_code', 'ean_13']);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(calls[0], ['construct', { formats: ['qr_code', 'code_128', 'ean_13'] }]);
});

test('failed or unavailable BarcodeDetector falls back to the existing single QR decoder', async () => {
  class BrokenDetector {
    static async getSupportedFormats() { return ['qr_code']; }
    async detect() { throw new Error('detector unavailable'); }
  }
  const attempts = [];
  const result = await detectBarcodeResults({
    source: {},
    BarcodeDetectorCtor: BrokenDetector,
    jsQRFn(data, width, height, options) {
      attempts.push(options.inversionAttempts);
      return attempts.length === 1 ? null : { data: 'fallback payload' };
    },
    imageData: { data: new Uint8ClampedArray(64) },
    width: 4,
    height: 4,
  });

  assert.equal(result.engine, 'jsqr');
  assert.deepEqual(result.results, [{ value: 'fallback payload', format: 'qr_code', x: 0, y: 0 }]);
  assert.deepEqual(attempts, ['dontInvert', 'attemptBoth']);
});

test('a stalled native detector is time-bounded and falls back to jsQR', async () => {
  class StalledDetector {
    async detect() { return new Promise(() => {}); }
  }
  const pending = detectBarcodeResults({
    source: {},
    BarcodeDetectorCtor: StalledDetector,
    detectorTimeoutMs: 5,
    jsQRFn() { return { data: 'timeout fallback' }; },
    imageData: { data: new Uint8ClampedArray(64) },
    width: 4,
    height: 4,
  });
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ engine: 'still-pending' }), 40)),
  ]);

  assert.equal(result.engine, 'jsqr');
  assert.equal(result.results[0].value, 'timeout fallback');
});

test('scan generation rejects late results after a new scan or close', () => {
  const state = { qrRequestId: 0, qrResults: [], qrData: null, qrOpenURL: 'https://old.example' };
  const stale = beginBarcodeScan(state);
  assert.equal(state.qrOpenURL, null);
  const current = beginBarcodeScan(state);

  assert.equal(commitBarcodeScan(state, stale, [{ rawValue: 'old', format: 'qr_code' }]), false);
  assert.equal(commitBarcodeScan(state, current, [{ rawValue: 'new', format: 'code_128' }]), true);
  assert.equal(state.qrData, 'new');

  beginBarcodeScan(state); // close/cancel invalidates the still-running request
  assert.equal(commitBarcodeScan(state, current, [{ rawValue: 'late', format: 'qr_code' }]), false);
  assert.equal(state.qrData, null);
});

test('scan canvas is bounded by both edge length and total pixels', () => {
  const size = calculateBarcodeScanSize(8000, 4000, 1280, 1_500_000);
  assert.ok(size.width <= 1280);
  assert.ok(size.height <= 1280);
  assert.ok(size.width * size.height <= 1_500_000);

  assert.deepEqual(calculateBarcodeScanSize(640, 480, 1280, 1_500_000), {
    width: 640,
    height: 480,
  });
});
