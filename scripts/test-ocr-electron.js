// 临时实测：在真 Electron 主进程里调用产品代码 src/main/ocr.js 的 recognize()，确认 MED-2 修复后本地 OCR 真能离线工作。
// 用法：node_modules/.bin/electron scripts/test-ocr-electron.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration && app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // 清掉缓存，模拟全新用户首次使用
  try { fs.rmSync(path.join(app.getPath('userData'), 'tessdata-cache'), { recursive: true, force: true }); } catch (_) {}
  const ocr = require('../src/main/ocr');
  const imgB64 = fs.readFileSync('/tmp/ocrtext.png').toString('base64');
  const dataURL = 'data:image/png;base64,' + imgB64;
  const t0 = Date.now();
  const timer = setTimeout(() => { console.log('[main] RESULT=HANG 仍卡死'); app.exit(2); }, 25000);
  try {
    const text = await ocr.recognize(dataURL, 'chi_sim+eng');
    clearTimeout(timer);
    console.log('[main] recognize 用时', Date.now() - t0, 'ms');
    console.log('[main] text =', JSON.stringify(text));
    console.log('[main] RESULT=' + (text && text.length ? 'OK 产品代码 ocr.recognize 离线可用' : 'EMPTY 返回空文本'));
    app.exit(text && text.length ? 0 : 3);
  } catch (e) {
    clearTimeout(timer);
    console.log('[main] RESULT=ERROR', e && e.message);
    app.exit(1);
  }
});
