// 截图历史持久化：把每次捕获的图片存到 userData/history，并维护 index.json 元数据。
// 列表返回轻量缩略图（≤360px）以便画廊快速渲染；详情按需取原图。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, nativeImage } = require('electron');

let dir = null;
let imgDir = null;
let mediaDir = null;
let indexPath = null;
let cache = null;

function ensureDirs() {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'history');
    imgDir = path.join(dir, 'images');
    mediaDir = path.join(dir, 'media');
    indexPath = path.join(dir, 'index.json');
  }
  fs.mkdirSync(imgDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
}

// index.json 是本地可编辑文件，不能直接信任其中的 file/thumbFile。只允许 images/
// 目录下的单层 PNG 文件名，阻止 ../../ 路径穿越读取或删除其它本机文件。
function imagePath(fileName) {
  ensureDirs();
  if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) return null;
  if (!/\.png$/i.test(fileName)) return null;
  const root = path.resolve(imgDir) + path.sep;
  const candidate = path.resolve(imgDir, fileName);
  return candidate.startsWith(root) ? candidate : null;
}

// 录屏历史保留一份受管副本，不信任 index.json 里的任意绝对路径。
// 仅接受录屏导出实际支持的三种后缀，并限制在 history/media 单层目录。
function mediaPath(fileName) {
  ensureDirs();
  if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) return null;
  if (!/\.(webm|mp4|gif)$/i.test(fileName)) return null;
  const root = path.resolve(mediaDir) + path.sep;
  const candidate = path.resolve(mediaDir, fileName);
  return candidate.startsWith(root) ? candidate : null;
}

function itemFilePath(item) {
  if (!item || typeof item !== 'object') return null;
  return item.kind === 'media' ? mediaPath(item.file) : imagePath(item.file);
}

function isSafeItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) return false;
  if (item.kind === 'media') {
    if (item.type !== 'recording' || !mediaPath(item.file) || item.thumbFile) return false;
    return true;
  }
  if (item.kind != null && item.kind !== 'image') return false;
  if (!imagePath(item.file)) return false;
  if (item.thumbFile && !imagePath(item.thumbFile)) return false;
  return true;
}

function loadIndex() {
  if (cache) return cache;
  ensureDirs();
  try {
    if (fs.existsSync(indexPath)) {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      cache = Array.isArray(parsed) ? parsed.filter(isSafeItem) : [];
      if (Array.isArray(parsed) && cache.length !== parsed.length) {
        console.warn(`[history] 已忽略 ${parsed.length - cache.length} 条不安全或损坏的索引记录。`);
      }
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
  const tmp = path.join(dir, `.index-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    // 先把完整 JSON 写入同目录私有临时文件并同步到磁盘，再原子替换正式索引。
    // 进程若在写入中途退出，旧 index.json 仍保持完整，启动时不会读到半截 JSON。
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(cache || [], null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, indexPath);
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// 只有索引真正原子落盘后才让新的内存视图生效。磁盘满、权限变化等错误发生时，
// 回滚 cache，避免当前进程显示的历史与重启后读到的历史互相矛盾。
function commitIndex(next, previous) {
  cache = next;
  try {
    saveIndex();
    return true;
  } catch (e) {
    cache = previous;
    console.error('[history] 写索引失败：', e.message);
    return false;
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

// 新增一条图片历史。type: region|window|fullscreen|timed|pin|long。返回元数据项。
function add(dataURL, type) {
  ensureDirs();
  if (!isValidImageDataURL(dataURL)) {
    console.error('[history] 跳过非法 dataURL（非 data:image;base64 或 base64 内容无效），不写盘。');
    return null;
  }
  const idx = loadIndex();
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const file = id + '.png';
  const thumbFile = id + '.thumb.png';
  let width = 0;
  let height = 0;
  try {
    const img = nativeImage.createFromDataURL(dataURL);
    const size = img.getSize();
    width = size.width;
    height = size.height;
    // P3-5(B14)：合法 base64 但解码为空图 → 拒绝入库，避免 0×0 脏记录污染索引
    if (img.isEmpty() || !width || !height) {
      console.error('[history] 跳过无法解码的图片（base64 合法但内容不是有效图片）。');
      return null;
    }
    fs.writeFileSync(imagePath(file), dataURLToBuffer(dataURL), { mode: 0o600 });
    // 生成缩略图（最长边 360）
    const maxw = width >= height ? 360 : Math.round((360 * width) / Math.max(1, height));
    const thumb = img.resize({ width: Math.min(width, maxw || 360), quality: 'good' });
    fs.writeFileSync(imagePath(thumbFile), thumb.toPNG(), { mode: 0o600 });
  } catch (e) {
    console.error('[history] 保存图片失败：', e.message);
    // 回滚已写入的半成品文件，避免在 images/ 留下不进 index 的孤儿 png。
    try { fs.unlinkSync(imagePath(file)); } catch (_) {}
    try { fs.unlinkSync(imagePath(thumbFile)); } catch (_) {}
    return null;
  }
  const item = { id, file, thumbFile, time: Date.now(), width, height, type: type || 'region', kind: 'image' };
  const next = [item, ...idx];
  if (!commitIndex(next, idx)) {
    // 图片先写盘、索引后提交：索引提交失败时删除这次新增的图片，维持事务一致性。
    try { fs.unlinkSync(imagePath(file)); } catch (_) {}
    try { fs.unlinkSync(imagePath(thumbFile)); } catch (_) {}
    return null;
  }
  return item;
}

// 录屏成功导出后，把视频/GIF 复制到受管历史目录。这与截图历史保留 PNG
// 副本的语义一致：删除/清空历史只删受管副本，不会删用户选择位置上的原始导出。
async function addMedia(sourcePath, type) {
  ensureDirs();
  if (type !== 'recording' || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return null;
  const ext = path.extname(sourcePath).toLowerCase();
  if (!['.webm', '.mp4', '.gif'].includes(ext)) return null;
  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch (_) {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;

  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const file = id + ext;
  const target = mediaPath(file);
  const tmp = path.join(mediaDir, `.media-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    // 录屏上限可达 128 MB；复制/刷盘必须走异步 fs，避免保存期间冻结 Electron 主线程。
    await fs.promises.copyFile(sourcePath, tmp, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(tmp, 0o600);
    const handle = await fs.promises.open(tmp, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(tmp, target);
  } catch (e) {
    console.error('[history] 保存录屏副本失败：', e.message);
    try { await fs.promises.unlink(tmp); } catch (_) {}
    return null;
  }

  // 放到最后加载最新 cache；多个并发 addMedia 在每次无 await 的提交段内依次合并，
  // 不会用复制开始前的旧快照互相覆盖。
  const idx = loadIndex();
  const item = {
    id,
    file,
    time: Date.now(),
    width: 0,
    height: 0,
    type: 'recording',
    kind: 'media',
    size: stat.size,
  };
  const next = [item, ...idx];
  if (!commitIndex(next, idx)) {
    try { await fs.promises.unlink(target); } catch (_) {}
    return null;
  }
  return item;
}

// 列表：返回元数据 + 缩略图引用。
// thumb 用自定义协议 URL（kkthumb://<id>）而非内联 base64——渲染层 <img> 按需加载磁盘缩略图，
// 浏览器自行管理解码/释放，避免历史很多时把全部缩略图字符串同步读盘并常驻 DOM/内存。
// 加 ?t=time 让不同图片 URL 互异（同时利用缓存；同一 id 内容不变故时间戳稳定，可被缓存复用）。
function list(options) {
  const idx = loadIndex();
  const includeMedia = !!(options && options.includeMedia === true);
  return idx.filter((it) => includeMedia || it.kind !== 'media').map((it) => ({
    id: it.id,
    time: it.time,
    width: it.width,
    height: it.height,
    type: it.type,
    kind: it.kind || 'image',
    size: it.size || 0,
    thumb: it.kind === 'media' ? null : 'kkthumb://img/' + encodeURIComponent(it.id) + '?t=' + (it.time || 0),
  }));
}

// 按 id 返回缩略图文件的绝对路径（供 kkthumb:// 协议 handler 用）。找不到返回 null。
function thumbPathOf(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  if (!it || it.kind === 'media') return null;
  ensureDirs();
  const p = imagePath(it.thumbFile || it.file);
  if (!p) return null;
  return fs.existsSync(p) ? p : null;
}

// 取原图 dataURL
function get(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  if (!it) return null;
  if (it.kind === 'media') return { item: it, dataURL: null };
  try {
    const p = imagePath(it.file);
    if (!p) return null;
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
  const file = itemFilePath(it);
  const thumb = it.thumbFile ? imagePath(it.thumbFile) : null;
  if (!file || (it.thumbFile && !thumb)) return false;
  const next = idx.filter((x) => x.id !== id);
  if (!commitIndex(next, idx)) return false;
  // 先从索引提交删除，再清理图片。后者失败至多留下不可见的孤儿文件，不会让索引指向缺失文件。
  try { fs.unlinkSync(file); } catch (_) {}
  try { if (thumb) fs.unlinkSync(thumb); } catch (_) {}
  return true;
}

// 批量删除：一次写盘、由调用方一次广播，避免逐个删除时的「写盘 + 广播」风暴。返回实际删除数。
function removeMany(ids) {
  const set = new Set(ids || []);
  if (!set.size) return 0;
  const idx = loadIndex();
  const targets = [];
  idx.forEach((it) => {
    if (!set.has(it.id)) return;
    const file = itemFilePath(it);
    const thumb = it.thumbFile ? imagePath(it.thumbFile) : null;
    if (!file || (it.thumbFile && !thumb)) return;
    targets.push({ id: it.id, file, thumb });
  });
  if (!targets.length) return 0;
  const targetIds = new Set(targets.map((target) => target.id));
  const next = idx.filter((x) => !targetIds.has(x.id));
  if (!commitIndex(next, idx)) return 0;
  targets.forEach(({ file, thumb }) => {
    try { fs.unlinkSync(file); } catch (_) {}
    try { if (thumb) fs.unlinkSync(thumb); } catch (_) {}
  });
  return targets.length;
}

function clear() {
  const idx = loadIndex();
  if (!commitIndex([], idx)) return false;
  idx.forEach((it) => {
    const file = itemFilePath(it);
    const thumb = it.thumbFile ? imagePath(it.thumbFile) : null;
    try { if (file) fs.unlinkSync(file); } catch (_) {}
    try { if (thumb) fs.unlinkSync(thumb); } catch (_) {}
  });
  return true;
}

function filePathOf(id) {
  const idx = loadIndex();
  const it = idx.find((x) => x.id === id);
  return it ? itemFilePath(it) : null;
}

module.exports = { add, addMedia, list, get, remove, removeMany, clear, filePathOf, thumbPathOf };
