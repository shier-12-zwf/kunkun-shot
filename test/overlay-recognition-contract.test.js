const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildOverlayOCRRequest,
  createBarcodeScanPlan,
  runBarcodeScanAttempts,
} = require('../src/renderer/overlay/overlay.js');

test('overlay OCR leaves engine selection to persisted configuration', () => {
  assert.deepEqual(buildOverlayOCRRequest('data:image/png;base64,abc'), {
    dataURL: 'data:image/png;base64,abc',
  });
  assert.equal('engine' in buildOverlayOCRRequest('image'), false);
});

test('overlay OCR runtime passes the configuration-neutral request', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  assert.match(source, /kkapi\.runOCR\(buildOverlayOCRRequest\(dataURL\)\)/);
  assert.doesNotMatch(source, /runOCR\(\{\s*dataURL\s*,\s*engine\s*:\s*['"]local['"]/);
});

test('barcode runtime scans the exact source crop through every planned attempt', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  assert.match(source, /createBarcodeScanPlan\(S\.rect, currentViewportSize\(\), currentSourceSize\(\)/);
  assert.match(source, /runBarcodeScanAttempts\(plan\.attempts/);
  assert.match(source, /plan\.sourceRect\.x[\s\S]*?plan\.sourceRect\.y[\s\S]*?plan\.sourceRect\.width[\s\S]*?plan\.sourceRect\.height/);
});

test('barcode crop uses exact source mapping and schedules an original-resolution retry', () => {
  const plan = createBarcodeScanPlan(
    { x: 100.2, y: 50.4, width: 400.4, height: 300.2 },
    { width: 933, height: 701 },
    { width: 4000, height: 3001 },
    1280,
    1_500_000,
  );

  assert.deepEqual(plan.sourceRect, { x: 430, y: 216, width: 1716, height: 1285 });
  assert.equal(plan.attempts[0].kind, 'bounded');
  assert.ok(plan.attempts[0].width < plan.sourceRect.width);
  assert.deepEqual(plan.attempts.at(-1), {
    kind: 'original',
    width: 1716,
    height: 1285,
  });
});

test('barcode retry stops on success and otherwise reaches original resolution', async () => {
  const calls = [];
  const found = await runBarcodeScanAttempts(
    [{ kind: 'bounded' }, { kind: 'original' }],
    async (attempt) => {
      calls.push(attempt.kind);
      return attempt.kind === 'original'
        ? { engine: 'barcode-detector', results: [{ rawValue: 'found', format: 'qr_code' }] }
        : { engine: 'jsqr', results: [] };
    },
  );
  assert.deepEqual(calls, ['bounded', 'original']);
  assert.equal(found.attempt, 'original');
  assert.equal(found.results[0].value, 'found');

  calls.length = 0;
  await runBarcodeScanAttempts(
    [{ kind: 'bounded' }, { kind: 'original' }],
    async (attempt) => {
      calls.push(attempt.kind);
      return { engine: 'barcode-detector', results: [{ rawValue: 'first pass', format: 'code_128' }] };
    },
  );
  assert.deepEqual(calls, ['bounded']);
});
