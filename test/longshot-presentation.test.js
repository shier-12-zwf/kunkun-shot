'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLongshotLayout, rectanglesOverlap, normalizeLongshotPresentation } = require('../src/main/longshot-presentation');

function assertVisible(rect, bounds) {
  assert.ok(rect.x >= bounds.x && rect.y >= bounds.y);
  assert.ok(rect.x + rect.width <= bounds.x + bounds.width);
  assert.ok(rect.y + rect.height <= bounds.y + bounds.height);
}

test('visual longshot layout keeps side preview and compact toolbar outside the selected pixels', () => {
  const bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const rect = { x: 180, y: 100, width: 800, height: 580 };
  const layout = calculateLongshotLayout({ rect, displayBounds: bounds });
  assert.deepEqual(layout.rect, rect);
  assert.equal(layout.toolbar.height, 76);
  assert.equal(layout.toolbar.width, 660);
  assert.equal(layout.toolbarOverlapsSelection, false);
  assert.ok(layout.preview, 'wide right margin supports the visible preview');
  assert.equal(rectanglesOverlap(layout.preview, rect), false);
  assert.equal(rectanglesOverlap(layout.preview, layout.toolbar), false);
  assertVisible(layout.preview, bounds);
  assertVisible(layout.toolbar, bounds);
});

test('negative display origins affect native windows, never local preview coordinates or capture area', () => {
  const displayBounds = { x: -1920, y: -120, width: 1920, height: 1080 };
  const rect = { x: 130, y: 50, width: 1100, height: 700 };
  const layout = calculateLongshotLayout({ rect, displayBounds, scaleFactor: 2 });
  assert.deepEqual(layout.rect, rect);
  assert.deepEqual(layout.captureBounds, { x: -1790, y: -70, width: 1100, height: 700 });
  assert.equal(layout.toolbarBounds.x, layout.toolbar.x - 1920);
  assert.equal(layout.toolbarBounds.y, layout.toolbar.y - 120);
  assertVisible(layout.toolbarBounds, displayBounds);
  assertVisible(layout.preview, { x: 0, y: 0, width: 1920, height: 1080 });
});

test('fullscreen selection keeps its exact area, hides unavailable preview and marks the bar for capture suppression', () => {
  const displayBounds = { x: 0, y: 0, width: 800, height: 600 };
  const rect = { ...displayBounds };
  const layout = calculateLongshotLayout({ rect, displayBounds, expanded: true });
  assert.deepEqual(layout.rect, rect);
  assert.equal(layout.preview, null);
  assert.equal(layout.toolbarOverlapsSelection, true);
  assert.equal(layout.toolbar.height, 300);
  assertVisible(layout.toolbar, displayBounds);
});

test('narrow and short displays keep expanded controls accessible without growing the capture area', () => {
  const displayBounds = { x: -360, y: 20, width: 360, height: 240 };
  const rect = { x: 0, y: 0, width: 350, height: 220 };
  const layout = calculateLongshotLayout({ rect, displayBounds, expanded: true });
  assert.equal(layout.toolbar.width, 360);
  assert.equal(layout.toolbar.height, 240);
  assertVisible(layout.toolbarBounds, displayBounds);
  assert.deepEqual(layout.rect, rect);
  assert.equal(layout.preview, null);
});

test('all generated previews are fully on-screen and never intersect captured pixels or toolbar', () => {
  for (const width of [360, 800, 1440]) {
    for (const height of [240, 600, 1000]) {
      for (const fraction of [0.2, 0.6, 1]) {
        for (const expanded of [false, true]) {
          const displayBounds = { x: -width, y: -100, width, height };
          const rect = { x: 0, y: 0, width: Math.round(width * fraction), height: Math.round(height * fraction) };
          const layout = calculateLongshotLayout({ rect, displayBounds, expanded });
          assertVisible(layout.toolbarBounds, displayBounds);
          assert.deepEqual(layout.rect, rect);
          if (!layout.preview) continue;
          assertVisible(layout.preview, { x: 0, y: 0, width, height });
          assert.equal(rectanglesOverlap(layout.preview, rect), false);
          assert.equal(rectanglesOverlap(layout.preview, layout.toolbar), false);
        }
      }
    }
  }
});

test('layout rejects non-finite, offscreen and empty capture rectangles', () => {
  const displayBounds = { x: 0, y: 0, width: 800, height: 600 };
  for (const rect of [null, { x: 0, y: 0, width: 0, height: 1 }, { x: -1, y: 0, width: 100, height: 100 }, { x: 750, y: 0, width: 100, height: 100 }]) {
    assert.throws(() => calculateLongshotLayout({ rect, displayBounds }));
  }
  assert.throws(() => calculateLongshotLayout({ rect: { x: 0, y: 0, width: 1, height: 1 }, displayBounds: { ...displayBounds, x: NaN } }));
});

const tinyPNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';

test('presentation forwards only bounded preview and explicit typed metadata', () => {
  assert.deepEqual(normalizeLongshotPresentation({ previewDataURL: tinyPNG, outputWidth: 800, outputHeight: 120000, frameCount: 1000, capturing: true, expanded: false }), {
    previewDataURL: tinyPNG, outputWidth: 800, outputHeight: 120000, frameCount: 1000, capturing: true, expanded: false,
  });
  assert.deepEqual(normalizeLongshotPresentation({ expanded: true }), { expanded: true });
  assert.deepEqual(normalizeLongshotPresentation({ previewDataURL: null }), { previewDataURL: null });
  for (const bad of [{ expanded: 'yes' }, { capturing: 1 }, { outputWidth: -1 }, { frameCount: 1.5 }, { previewDataURL: 'https://example.com/private.png' }, { secret: 'ignored?' }]) {
    assert.throws(() => normalizeLongshotPresentation(bad));
  }
  assert.throws(() => normalizeLongshotPresentation({ previewDataURL: 'data:image/png;base64,' + 'A'.repeat(1024 * 1024) }));
});
