const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareInlineTranslation,
  clearInlineTranslationState,
  commitInlineTranslationCells,
  copyTextWithConfirmation,
  persistTranslationTarget,
} = require('../src/renderer/overlay/overlay.js');

test('inline translation uses a clean capture, configured target, and commits export cells', async () => {
  const calls = [];
  const state = {
    trLayer: null,
    trCells: [{ text: 'stale translation' }],
    trRequestId: 0,
  };
  const requestId = clearInlineTranslationState(state);

  const prepared = await prepareInlineTranslation(
    {
      ocrBoxes: async (payload) => {
        calls.push(['ocr', payload]);
        return {
          lines: [
            { x: 10, y: 15, w: 35, h: 12, t: '你好' },
            { x: 52, y: 40, w: 38, h: 16, t: '世界' },
          ],
        };
      },
      translateLines: async (payload) => {
        calls.push(['translate', payload]);
        return { lines: ['Hello', 'world'] };
      },
    },
    (options) => {
      calls.push(['compose', options]);
      return 'data:image/png;base64,clean-source';
    },
    '英语'
  );

  assert.deepEqual(calls, [
    ['compose', { clean: true }],
    ['ocr', { dataURL: 'data:image/png;base64,clean-source' }],
    ['translate', { lines: ['你好', '世界'], target: '英语' }],
  ]);
  assert.deepEqual(prepared.cells, [
    { xp: 10, yp: 15, wp: 35, hp: 12, text: 'Hello', bg: '#fff', fg: '#111' },
    { xp: 52, yp: 40, wp: 38, hp: 16, text: 'world', bg: '#fff', fg: '#111' },
  ]);

  assert.equal(commitInlineTranslationCells(state, requestId, prepared.cells), true);
  assert.deepEqual(state.trCells, prepared.cells);
});

test('clearing inline translation removes both DOM and export state and invalidates stale work', () => {
  const removed = [];
  const layer = {};
  layer.parentNode = {
    removeChild(node) {
      removed.push(node);
    },
  };
  const state = {
    trLayer: layer,
    trCells: [{ text: 'old' }],
    trRequestId: 7,
  };

  const staleRequestId = clearInlineTranslationState(state);

  assert.deepEqual(removed, [layer]);
  assert.equal(state.trLayer, null);
  assert.deepEqual(state.trCells, []);
  assert.equal(staleRequestId, 8);

  clearInlineTranslationState(state);
  assert.equal(commitInlineTranslationCells(state, staleRequestId, [{ text: 'late result' }]), false);
  assert.deepEqual(state.trCells, []);
});

test('overlay copy feedback only succeeds after the clipboard confirms the write', async () => {
  await assert.doesNotReject(() => copyTextWithConfirmation({ copyText: async () => true }, '已复制'));
  await assert.rejects(
    () => copyTextWithConfirmation({ copyText: async () => false }, '未复制'),
    /剪贴板/
  );
});

test('translation target persistence rejects resolved configuration failures', async () => {
  const patches = [];
  await persistTranslationTarget({
    setConfig: async (patch) => {
      patches.push(patch);
      return { ok: true };
    },
  }, '日语');
  assert.deepEqual(patches, [{ translate: { target: '日语' } }]);

  await assert.rejects(
    () => persistTranslationTarget({ setConfig: async () => ({ ok: false, error: '无法写入配置' }) }, '英语'),
    /无法写入配置/
  );
});
