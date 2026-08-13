// 一次性恢复「截图原地翻译」功能：channels / preload / main / overlay 四处改动，带 anchor 保护。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const report = [];

function patch(rel, fn) {
  const p = path.join(ROOT, rel);
  let s = fs.readFileSync(p, 'utf8');
  const res = fn(s);
  if (res.skip) { report.push(rel + ':SKIP(' + res.skip + ')'); return; }
  if (res.miss) { report.push(rel + ':MISS(' + res.miss + ')'); return; }
  fs.writeFileSync(p, res.s);
  report.push(rel + ':OK');
}

// 1. channels.js — 加 OCR_BOXES + TRANSLATE_TEXT
patch('src/shared/channels.js', (s) => {
  if (s.indexOf('OCR_BOXES') >= 0) return { skip: 'already' };
  const a = "    OCR_RUN: 'ocr:run',";
  if (s.indexOf(a) < 0) return { miss: 'OCR_RUN' };
  s = s.replace(a, a + "\n    OCR_BOXES: 'ocr:boxes-vision',\n    TRANSLATE_TEXT: 'ai:translate-text',");
  return { s };
});

// 2. preload.js — 暴露 ocrBoxes（TRANSLATE_TEXT 走通用 invoke，无需额外暴露）
patch('src/preload/preload.js', (s) => {
  if (s.indexOf('ocrBoxes') >= 0) return { skip: 'already' };
  const a = '    runOCR: (payload) => ipcRenderer.invoke(C.OCR_RUN, payload),';
  if (s.indexOf(a) < 0) return { miss: 'runOCR' };
  s = s.replace(a, a + '\n    ocrBoxes: (payload) => ipcRenderer.invoke(C.OCR_BOXES, payload),');
  return { s };
});

// 3. main.js — OCR_BOXES handler + TRANSLATE_TEXT handler（插在 OCR_RUN handler 之前）
patch('src/main/main.js', (s) => {
  if (s.indexOf('TRANSLATE_TEXT') >= 0) return { skip: 'already' };
  const a = 'ipcMain.handle(channels.OCR_RUN, async (e, payload) => {';
  if (s.indexOf(a) < 0) return { miss: 'OCR_RUN handler' };
  const handlers = [
    'ipcMain.handle(channels.OCR_BOXES, async (e, payload) => {',
    '      try {',
    "        const m = require('./ocr-boxes');",
    '        return await m.runOCRBoxes(payload && payload.dataURL);',
    '      } catch (err) {',
    '        return { error: (err && err.message) || String(err) };',
    '      }',
    '    });',
    '    ipcMain.handle(channels.TRANSLATE_TEXT, async (e, payload) => {',
    '      try {',
    "        const text = (payload && payload.text) || '';",
    "        const target = (payload && payload.target) || '中文';",
    "        if (!String(text).trim()) return { text: '' };",
    '        const prov = aiProvider(false);',
    "        if (!prov || !prov.apiKey) return { error: '未配置 API Key（请在设置里填 DeepSeek Key）' };",
    "        const sys = '你是翻译引擎。把用户提供的文本完整翻译成' + target + '，只输出译文，保持原有分行，不要解释、不要附原文。';",
    '        const out = await deepseek.completeText({',
    '          baseUrl: prov.baseUrl,',
    '          apiKey: prov.apiKey,',
    '          model: prov.model,',
    "          messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text) }],",
    '          think: false,',
    '        });',
    "        const clean = deepseek.stripThink ? deepseek.stripThink(out || '') : (out || '');",
    '        return { text: clean };',
    '      } catch (err) {',
    '        return { error: (err && err.message) || String(err) };',
    '      }',
    '    });',
    '    ',
  ].join('\n');
  s = s.replace(a, handlers + a);
  return { s };
});

// 4. overlay.js — runAction 拆出 translateImage + 新增 translateInline
patch('src/renderer/overlay/overlay.js', (s) => {
  if (s.indexOf('translateInline') >= 0) return { skip: 'already' };
  const miss = [];
  const swA = "        case 'ai':\n        case 'translateImage':\n        case 'ocr':\n          emitAI(key);\n          break;";
  const swB = "        case 'translateImage':\n          translateInline();\n          break;\n        case 'ai':\n        case 'ocr':\n          emitAI(key);\n          break;";
  if (s.indexOf(swA) < 0) miss.push('switch');
  else s = s.replace(swA, swB);
  const emitAnchor =
    '    function emitAI(mode) {\n' +
    '      const dataURL = cropSelectionToDataURL();\n' +
    '      if (!dataURL) return;\n' +
    "      send('overlay:ai', { mode: mode, dataURL: dataURL });\n" +
    '      cleanupAndClose();\n' +
    '    }';
  const fn = [
    '',
    '',
    '    // 微信式原地翻译：识别选区文字 → 翻译 → 在选区正下方显示译文（保留原图、不跳窗口）',
    '    async function translateInline() {',
    '      const dataURL = cropSelectionToDataURL();',
    '      if (!dataURL) return;',
    '      const r = norm(selRect);',
    "      const panel = document.createElement('div');",
    "      panel.className = 'kk-tr-panel';",
    '      panel.style.cssText =',
    "        'position:fixed;z-index:2147483600;box-sizing:border-box;' +",
    "        'left:' + Math.max(8, r.x) + 'px;top:' + (r.y + r.h + 10) + 'px;' +",
    "        'width:' + Math.max(r.w, 280) + 'px;max-height:42vh;overflow:auto;' +",
    "        'background:rgba(28,28,30,0.97);color:#fff;border-radius:12px;' +",
    "        'padding:12px 14px;font:13px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;' +",
    "        'white-space:pre-wrap;box-shadow:0 10px 36px rgba(0,0,0,0.45);';",
    "      const body = document.createElement('div');",
    "      body.textContent = '正在识别…';",
    '      panel.appendChild(body);',
    "      const bar = document.createElement('div');",
    "      bar.style.cssText = 'display:flex;gap:14px;justify-content:flex-end;margin-top:10px;';",
    "      const copyBtn = document.createElement('span');",
    "      copyBtn.textContent = '复制译文';",
    "      copyBtn.style.cssText = 'cursor:pointer;opacity:.75;font-size:12px;';",
    "      const closeBtn = document.createElement('span');",
    "      closeBtn.textContent = '关闭';",
    "      closeBtn.style.cssText = 'cursor:pointer;opacity:.75;font-size:12px;';",
    "      closeBtn.addEventListener('click', function () { try { ROOT.removeChild(panel); } catch (_) {} cleanupAndClose(); });",
    "      copyBtn.addEventListener('click', function () { try { if (api.copyText) api.copyText(body.textContent); } catch (_) {} });",
    '      bar.appendChild(copyBtn);',
    '      bar.appendChild(closeBtn);',
    '      panel.appendChild(bar);',
    '      ROOT.appendChild(panel);',
    '      try {',
    "        const vr = await invoke('ocr:boxes-vision', { dataURL: dataURL });",
    "        if (vr && vr.error) { body.textContent = '识别失败：' + vr.error; return; }",
    "        const src = vr && vr.lines ? vr.lines.map(function (l) { return l.t; }).join('\\n') : '';",
    "        if (!String(src).trim()) { body.textContent = '未识别到文字'; return; }",
    "        body.textContent = '正在翻译…';",
    "        const tr = await invoke('ai:translate-text', { text: src, target: '中文' });",
    "        if (tr && tr.error) { body.textContent = '翻译失败：' + tr.error; return; }",
    "        body.textContent = (tr && tr.text) || '(无译文)';",
    '      } catch (e) {',
    "        body.textContent = '出错：' + (e && e.message ? e.message : e);",
    '      }',
    '    }',
  ].join('\n');
  if (s.indexOf(emitAnchor) < 0) miss.push('emitAI');
  else s = s.replace(emitAnchor, emitAnchor + fn);
  if (miss.length) return { miss: miss.join('+') };
  return { s };
});

console.log(report.join(' | '));
