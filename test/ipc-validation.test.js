const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_IMAGE_DATA_URL_CHARS,
  requireImageDataURL,
  normalizeCaptureRect,
  normalizePinBounds,
  normalizeWindowResize,
  normalizeWindowMove,
  normalizeTranslationRequest,
  normalizeChatRequest,
  normalizeProviderBaseUrl,
  normalizeOCRLanguage,
  normalizeConfigPatch,
  normalizePinStateFlags,
  normalizeProviderTestTarget,
  normalizeRecordingPayload,
} = require('../src/main/ipc-validation');

const tinyPng =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('image IPC accepts supported base64 images and rejects malformed or oversized payloads', () => {
  assert.equal(requireImageDataURL(tinyPng), tinyPng);
  assert.throws(() => requireImageDataURL('data:text/html;base64,PHNjcmlwdD4='), /图片数据/);
  assert.throws(() => requireImageDataURL('data:image/png;base64,%%%'), /图片数据/);
  assert.ok(MAX_IMAGE_DATA_URL_CHARS >= 64 * 1024 * 1024);
  assert.throws(() => requireImageDataURL('data:image/png;base64,' + 'A'.repeat(128), 64), /过大/);
});

test('capture rectangles must be finite, positive, and contained by the selected display', () => {
  assert.deepEqual(
    normalizeCaptureRect({ x: 10.4, y: 20.6, width: 300.2, height: 200.8 }, { width: 1440, height: 900 }),
    { x: 10, y: 21, width: 300, height: 201 }
  );
  assert.throws(() => normalizeCaptureRect({ x: -1, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }), /选区/);
  assert.throws(() => normalizeCaptureRect({ x: 0, y: 0, width: 101, height: 10 }, { width: 100, height: 100 }), /选区/);
  assert.throws(() => normalizeCaptureRect({ x: 0, y: 0, width: NaN, height: 10 }, { width: 100, height: 100 }), /选区/);
});

test('pin and window geometry reject NaN and clamp unreasonable sizes or deltas', () => {
  assert.deepEqual(normalizePinBounds({ x: -100, y: 50, width: 9000, height: 20 }), {
    x: -100,
    y: 50,
    width: 8000,
    height: 40,
  });
  assert.throws(() => normalizePinBounds({ x: Infinity, y: 0, width: 100, height: 100 }), /窗口位置/);
  assert.deepEqual(normalizeWindowResize({ width: 9000, height: 1 }), { width: 8000, height: 48 });
  assert.throws(() => normalizeWindowResize({ width: undefined, height: 100 }), /窗口尺寸/);
  assert.deepEqual(normalizeWindowMove({ dx: 999999, dy: -999999 }), { dx: 8000, dy: -8000 });
});

test('translation and chat requests have bounded, normalized text payloads', () => {
  assert.deepEqual(normalizeTranslationRequest({ lines: [' hello ', 'world'], target: ' 英语 ' }), {
    lines: [' hello ', 'world'],
    target: '英语',
  });
  assert.throws(() => normalizeTranslationRequest({ lines: 'not-array' }), /翻译行/);
  assert.throws(() => normalizeTranslationRequest({ lines: new Array(2001).fill('x') }), /翻译行/);

  assert.deepEqual(
    normalizeChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      streamId: ' s1 ',
      model: ' model ',
      think: 1,
    }),
    { messages: [{ role: 'user', content: 'hi' }], streamId: 's1', model: 'model', think: true }
  );
  assert.throws(() => normalizeChatRequest({ messages: [{ role: 'tool', content: 'x' }] }), /消息角色/);
  assert.throws(() => normalizeChatRequest({ messages: new Array(101).fill({ role: 'user', content: 'x' }) }), /消息数量/);
  assert.throws(() => normalizeChatRequest({ messages: [{ role: 'user', content: 'x' }], streamId: '' }), /流标识/);
});

test('provider URLs require HTTPS except for explicit loopback HTTP endpoints', () => {
  assert.equal(normalizeProviderBaseUrl(' https://api.example.com/v1/ '), 'https://api.example.com/v1');
  assert.equal(normalizeProviderBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
  assert.equal(normalizeProviderBaseUrl('http://[::1]:11434/v1'), 'http://[::1]:11434/v1');
  assert.throws(() => normalizeProviderBaseUrl('http://example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeProviderBaseUrl('file:///tmp/key'), /URL/);
  assert.throws(() => normalizeProviderBaseUrl('https://user:pass@example.com/v1'), /凭据/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.example.com/v1?tenant=a'), /查询参数|片段/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.example.com/v1#models'), /查询参数|片段/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.example.com/v1?'), /查询参数|片段/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.example.com/v1#'), /查询参数|片段/);
});

test('configuration patches are schema-bound and role-scoped', () => {
  assert.deepEqual(normalizeConfigPatch({ translate: { target: '英语' } }, 'overlay'), {
    translate: { target: '英语' },
  });
  assert.deepEqual(normalizeConfigPatch({ capture: { copyAfterCapture: true } }, 'popover'), {
    capture: { copyAfterCapture: true },
  });
  assert.throws(() => normalizeConfigPatch({ general: { launchAtLogin: true } }, 'overlay'), /权限/);
  assert.throws(() => normalizeConfigPatch({ general: { launchAtLogin: 'yes' } }, 'main'), /布尔/);
  assert.throws(() => normalizeConfigPatch({ unknown: { value: 1 } }, 'main'), /未知/);
  assert.throws(() => normalizeConfigPatch({ deepseek: { baseUrl: 'http://api.example.com/v1' } }, 'main'), /HTTPS/);
  assert.deepEqual(normalizeConfigPatch({ recording: { fps: 999 } }, 'main'), { recording: { fps: 60 } });
});

test('OCR language input is a fixed fail-closed selection, not an arbitrary language-code string', () => {
  for (const lang of ['chi_sim+eng', 'chi_sim', 'eng']) {
    assert.equal(normalizeOCRLanguage(lang), lang);
    assert.deepEqual(normalizeConfigPatch({ ocr: { lang } }, 'main'), { ocr: { lang } });
  }

  for (const lang of ['jpn', 'chi_sim+jpn', 'eng+chi_sim', 'chi_sim+eng+chi_sim', '', ' chi_sim ']) {
    assert.throws(() => normalizeOCRLanguage(lang), /OCR.*语言/);
    assert.throws(() => normalizeConfigPatch({ ocr: { lang } }, 'main'), /ocr\.lang|OCR.*语言/i);
  }
});

test('pin state and provider test selectors reject unexpected renderer input', () => {
  assert.deepEqual(normalizePinStateFlags({ onTop: true }), { onTop: true });
  assert.deepEqual(normalizePinStateFlags({ ignoreMouse: false }), { ignoreMouse: false });
  assert.deepEqual(
    normalizePinStateFlags({ opacity: 0.1, locked: true, title: 'Reference' }),
    { opacity: 0.3, locked: true, title: 'Reference' }
  );
  assert.throws(() => normalizePinStateFlags(null), /贴图状态/);
  assert.throws(() => normalizePinStateFlags({ onTop: 'yes' }), /布尔/);
  assert.throws(() => normalizePinStateFlags({ title: 'x'.repeat(513) }), /标题/);
  assert.throws(() => normalizePinStateFlags({ onTop: true, surprise: true }), /未知/);

  assert.equal(normalizeProviderTestTarget(undefined), undefined);
  assert.equal(normalizeProviderTestTarget('minimax'), 'minimax');
  assert.throws(() => normalizeProviderTestTarget('attacker-controlled'), /提供方/);
});

test('recording payloads require a WebM header and strictly typed options', () => {
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
  const normalized = normalizeRecordingPayload({
    buffer: webm,
    toGif: false,
    fps: 120,
    trimStart: -5,
    trimEnd: 9.5,
  });
  assert.equal(normalized.buffer, webm);
  assert.equal(normalized.toGif, false);
  assert.equal(normalized.fps, 60);
  assert.equal(normalized.trimStart, 0);
  assert.equal(normalized.trimEnd, 9.5);
  assert.throws(() => normalizeRecordingPayload({ buffer: Uint8Array.from([1, 2, 3, 4]) }), /WebM/);
  assert.throws(() => normalizeRecordingPayload({ buffer: webm, toGif: 'yes' }), /布尔/);
  assert.throws(() => normalizeRecordingPayload({ buffer: webm, fps: '30' }), /有限数字/);
  assert.throws(() => normalizeRecordingPayload({ buffer: webm, extra: true }), /未知/);
});
