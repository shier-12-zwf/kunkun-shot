'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settingsPath = path.join(
  __dirname,
  '..',
  'src',
  'renderer',
  'main',
  'pages',
  'settings.js'
);

test('settings privacy copy distinguishes encrypted key storage from AI data transfer', () => {
  const source = fs.readFileSync(settingsPath, 'utf8');

  [
    '不会上传到任何第三方服务器',
    '不会上传第三方',
    '应用不会主动上传你的数据',
  ].forEach((misleadingPromise) => {
    assert.doesNotMatch(source, new RegExp(misleadingPromise), misleadingPromise);
  });

  assert.ok(
    (source.match(/API Key 在本机加密保存/g) || []).length >= 4,
    '顶部、三个服务商和存储分组都应说明 Key 在本机加密保存'
  );
  assert.match(source, /截图、OCR 文字或选中文字/);
  assert.match(source, /发送到你选择或配置的服务端点/);
  assert.match(source, /作为鉴权信息发送/);
  assert.match(source, /仅使用本地 OCR 时/);
});
