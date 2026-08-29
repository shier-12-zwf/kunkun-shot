const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeOverlayResultEnvelope } = require('../src/main/overlay-result-contract');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('live record and long actions contain only live geometry and never static image fields', () => {
  assert.deepEqual(normalizeOverlayResultEnvelope({
    action: 'record',
    rect: { x: 1, y: 2, width: 30, height: 40 },
    displayId: 9,
  }), {
    kind: 'live',
    action: 'record',
    rect: { x: 1, y: 2, width: 30, height: 40 },
    displayId: 9,
  });

  assert.equal(normalizeOverlayResultEnvelope({
    action: 'long',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    displayId: 'display-1',
  }).kind, 'live');
});

test('live actions reject static image and static bounds fields instead of silently ignoring them', () => {
  const base = {
    action: 'record',
    rect: { x: 1, y: 2, width: 30, height: 40 },
    displayId: 9,
  };
  assert.throws(() => normalizeOverlayResultEnvelope({ ...base, imageDataURL: PNG }), /互斥/);
  assert.throws(() => normalizeOverlayResultEnvelope({ ...base, imageDataURL: null }), /互斥/);
  assert.throws(() => normalizeOverlayResultEnvelope({ ...base, bounds: { x: 1, y: 2, width: 30, height: 40 } }), /互斥/);
  assert.throws(() => normalizeOverlayResultEnvelope({ ...base, sourceRect: { x: 1, y: 2, width: 30, height: 40 } }), /互斥/);
});

test('static actions require image data and reject live-only payload shapes', () => {
  const result = normalizeOverlayResultEnvelope({
    action: 'copy',
    imageDataURL: PNG,
    rect: { x: 1, y: 2, width: 30, height: 40 },
    bounds: { x: 11, y: 12, width: 30, height: 40 },
    sourceRect: { x: 2, y: 4, width: 60, height: 80 },
    displayId: 9,
  });
  assert.equal(result.kind, 'static');
  assert.equal(result.imageDataURL, PNG);
  assert.throws(() => normalizeOverlayResultEnvelope({
    action: 'save',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    displayId: 1,
  }), /图片数据/);
});

test('unknown and extra overlay result fields fail closed', () => {
  assert.throws(() => normalizeOverlayResultEnvelope(null), /格式无效/);
  assert.throws(() => normalizeOverlayResultEnvelope({ action: 'launch' }), /操作无效/);
  assert.throws(() => normalizeOverlayResultEnvelope({
    action: 'copy',
    imageDataURL: PNG,
    rect: {},
    displayId: 1,
    captureType: 'fullscreen',
  }), /未知截图结果字段/);
});

test('overlay renderer emits the mutually exclusive live payload shape expected by the boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.js'),
    'utf8',
  );
  const liveStart = source.indexOf('if (isLiveAction)');
  const staticStart = source.indexOf('} else {', liveStart);
  assert.ok(liveStart >= 0 && staticStart > liveStart);
  const liveBranch = source.slice(liveStart, staticStart);
  assert.match(liveBranch, /action:\s*action/);
  assert.match(liveBranch, /rect:\s*rectOut/);
  assert.match(liveBranch, /displayId:\s*S\.displayId/);
  assert.doesNotMatch(liveBranch, /imageDataURL|bounds:\s*boundsOut|sourceRect/);
});
