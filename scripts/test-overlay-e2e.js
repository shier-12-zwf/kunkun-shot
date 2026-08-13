// 端到端测试「原位覆盖翻译」后端：Vision 出坐标 → 逐行翻译对齐。镜像 TRANSLATE_TEXT handler 逻辑。
const fs = require('fs');
const os = require('os');
const path = require('path');
const ob = require('../src/main/ocr-boxes');
const deepseek = require('../src/main/deepseek');

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library', 'Application Support', '困困截图工具', 'config.json'), 'utf8'));
const d = cfg.deepseek || {};

(async () => {
  const img = '/tmp/kktest2.png';
  if (!fs.existsSync(img)) { console.log('NO_TEST_IMG (先截个图)'); return; }
  const dataURL = 'data:image/png;base64,' + fs.readFileSync(img).toString('base64');
  const vr = await ob.runOCRBoxes(dataURL);
  if (vr.error) { console.log('OCR_ERR=' + vr.error); return; }
  const lines = (vr.lines || []).map((l) => l.t);
  console.log('VISION_LINES=' + lines.length);
  if (!lines.length) { console.log('NO_TEXT'); return; }
  // 镜像 handler：逐行翻译
  const numbered = lines.map((t, i) => (i + 1) + '. ' + String(t).replace(/\n/g, ' ')).join('\n');
  const sys = '你是翻译引擎。把带编号的每一行翻译成中文。严格只输出一个 JSON 数组，每个元素形如 {"i":编号数字,"t":"译文"}，不要解释、不要 markdown、不要反引号。';
  const out = await deepseek.completeText({
    baseUrl: d.baseUrl, apiKey: d.apiKey, model: d.textModel,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }],
    think: false,
  });
  let txt = deepseek.stripThink(out || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const a0 = txt.indexOf('['), b0 = txt.lastIndexOf(']');
  if (a0 >= 0 && b0 > a0) txt = txt.slice(a0, b0 + 1);
  let arr = [];
  try { arr = JSON.parse(txt); } catch (_) {}
  console.log('PARSED_TRANSLATIONS=' + (Array.isArray(arr) ? arr.length : 'PARSE_FAIL'));
  console.log('ALIGN_OK=' + (Array.isArray(arr) && arr.length === lines.length));
})().catch((e) => console.log('THROW=' + (e && e.message ? e.message : e)));
