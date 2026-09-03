const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAnnotationDraft,
  createOverlayTextAnnotation,
  getMagnifierSampleRect,
  normalizeMagnifierZoom,
  partitionAnnotationShapes,
} = require('../src/renderer/overlay/overlay.js');

test('blur is a real brush draft and spotlight is an ellipse region', () => {
  assert.deepEqual(createAnnotationDraft('blur', { x: 12, y: 34 }, '#ef4444', 4, 1), {
    type: 'blur',
    points: [{ x: 12, y: 34 }],
    color: '#ef4444',
    width: 4,
  });
  assert.deepEqual(createAnnotationDraft('spotlight', { x: 8, y: 9 }, '#fff', 2, 1), {
    type: 'spotlight',
    x1: 8,
    y1: 9,
    x2: 8,
    y2: 9,
    color: '#fff',
    width: 2,
    opacity: 0.58,
  });
});

test('watermark stores export-stable opacity and angle', () => {
  assert.deepEqual(
    createOverlayTextAnnotation('watermark', { x: 20, y: 30 }, '仅供审核', '#2563eb', 22),
    {
      type: 'watermark',
      x: 20,
      y: 30,
      text: '仅供审核',
      color: '#2563eb',
      size: 22,
      opacity: 0.35,
      angle: -20,
    },
  );
});

test('magnifier is a persistent box annotation with a bounded adjustable zoom', () => {
  assert.deepEqual(createAnnotationDraft('magnifier', { x: 40, y: 50 }, '#2563eb', 4, 1), {
    type: 'magnifier',
    x1: 40,
    y1: 50,
    x2: 40,
    y2: 50,
    color: '#2563eb',
    width: 4,
    zoom: 2,
  });
  assert.equal(normalizeMagnifierZoom('3'), 3);
  assert.equal(normalizeMagnifierZoom(0.5), 1.25);
  assert.equal(normalizeMagnifierZoom(99), 8);
});

test('magnifier samples the underlying source around its center without crossing bounds', () => {
  assert.deepEqual(
    getMagnifierSampleRect({ type: 'magnifier', x1: 70, y1: 40, x2: 110, y2: 80, zoom: 2 }, 100, 100),
    { x: 80, y: 50, width: 20, height: 20, zoom: 2 },
  );
  assert.deepEqual(
    getMagnifierSampleRect({ type: 'magnifier', x1: -20, y1: -20, x2: 20, y2: 20, zoom: 4 }, 100, 100),
    { x: 0, y: 0, width: 10, height: 10, zoom: 4 },
  );
});

test('effect layers are partitioned deterministically for preview and export', () => {
  const shapes = [
    { type: 'rect' },
    { type: 'spotlight' },
    { type: 'blur' },
    { type: 'mosaic' },
    { type: 'watermark' },
  ];
  assert.deepEqual(partitionAnnotationShapes(shapes), {
    backgroundEffects: [shapes[2], shapes[3]],
    spotlights: [shapes[1]],
    foreground: [shapes[0], shapes[4]],
  });
});

test('preview and export share the real background-effect renderer', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  const calls = source.match(/renderAnnotationLayers\(/g) || [];
  assert.ok(calls.length >= 3, 'definition plus preview/export calls must exist');
  assert.match(source, /function drawBlur\([\s\S]*?\.filter\s*=\s*['"]blur\(/);
  assert.match(source, /function drawSpotlightLayer\([\s\S]*?destination-out/);
  assert.match(source, /s\.type === 'watermark'[\s\S]*?ctx\.rotate\(/);
  assert.match(source, /else if \(s\.type === 'magnifier'\) \{\s*drawMagnifier\(/);
  assert.match(source, /function drawMagnifier\([\s\S]*?ctx\.clip\(\)[\s\S]*?ctx\.drawImage\(baseCanvas/);
  assert.match(
    source,
    /var phys = Math\.min\(outW \/ r\.width, outH \/ r\.height\);/,
    'export-only translation and frame effects need a defined source-aware physical scale',
  );
});

test('magnifier participates in move, resize, zoom history, preview, and export', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  assert.match(source, /function getBBox\(s\)[\s\S]*?s\.type === 'magnifier'/);
  assert.match(source, /function translateShape\(src, dx, dy\)[\s\S]*?s\.type === 'magnifier'/);
  assert.match(source, /function resizeShape\(src, ob, nb\)[\s\S]*?s\.type === 'magnifier'/);
  assert.match(source, /magnifierZoom\.addEventListener\('change'[\s\S]*?pushHistory\(\)[\s\S]*?S\.selected\.zoom/);
  const layerCalls = source.match(/renderAnnotationLayers\(/g) || [];
  assert.ok(layerCalls.length >= 3, 'preview and export must both call the shared annotation renderer');
});

test('annotation export scales from the same integer canvas used by preview', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  assert.match(source, /var annotationCanvasWidth = Math\.max\(1, annoCanvas\.width/);
  assert.match(source, /var annotationCanvasHeight = Math\.max\(1, annoCanvas\.height/);
  assert.match(source, /var annotationScaleX = outW \/ annotationCanvasWidth;/);
  assert.match(source, /var annotationScaleY = outH \/ annotationCanvasHeight;/);
});

test('each legacy annotation renderer remains reachable after adding effect layers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/overlay/overlay.js'),
    'utf8',
  );
  const arrowBranches = source.match(/else if \(s\.type === 'arrow'\)/g) || [];
  assert.equal(
    arrowBranches.length,
    1,
    'a duplicate arrow condition makes the real drawArrow branch unreachable',
  );
  assert.match(source, /else if \(s\.type === 'arrow'\) \{\s*drawArrow\(/);
});
