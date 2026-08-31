'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExternalHttpUrl } = require('../src/main/ipc-validation');
const { openValidatedExternalUrl } = require('../src/main/external-url');
const { handleExternalOpenOutcome } = require('../src/renderer/overlay/overlay');

test('invalid external URLs are rejected without invoking the system browser', async () => {
  let calls = 0;
  const result = await openValidatedExternalUrl('file:///tmp/private', {
    normalizeUrl: normalizeExternalHttpUrl,
    openExternal: async () => { calls += 1; },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP/);
  assert.equal(calls, 0);
});

test('valid external URLs are canonicalized and opened exactly once', async () => {
  const opened = [];
  const result = await openValidatedExternalUrl(' HTTPS://Example.COM:443/docs?q=1 ', {
    normalizeUrl: normalizeExternalHttpUrl,
    openExternal: async (url) => { opened.push(url); },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(opened, ['https://example.com/docs?q=1']);
});

test('system-browser rejection remains visible to the renderer as a failure', async () => {
  const reported = [];
  const result = await openValidatedExternalUrl('https://example.com/', {
    normalizeUrl: normalizeExternalHttpUrl,
    openExternal: async () => { throw new Error('no URL handler'); },
    reportError: (error, url) => reported.push([error.message, url]),
  });

  assert.deepEqual(result, { ok: false, error: '系统浏览器未能打开该链接。' });
  assert.deepEqual(reported, [['no URL handler', 'https://example.com/']]);

  let closed = false;
  let message = '';
  assert.equal(
    handleExternalOpenOutcome(result, () => { closed = true; }, (value) => { message = value; }),
    false
  );
  assert.equal(closed, false, '打开失败时应保留二维码面板');
  assert.equal(message, result.error);
});
