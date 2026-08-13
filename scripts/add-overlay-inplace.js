// overlay.js：把「翻译」改成原位覆盖——识别选区每行文字+坐标 → 翻译 → 译文盖在每行原文位置上。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('startInlineTranslate') >= 0) { console.log('ALREADY'); process.exit(0); }

const miss = [];

// A. 在 openInlineAI 前插入两个函数，并在其守卫后拦截 translate
const anchorA =
  '  async function openInlineAI(kind) {\n' +
  '    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) return;';
if (s.indexOf(anchorA) < 0) miss.push('openInlineAI');
const FN = [
  '  // 原位覆盖翻译：识别选区每行文字+坐标 → 翻译 → 把译文盖在每行原文位置上',
  '  function clearInlineTranslate() {',
  '    if (S.trLayer && S.trLayer.parentNode) S.trLayer.parentNode.removeChild(S.trLayer);',
  '    S.trLayer = null;',
  '  }',
  '  async function startInlineTranslate() {',
  '    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) return;',
  '    commitText();',
  '    var r = { x: S.rect.x, y: S.rect.y, width: S.rect.width, height: S.rect.height };',
  '    var dataURL = composeImage();',
  '    if (!dataURL) return;',
  '    clearInlineTranslate();',
  "    var layer = document.createElement('div');",
  "    layer.className = 'kk-tr-layer';",
  "    layer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:90;pointer-events:none;';",
  '    document.body.appendChild(layer);',
  '    S.trLayer = layer;',
  "    var tip = document.createElement('div');",
  "    tip.style.cssText = 'position:fixed;z-index:96;left:' + r.x + 'px;top:' + Math.max(2, r.y - 26) + 'px;background:rgba(20,20,22,.92);color:#fff;font:12px/1.5 -apple-system,sans-serif;padding:3px 9px;border-radius:6px;';",
  "    tip.textContent = '正在识别…';",
  '    layer.appendChild(tip);',
  '    try {',
  '      var vr = await kkapi.ocrBoxes({ dataURL: dataURL });',
  '      if (!vr || vr.error || !vr.lines || !vr.lines.length) {',
  "        tip.textContent = vr && vr.error ? '识别失败：' + vr.error : '未识别到文字';",
  '        setTimeout(clearInlineTranslate, 1600);',
  '        return;',
  '      }',
  "      tip.textContent = '正在翻译…';",
  '      var texts = vr.lines.map(function (l) { return l.t; });',
  "      var tr = await kkapi.translateLines({ lines: texts, target: '中文' });",
  '      if (!tr || tr.error) {',
  "        tip.textContent = '翻译失败：' + ((tr && tr.error) || '');",
  '        setTimeout(clearInlineTranslate, 1600);',
  '        return;',
  '      }',
  '      var outs = tr.lines || [];',
  '      if (tip.parentNode) tip.parentNode.removeChild(tip);',
  '      for (var i = 0; i < vr.lines.length; i++) {',
  '        var ln = vr.lines[i];',
  '        var x = r.x + (ln.x / 100) * r.width;',
  '        var y = r.y + (ln.y / 100) * r.height;',
  '        var w = (ln.w / 100) * r.width;',
  '        var h = (ln.h / 100) * r.height;',
  "        var cell = document.createElement('div');",
  "        cell.style.cssText = 'position:fixed;overflow:hidden;display:flex;align-items:center;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;background:#fff;color:#111;border-radius:2px;box-sizing:border-box;padding:0 1px;white-space:nowrap;';",
  "        var span = document.createElement('span');",
  "        span.textContent = outs[i] || '';",
  "        span.style.cssText = 'display:inline-block;transform-origin:left center;line-height:1;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';",
  "        span.style.fontSize = Math.max(8, Math.floor(h * 0.7)) + 'px';",
  '        cell.appendChild(span);',
  '        layer.appendChild(cell);',
  '        (function (sp, availW) {',
  '          requestAnimationFrame(function () {',
  '            var sw = sp.scrollWidth;',
  "            if (sw > availW && sw > 0) sp.style.transform = 'scaleX(' + Math.max(0.35, availW / sw) + ')';",
  '          });',
  '        })(span, w - 2);',
  '      }',
  '    } catch (e) {',
  "      tip.textContent = '出错：' + (e && e.message ? e.message : e);",
  '      setTimeout(clearInlineTranslate, 1600);',
  '    }',
  '  }',
  '',
].join('\n');
const replA =
  FN + '\n' +
  '  async function openInlineAI(kind) {\n' +
  '    if (!S.rect || S.rect.width < 3 || S.rect.height < 3) return;\n' +
  "    if (kind === 'translate') return startInlineTranslate();";
if (s.indexOf(anchorA) >= 0) s = s.replace(anchorA, replA);

// B. 新建选区时清掉旧的覆盖译文
const anchorB = 'S.rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };';
if (s.indexOf(anchorB) >= 0) {
  s = s.replace(anchorB, anchorB + '\n      if (typeof clearInlineTranslate === \'function\') clearInlineTranslate();');
} else {
  miss.push('newRect(可选)');
}

if (miss.filter((m) => m.indexOf('可选') < 0).length) {
  console.log('MISS:' + miss.join(','));
} else {
  fs.writeFileSync(p, s);
  console.log('PATCHED' + (miss.length ? ' (跳过:' + miss.join(',') + ')' : ''));
}
