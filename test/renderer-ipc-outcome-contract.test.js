'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const mainAI = read('src/renderer/main/pages/ai.js');
const standaloneAI = read('src/renderer/ai/ai.js');
const overlay = read('src/renderer/overlay/overlay.js');
const popover = read('src/renderer/popover/popover.js');

test('AI workspaces confirm clipboard writes before showing copied feedback', () => {
  assert.match(mainAI, /async function copyTextWithConfirmation\(text\)/);
  assert.match(mainAI, /copied\s*!==\s*true/);
  assert.equal((mainAI.match(/await copyTextWithConfirmation\(/g) || []).length, 2);
  assert.match(mainAI, /catch\s*\(error\)\s*\{\s*showError\(['"]复制失败/);

  assert.match(standaloneAI, /async function copyTextWithConfirmation\(text\)/);
  assert.match(standaloneAI, /copied\s*!==\s*true/);
  assert.equal((standaloneAI.match(/await copyTextWithConfirmation\(/g) || []).length, 3);
  assert.match(standaloneAI, /复制表格失败/);
  assert.match(standaloneAI, /复制结果失败/);
  assert.match(standaloneAI, /复制识别文字失败/);
});

test('AI window opens require an explicit ok result before success UI or popover close', () => {
  assert.match(overlay, /async function openAIPanelWithConfirmation\(api, payload\)/);
  assert.match(overlay, /outcome\s*&&\s*outcome\.ok\s*===\s*true/);
  assert.equal((overlay.match(/openAIPanelWithConfirmation\(kkapi,/g) || []).length, 2);
  assert.match(overlay, /AI 打开失败/);

  assert.match(popover, /opened\s*=\s*await\s+api\.openAIPanel/);
  assert.match(popover, /!opened\s*\|\|\s*opened\.ok\s*!==\s*true/);
  assert.ok(
    popover.indexOf('opened.ok !== true') < popover.indexOf('await api.hidePopover()', popover.indexOf('opened.ok !== true')),
    'the popover must stay visible until the AI window explicitly confirms success',
  );
});

test('standalone AI settings links surface rejected or denied window opens', () => {
  assert.match(standaloneAI, /async function openSettingsWithFeedback\(\)/);
  assert.match(standaloneAI, /outcome\s*=\s*await\s+kkapi\.openSettings\(\)/);
  assert.match(standaloneAI, /!outcome\s*\|\|\s*outcome\.ok\s*!==\s*true/);
  assert.equal((standaloneAI.match(/openSettingsWithFeedback\(\)/g) || []).length, 3);
  assert.match(standaloneAI, /设置窗口打开失败/);
});
