// 本地 OCR：基于 tesseract.js。
// 只使用打包内自带的 tessdata/chi_sim.traineddata 与 eng.traineddata。
// 语言数据缺失时明确失败，绝不回退到 tesseract.js 的 CDN/网络加载。
// 若用户在设置里选 'model' 引擎，则由 main.js 路由到大模型多模态，不走这里。
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { createOCRWorkerPool } = require('./ocr-worker');
const { listBundledOCRLanguages, normalizeBundledOCRLanguage } = require('./ocr-languages');
const { ensureVerifiedCacheFile } = require('./verified-cache-file');

let Tesseract = null;

// 自带语言包目录：打包后在 Resources/tessdata；开发期在仓库根目录 tessdata/。
function tessdataDir() {
  try {
    if (app && app.isPackaged) return path.join(process.resourcesPath, 'tessdata');
  } catch (_) {}
  return path.join(__dirname, '..', '..', 'tessdata');
}

// 构造 createWorker 选项：只有本地语言包完整时才启动 worker。
function buildWorkerOptions(language) {
  const dir = tessdataDir();
  // 只允许仓库/安装包中实际存在的语言数据。缺失时明确失败，绝不静默回退 CDN：
  // 后者会让“离线 OCR”在断网时表现成无限等待，也会产生未提示的网络请求。
  const available = listBundledOCRLanguages(dir);
  const normalized = normalizeBundledOCRLanguage(language, available);
  const langs = normalized.split('+');
  const cachePath = path.join(app.getPath('userData'), 'tessdata-cache');
  fs.mkdirSync(cachePath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cachePath, 0o700); } catch (_) {}
    // 关键（Electron 必需）：tesseract.js 把运行环境识别为 'electron'，会把本地 langPath 当 URL 走 node-fetch，
    // 读本地绝对路径直接报错 → 本地 OCR 在打包后的 app 里卡死/不可用（已实测）。
    // 规避：预先把语言包按 worker 期望的缓存文件名放进 cachePath，worker 的 readCache 会先命中本地文件，
    // 根本不进那个错误的 fetch 分支。仅首次拷贝（语言包不变）。
    for (const l of langs) {
      const src = path.join(dir, l + '.traineddata');
      const dst = path.join(cachePath, l + '.traineddata');
      ensureVerifiedCacheFile(src, dst, { directoryMode: 0o700, fileMode: 0o600 });
    }
  return {
    langPath: dir, // 指向本地未压缩 .traineddata（配合上面的缓存预填，确保离线读取）
    gzip: false, // 自带的是未压缩包
    cachePath, // 缓存写到 userData，避免污染工作目录
  };
}

const workerPool = createOCRWorkerPool({
  timeoutMs: 60000,
  buildWorkerOptions,
  createWorker(language, oem, options) {
    if (!Tesseract) Tesseract = require('tesseract.js');
    return Tesseract.createWorker(language, oem, options);
  }
});

function recognize(dataURL, lang) {
  return workerPool.recognize(dataURL, lang || 'chi_sim+eng');
}

module.exports = { recognize };
