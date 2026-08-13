// 给原位翻译装"错误显示器"：出错时屏幕左下角弹红色提示，便于定位「闪退/出不来」。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'overlay.js');
let s = fs.readFileSync(p, 'utf8');
if (s.indexOf('__kkShowErr') >= 0) { console.log('ALREADY'); process.exit(0); }

// 1. 在 clearInlineTranslate 前注入全局错误显示器
const a1 = '  function clearInlineTranslate() {';
if (s.indexOf(a1) < 0) { console.log('MISS:clear'); process.exit(1); }
const inject = [
  '  (function () {',
  '    if (window.__kkErrHooked) return;',
  '    window.__kkErrHooked = true;',
  '    function showTrErr(msg) {',
  '      try {',
  "        var d = document.createElement('div');",
  "        d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:82vw;background:#c0392b;color:#fff;font:12px/1.55 -apple-system,sans-serif;padding:8px 12px;border-radius:8px;white-space:pre-wrap;';",
  "        d.textContent = '[翻译诊断] ' + String(msg).slice(0, 500);",
  '        document.body.appendChild(d);',
  '        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 10000);',
  '      } catch (_) {}',
  '    }',
  '    window.__kkShowErr = showTrErr;',
  "    window.addEventListener('error', function (e) { showTrErr('JS错误: ' + (e.message || (e.error && e.error.message) || e.error)); });",
  "    window.addEventListener('unhandledrejection', function (e) { showTrErr('未处理拒绝: ' + ((e.reason && e.reason.message) || e.reason)); });",
  '  })();',
  '  function clearInlineTranslate() {',
].join('\n');
s = s.replace(a1, inject);

// 2. startInlineTranslate 里：composeImage 后加接口存在性检查
const a2 = "    var dataURL = composeImage();\n    if (!dataURL) return;\n    clearInlineTranslate();";
if (s.indexOf(a2) < 0) { console.log('MISS:start'); process.exit(1); }
const b2 = [
  '    var dataURL = composeImage();',
  '    if (!dataURL) return;',
  '    if (!kkapi.ocrBoxes || !kkapi.translateLines) {',
  "      if (window.__kkShowErr) window.__kkShowErr('接口缺失：ocrBoxes/translateLines 未暴露，preload 没生效，请彻底重启 app');",
  '      return;',
  '    }',
  '    clearInlineTranslate();',
].join('\n');
s = s.replace(a2, b2);

// 3. catch 里也弹错误
const a3 = "    } catch (e) {\n      tip.textContent = '出错：' + (e && e.message ? e.message : e);\n      setTimeout(clearInlineTranslate, 1600);\n    }";
if (s.indexOf(a3) >= 0) {
  const b3 = "    } catch (e) {\n      tip.textContent = '出错：' + (e && e.message ? e.message : e);\n      if (window.__kkShowErr) window.__kkShowErr('翻译流程异常: ' + (e && e.message ? e.message : e));\n      setTimeout(clearInlineTranslate, 2600);\n    }";
  s = s.replace(a3, b3);
}

fs.writeFileSync(p, s);
console.log('PATCHED');
