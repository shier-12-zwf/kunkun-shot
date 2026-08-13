// 为「原位覆盖翻译」加后端：channels(OCR_BOXES/TRANSLATE_TEXT) + preload(ocrBoxes/translateLines) + main(两个 handler)。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const report = [];
function patch(rel, fn) {
  const p = path.join(ROOT, rel);
  let s = fs.readFileSync(p, 'utf8');
  const res = fn(s);
  if (res.skip) { report.push(rel + ':SKIP'); return; }
  if (res.miss) { report.push(rel + ':MISS(' + res.miss + ')'); return; }
  fs.writeFileSync(p, res.s);
  report.push(rel + ':OK');
}

// 1. channels.js
patch('src/shared/channels.js', (s) => {
  if (s.indexOf('OCR_BOXES') >= 0) return { skip: 1 };
  const a = "OCR_RUN: 'ocr:run',";
  if (s.indexOf(a) < 0) return { miss: 'OCR_RUN' };
  s = s.replace(a, a + "\n  OCR_BOXES: 'ocr:boxes',\n  TRANSLATE_TEXT: 'ai:translate-text',");
  return { s };
});

// 2. preload.js
patch('src/preload/preload.js', (s) => {
  if (s.indexOf('ocrBoxes') >= 0) return { skip: 1 };
  const a = 'runOCR: (payload) => ipcRenderer.invoke(C.OCR_RUN, payload),';
  if (s.indexOf(a) < 0) return { miss: 'runOCR' };
  const add =
    '\n  ocrBoxes: (payload) => ipcRenderer.invoke(C.OCR_BOXES, payload),' +
    '\n  translateLines: (payload) => ipcRenderer.invoke(C.TRANSLATE_TEXT, payload),';
  s = s.replace(a, a + add);
  return { s };
});

// 3. main.js — 两个 handler 插在 DEEPSEEK_ASK_IMAGE 之前
patch('src/main/main.js', (s) => {
  if (s.indexOf('C.OCR_BOXES') >= 0) return { skip: 1 };
  const a = 'ipcMain.handle(C.DEEPSEEK_ASK_IMAGE,';
  if (s.indexOf(a) < 0) return { miss: 'ASK_IMAGE' };
  const h = [
    'ipcMain.handle(C.OCR_BOXES, async (_e, payload) => {',
    '      try {',
    "        const m = require('./ocr-boxes');",
    '        return await m.runOCRBoxes(payload && payload.dataURL);',
    '      } catch (err) {',
    '        return { error: (err && err.message) || String(err) };',
    '      }',
    '    });',
    '    ipcMain.handle(C.TRANSLATE_TEXT, async (_e, payload) => {',
    '      try {',
    '        const lines = (payload && payload.lines) || [];',
    "        const target = (payload && payload.target) || '中文';",
    '        if (!lines.length) return { lines: [] };',
    '        const p = aiProvider(false);',
    "        if (!p.apiKey) return { error: '未配置 API Key（请在设置里填 DeepSeek Key）' };",
    "        const numbered = lines.map((t, i) => (i + 1) + '. ' + String(t).replace(/\\n/g, ' ')).join('\\n');",
    "        const sys = '你是翻译引擎。把带编号的每一行翻译成' + target + '。严格只输出一个 JSON 数组，每个元素形如 {\"i\":编号数字,\"t\":\"译文\"}，不要解释、不要 markdown、不要反引号。';",
    '        const out = await deepseek.completeText({',
    '          baseUrl: p.baseUrl,',
    '          apiKey: p.apiKey,',
    '          model: p.textModel,',
    "          messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }],",
    '          think: false,',
    '        });',
    "        let txt = deepseek.stripThink(out || '').trim();",
    "        txt = txt.replace(/^```[a-z]*\\s*/i, '').replace(/```\\s*$/i, '');",
    "        const a0 = txt.indexOf('['), b0 = txt.lastIndexOf(']');",
    '        if (a0 >= 0 && b0 > a0) txt = txt.slice(a0, b0 + 1);',
    '        let arr = [];',
    '        try { arr = JSON.parse(txt); } catch (_) { arr = []; }',
    '        const map = {};',
    '        if (Array.isArray(arr)) arr.forEach((it) => { if (it && it.i != null) map[Number(it.i)] = it.t == null ? \'\' : String(it.t); });',
    '        const result = lines.map((t, i) => (map[i + 1] != null ? map[i + 1] : String(t)));',
    '        return { lines: result };',
    '      } catch (err) {',
    '        return { error: (err && err.message) || String(err) };',
    '      }',
    '    });',
    '    ',
  ].join('\n');
  s = s.replace(a, h + a);
  return { s };
});

console.log(report.join(' | '));
