// 截图历史持久化：把每次捕获的图片存到 userData/history，并维护 index.json 元数据。
// 列表返回轻量缩略图（≤360px）以便画廊快速渲染；详情按需取原图。
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

let dir = null;
let imgDir = null;
let indexPath = null;
let cache = null;

function ensureDirs() {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'history');
    imgDir = path.join(dir, 'images');
    indexPath = path.join(dir, 'index.json');
  }
  fs.mkdirSync(imgDir, { recursive: true });
}

function loadIndex() {
  if (cache) return cache;
  ensureDirs();
  try {
    if (fs.existsSync(indexPath)) {
      cache = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (!Array.isArray(cache)) cache = [];
    } else {
      cache = [];
    }
  } catch (e) {
    console.error('[history] 读取索引失败：', e.message);
    cache = [];
  }
  return cache;
}

function saveIndex() {
  ensureDirs();
  try {
    fs.writeFileSync(indexPath, JSON.stringify(cache || [], null, 2), 'utf-8');
  } catch (e) {
    console.error('[history] 写索引失败：', e.message);
  }
}

function dataURLToBuffer(dataURL) {
  const i = dataURL.indexOf(',');
  return Buffer.from(i >= 0 ? dataURL.slice(i + 1) : dataURL, 'base64');
}

// dataURL 是否是有效的 base64 图片（前缀 + 合法 base64 字符 + 合理长度）。
// 关键：nativeImage.createFromDataURL 对非法/空输入不抛异常，而是返回空图，resize/toPNG 也不抛，
// 因此「写盘失败靠 catch 回滚」对脏输入无效——必须在写盘前就把非法 dataURL 拦下，否则会写出 0 字节脏图并污染 index。
function isValidImageDataURL(dataURL) {
  if (typeof dataURL !== 'string') return false;
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataURL)) return false;
  const b64 = dataURL.slice(dataURL.indexOf(',') + 1);
  if (!b64 || b64.length < 24) return false; // 任何真实图片的 base64 都远长于此
  return /^[A-Za-z0-9+/=\s]+$/.test(b64); // 合法 base64 字符集（含换行/填充）
}

// 新增一条历史。type: region|window|fullscreen|timed|pin|long。返回元数据项。
function add(dataURL, type) {
  ensureDirs();
  if (!isValidImageDataURL(dataURL)) {
    console.error('[history] 跳过非法 dataURL（非 data:image;base64 或 base64 内容无效），不写盘。');
    return null;
  }
  const idx = loadIndex();
  const id = `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const file = id + '.png';
  const thumbFile = id + '.thumb.png';
  let width = 0;
  let height = 0;
  try {
    const img = nativeImage.createFromDataURL(dataURL);
    const size = img.getSize();
    width = size.width;
    height = size.height;
    fs.writeFileSync(path.join(imgDir, file), dataURLToBuffer(dataURL));
    // 生成缩略图（最长边 360）
    const maxw = width >= height ? 360 : Math.round((360 * width) / Math.max(1, height));
    const thumb = img.resize({ width: Math.min(width, maxw || 360), quality: 'good' });
    fs.writeFileSync(path.join(imgDir, thumbFile), thumb.toPNG());
  } catch (e) {
    console.error('[history] 保存图片失败：', e.message);
    // 回滚已写入的半成品文件，避免在 images/ 留下不进 index 的孤儿 png。
    try { fs.unlinkSync(path.join(imgDir, file)); } catch (_) {}
    try { fs.unlinkSync(path.join(imgDir, thumbFile)); } catch (_) {}
    return null;
  }
  const item = { id, file, thumbFile, time: Date.now(), width, height, type: type || 'region' };
  idx.unshift(item);
  cache = idx;
  saveIndex();
  return item;
}

// 列表：返回元数据 + 缩略图引用。
// thumb 用自定义协议 URL（kkthumb://<id>）而非内联 base64——渲染层 <img> 按需加载磁盘缩略图，
// 浏览器自行管理解码/释放，避免历史很多时把全部缩略图字符串同步读盘并常驻 DOM/内存。
// 加 ?t=time 让不同图片 URL 互异（同时利用缓存；同一 id 内容不变故时间戳稳定，可被缓存复用）。
function list() {
  const idx = loadIndex();
  return idx.map((it) => ({
    id: it.id,
    time: it.time,
    width: it.width,
    height: it.height,
    type: it.type,
    thumb: 'kkthumb://img/' + encodeURIComponent(it.id) + '?t=' + (it.time || 0),
  }));
}

// 按 id 返回缩略图文件的绝对路径（供 kkthumb:// 协议 handler 用）。找不到返回 null。
function thumbPathOf(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  if (!it) return null;
  ensureDirs();
  const p = path.join(imgDir, it.thumbFile || it.file);
  return fs.existsSync(p) ? p : null;
}

// 取原图 dataURL
function get(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  if (!it) return null;
  try {
    const p = path.join(imgDir, it.file);
    const dataURL = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    return { item: it, dataURL };
  } catch (_) {
    return null;
  }
}

function remove(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  if (!it) return false;
  try { fs.unlinkSync(path.join(imgDir, it.file)); } catch (_) {}
  try { if (it.thumbFile) fs.unlinkSync(path.join(imgDir, it.thumbFile)); } catch (_) {}
  cache = idx.filter((x) => x.id !== id);
  saveIndex();
  return true;
}

// 批量删除：一次写盘、由调用方一次广播，避免逐个删除时的「写盘 + 广播」风暴。返回实际删除数。
function removeMany(ids) {
  const set = new Set(ids || []);
  if (!set.size) return 0;
  const idx = loadIndex();
  let n = 0;
  idx.forEach((it) => {
    if (!set.has(it.id)) return;
    try { fs.unlinkSync(path.join(imgDir, it.file)); } catch (_) {}
    try { if (it.thumbFile) fs.unlinkSync(path.join(imgDir, it.thumbFile)); } catch (_) {}
    n++;
  });
  cache = idx.filter((x) => !set.has(x.id));
  saveIndex();
  return n;
}

function clear() {
  const idx = loadIndex();
  idx.forEach((it) => {
    try { fs.unlinkSync(path.join(imgDir, it.file)); } catch (_) {}
    try { if (it.thumbFile) fs.unlinkSync(path.join(imgDir, it.thumbFile)); } catch (_) {}
  });
  cache = [];
  saveIndex();
}

function filePathOf(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  return it ? path.join(imgDir, it.file) : null;
}

module.exports = { add, list, get, remove, removeMany, clear, filePathOf, thumbPathOf };
