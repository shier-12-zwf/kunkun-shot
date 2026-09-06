'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('native origin compensation aligns the outline, all shades and preview without moving capture content', () => {
  const elements = new Map();
  let initialize;
  let update;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/longshot/longshot-guide.js'), 'utf8'), {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, removeAttribute() {} });
      return elements.get(id);
    } },
    kkapi: { onInit(fn) { initialize = fn; }, onLongshotUpdate(fn) { update = fn; } },
  });
  const rect = { x: 80, y: 100, width: 420, height: 260 };
  const layout = { preview: { x: 520, y: 100, width: 200, height: 300 } };
  initialize({ rect, displayBounds: { x: 0, y: 0, width: 1512, height: 982 },
    guideOffset: { x: -4, y: -38 }, layout, presentation: {} });
  const style = (id) => elements.get(id).style;
  assert.equal(style('selectionOutline').left, '76px');
  assert.equal(style('selectionOutline').top, '62px');
  assert.equal(style('shadeTop').top, '-38px');
  assert.equal(style('shadeTop').height, '100px');
  assert.equal(style('shadeBottom').top, '322px');
  assert.equal(style('shadeLeft').top, '62px');
  assert.equal(style('shadeRight').left, '496px');
  assert.equal(style('previewPanel').left, '516px');
  assert.equal(style('previewPanel').top, '62px');
  update({ guideOffset: { x: 0, y: -48 }, layout });
  assert.equal(style('selectionOutline').top, '52px');
  assert.equal(style('shadeBottom').top, '312px');
  assert.equal(style('previewPanel').top, '52px');
  assert.deepEqual(rect, { x: 80, y: 100, width: 420, height: 260 });
});
