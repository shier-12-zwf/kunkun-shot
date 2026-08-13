// 困困截图工具 —— 主进程入口。
// 负责：单实例锁、菜单栏托盘、全局快捷键、屏幕捕获编排、所有 IPC 处理。
const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  screen,
  desktopCapturer,
  clipboard,
  nativeImage,
  dialog,
  shell,
  systemPreferences,
  protocol,
  net,
  Notification,
} = require('electron');

const C = require('../shared/channels');
const config = require('./config');
const deepseek = require('./deepseek');
const ocr = require('./ocr');
const media = require('./media');
const windows = require('./windows');
const history = require('./history');
const { spawn } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');

// 自定义协议 kkthumb://<id> 专供历史缩略图：让渲染层 <img> 按需加载磁盘缩略图文件，
// 而非把每张 base64 内联进 DOM（历史攒到成百上千条时内联会导致主进程同步读盘 + 跨进程序列化 +
// 渲染层常驻大量大字符串）。须在 app ready 前声明为特权 scheme（standard + secure），
// 否则 file:// 页面因同源策略无法加载它。
protocol.registerSchemesAsPrivileged([
  { scheme: 'kkthumb', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

// 进行中的流式请求：streamId -> AbortController，供「主动取消」与「窗口销毁自动中止」使用。
const streamAborts = new Map();

// 包装一次流式请求：登记 AbortController，发起方窗口销毁时自动中止，结束后清理登记。
async function streamWithAbort(streamId, sender, opts, send) {
  const ac = new AbortController();
  if (streamId) streamAborts.set(streamId, ac);
  const onGone = () => ac.abort();
  try { sender.once('destroyed', onGone); } catch (_) {}
  try {
    await deepseek.streamChat({ ...opts, signal: ac.signal }, send);
  } finally {
    if (streamId) streamAborts.delete(streamId);
    try { sender.removeListener('destroyed', onGone); } catch (_) {}
  }
}

// macOS 屏幕录制权限（TCC）检查。未授权时可弹原生引导对话框，并一键跳转「系统设置 › 隐私 › 屏幕录制」。
// 返回 true=已授权；false=未授权（此时截图/长截图/录屏会黑屏或空白）。
function checkScreenPermission(promptIfDenied) {
  if (process.platform !== 'darwin') return true;
  let status = 'granted';
  try {
    status = systemPreferences.getMediaAccessStatus('screen');
  } catch (_) {}
  if (status === 'granted') return true;
  if (promptIfDenied) {
    try {
      const r = dialog.showMessageBoxSync({
        type: 'warning',
        title: '需要「屏幕录制」权限',
        message: '困困截图工具需要「屏幕录制」权限，才能截图 / 长截图 / 录屏。',
        detail:
          '请在「系统设置 › 隐私与安全性 › 屏幕录制」里勾选「困困截图工具」，然后重新尝试。\n首次授权后可能需要重启本应用才会生效。',
        buttons: ['打开系统设置', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (r === 0) {
        shell
          .openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
          .catch(() => {});
      }
    } catch (_) {}
  }
  return false;
}

// 保存一张图到历史并广播刷新
function saveToHistory(dataURL, type) {
  try {
    const item = history.add(dataURL, type);
    windows.broadcast(C.HISTORY_CHANGED);
    return item;
  } catch (e) {
    console.error('[history] 保存失败：', e.message);
    return null;
  }
}

// 仅当用户开启「自动保存历史」时才入库；默认只有手动「保存到本地」才进历史。
function autoSaveToHistory(dataURL, type) {
  try {
    if (!config.get().capture.autoSaveHistory) return null;
  } catch (_) {}
  return saveToHistory(dataURL, type);
}

// 通用 OpenAI 兼容服务商（硅基流动/通义千问/Kimi/自定义）作为「纯文本」provider 返回。
// 看图能力它没有（vision:false），故仅用于文本任务；未配 Key 返回 null 让调用方回退。
function openaiTextProvider() {
  const o = (config.get().openai) || {};
  if (!o.apiKey || !o.baseUrl) return null;
  return {
    name: 'openai',
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    textModel: o.model,
    visionModel: o.model,
    vision: false,
    downgraded: false,
  };
}

// 当前生效的 AI 提供方。四种模式：
//   deepseek = 全用 DeepSeek（看图走本地 OCR）
//   minimax  = 全用 MiniMax-M3（可直接看图）
//   openai   = 通用 OpenAI 兼容（硅基流动/通义千问/Kimi/自定义），纯文本；看图任务自动退回本地 OCR
//   auto     = 智能分流（省钱）：纯文本走「openai(若配) 否则 DeepSeek」，看图任务走 MiniMax
// needVision 标记本次任务是否需要「看图」，仅在 auto 模式下影响路由。
function aiProvider(needVision) {
  const cfg = config.get();
  const mode = (cfg.ai && cfg.ai.provider) || 'deepseek';
  const m = cfg.minimax || {};
  let which;
  // 「智能分流」想看图但没配 MiniMax Key → 被迫降级为文本+本地OCR，标记出来好在调用处提示用户。
  let downgraded = false;
  if (mode === 'auto') {
    // 看图且 MiniMax 已配 Key → MiniMax；否则走文本 provider（文本/本地 OCR）
    if (needVision && m.apiKey) {
      which = 'minimax';
    } else {
      which = 'text'; // 文本路由：优先 openai，其次 deepseek
      downgraded = needVision && !m.apiKey;
    }
  } else if (mode === 'minimax') {
    which = 'minimax';
  } else if (mode === 'openai') {
    // 显式选了通用服务商：文本任务用它；看图任务它做不到 → 退回 DeepSeek 本地 OCR 并标记
    if (needVision) { which = 'deepseek'; downgraded = true; }
    else { which = 'openai'; }
  } else {
    which = 'deepseek';
  }
  if (which === 'minimax') {
    return {
      name: 'minimax',
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      textModel: m.textModel || m.visionModel,
      visionModel: m.visionModel || m.textModel,
      vision: true,
      downgraded: false,
    };
  }
  if (which === 'text' || which === 'openai') {
    const oa = openaiTextProvider();
    if (oa) { oa.downgraded = downgraded; return oa; }
    // openai 显式选中却没配好 → 落到 DeepSeek 兜底（避免直接无 Key 报错）
  }
  const d = cfg.deepseek || {};
  return {
    name: 'deepseek',
    baseUrl: d.baseUrl,
    apiKey: d.apiKey,
    textModel: d.textModel,
    visionModel: d.visionModel,
    vision: false,
    downgraded,
  };
}

let tray = null;

// ---------- 屏幕捕获 ----------
// 抓取光标所在显示器的整屏，返回截图层需要的数据。
async function grabDisplay() {
  // 权限单点收口：所有「整屏抓取」都经此函数（区域/全屏/定时全屏/截图前蒙版）。未授权时弹原生引导并中止，
  // 避免黑屏/空截图。注：长截图逐帧走 CAPTURE_REGION（不经此函数），故不会每帧弹窗。
  if (!checkScreenPermission(true)) throw new Error('SCREEN_PERMISSION_DENIED');
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    },
  });
  let src = sources.find((s) => String(s.display_id) === String(display.id));
  if (!src) {
    // 修复(多显示器抓错屏)：部分 macOS 上 screen source 的 display_id 为空串，无法直接匹配，
    // 直接退回 sources[0]（主屏）会导致「截图层开在光标所在副屏、背景图却是主屏」的错位。
    // 与 CAPTURE_REGION 一致地按「该显示器在 getAllDisplays 里的序号」取同序号 source（两者顺序通常一致），
    // 仍无匹配才退回首个。
    const di = screen.getAllDisplays().findIndex((d) => String(d.id) === String(display.id));
    src = (di >= 0 && sources[di]) || sources[0];
  }
  if (!src) throw new Error('未获取到屏幕源，请检查「屏幕录制」权限。');
  return {
    display,
    dataURL: src.thumbnail.toDataURL(),
    scaleFactor: sf,
    displayId: display.id,
    sourceId: src.id,
    width: display.size.width,
    height: display.size.height,
  };
}

async function startCapture(mode) {
  if (windows.getOverlay()) windows.closeOverlay();
  // 屏幕录制权限未授权：弹原生引导（可一键跳系统设置），避免黑屏/空截图
  if (!checkScreenPermission(true)) return;
  try {
    const g = await grabDisplay();
    windows.createOverlay(g.display, {
      dataURL: g.dataURL,
      scaleFactor: g.scaleFactor,
      displayId: g.displayId,
      sourceId: g.sourceId,
      width: g.width,
      height: g.height,
      mode: mode || 'region',
    });
  } catch (e) {
    console.error('[capture] 失败：', e);
    dialog.showErrorBox('截图失败', `${e.message}\n\n如果在 macOS 上，请到「系统设置 → 隐私与安全性 → 屏幕录制」里授权本应用。`);
  }
}

function pinFromClipboard() {
  const img = clipboard.readImage();
  if (img.isEmpty()) {
    dialog.showMessageBox({ type: 'info', message: '剪贴板里没有图片', detail: '先复制一张图片再使用此功能。' });
    return;
  }
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const sf = display.scaleFactor || 1;
  const size = img.getSize();
  const w = Math.round(size.width / sf);
  const h = Math.round(size.height / sf);
  windows.createPin({
    dataURL: img.toDataURL(),
    bounds: { x: point.x, y: point.y, width: w, height: h },
  });
}

// ---------- 全局划词翻译（纯 Electron：快捷键 + 剪贴板兜底）----------
// 说明：Electron 拿不到「别的 App 里选中的文字」和选区坐标，故走通用兜底：
//   模拟 Cmd+C 读取当前选中文字 → 用完还原剪贴板 → 在鼠标附近弹翻译卡片。
// 需要 macOS「辅助功能」权限（模拟按键的前提）。

// 检测辅助功能权限（模拟按键必需）。promptIfDenied=true 时弹系统授权面板。
function checkAccessibilityPermission(promptIfDenied) {
  if (process.platform !== 'darwin') return true; // 仅 mac 需要
  try {
    return systemPreferences.isTrustedAccessibilityClient(!!promptIfDenied);
  } catch (_) {
    return true; // 拿不到就别拦着，交给后续实际操作暴露问题
  }
}

// 备份当前剪贴板（文本 + 图片），返回一个可用于还原的快照。
function snapshotClipboard() {
  let text = '';
  let image = null;
  try { text = clipboard.readText(); } catch (_) {}
  try { const img = clipboard.readImage(); if (img && !img.isEmpty()) image = img; } catch (_) {}
  return { text, image };
}

// 用快照还原剪贴板（优先按原本类型还原；都空则清空避免残留选中文字）。
function restoreClipboard(snap) {
  try {
    if (snap && snap.image) { clipboard.writeImage(snap.image); return; }
    if (snap && typeof snap.text === 'string') { clipboard.writeText(snap.text); return; }
    clipboard.clear();
  } catch (_) {}
}

// 模拟一次 Cmd+C（mac 用 osascript 发 System Events keystroke）。
function simulateCopy() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    const script = 'tell application "System Events" to keystroke "c" using command down';
    const p = spawn('osascript', ['-e', script]);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读取「当前选中的文字」：清空剪贴板→模拟 Cmd+C→等系统写入→读回。全程有备份，末尾还原。
// 返回选中的纯文本（可能为空）。
async function readSelectedText() {
  const snap = snapshotClipboard();
  try {
    // 先清空，便于判断 Cmd+C 是否真的写入了新内容（没选中文字时剪贴板不会变）
    clipboard.clear();
    const ok = await simulateCopy();
    if (!ok) return '';
    // 系统把选中内容写进剪贴板有延迟，Swift 版也等 0.1~0.4s，这里等 180ms 再读
    await sleep(180);
    let text = '';
    try { text = clipboard.readText() || ''; } catch (_) {}
    return text.trim();
  } finally {
    restoreClipboard(snap); // 无论成败都还原用户原本的剪贴板
  }
}

// 划词翻译总入口：由全局快捷键触发。
let translateBusy = false;
async function triggerGlobalTranslate() {
  // P2-1(B2)：划词翻译依赖 macOS 模拟 Cmd+C，非 mac 平台静默失效 → 明确提示
  if (process.platform !== 'darwin') {
    dialog.showMessageBox({
      type: 'info',
      message: '划词翻译仅支持 macOS',
      detail: '此功能依赖 macOS 的系统辅助功能（模拟拷贝读取选中文字），Windows/Linux 暂不支持。',
    });
    return;
  }
  if (translateBusy) return; // 防连点
  translateBusy = true;
  // busy 需覆盖「读选中文字 + 弹窗 + 网络翻译」整个生命周期，否则连点会并发弹多张卡片、
  // 浪费重复的 LLM 调用。releaseBusy 保证只释放一次；各提前 return 分支与异步回调都要调它。
  let released = false;
  const releaseBusy = () => { if (!released) { released = true; translateBusy = false; } };
  try {
    // 1) 权限：未授权则弹系统面板 + 提示，不继续
    if (!checkAccessibilityPermission(true)) {
      dialog.showMessageBox({
        type: 'info',
        message: '需要「辅助功能」权限',
        detail: '划词翻译要模拟一次「拷贝」来读取你选中的文字。\n请在「系统设置 → 隐私与安全性 → 辅助功能」里勾选「困困截屏助手」，然后重试。',
      });
      releaseBusy();
      return;
    }
    // 2) 记录鼠标位置（卡片锚点），读取选中文字
    const anchor = screen.getCursorScreenPoint();
    const text = await readSelectedText();
    if (!text) { releaseBusy(); return; } // 没选中文字：静默，不打扰

    // 3) 弹卡片（先显示 loading），异步翻译后回填
    const target = (config.get().translate && config.get().translate.target) || '中文';
    const win = windows.createTranslatePopup(anchor);
    const send = (payload) => {
      const w = windows.getTranslatePopup();
      if (w && w === win && !w.isDestroyed()) w.webContents.send(C.TRANSLATE_POPUP_DATA, payload);
    };
    // 兜底：若 did-finish-load 因加载失败等原因始终不触发，20s 后强制释放 busy，避免永久卡死。
    const failsafe = setTimeout(releaseBusy, 20000);
    // 卡片加载完再推首帧数据（避免 did-finish-load 之前发送丢失）
    win.webContents.once('did-finish-load', async () => {
      send({ text, target, loading: true });
      try {
        const p = aiProvider(false);
        if (!p.apiKey) { send({ text, target, error: '未配置 API Key，请在「设置 → AI 模型」里填写。' }); return; }
        const sys = '你是一个高效的翻译助手。把用户给的文字翻译成' + target
          + '。只输出译文本身，不要任何解释、音标、词性、例句、引号或多余的话。若是句子就直接给通顺的整句翻译。';
        const out = await deepseek.completeText({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.textModel,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
          think: false,
        });
        const translation = deepseek.stripThink(out || '').trim();
        if (!translation) { send({ text, target, error: '翻译返回为空，请重试。' }); return; }
        send({ text, target, translation });
      } catch (err) {
        send({ text, target, error: (err && err.message) || String(err) });
      } finally {
        clearTimeout(failsafe);
        releaseBusy(); // 翻译真正结束（成功/失败）后才允许下一次
      }
    });
  } catch (err) {
    // 前置步骤（权限/读字/弹窗）抛错也要释放，否则 busy 永久卡死
    releaseBusy();
    throw err;
  }
}

// 立即整屏截图 → 复制 + 存历史
async function doFullscreenNow() {
  const g = await grabDisplay();
  clipboard.writeImage(nativeImage.createFromDataURL(g.dataURL));
  return autoSaveToHistory(g.dataURL, 'fullscreen');
}

// 交互式窗口截图（macOS screencapture -w）→ 复制 + 存历史
function doWindowCapture() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      return resolve({ ok: false, error: '交互式窗口截图目前仅支持 macOS' });
    }
    const tmp = path.join(os.tmpdir(), `kkwin-${Date.now()}.png`);
    const p = spawn('screencapture', ['-w', '-x', '-o', tmp]);
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', () => {
      try {
        if (!fs.existsSync(tmp)) return resolve({ ok: false, error: '已取消' });
        const dataURL = 'data:image/png;base64,' + fs.readFileSync(tmp).toString('base64');
        fs.unlinkSync(tmp);
        clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
        const item = autoSaveToHistory(dataURL, 'window');
        resolve({ ok: true, item });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

// ---------- 大图降采样（P2-6/B8）：发送给视觉 API 前压缩，避免超限/烧 token ----------
function downscaleDataURL(dataURL, maxSide) {
  if (!dataURL || maxSide <= 0) return dataURL;
  try {
    const img = nativeImage.createFromDataURL(dataURL);
    const sz = img.getSize();
    if (!sz.width || !sz.height) return dataURL;
    const m = Math.max(sz.width, sz.height);
    if (m <= maxSide) return dataURL;
    const r = maxSide / m;
    return img
      .resize({ width: Math.max(1, Math.round(sz.width * r)), height: Math.max(1, Math.round(sz.height * r)), quality: 'good' })
      .toDataURL();
  } catch (_) {
    return dataURL;
  }
}

// ---------- 保存图片 ----------
async function saveImageWithDialog(dataURL, suggestName) {
  const cfg = config.get();
  const dir = cfg.general.saveDir || app.getPath('pictures');
  const name = suggestName || `困困截图-${Date.now()}.png`;
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '保存图片',
    defaultPath: path.join(dir, name),
    filters: [
      { name: 'PNG 图片（无损，支持透明）', extensions: ['png'] },
      { name: 'JPEG 图片（更小，不支持透明）', extensions: ['jpg', 'jpeg'] },
      { name: 'WebP 图片（体积小）', extensions: ['webp'] },
    ],
  });
  if (canceled || !filePath) return { saved: false };
  const ext = path.extname(filePath || '').toLowerCase();
  try {
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      // 先写临时 PNG（原始质量），再用 ffmpeg 转目标格式
      const tmp = path.join(os.tmpdir(), `kkshot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
      media.saveImageFile(dataURL, tmp);
      await media.convertImage(tmp, filePath, ext === '.webp' ? ['-quality', '86'] : ['-q:v', '3']);
      try { fs.unlinkSync(tmp); } catch (_) {}
    } else {
      media.saveImageFile(dataURL, filePath);
    }
    return { saved: true, path: filePath };
  } catch (err) {
    dialog.showErrorBox('保存图片失败', (err && err.message) || String(err));
    return { saved: false, error: (err && err.message) || String(err) };
  }
}

// ---------- IPC ----------
function registerIpc() {
  // M1 修复：统一拦截所有 ipcMain.handle——只接受本应用窗口工厂创建的 webContents 发来的请求。
  // 被导航/注入的窗口、外部 webContents 一律拿不到任何能力（截图/剪贴板/配置/AI 请求等）。
  if (!ipcMain.__kkGuarded) {
    ipcMain.__kkGuarded = true;
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) =>
      origHandle(channel, (event, ...args) => {
        if (!event || !event.sender || !windows.isTrustedSender(event.sender.id)) {
          return undefined; // invoke 端收到 undefined，静默失败（不抛错、不给信息）
        }
        return listener(event, ...args);
      });
  }

  ipcMain.handle(C.CONFIG_GET, () => config.publicView()); // H2：渲染层只拿掩码视图，Key 不出主进程
  ipcMain.handle(C.CONFIG_SET, (_e, patch) => {
    // P1-2(M3)：禁止把 API 端点配成明文 http://（Key 会明文传输）；本机回环地址除外（自建 LLM / Ollama）。
    const badBase = ['deepseek', 'minimax', 'openai']
      .map((k) => ({ k, url: patch && patch[k] && typeof patch[k].baseUrl === 'string' ? patch[k].baseUrl.trim() : '' }))
      .filter((x) => x.url && /^http:\/\//i.test(x.url))
      .filter(
        (x) =>
          !/^http:\/\/localhost([:/]|$)/i.test(x.url) &&
          !/^http:\/\/127\.0\.0\.1([:/]|$)/i.test(x.url) &&
          !/^http:\/\/\[?::1\]?([:/]|$)/i.test(x.url)
      );
    if (badBase.length) {
      throw new Error(
        '「' + badBase[0].k + '」的 Base URL 不允许使用 http:// 明文端点（API Key 会明文传输）。请改用 https://，或本机回环地址（如 http://localhost:11434/v1）。'
      );
    }
    const merged = config.set(patch);
    registerShortcuts();
    applyLoginItem();
    return merged;
  });

  ipcMain.handle(C.WINDOW_CLOSE_SELF, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  });
  ipcMain.handle(C.WINDOW_MINIMIZE_SELF, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.minimize();
  });
  // 以中心为锚点缩放当前窗口（贴图触控板捏合缩放用）
  ipcMain.handle(C.WINDOW_RESIZE_SELF, (e, { width, height }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    const nw = Math.max(48, Math.min(8000, Math.round(width)));
    const nh = Math.max(48, Math.min(8000, Math.round(height)));
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    w.setBounds({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), width: nw, height: nh });
    return { width: nw, height: nh }; // 回传实际应用尺寸（含 clamp），供贴图回算真实缩放，避免缩放迟滞
  });
  // 按增量移动当前窗口（贴图 JS 拖动用）
  ipcMain.handle(C.WINDOW_MOVE_SELF, (e, { dx, dy }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    w.setBounds({ x: Math.round(b.x + (dx || 0)), y: Math.round(b.y + (dy || 0)), width: b.width, height: b.height });
  });
  ipcMain.handle(C.OPEN_SETTINGS, () => windows.openSettings());
  ipcMain.handle(C.OPEN_AI_PANEL, (_e, payload) => windows.openAIPanel(payload));

  ipcMain.handle(C.CAPTURE_TRIGGER, (_e, mode) => startCapture(mode));
  ipcMain.handle(C.CAPTURE_REGION, async (_e, { rect, displayId }) => {
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) ||
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    let src = sources.find((s) => String(s.display_id) === String(display.id));
    if (!src) {
      // 部分 macOS 上 screen source 的 display_id 为空串，无法直接匹配 →
      // 退而用「该显示器在 getAllDisplays 里的序号」对应 sources 的同序号（两者顺序通常一致），最后才退回首个。
      const di = screen.getAllDisplays().findIndex((d) => String(d.id) === String(display.id));
      src = (di >= 0 && sources[di]) || sources[0];
    }
    // 屏幕源可能为空（屏幕录制权限被中途撤销 / 多屏热插拔瞬间）。长截图逐帧调用此通道，
    // 不保护会在 src 为 undefined 时抛 TypeError 静默搞挂整个长截图流程，故与 grabDisplay 一致地给出清晰错误。
    if (!src || !src.thumbnail) throw new Error('未获取到屏幕源，请检查「屏幕录制」权限是否开启。');
    const crop = src.thumbnail.crop({
      x: Math.round(rect.x * sf),
      y: Math.round(rect.y * sf),
      width: Math.round(rect.width * sf),
      height: Math.round(rect.height * sf),
    });
    return crop.toDataURL();
  });
  ipcMain.handle(C.CAPTURE_GET_SOURCES, async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
  });

  ipcMain.handle(C.OVERLAY_CANCEL, () => windows.closeOverlay());
  ipcMain.handle(C.OVERLAY_RESULT, async (_e, result) => {
    const { action, imageDataURL, bounds, displayId, rect } = result || {};
    windows.closeOverlay();
    const cfg = config.get();
    try {
    let savedToHistory = false; // save 动作是否已真正存盘并入历史，用于避免与下面自动入历史重复
    switch (action) {
      case 'copy':
        clipboard.writeImage(nativeImage.createFromDataURL(imageDataURL));
        break;
      case 'save': {
        const r = await saveImageWithDialog(imageDataURL);
        if (r && r.saved) { saveToHistory(imageDataURL, 'region'); savedToHistory = true; } // 主动保存到本地 → 入历史
        break;
      }
      case 'quickSave': {
        // 快速保存：免对话框直接存到保存目录，并弹系统通知
        const dir = cfg.general.saveDir || app.getPath('pictures');
        const file = path.join(dir, `困困截图-${Date.now()}.png`);
        try {
          media.saveImageFile(imageDataURL, file);
          saveToHistory(imageDataURL, 'region');
          savedToHistory = true;
          if (Notification.isSupported()) {
            new Notification({ title: '困困截图', body: '已快速保存：' + file }).show();
          }
        } catch (err) {
          console.error('[quick-save] 失败：', err);
          dialog.showErrorBox('快速保存失败', (err && err.message) || String(err));
        }
        break;
      }
      case 'pin':
        windows.createPin({ dataURL: imageDataURL, bounds });
        break;
      case 'ocr':
        windows.openAIPanel({ mode: 'ocr', dataURL: imageDataURL });
        break;
      case 'ask':
        windows.openAIPanel({ mode: 'ask', dataURL: imageDataURL });
        break;
      case 'translate':
        windows.openAIPanel({ mode: 'translateImage', dataURL: imageDataURL });
        break;
      case 'record': {
        const dd = boundsToDisplay(displayId);
        windows.createRecorder({
          rect,
          displayBounds: dd.bounds,
          scaleFactor: dd.scaleFactor,
          displayId,
          // 显示器序号：macOS 上 source.display_id 可能为空，录屏端据此按序号兜底匹配，避免录错屏。
          displayIndex: screen.getAllDisplays().findIndex((d) => String(d.id) === String(displayId)),
          fps: cfg.recording.fps,
          toGif: cfg.recording.toGif,
        });
        break;
      }
      case 'long': {
        const dd = boundsToDisplay(displayId);
        windows.createLongShot({
          rect,
          displayBounds: dd.bounds,
          scaleFactor: dd.scaleFactor,
          displayId,
        });
        break;
      }
      default:
        break;
    }
    if (cfg.capture.copyAfterCapture && imageDataURL && action !== 'copy') {
      clipboard.writeImage(nativeImage.createFromDataURL(imageDataURL));
    }
    // 自动贴图：截完把图钉到屏幕原位。pin 动作本身即贴图、record/long 无静态图，均跳过。
    if (cfg.capture.autoPin && imageDataURL && bounds && action !== 'pin') {
      windows.createPin({ dataURL: imageDataURL, bounds });
    }
    // 自动入历史（仅当开启「自动保存历史」）。save 动作若已真正存盘入库则跳过避免重复；
    // 但若 save 对话框被取消(未入库)，开启自动历史时仍应入历史，保持与 copy/ocr/ask 等其它动作一致。
    if (imageDataURL && !(action === 'save' && savedToHistory)) autoSaveToHistory(imageDataURL, action === 'pin' ? 'pin' : 'region');
    } catch (err) {
      // 核心动作分发器一旦中途抛错，overlay 已关闭、用户看不到任何反馈（图没了也没保存）。
      // 显式记录并弹原生错误框，避免静默吞错。
      console.error('[overlay-result] 处理失败:', action, err);
      try { dialog.showErrorBox('截图处理失败', `「${action || '操作'}」处理时出错：\n${(err && err.message) || err}`); } catch (_) {}
    }
  });

  ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE, (_e, dataURL) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
    return true;
  });
  ipcMain.handle(C.CLIPBOARD_WRITE_TEXT, (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle(C.CLIPBOARD_READ_IMAGE, () => {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toDataURL();
  });
  ipcMain.handle(C.IMAGE_SAVE, async (_e, dataURL) => {
    const r = await saveImageWithDialog(dataURL);
    if (r && r.saved) saveToHistory(dataURL, 'region'); // 主动保存到本地 → 入历史
    return r;
  });

  // 选择截图保存目录（系统目录选择对话框），选中即写入 config
  ipcMain.handle(C.CHOOSE_SAVE_DIR, async () => {
    const cur = config.get().general.saveDir || app.getPath('pictures');
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择截图保存目录',
      defaultPath: cur,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { dir: null };
    const dir = filePaths[0];
    config.set({ general: { saveDir: dir } });
    return { dir };
  });

  ipcMain.handle(C.PIN_CREATE, (_e, { dataURL, bounds }) => windows.createPin({ dataURL, bounds }));

  ipcMain.handle(C.OCR_RUN, async (_e, payload) => {
    const cfg = config.get();
    const lang = (payload && payload.lang) || cfg.ocr.lang;
    const engine = (payload && payload.engine) || (cfg.ocr && cfg.ocr.engine) || 'local';
    // 大模型模式：用当前 AI 提供方「看图」识别文字（仅支持视觉的提供方，如 MiniMax-M3）
    if (engine !== 'local') {
      const p = aiProvider(true);
      if (p.vision && p.apiKey) {
        try {
          const prompt = (cfg.deepseek && cfg.deepseek.ocrPrompt) || '请提取图片中的全部文字，按原排版输出，只输出文字本身。';
          const text = await deepseek.completeText({
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            model: p.visionModel,
            messages: [deepseek.imageMessage(prompt, downscaleDataURL(payload.dataURL, 2048))],
            think: false, // OCR 只要结果，不要思考
          });
          return { text: deepseek.stripThink(text) };
        } catch (e) {
          return { text: '', error: e.message };
        }
      }
      // 当前提供方不支持看图（如纯 DeepSeek）→ 落到本地引擎兜底
    }
    // 本地引擎：tesseract.js（已配 langPath + 缓存预填指向打包内 tessdata，离线读取，不联网）
    try {
      const text = await ocr.recognize(payload.dataURL, lang);
      return { text };
    } catch (e) {
      return { text: '', error: e.message };
    }
  });

  ipcMain.handle(C.OCR_BOXES, async (_e, payload) => {
      try {
        const m = require('./ocr-boxes');
        return await m.runOCRBoxes(payload && payload.dataURL);
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle(C.TRANSLATE_TEXT, async (_e, payload) => {
      try {
        const lines = (payload && payload.lines) || [];
        const target = (payload && payload.target) || '中文';
        if (!lines.length) return { lines: [] };
        const p = aiProvider(false);
        if (!p.apiKey) return { error: '未配置 API Key（请在设置里填 DeepSeek Key）' };
        const numbered = lines.map((t, i) => (i + 1) + '. ' + String(t).replace(/\n/g, ' ')).join('\n');
        const sys = '你是翻译引擎。把带编号的每一行翻译成' + target + '。严格只输出一个 JSON 数组，每个元素形如 {"i":编号数字,"t":"译文"}，不要解释、不要 markdown、不要反引号。';
        const out = await deepseek.completeText({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.textModel,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }],
          think: false,
        });
        let txt = deepseek.stripThink(out || '').trim();
        txt = txt.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
        const a0 = txt.indexOf('['), b0 = txt.lastIndexOf(']');
        if (a0 >= 0 && b0 > a0) txt = txt.slice(a0, b0 + 1);
        let arr = [];
        try { arr = JSON.parse(txt); } catch (_) { arr = []; }
        const map = {};
        if (Array.isArray(arr)) arr.forEach((it) => { if (it && it.i != null) map[Number(it.i)] = it.t == null ? '' : String(it.t); });
        // 模型完全没按 JSON 输出 / 一行都没对上 → 报错而非把全部原文当译文返回，
        // 否则 overlay 会把原文当译文盖回并永久烤进保存/复制的导出图（用户以为翻译成功）。
        if (!Object.keys(map).length) return { error: '翻译结果解析失败（模型未按要求输出 JSON），请重试。' };
        // 未命中编号的行返回 null（而非用原文冒充译文）：这样 overlay 会跳过该行、保留原文可见，
        // 也不会把「看似翻译实则原文」的格子烤进保存/复制的导出图，避免用户误以为已翻译。
        const result = lines.map((t, i) => (map[i + 1] != null ? map[i + 1] : null));
        return { lines: result };
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle(C.DEEPSEEK_ASK_IMAGE, async (e, { dataURL, prompt, streamId, think }) => {
    const p = aiProvider(true); // 图片任务：auto 模式下走 MiniMax 看图
    const sender = e.sender;
    const send = (ev) => {
      if (!sender.isDestroyed()) sender.send(C.DEEPSEEK_STREAM, { streamId, ...ev });
    };
    // 支持视觉的提供方（MiniMax-M3）：把图片直接发给模型「看」
    if (p.vision) {
      await streamWithAbort(streamId, sender, {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.visionModel,
        messages: [deepseek.imageMessage(prompt || '请分析这张截图的内容。', downscaleDataURL(dataURL, 2048))],
        think,
      }, send);
      return { ok: true };
    }
    // 纯文本提供方（DeepSeek 不支持图片）：先本地 OCR 抠字，再把文字发给文本模型
    // 「智能分流」想看图却没配 MiniMax Key 而被降级时，先告知用户，避免「为何识别变差」的困惑。
    if (p.downgraded) {
      send({
        delta:
          '（提示：当前为「智能分流」但未配置 MiniMax Key，本次看图已降级为 DeepSeek + 本地 OCR，识别精度可能下降。可到「设置 → AI 模型」填入 MiniMax Key 以直接看图。）\n\n',
      });
    }
    let text = '';
    try {
      // 本地 OCR 前也降采样：极大图会拖慢 tesseract 且无精度收益
      text = await ocr.recognize(downscaleDataURL(dataURL, 4096), config.get().ocr.lang);
    } catch (err) {
      send({ error: '本地 OCR 失败：' + (err && err.message ? err.message : err) });
      return { ok: false };
    }
    if (!text || !text.trim()) {
      send({
        delta:
          '（没在图片里识别到文字。当前 AI 提供方不支持看图——可到「设置 → AI 模型」切换到 MiniMax 直接看图，或框选含文字的区域再试。）',
      });
      send({ done: true });
      return { ok: true };
    }
    const userContent = (prompt || '请处理下面的内容：') + '\n\n【截图中识别到的文字】\n' + text;
    await streamWithAbort(streamId, sender, {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.textModel,
      messages: [{ role: 'user', content: userContent }],
      think,
    }, send);
    return { ok: true };
  });

  ipcMain.handle(C.DEEPSEEK_CHAT, async (e, { messages, streamId, model, think }) => {
    const p = aiProvider(false); // 纯文本任务：auto 模式下走 DeepSeek 省钱
    const sender = e.sender;
    const send = (ev) => {
      if (!sender.isDestroyed()) sender.send(C.DEEPSEEK_STREAM, { streamId, ...ev });
    };
    await streamWithAbort(streamId, sender, {
      baseUrl: p.baseUrl, apiKey: p.apiKey, model: model || p.textModel, messages, think,
    }, send);
    return { ok: true };
  });

  // 主动取消一条进行中的流（渲染层切流 / 离开 AI 页时调用）。
  ipcMain.handle(C.DEEPSEEK_CANCEL, (_e, streamId) => {
    const ac = streamId && streamAborts.get(streamId);
    if (ac) ac.abort();
    return { ok: true };
  });

  // which: 'deepseek' | 'minimax' | 'openai'（指定测哪一家，与当前生效模式解耦）。缺省按文本路由。
  ipcMain.handle(C.DEEPSEEK_TEST, async (_e, which) => {
    const cfg = config.get();
    let p;
    if (which === 'minimax') {
      const m = cfg.minimax || {};
      p = { name: 'minimax', baseUrl: m.baseUrl, apiKey: m.apiKey, textModel: m.textModel || m.visionModel };
    } else if (which === 'deepseek') {
      const d = cfg.deepseek || {};
      p = { name: 'deepseek', baseUrl: d.baseUrl, apiKey: d.apiKey, textModel: d.textModel };
    } else if (which === 'openai') {
      const o = cfg.openai || {};
      p = { name: 'openai', baseUrl: o.baseUrl, apiKey: o.apiKey, textModel: o.model };
    } else {
      p = aiProvider(false); // 兼容旧的无参调用
    }
    try {
      const text = await deepseek.completeText({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.textModel,
        messages: [{ role: 'user', content: '只回复两个字：你好' }],
      });
      return { ok: true, message: '[' + p.name + '] ' + (text || '(空响应)') };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // 在线拉取模型清单（GET {baseUrl}/models）。设置页「刷新模型列表」用。
  // H2 配套：渲染层拿不到明文 Key（只有掩码），payload.apiKey 为空时按 baseUrl 匹配主进程里存储的真实 Key。
  ipcMain.handle(C.AI_FETCH_MODELS, async (_e, { baseUrl, apiKey } = {}) => {
    try {
      let url = String(baseUrl || '');
      let key = typeof apiKey === 'string' ? apiKey : '';
      if (!key) {
        const norm = url.replace(/\/+$/, '');
        const cfg = config.get();
        const hit = [cfg.openai, cfg.deepseek, cfg.minimax].find(
          (p) => p && p.baseUrl && String(p.baseUrl).replace(/\/+$/, '') === norm
        );
        if (hit) {
          key = hit.apiKey || '';
          if (!url) url = hit.baseUrl || '';
        }
      }
      const models = await deepseek.fetchModels({ baseUrl: url, apiKey: key });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // 划词翻译卡片：关闭（卡片里点 ✕ 或按 Esc 时调用）。
  ipcMain.handle(C.TRANSLATE_POPUP_CLOSE, () => {
    windows.closeTranslatePopup();
    return { ok: true };
  });

  ipcMain.handle(C.RECORD_SAVE, async (_e, { buffer, mime, toGif, fps }) => {
    // P1-4(B13)：限制录屏数据大小，防止超长录制或异常 payload 打满内存/磁盘。
    const byteLen = buffer ? (buffer.byteLength != null ? buffer.byteLength : buffer.length) : 0;
    const MAX_REC_BYTES = 2 * 1024 * 1024 * 1024; // 2GB 上限（约 12fps webm 数小时的量级，正常录屏远达不到）
    if (!(byteLen > 0) || byteLen > MAX_REC_BYTES) {
      return { saved: false, error: '录制数据为空或超过 2GB 上限，无法保存。' };
    }
    const cfg = config.get();
    const tmp = media.writeTempRecording(buffer, 'webm');
    const wantGif = toGif !== undefined ? toGif : cfg.recording.toGif;
    const dir = cfg.general.saveDir || app.getPath('videos') || app.getPath('downloads');
    const ext = wantGif ? 'gif' : 'webm';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存录屏',
      defaultPath: path.join(dir, `困困录屏-${Date.now()}.${ext}`),
      filters: wantGif
        ? [{ name: 'GIF 动图', extensions: ['gif'] }]
        : [{ name: 'WebM 视频', extensions: ['webm'] }],
    });
    if (canceled || !filePath) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { saved: false };
    }
    try {
      if (wantGif) {
        await media.convertToGif(tmp, filePath, fps || cfg.recording.fps);
      } else {
        fs.copyFileSync(tmp, filePath);
      }
      return { saved: true, path: filePath };
    } catch (err) {
      dialog.showErrorBox('保存录屏失败', err.message);
      return { saved: false, error: err.message };
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  // ---- 主窗口 / 菜单栏弹窗 ----
  // 外链打开：只放行 http(s)，其它协议一律拒绝（防 file:// 等被利用）
  ipcMain.handle(C.OPEN_EXTERNAL, (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return true;
  });

  ipcMain.handle(C.OPEN_MAIN, (_e, page) => {
    windows.hidePopover();
    windows.createMain(page);
  });
  ipcMain.handle(C.POPOVER_TOGGLE, () => {
    if (tray) windows.togglePopover(tray.getBounds());
  });
  ipcMain.handle(C.POPOVER_HIDE, () => windows.hidePopover());

  // ---- 新捕获模式 ----
  ipcMain.handle(C.CAPTURE_FULLSCREEN_NOW, async () => {
    try {
      const item = await doFullscreenNow();
      return { ok: true, item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle(C.CAPTURE_WINDOW, () => doWindowCapture());
  ipcMain.handle(C.CAPTURE_TIMED, (_e, payload) => {
    const delay = Math.min(300, Math.max(0, ((payload && payload.delay) || 0))) * 1000; // P3-2：上限 300s，防 setTimeout 溢出
    const mode = (payload && payload.mode) || 'region';
    setTimeout(() => {
      if (mode === 'fullscreen') {
        grabDisplay()
          .then((g) => {
            clipboard.writeImage(nativeImage.createFromDataURL(g.dataURL));
            autoSaveToHistory(g.dataURL, 'timed');
          })
          .catch((err) => {
            // P3-4：不再静默吞错
            console.error('[timed-capture] 失败：', err && err.message ? err.message : err);
            dialog.showErrorBox('定时截图失败', (err && err.message) || String(err));
          });
      } else {
        startCapture('region');
      }
    }, delay);
    return { ok: true };
  });

  // ---- 历史记录 ----
  ipcMain.handle(C.HISTORY_LIST, () => history.list());
  ipcMain.handle(C.HISTORY_GET, (_e, id) => history.get(id));
  ipcMain.handle(C.HISTORY_DELETE, (_e, id) => {
    const ok = history.remove(id);
    windows.broadcast(C.HISTORY_CHANGED);
    return ok;
  });
  ipcMain.handle(C.HISTORY_DELETE_MANY, (_e, ids) => {
    const n = history.removeMany(ids);
    if (n) windows.broadcast(C.HISTORY_CHANGED); // 批量删除只广播一次，避免刷新风暴
    return { deleted: n };
  });
  ipcMain.handle(C.HISTORY_CLEAR, () => {
    history.clear();
    windows.broadcast(C.HISTORY_CHANGED);
    return true;
  });
  ipcMain.handle(C.HISTORY_EXPORT, async (_e, id) => {
    const got = history.get(id);
    if (!got) return { saved: false };
    return saveImageWithDialog(got.dataURL, `困困截图-${Date.now()}.png`);
  });
  // 批量导出：只弹一次目录选择框，把所有选中图片写进该目录（避免逐张弹保存框）。
  ipcMain.handle(C.HISTORY_EXPORT_MANY, async (_e, ids) => {
    if (!Array.isArray(ids) || !ids.length) return { saved: false, count: 0 };
    const cfg = config.get();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择导出目录（批量导出 ' + ids.length + ' 张）',
      defaultPath: cfg.general.saveDir || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { saved: false, count: 0 };
    const dir = filePaths[0];
    let count = 0;
    for (const id of ids) {
      try {
        const got = history.get(id);
        if (got && got.dataURL) { media.saveImageFile(got.dataURL, path.join(dir, `困困截图-${id}.png`)); count++; }
      } catch (err) { console.error('[history] 批量导出单张失败', id, err); }
    }
    return { saved: count > 0, count, dir };
  });
}

function boundsToDisplay(displayId) {
  const d =
    screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) ||
    screen.getPrimaryDisplay();
  return { bounds: d.bounds, scaleFactor: d.scaleFactor || 1 };
}

// ---------- 全局快捷键 ----------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const sc = config.get().shortcuts;
  const bind = (accel, fn) => {
    if (!accel) return;
    try {
      // register 在快捷键被系统 / 其他 app 占用时不抛异常、而是返回 false，
      // 会出现「设了快捷键但全程无效」却毫无感知。这里检查返回值并告警。
      const ok = globalShortcut.register(accel, fn);
      if (!ok) console.warn('[shortcut] 注册无效（可能已被系统或其他应用占用）:', accel);
    } catch (e) {
      console.error('[shortcut] 注册失败', accel, e.message);
    }
  };
  bind(sc.capture, () => startCapture('region'));
  bind(sc.ocr, () => startCapture('ocr'));
  bind(sc.longShot, () => startCapture('long'));
  bind(sc.record, () => startCapture('record'));
  bind(sc.pinClipboard, () => pinFromClipboard());
  if (process.platform === 'darwin') {
    bind(sc.translate, () => { triggerGlobalTranslate().catch(() => {}); });
  }
}

function applyLoginItem() {
  const want = !!config.get().general.launchAtLogin;
  try {
    const cur = app.getLoginItemSettings().openAtLogin;
    if (cur !== want) app.setLoginItemSettings({ openAtLogin: want });
  } catch (_) {}
}

// ---------- 托盘 ----------
function buildTray() {
  let icon = nativeImage.createEmpty();
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) icon = img.resize({ width: 18, height: 18 });
  }
  tray = new Tray(icon);
  if (icon.isEmpty()) tray.setTitle('📸');
  tray.setToolTip('困困截屏助手');
  // 左键：切换菜单栏弹窗
  tray.on('click', () => windows.togglePopover(tray.getBounds()));
  // 右键：原生菜单兜底
  tray.on('right-click', () => {
    const sc = config.get().shortcuts;
    const menu = Menu.buildFromTemplate([
      { label: '打开主应用', click: () => windows.createMain() },
      { type: 'separator' },
      { label: '区域截图', accelerator: sc.capture, click: () => startCapture('region') },
      { label: '全屏截图', click: () => { doFullscreenNow().catch(() => {}); } },
      { label: '窗口截图', click: () => { doWindowCapture(); } },
      { label: '截图 OCR', accelerator: sc.ocr, click: () => startCapture('ocr') },
      { label: '长截图', accelerator: sc.longShot, click: () => startCapture('long') },
      { label: '区域录屏', accelerator: sc.record, click: () => startCapture('record') },
      { label: '把剪贴板图片贴到屏幕', accelerator: sc.pinClipboard, click: () => pinFromClipboard() },
      ...(process.platform === 'darwin'
        ? [{ label: '划词翻译（选中文字后）', accelerator: sc.translate, click: () => { triggerGlobalTranslate().catch(() => {}); } }]
        : []),
      { type: 'separator' },
      { label: '设置…', click: () => windows.createMain('settings') },
      { label: '打开数据文件夹（历史/配置）', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: '退出困困截屏助手', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 再次启动（双击已在运行的 app）→ 打开/聚焦设置页，给出可见反馈
  app.on('second-instance', () => windows.openSettings());

  app.whenReady().then(() => {
    config.get();
    // 注册 kkthumb://img/<id> 协议：把请求映射到磁盘上的历史缩略图文件，供历史/首页画廊按需加载。
    // 只读、只服务 history 目录内的缩略图，路径由 history.thumbPathOf 校验，不接受任意路径注入。
    protocol.handle('kkthumb', async (req) => {
      try {
        const u = new URL(req.url); // kkthumb://img/<id>?t=...
        const id = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
        const p = id ? history.thumbPathOf(id) : null;
        if (!p) return new Response('not found', { status: 404 });
        // 用 pathToFileURL 生成 file URL（官方推荐）：正确处理含中文/空格/特殊字符的路径，
        // 本项目路径本身就含中文，手写 'file://'+path 会编码错误。
        return net.fetch(pathToFileURL(p).toString());
      } catch (_) {
        return new Response('bad request', { status: 400 });
      }
    });
    // 安全：统一拦截所有窗口的「新窗口打开」与「页内导航」——外链走系统浏览器，禁止导航到非本地(file://)页面，
    // 即使渲染层被注入也无法把窗口导到外部 URL。须在创建任何窗口前注册。
    // P1-1(M4) 收紧：file:// 也只允许导航到应用自身渲染层目录（防被注入后把窗口导到本机任意本地文件渲染）。
    const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
    const ALLOWED_FILE_PREFIX = pathToFileURL(RENDERER_ROOT + path.sep).toString();
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      });
      contents.on('will-navigate', (ev, url) => {
        const okLocal = url.startsWith('file:') && url.startsWith(ALLOWED_FILE_PREFIX);
        if (!okLocal) {
          ev.preventDefault();
          if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
        }
      });
    });
    if (process.platform === 'darwin' && app.dock) {
      try {
        const _ic = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
        if (!_ic.isEmpty()) app.dock.setIcon(_ic);
      } catch (_) {}
    }
    registerIpc();
    buildTray();
    registerShortcuts();
    applyLoginItem();
    // 启动即打开桌面主窗口（快捷截图首页）。
    // （KK_SMOKE 自检模式下由自检流程自行开窗，这里跳过避免重复）
    if (!process.env.KK_SMOKE) windows.createMain('capture');

    // macOS：屏幕录制权限——启动只做无打扰检测；真正未授权时，用户触发截图会在 startCapture 弹原生引导
    if (process.platform === 'darwin' && !process.env.KK_SMOKE) {
      if (!checkScreenPermission(false)) {
        console.warn('[权限] 屏幕录制未授权，触发截图时会弹出引导对话框。');
      }
    }

    // 冒烟自检：仅在 KK_SMOKE 环境变量下激活，加载设置窗并收集渲染层错误后自动退出。
    if (process.env.KK_SMOKE) {
      const problems = [];
      app.on('web-contents-created', (_e, wc) => {
        wc.on('console-message', (...args) => {
          const d = args[1] && typeof args[1] === 'object'
            ? args[1]
            : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
          const lvl = d.level;
          if (lvl === 'error' || lvl === 3) problems.push(`[console.error] ${d.message} @${d.sourceId || ''}:${d.lineNumber || ''}`);
        });
        wc.on('did-fail-load', (_ev, code, desc, url) => problems.push(`[did-fail-load] ${code} ${desc} ${url}`));
        wc.on('render-process-gone', (_ev, details) => problems.push(`[render-gone] ${JSON.stringify(details)}`));
        wc.on('preload-error', (_ev, p, err) => problems.push(`[preload-error] ${p} ${err && err.message}`));
      });
      const tinyPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const d = screen.getPrimaryDisplay();
      const syntheticRect = { x: 100, y: 100, width: 300, height: 200 };
      windows.createMain('capture');
      if (tray) windows.togglePopover(tray.getBounds());
      windows.openSettings();
      windows.openAIPanel({ mode: 'translate', text: 'smoke-test' });
      windows.createOverlay(d, {
        dataURL: tinyPng,
        scaleFactor: d.scaleFactor || 1,
        displayId: d.id,
        width: d.size.width,
        height: d.size.height,
        mode: 'region',
      });
      windows.createRecorder({
        rect: syntheticRect,
        displayBounds: d.bounds,
        scaleFactor: d.scaleFactor || 1,
        displayId: d.id,
        fps: 12,
        toGif: true,
      });
      windows.createLongShot({
        rect: syntheticRect,
        displayBounds: d.bounds,
        scaleFactor: d.scaleFactor || 1,
        displayId: d.id,
      });
      // 划词翻译卡片：验证新窗口能加载 + 首帧数据渲染无错
      {
        const tpWin = windows.createTranslatePopup({ x: 200, y: 200 });
        tpWin.webContents.once('did-finish-load', () => {
          const w = windows.getTranslatePopup();
          if (w && !w.isDestroyed()) {
            w.webContents.send(C.TRANSLATE_POPUP_DATA, { text: 'hello world', target: '中文', loading: true });
            w.webContents.send(C.TRANSLATE_POPUP_DATA, { text: 'hello world', target: '中文', translation: '你好，世界' });
          }
        });
      }
      // 探针：验证 kkthumb:// 协议能取到真实缩略图字节（历史缩略图按需加载链路自检）。
      (async () => {
        try {
          const items = history.list();
          if (items.length && items[0].thumb && items[0].thumb.startsWith('kkthumb:')) {
            const resp = await net.fetch(items[0].thumb);
            const buf = Buffer.from(await resp.arrayBuffer());
            const okPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50; // PNG 魔数 \x89P
            if (!resp.ok || !okPng) problems.push(`[kkthumb] fetch status=${resp.status} bytes=${buf.length} png=${okPng}`);
            else console.log(`KK_SMOKE_THUMB ok bytes=${buf.length} url=${items[0].thumb}`);
          } else {
            console.log('KK_SMOKE_THUMB skip（无历史缩略图可测）');
          }
        } catch (e) {
          problems.push('[kkthumb] probe error ' + (e && e.message));
        }
      })();
      setTimeout(() => {
        console.log('KK_SMOKE_RESULT ' + JSON.stringify({ ok: problems.length === 0, problems }));
        app.exit(0);
      }, 3500);
    }
  });

  // 托盘应用：关掉所有窗口也不退出
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });

  // 点击程序坞图标 → 打开/聚焦桌面主窗口
  app.on('activate', () => {
    windows.createMain();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    windows.closeAll();
  });
}
