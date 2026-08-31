'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const settingsSource = read('src/renderer/main/pages/settings.js');
const pinHtml = read('src/renderer/pin/pin.html');
const pinSource = read('src/renderer/pin/pin.js');

test('settings field helpers associate visible labels and hints with their controls', () => {
  assert.match(settingsSource, /function associateField\(/);
  assert.match(settingsSource, /setAttribute\('for',\s*target\.id\)/);
  assert.match(settingsSource, /setAttribute\('aria-labelledby',\s*label\.id\)/);
  assert.match(settingsSource, /setAttribute\('aria-describedby',\s*hint\.id\)/);

  const rowField = settingsSource.match(
    /function rowField\([\s\S]*?\n      \}\n\n      \/\/ \u7ad6\u6392\u5b57\u6bb5/
  );
  assert.ok(rowField, 'rowField implementation must be present');
  assert.match(rowField[0], /h\('label',\s*\{ class: 'row-label'/);
  assert.match(rowField[0], /associateField\(label,\s*hint,\s*control\)/);

  const stackField = settingsSource.match(
    /function stackField\([\s\S]*?\n      \}\n\n      \/\/ \u5f00\u5173/
  );
  assert.ok(stackField, 'stackField implementation must be present');
  assert.match(stackField[0], /h\('label',\s*\{ class: 'label'/);
  assert.match(stackField[0], /associateField\(label,\s*hint,\s*control\)/);

  assert.match(
    settingsSource,
    /querySelectorAll\('input:not\(\[type="hidden"\]\), select, textarea'\)/,
    'wrapped toggles and fields must expose their actual form controls to the association helper'
  );
});

test('pin context menu exposes a roving tabindex and complete keyboard operation', () => {
  assert.match(pinHtml, /id="ctxMenu" role="menu" aria-label="\u8d34\u56fe\u64cd\u4f5c"/);
  const menuItems = Array.from(pinHtml.matchAll(/class="ctx-item[^"]*"[^>]*role="menuitem"[^>]*tabindex="-1"/g));
  assert.equal(menuItems.length, 14, 'every actionable context-menu item starts outside the tab order');

  assert.match(pinSource, /function focusCtxItem\(/);
  assert.match(pinSource, /ctxMenuItems\[(?:nextIndex|index)\]\.focus\(\)/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']) {
    assert.match(pinSource, new RegExp(`e\\.key === '${key}'`), `${key} must be handled`);
  }
  assert.match(pinSource, /e\.key === ' '/, 'Space must activate the focused menu item');
  assert.match(pinSource, /hideCtxMenu\(true\)/, 'Escape must close the menu and restore prior focus');
  assert.match(pinSource, /ctxMenu\.addEventListener\('click'/, 'mouse activation must remain supported');
});

test('every renderer window has a reduced-motion fallback', () => {
  const motionRoots = [
    'src/renderer/shared/design.css',
    'src/renderer/ai/ai.css',
    'src/renderer/longshot/longshot.css',
    'src/renderer/overlay/overlay.css',
    'src/renderer/pin/pin.css',
    'src/renderer/recorder/recorder.css',
    'src/renderer/translate-popup/translate-popup.css',
  ];

  for (const relativePath of motionRoots) {
    const css = read(relativePath);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, relativePath);
    assert.match(css, /animation-duration:\s*0\.01ms\s*!important/, relativePath);
    assert.match(css, /animation-iteration-count:\s*1\s*!important/, relativePath);
    assert.match(css, /transition-duration:\s*0\.01ms\s*!important/, relativePath);
  }
});

test('AI error callouts avoid side-stripe borders and loading dots do not bounce', () => {
  const mainAiCss = read('src/renderer/main/pages/ai.css');
  const standaloneAiCss = read('src/renderer/ai/ai.css');
  const translateCss = read('src/renderer/translate-popup/translate-popup.css');

  const mainError = mainAiCss.match(/\.kk-ai-error\s*\{[\s\S]*?\}/);
  assert.ok(mainError, 'main AI error callout must exist');
  assert.doesNotMatch(mainError[0], /border-(?:left|right):/);

  const standaloneError = standaloneAiCss.match(/\.error\s*\{[\s\S]*?\}/);
  assert.ok(standaloneError, 'standalone AI error callout must exist');
  assert.doesNotMatch(standaloneError[0], /border-(?:left|right):/);

  const thinkCallout = standaloneAiCss.match(/\.think-block\s*\{[\s\S]*?\}/);
  assert.ok(thinkCallout, 'AI reasoning callout must exist');
  assert.doesNotMatch(thinkCallout[0], /border-(?:left|right):/);

  assert.doesNotMatch(translateCss, /tp-bounce|transform:\s*scale\(/);
  assert.match(translateCss, /animation:\s*tp-pulse/);
  assert.match(translateCss, /@keyframes tp-pulse/);
});
