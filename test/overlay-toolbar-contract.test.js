const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'overlay', 'overlay.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'overlay', 'overlay.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src', 'renderer', 'overlay', 'overlay.js'), 'utf8');

function extract(pattern, source, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return match[1];
}

test('compact overlay toolbar preserves every tool and action exactly once', () => {
  const toolbar = extract(
    /<div id="toolbar"[\s\S]*?>([\s\S]*?)<!-- 文字输入框/,
    html,
    'toolbar markup'
  );
  const actions = Array.from(toolbar.matchAll(/data-action="([^"]+)"/g), (match) => match[1]);
  const tools = Array.from(toolbar.matchAll(/data-tool="([^"]+)"/g), (match) => match[1]);
  const directActions = Array.from(
    toolbar.matchAll(/<button\b([^>]*class="[^"]*\baction-btn\b[^"]*"[^>]*)>/g),
    (match) => match[1]
  )
    .filter((attributes) => !/\btoolbar-menu-item\b/.test(attributes))
    .map((attributes) => attributes.match(/\bdata-action="([^"]+)"/)?.[1])
    .filter(Boolean);

  assert.deepEqual(
    [...actions].sort(),
    ['ask', 'cancel', 'copy', 'formula', 'ocr', 'pin', 'polish', 'qr', 'quickSave', 'save', 'table', 'translate']
  );
  assert.equal(new Set(actions).size, actions.length);
  assert.deepEqual(directActions.slice(0, 2), ['translate', 'ocr']);
  assert.deepEqual(
    [...tools].sort(),
    ['arrow', 'ellipse', 'highlight', 'line', 'mosaic', 'number', 'pen', 'polyline', 'rect', 'select', 'text']
  );
  assert.equal(new Set(tools).size, tools.length);
});

test('secondary tools remain inside the delegated toolbar and expose accessible menus', () => {
  const toolbar = extract(
    /<div id="toolbar"[\s\S]*?>([\s\S]*?)<!-- 文字输入框/,
    html,
    'toolbar markup'
  );
  const annotationMenu = extract(
    /<div class="toolbar-menu annotation-menu"[^>]*>([\s\S]*?)<\/div>/,
    toolbar,
    'annotation menu'
  );
  const actionMenu = extract(
    /<div class="toolbar-menu action-menu"[^>]*>([\s\S]*?)<\/div>/,
    toolbar,
    'action menu'
  );

  assert.match(toolbar, /id="btnToolMore"[\s\S]*?aria-expanded="false"[\s\S]*?aria-controls="annotationMenu"/);
  assert.match(toolbar, /id="btnActionMore"[\s\S]*?aria-expanded="false"[\s\S]*?aria-controls="actionMenu"/);
  assert.match(toolbar, /id="annotationMenu" role="group" aria-label="更多标注工具"/);
  assert.match(toolbar, /id="actionMenu" role="group" aria-label="更多截图与处理选项"/);
  assert.match(annotationMenu, />椭圆</);
  assert.match(annotationMenu, />荧光笔</);
  assert.match(actionMenu, /data-action="table"[\s\S]*?>AI 表格</);
  assert.match(actionMenu, /data-action="formula"[\s\S]*?>AI 公式</);
  assert.doesNotMatch(actionMenu, /data-action="translate"/);
  assert.match(actionMenu, /data-action="ask"[\s\S]*?>问 AI</);
  assert.match(actionMenu, /id="trLang"/);
  for (const id of ['btnRatioLock', 'btnRounded', 'btnAx', 'btnFrame']) {
    assert.match(actionMenu, new RegExp(`id="${id}"[\\s\\S]*?aria-pressed="false"`));
    assert.equal((toolbar.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  }
  assert.match(actionMenu, />截图选项</);
  assert.match(actionMenu, />识别与保存</);
  assert.match(js, /toolbar\.addEventListener\('click'[\s\S]*?closest\('\.action-btn\[data-action\]'\)/);
  assert.match(js, /hasOpenToolbarMenu\(\)[\s\S]*?closeToolbarMenus\(\)/);
  assert.match(js, /setSelectionOptionActive\([\s\S]*?aria-pressed/);
  assert.match(js, /toolbarControl[\s\S]*?isEditableControl[\s\S]*?isControlKey/);
  assert.doesNotMatch(toolbar, /role="menu(?:item)?"/);
});

test('toolbar labels cannot shrink into clipped vertical text', () => {
  assert.match(css, /\.tool-group\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.action-btn\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?white-space:\s*nowrap;[\s\S]*?word-break:\s*keep-all;/);
  assert.match(css, /\.action-btn\s*>\s*span\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?word-break:\s*keep-all;/);
  assert.match(css, /\.toolbar-menu\s*\{[\s\S]*?position:\s*absolute;/);
  assert.match(css, /\.toolbar-menu\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.toolbar-menu\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /\.toolbar-menu-trigger\.has-active-option::after\s*\{/);
  assert.match(js, /function positionOpenToolbarMenu\(\)[\s\S]*?naturalHeight[\s\S]*?spaceAbove[\s\S]*?spaceBelow[\s\S]*?maxHeight/);
  assert.match(js, /MutationObserver[\s\S]*?attributeFilter:\s*\['hidden'\]/);
});

test('smart selection can replace an existing region and return to the toolbar', () => {
  assert.match(js, /getSelectableFrame\(\)/);
  assert.doesNotMatch(js, /S\.axFrame && !S\.rect/);
  assert.match(js, /function disableAx\(\)[\s\S]*?setSelectionOptionActive\(btnAx, false\)[\s\S]*?\.disable\(\)/);
});
