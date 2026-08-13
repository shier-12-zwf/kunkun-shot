// 本地 OCR：基于 tesseract.js。
// 默认优先用打包内自带的语言包（tessdata/chi_sim+eng.traineddata）→ 真离线，无需联网。
// 仅当找不到本地语言包时，才回退到 tesseract.js 默认行为（首次从 CDN 下载，需联网一次）。
// 若用户在设置里选 'model' 引擎，则由 main.js 路由到大模型多模态，不走这里。
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let Tesseract = null;

// 自带语言包目录：打包后在 Resources/tessdata；开发期在仓库根目录 tessdata/。
function tessdataDir() {
  try {
    if (app && app.isPackaged) return path.join(process.resourcesPath, 'tessdata');
  } catch (_) {}
  return path.join(__dirname, '..', '..', 'tessdata');
}

// 构造 createWorker 选项：本地语言包存在则走离线，否则返回空对象（回退默认 CDN）。
function buildWorkerOptions(language) {
  const dir = tessdataDir();
  try {
    // 校验本次所需的每个语言包文件都在本地（chi_sim+eng → chi_sim.traineddata / eng.traineddata）
    const langs = String(language).split('+').filter(Boolean);
    const allPresent = langs.length > 0 && langs.every((l) => fs.existsSync(path.join(dir, l + '.traineddata')));
    if (!allPresent) return {};
    const cachePath = path.join(app.getPath('userData'), 'tessdata-cache');
    try { fs.mkdirSync(cachePath, { recursive: true }); } catch (_) {}
    // 关键（Electron 必需）：tesseract.js 把运行环境识别为 'electron'，会把本地 langPath 当 URL 走 node-fetch，
    // 读本地绝对路径直接报错 → 本地 OCR 在打包后的 app 里卡死/不可用（已实测）。
    // 规避：预先把语言包按 worker 期望的缓存文件名放进 cachePath，worker 的 readCache 会先命中本地文件，
    // 根本不进那个错误的 fetch 分支。仅首次拷贝（语言包不变）。
    for (const l of langs) {
      try {
        const dst = path.join(cachePath, l + '.traineddata');
        if (!fs.existsSync(dst)) fs.copyFileSync(path.join(dir, l + '.traineddata'), dst);
      } catch (_) {}
    }
    return {
      langPath: dir, // 指向本地未压缩 .traineddata（配合上面的缓存预填，确保离线读取）
      gzip: false, // 自带的是未压缩包
      cachePath, // 缓存写到 userData，避免污染工作目录
    };
  } catch (_) {
    return {};
  }
}

async function recognize(dataURL, lang) {
  if (!Tesseract) Tesseract = require('tesseract.js');
  const language = lang || 'chi_sim+eng';
  const opts = buildWorkerOptions(language);
  const worker = await Tesseract.createWorker(language, undefined, opts);
  try {
    const { data } = await worker.recognize(dataURL);
    return (data && data.text ? data.text : '').trim();
  } finally {
    try {
      await worker.terminate();
    } catch (_) {}
  }
}

module.exports = { recognize };
