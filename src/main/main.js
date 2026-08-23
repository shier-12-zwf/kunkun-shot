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
const tempFiles = require('./temp-files');
const pasteboardPreserver = require('./pasteboard-preserver');
const {
  requireImageDataURL,
  normalizeCaptureRect,
  normalizePinBounds,
  normalizeWindowResize,
  normalizeWindowMove,
  normalizeTranslationRequest,
  normalizeStreamId,
  normalizeChatRequest,
  normalizeProviderBaseUrl,
  normalizeConfigPatch,
  normalizePinStateFlags,
  normalizeProviderTestTarget,
  normalizeRecordingPayload,
} = require('./ipc-validation');
const { spawn } = require('child_process');
const axprobe = require('./axprobe');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');

// 自定义协议 kkthumb://<id> 专供历史缩略图：让渲染层 <img> 按需加载磁盘缩略图文件，
// 而非把每张 base64 内联进 DOM（历史攒到成百上千条时内联会导致主进程同步读盘 + 跨进程序列化 +
// 渲染层常驻大量大字符串）。须在 app ready 前声明为特权 scheme（standard + secure），
// 否则 file:// 页面因同源策略无法加载它。
protocol.registerSchemesAsPrivileged([
  { scheme: 'kkthumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 自动化/冒烟测试必须与真实用户配置、历史和 API Key 完全隔离。该环境变量只由本地测试脚本设置，
// 并且要在任何模块首次调用 app.getPath('userData') 前生效。
let ownedSmokeUserData = null;
if (process.env.KK_TEST_USER_DATA_DIR || process.env.KK_SMOKE) {
  const isolatedUserData = process.env.KK_TEST_USER_DATA_DIR
    ? path.resolve(process.env.KK_TEST_USER_DATA_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kkshot-smoke-'));
  if (!process.env.KK_TEST_USER_DATA_DIR) ownedSmokeUserData = isolatedUserData;
  fs.mkdirSync(isolatedUserData, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(isolatedUserData, 0o700); } catch (_) {}
  app.setPath('userData', isolatedUserData);
}

// 进行中的流式请求：streamId -> AbortController，供「主动取消」与「窗口销毁自动中止」使用。
const streamAborts = new Map();

// 包装一次流式请求：登记 AbortController，发起方窗口销毁时自动中止，结束后清理登记。
async function streamWithAbort(streamId, sender, opts, send) {
  const ac = new AbortController();
  const streamKey = streamId ? `${sender.id}:${streamId}` : null;
  if (streamKey) {
    const previous = streamAborts.get(streamKey);
    if (previous && previous.controller) previous.controller.abort();
    streamAborts.set(streamKey, { controller: ac, senderId: sender.id });
  }
  const onGone = () => ac.abort();
  try { sender.once('destroyed', onGone); } catch (_) {}
  try {
    await deepseek.streamChat({ ...opts, signal: ac.signal }, send);
  } finally {
    const current = streamKey && streamAborts.get(streamKey);
    if (current && current.controller === ac) streamAborts.delete(streamKey);
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
    if (item) windows.broadcast(C.HISTORY_CHANGED);
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

// 通用 OpenAI 兼容服务商是纯文本 provider。看图任务仍可选择它：图片只在本地 OCR，
// 随后把识别文字发给这个已选端点；绝不能因它不支持图片而改投残留的 DeepSeek 配置。
function openaiTextProvider(cfg, routeMode) {
  return requireConfiguredProvider(cfg || config.get(), 'openai', routeMode || 'explicit');
}

const AI_PROVIDER_LABELS = {
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  openai: 'OpenAI 兼容服务商',
};

function requireConfiguredProvider(cfg, name, routeMode) {
  const source = (cfg && cfg[name]) || {};
  let provider;
  if (name === 'minimax') {
    provider = {
      name,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      textModel: source.textModel || source.visionModel,
      visionModel: source.visionModel || source.textModel,
      vision: true,
    };
  } else if (name === 'openai') {
    provider = {
      name,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      textModel: source.model,
      visionModel: source.model,
      vision: false,
    };
  } else {
    provider = {
      name: 'deepseek',
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      textModel: source.textModel,
      visionModel: source.visionModel,
      vision: false,
    };
  }

  const missing = [];
  if (!provider.apiKey) missing.push('API Key');
  if (!provider.baseUrl) missing.push('Base URL');
  if (!provider.textModel) missing.push('文本模型');
  if (provider.vision && !provider.visionModel) missing.push('视觉模型');
  if (missing.length) {
    const label = AI_PROVIDER_LABELS[name] || name;
    const prefix = routeMode === 'auto'
      ? `智能分流要求本次任务使用 ${label}`
      : `当前已选择 ${label}`;
    throw new Error(`${prefix}，但未配置${missing.join('、')}；请求已停止，不会回退到其他服务商。`);
  }
  return provider;
}

// 路由是用户选择的确定性映射，不以“哪家还残留着 Key”作为条件：
//   deepseek = 所有任务都留在 DeepSeek；图片先本地 OCR
//   minimax  = 所有任务都留在 MiniMax；图片可直接发送
//   openai   = 所有任务都留在所选 OpenAI 兼容端点；图片先本地 OCR
//   auto     = 纯文本固定走 DeepSeek，图片固定走 MiniMax
function chooseTextProvider(cfg) {
  const mode = (cfg.ai && cfg.ai.provider) || 'deepseek';
  if (mode === 'auto') return requireConfiguredProvider(cfg, 'deepseek', 'auto');
  if (mode === 'openai') return openaiTextProvider(cfg, 'explicit');
  if (mode === 'deepseek' || mode === 'minimax') {
    return requireConfiguredProvider(cfg, mode, 'explicit');
  }
  throw new Error('AI 提供方配置无效，请在设置中重新选择。');
}

function chooseVisionProvider(cfg) {
  const mode = (cfg.ai && cfg.ai.provider) || 'deepseek';
  if (mode === 'auto') return requireConfiguredProvider(cfg, 'minimax', 'auto');
  if (mode === 'openai') return openaiTextProvider(cfg, 'explicit');
  if (mode === 'deepseek' || mode === 'minimax') {
    return requireConfiguredProvider(cfg, mode, 'explicit');
  }
  throw new Error('AI 提供方配置无效，请在设置中重新选择。');
}

function aiProvider(needVision) {
  const cfg = config.get();
  return needVision ? chooseVisionProvider(cfg) : chooseTextProvider(cfg);
}

let tray = null;

// Renderer 按窗口职责分权：即使某个本地页面因将来的 XSS/依赖漏洞被注入，也只能调用
// 自己正常工作所需的能力。所有 invoke 通道必须显式列出；遗漏即在注册时失败，绝不默认放行。
const IPC_ROLE_ALLOWLIST = {
  [C.CONFIG_GET]: ['main', 'overlay', 'ai', 'popover', 'pin'],
  [C.CONFIG_SET]: ['main', 'popover', 'overlay'],

  [C.WINDOW_CLOSE_SELF]: ['ai', 'longshot', 'pin', 'recorder'],
  [C.WINDOW_MINIMIZE_SELF]: ['ai'],
  [C.WINDOW_RESIZE_SELF]: ['pin'],
  [C.WINDOW_MOVE_SELF]: ['pin'],
  [C.OPEN_SETTINGS]: ['ai'],
  [C.OPEN_AI_PANEL]: ['main', 'overlay', 'pin', 'popover'],

  [C.CAPTURE_TRIGGER]: ['main', 'popover'],
  [C.CAPTURE_REGION]: ['longshot'],
  [C.CAPTURE_GET_SOURCES]: ['recorder'],
  [C.OVERLAY_RESULT]: ['overlay'],
  [C.OVERLAY_CANCEL]: ['overlay', 'recorder'],

  [C.CLIPBOARD_WRITE_IMAGE]: ['main', 'longshot', 'pin'],
  [C.CLIPBOARD_WRITE_TEXT]: ['main', 'overlay', 'ai', 'pin', 'translate-popup'],
  [C.CLIPBOARD_READ_IMAGE]: [],
  [C.IMAGE_SAVE]: ['longshot', 'pin'],
  [C.CHOOSE_SAVE_DIR]: ['main'],

  [C.PIN_CREATE]: [],
  [C.PIN_SET_STATE]: ['pin'],
  [C.PIN_START_DRAG]: ['pin'],
  [C.OPEN_PATH]: ['pin'],

  [C.OCR_RUN]: ['main', 'overlay', 'ai'],
  [C.AX_AT_POINT]: ['overlay'],
  [C.OCR_BOXES]: ['overlay', 'pin'],
  [C.TRANSLATE_TEXT]: ['overlay'],

  [C.DEEPSEEK_ASK_IMAGE]: ['main', 'overlay', 'ai'],
  [C.DEEPSEEK_CHAT]: ['main', 'overlay', 'ai'],
  [C.DEEPSEEK_CANCEL]: ['main', 'overlay', 'ai'],
  [C.DEEPSEEK_TEST]: ['main'],
  [C.AI_FETCH_MODELS]: ['main'],

  [C.TRANSLATE_POPUP_CLOSE]: ['translate-popup'],
  [C.RECORD_SAVE]: ['recorder'],
  [C.OPEN_EXTERNAL]: ['overlay'],

  [C.OPEN_MAIN]: ['popover'],
  [C.POPOVER_TOGGLE]: [],
  [C.POPOVER_HIDE]: ['popover'],
  [C.CAPTURE_FULLSCREEN_NOW]: ['main', 'popover'],
  [C.CAPTURE_WINDOW]: ['main', 'popover'],
  [C.CAPTURE_TIMED]: ['main'],

  [C.HISTORY_LIST]: ['main', 'overlay', 'popover'],
  [C.HISTORY_GET]: ['main', 'overlay', 'popover'],
  [C.HISTORY_DELETE]: ['main'],
  [C.HISTORY_DELETE_MANY]: ['main'],
  [C.HISTORY_CLEAR]: ['main'],
  [C.HISTORY_EXPORT]: ['main'],
  [C.HISTORY_EXPORT_MANY]: ['main'],
};

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
  const point = screen.getCursorScreenPoint();
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const display = screen.getDisplayNearestPoint(point);
    const sf = display.scaleFactor || 1;
    const size = img.getSize();
    const w = Math.round(size.width / sf);
    const h = Math.round(size.height / sf);
    windows.createPin({
      dataURL: img.toDataURL(),
      bounds: { x: point.x, y: point.y, width: w, height: h },
    });
    return;
  }
  // Finder 复制文件时通常同时提供 public.file-url 和文本。必须先识别文件 URL，
  // 否则它会被上面的普通文本分支抢走，最终只生成一张路径文字贴图。
  try {
    const buf = clipboard.read('public.file-url');
    if (buf && buf.length) {
      const raw = String(buf.toString('utf8') || '').trim();
      const m = raw.match(/^([^\n\r]+)/);

      if (m) {
        const fp = fileURLToPath(m[1]);
        if (fp && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          windows.createPin({ file: fp, bounds: { x: point.x, y: point.y, width: 280, height: 120 } });
          return;
        }
      }
    }
  } catch (_) {}

  // P1-15：剪贴板没图/文件但有文字 → 文本或颜色贴图（PixPin 式贴图类型之二、三）
  const text = clipboard.readText();
  if (text && text.trim()) {
    const t = text.trim();
    const color = parseColorText(t);
    if (color) {
      windows.createPin({ color, bounds: { x: point.x, y: point.y, width: 160, height: 100 } });
      return;
    }
    windows.createPin({
      text: t,
      bounds: { x: point.x, y: point.y, width: 320, height: 120 },
    });
    return;
  }

  dialog.showMessageBox({ type: 'info', message: '剪贴板里没有图片、文字、颜色或文件', detail: '先复制一张图片、一段文字、一个颜色值或一个文件（Finder 里 Cmd+C），再使用此功能。' });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读取「当前选中的文字」：完整快照剪贴板→CAS 清空→模拟 Cmd+C→读回→CAS 逐格式还原。
// 若原生快照不可用则在清空前直接失败；若期间有其它复制写入，changeCount 不再匹配，
// 恢复会安全跳过，绝不以覆盖用户较新的剪贴板为代价还原旧内容。
// 返回选中的纯文本（可能为空）。
async function readSelectedText() {
  const session = await pasteboardPreserver.begin();
  if (!session) return ''; // 快照后剪贴板已被其它来源更新，本轮不再介入
  let temporaryChangeCount = session.changeCount; // 当前是本轮 CAS 清空产生的代际
  try {
    const ok = await pasteboardPreserver.simulateCopy();
    if (!ok) return '';
    // 系统把选中内容写进剪贴板有延迟，Swift 版也等 0.1~0.4s，这里等 180ms 再读
    await sleep(180);
    // 记录读回时的临时代际。finally 中由原生 helper 再比较一次；此后若用户或其它 App
    // 写入新内容，代际会变化，旧快照便不会覆盖它。
    temporaryChangeCount = await pasteboardPreserver.getChangeCount();
    let text = '';
    try { text = clipboard.readText() || ''; } catch (_) {}
    return text.trim();
  } finally {
    await pasteboardPreserver.restore(session, temporaryChangeCount);
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
        detail: '划词翻译要模拟一次「拷贝」来读取你选中的文字。\n请在「系统设置 → 隐私与安全性 → 辅助功能」里勾选「困困截图工具」，然后重试。',
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
    const message = (err && err.message) || String(err);
    console.error('[translate] 划词翻译启动失败：', message);
    dialog.showErrorBox('划词翻译失败', message);
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
    const tmp = tempFiles.createPrivateTempPath('kkshot-window', 'png');
    const p = spawn('screencapture', ['-w', '-x', '-o', tmp]);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      tempFiles.cleanupTempPath(tmp);
      resolve(result);
    };
    p.on('error', (e) => finish({ ok: false, error: e.message }));
    p.on('close', () => {
      try {
        if (!fs.existsSync(tmp)) return finish({ ok: false, error: '已取消' });
        const dataURL = 'data:image/png;base64,' + fs.readFileSync(tmp).toString('base64');
        clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
        const item = autoSaveToHistory(dataURL, 'window');
        finish({ ok: true, item });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    });
  });
}

// ---------- 大图降采样（P2-6/B8）：发送给视觉 API 前压缩，避免超限/烧 token ----------
function validatedNativeImage(imageDataURL) {
  requireImageDataURL(imageDataURL);
  const image = nativeImage.createFromDataURL(imageDataURL);
  const size = image.getSize();
  // 限制解码后的尺寸，避免小体积压缩炸弹在主进程分配超大位图。
  if (
    image.isEmpty() ||
    !(size.width > 0) ||
    !(size.height > 0) ||
    size.width > 32768 ||
    size.height > 32768 ||
    size.width * size.height > 150 * 1024 * 1024
  ) {
    throw new Error('图片内容无效或解码后尺寸过大。');
  }
  return image;
}

function normalizeHistoryId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^\d{10,20}-[a-f0-9]{6,64}$/i.test(value)) {
    throw new Error('历史记录标识无效。');
  }
  return value;
}

function normalizeHistoryIds(values) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error('历史记录列表无效或过长。');
  return [...new Set(values.map(normalizeHistoryId))];
}

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
  let tmp = null;
  try {
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      // 先写临时 PNG（原始质量），再用 ffmpeg 转目标格式
      tmp = tempFiles.createPrivateTempPath('kkshot-image', 'png');
      media.saveImageFile(dataURL, tmp);
      await media.convertImage(tmp, filePath, ext === '.webp' ? ['-quality', '86'] : ['-q:v', '3']);
    } else {
      media.saveImageFile(dataURL, filePath);
    }
    return { saved: true, path: filePath };
  } catch (err) {
    dialog.showErrorBox('保存图片失败', (err && err.message) || String(err));
    return { saved: false, error: (err && err.message) || String(err) };
  } finally {
    if (tmp) tempFiles.cleanupTempPath(tmp);
  }
}

// ---------- IPC ----------
function registerIpc() {
  // M1 修复：统一拦截所有 ipcMain.handle——只接受本应用窗口工厂创建的 webContents 发来的请求。
  // 被导航/注入的窗口、外部 webContents 一律拿不到任何能力（截图/剪贴板/配置/AI 请求等）。
  if (!ipcMain.__kkGuarded) {
    ipcMain.__kkGuarded = true;
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => {
      if (!Object.prototype.hasOwnProperty.call(IPC_ROLE_ALLOWLIST, channel)) {
        throw new Error(`IPC 通道缺少角色权限声明：${channel}`);
      }
      return origHandle(channel, (event, ...args) => {
        const allowedRoles = IPC_ROLE_ALLOWLIST[channel];
        if (!event || !event.sender || !windows.isTrustedSender(event.sender.id, allowedRoles)) {
          return undefined; // invoke 端收到 undefined，静默失败（不抛错、不给信息）
        }
        return listener(event, ...args);
      });
    };
  }

  ipcMain.handle(C.CONFIG_GET, () => config.publicView()); // H2：渲染层只拿掩码视图，Key 不出主进程
  ipcMain.handle(C.CONFIG_SET, (e, patch) => {
    const safePatch = normalizeConfigPatch(patch, windows.getTrustedRole(e.sender.id));
    const merged = config.set(safePatch);
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
  ipcMain.handle(C.WINDOW_RESIZE_SELF, (e, payload) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    const { width, height } = normalizeWindowResize(payload);
    const b = w.getBounds();
    const nw = width;
    const nh = height;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    w.setBounds({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), width: nw, height: nh });
    return { width: nw, height: nh }; // 回传实际应用尺寸（含 clamp），供贴图回算真实缩放，避免缩放迟滞
  });
  // 按增量移动当前窗口（贴图 JS 拖动用）
  ipcMain.handle(C.WINDOW_MOVE_SELF, (e, payload) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    const { dx, dy } = normalizeWindowMove(payload);
    const b = w.getBounds();
    w.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  });
  ipcMain.handle(C.OPEN_SETTINGS, () => windows.openSettings());
  ipcMain.handle(C.OPEN_AI_PANEL, (_e, payload) => windows.openAIPanel(payload));

  ipcMain.handle(C.CAPTURE_TRIGGER, (_e, mode) => {
    const safeMode = mode == null ? 'region' : mode;
    if (!['region', 'long', 'record', 'ocr'].includes(safeMode)) throw new Error('截图模式无效。');
    return startCapture(safeMode);
  });
  ipcMain.handle(C.CAPTURE_REGION, async (_e, payload) => {
    const { rect, displayId } = payload && typeof payload === 'object' ? payload : {};
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) ||
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const safeRect = normalizeCaptureRect(rect, display.size);
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
      x: Math.round(safeRect.x * sf),
      y: Math.round(safeRect.y * sf),
      width: Math.round(safeRect.width * sf),
      height: Math.round(safeRect.height * sf),
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
    try {
      const cfg = config.get();
      const allowedActions = new Set(['copy', 'save', 'quickSave', 'pin', 'ocr', 'ask', 'translate', 'record', 'long']);
      if (!allowedActions.has(action)) throw new Error('未知的截图操作。');
      const isLiveCapture = action === 'record' || action === 'long';
      let image = null;
      let safeBounds = null;
      let safeRect = null;
      let displayData = null;
      if (isLiveCapture) {
        displayData = boundsToDisplay(displayId);
        safeRect = normalizeCaptureRect(rect, displayData.size);
      } else {
        image = validatedNativeImage(imageDataURL);
        if (bounds != null) safeBounds = normalizePinBounds(bounds);
      }
      let savedToHistory = false; // save 动作是否已真正存盘并入历史，用于避免与下面自动入历史重复
      switch (action) {
        case 'copy':
          clipboard.writeImage(image);
          break;
        case 'save': {
          const r = await saveImageWithDialog(imageDataURL);
          if (!r || r.saved !== true) {
            return {
              ok: false,
              canceled: !r || !r.error,
              error: r && r.error ? r.error : undefined,
            };
          }
          saveToHistory(imageDataURL, 'region');
          savedToHistory = true;
          break;
        }
        case 'quickSave': {
          // 快速保存：免对话框直接存到保存目录，并弹系统通知。
          // 写盘失败抛给统一错误分支，不确认成功，overlay 会保留并可重试。
          const dir = cfg.general.saveDir || app.getPath('pictures');
          const file = path.join(dir, `困困截图-${Date.now()}.png`);
          media.saveImageFile(imageDataURL, file);
          saveToHistory(imageDataURL, 'region');
          savedToHistory = true;
          if (Notification.isSupported()) {
            new Notification({ title: '困困截图', body: '已快速保存：' + file }).show();
          }
          break;
        }
        case 'pin':
          windows.createPin({ dataURL: imageDataURL, bounds: safeBounds });
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
          const dd = displayData;
          windows.createRecorder({
            rect: safeRect,
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
          const dd = displayData;
          windows.createLongShot({
            rect: safeRect,
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
        clipboard.writeImage(image);
      }
      // 自动贴图：截完把图钉到屏幕原位。pin 动作本身即贴图、record/long 无静态图，均跳过。
      if (cfg.capture.autoPin && imageDataURL && safeBounds && action !== 'pin') {
        windows.createPin({ dataURL: imageDataURL, bounds: safeBounds });
      }
      // 自动入历史（仅当开启「自动保存历史」）。save 成功后已入库，跳过避免重复。
      if (imageDataURL && !(action === 'save' && savedToHistory)) {
        autoSaveToHistory(imageDataURL, action === 'pin' ? 'pin' : 'region');
      }
      return { ok: true };
    } catch (err) {
      // 不确认成功，renderer 会恢复可提交状态并保留选区/标注。
      console.error('[overlay-result] 处理失败:', action, err);
      const error = (err && err.message) || String(err);
      try { dialog.showErrorBox('截图处理失败', `「${action || '操作'}」处理时出错：\n${error}`); } catch (_) {}
      return { ok: false, error };
    }
  });

  ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE, (_e, dataURL) => {
    clipboard.writeImage(validatedNativeImage(dataURL));
    return true;
  });
  ipcMain.handle(C.CLIPBOARD_WRITE_TEXT, (_e, text) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('剪贴板文本无效或过长。');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(C.CLIPBOARD_READ_IMAGE, () => {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : img.toDataURL();
  });
  ipcMain.handle(C.IMAGE_SAVE, async (_e, dataURL) => {
    validatedNativeImage(dataURL);
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

  ipcMain.handle(C.PIN_CREATE, (_e, payload) => {
    const { dataURL, bounds } = payload && typeof payload === 'object' ? payload : {};
    validatedNativeImage(dataURL);
    windows.createPin({ dataURL, bounds: normalizePinBounds(bounds) });
    return { ok: true };
  });
  // 贴图窗状态：置顶切换 / 鼠标穿透（作用调用方自己的窗口；主进程按 sender 定位）
  ipcMain.handle(C.PIN_SET_STATE, (e, flags) => {
    try {
      flags = normalizePinStateFlags(flags);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return { ok: false };
    try {
      if (typeof flags.onTop === 'boolean') {
        w.setAlwaysOnTop(flags.onTop, 'floating');
      }
      if (typeof flags.ignoreMouse === 'boolean') {
        w.setIgnoreMouseEvents(flags.ignoreMouse, { forward: true });
        if (flags.ignoreMouse) {
          passthroughPins.add(w.webContents.id);
          ensurePassthroughShortcut();
        } else {
          passthroughPins.delete(w.webContents.id);
          if (!passthroughPins.size) clearPassthroughShortcut();
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // P1-8：智能 UI 元素识别——查询屏幕坐标处元素（悬停节流探测用）
  let axPrompted = false;
  ipcMain.handle(C.AX_AT_POINT, async (_e, { x, y } = {}) => {
    if (process.platform !== 'darwin') return { error: '仅支持 macOS' };
    if (!checkAccessibilityPermission(!axPrompted)) {
      axPrompted = true;
      return { error: '需要「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）' };
    }
    if (!isFinite(Number(x)) || !isFinite(Number(y)) || Math.abs(Number(x)) > 100000 || Math.abs(Number(y)) > 100000) {
      return { error: '坐标无效' };
    }
    try {
      const r = await axprobe.probeAtPoint(Number(x), Number(y), 700);
      const f = r && r.frame;
      if (f && !(f.w > 0) && !(f.h > 0)) return { frame: null };
      return r;
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle(C.OCR_RUN, async (_e, payload) => {
    const dataURL = payload && payload.dataURL;
    validatedNativeImage(dataURL);
    const cfg = config.get();
    const lang = (payload && payload.lang) || cfg.ocr.lang;
    const engine = (payload && payload.engine) || (cfg.ocr && cfg.ocr.engine) || 'local';
    if (typeof lang !== 'string' || lang.length > 128 || !/^[a-z][a-z0-9_]*(?:\+[a-z][a-z0-9_]*){0,4}$/i.test(lang)) {
      throw new Error('OCR 语言代码无效。');
    }
    if (!['local', 'model'].includes(engine)) throw new Error('OCR 引擎无效。');
    // 大模型模式：严格使用当前选择所映射的视觉提供方；纯文本提供方只在本地 OCR，绝不改投别家。
    if (engine !== 'local') {
      const p = aiProvider(true);
      if (p.vision && p.apiKey) {
        try {
          const prompt = (cfg.deepseek && cfg.deepseek.ocrPrompt) || '请提取图片中的全部文字，按原排版输出，只输出文字本身。';
          const text = await deepseek.completeText({
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            model: p.visionModel,
            messages: [deepseek.imageMessage(prompt, downscaleDataURL(dataURL, 2048))],
            think: false, // OCR 只要结果，不要思考
          });
          return { text: deepseek.stripThink(text) };
        } catch (e) {
          return { text: '', error: e.message };
        }
      }
      // 当前已选提供方不支持看图（如 DeepSeek / OpenAI 兼容）→ 仅在本地完成 OCR。
    }
    // 本地引擎：tesseract.js（已配 langPath + 缓存预填指向打包内 tessdata，离线读取，不联网）
    try {
      const text = await ocr.recognize(dataURL, lang);
      return { text };
    } catch (e) {
      return { text: '', error: e.message };
    }
  });

  ipcMain.handle(C.OCR_BOXES, async (_e, payload) => {
      try {
        const dataURL = payload && payload.dataURL;
        validatedNativeImage(dataURL);
        const m = require('./ocr-boxes');
        return await m.runOCRBoxes(dataURL);
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle(C.TRANSLATE_TEXT, async (_e, payload) => {
      try {
        const { lines, target } = normalizeTranslationRequest(payload);
        if (!lines.length) return { lines: [] };
        const p = aiProvider(false);
        if (!p.apiKey) return { error: '当前 AI 提供方未配置 API Key。' };
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
    ipcMain.handle(C.DEEPSEEK_ASK_IMAGE, async (e, payload) => {
    const dataURL = payload && payload.dataURL;
    validatedNativeImage(dataURL);
    const prompt = payload && payload.prompt == null ? '' : payload.prompt;
    const streamId = normalizeStreamId(payload && payload.streamId);
    if (typeof prompt !== 'string' || prompt.length > 65536) throw new Error('AI 提示词无效或过长。');
    const think = !!(payload && payload.think);
    const p = aiProvider(true); // 图片任务：显式选择不变；auto 固定走 MiniMax
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
    // 已显式选择纯文本提供方（DeepSeek / OpenAI 兼容）：先本地 OCR，再只把文字发给同一提供方。
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

  ipcMain.handle(C.DEEPSEEK_CHAT, async (e, payload) => {
    const { messages, streamId, model, think } = normalizeChatRequest(payload);
    const p = aiProvider(false); // 纯文本任务：显式选择不变；auto 固定走 DeepSeek
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
  ipcMain.handle(C.DEEPSEEK_CANCEL, (e, streamId) => {
    try { streamId = normalizeStreamId(streamId); } catch (_) { return { ok: false }; }
    const entry = streamAborts.get(`${e.sender.id}:${streamId}`);
    if (entry) entry.controller.abort();
    return { ok: true };
  });

  // which: 'deepseek' | 'minimax' | 'openai'（指定测哪一家，与当前生效模式解耦）。缺省按文本路由。
  ipcMain.handle(C.DEEPSEEK_TEST, async (_e, which) => {
    try {
      which = normalizeProviderTestTarget(which);
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) };
    }
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
  ipcMain.handle(C.AI_FETCH_MODELS, async (_e, payload) => {
    try {
      const { baseUrl, apiKey } = payload && typeof payload === 'object' ? payload : {};
      let url = normalizeProviderBaseUrl(baseUrl);
      let key = typeof apiKey === 'string' ? apiKey : '';
      if (key.length > 16384) throw new Error('API Key 过长。');
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

  ipcMain.handle(C.RECORD_SAVE, async (_e, payload) => {
    let normalized;
    try {
      normalized = normalizeRecordingPayload(payload);
    } catch (err) {
      return { saved: false, error: (err && err.message) || String(err) };
    }
    const { buffer, toGif, fps: safeFps, trimStart: ss, trimEnd: te } = normalized;
    // P2-4 剪辑：起止秒（0=不裁）
    const trimArgs = [];
    if (ss > 0) trimArgs.push('-ss', String(ss));
    if (te > 0 && te > ss) trimArgs.push('-t', String(te - ss));
    const cfg = config.get();
    const tmp = media.writeTempRecording(buffer, 'webm');
    try {
      const wantGif = toGif !== undefined ? !!toGif : !!cfg.recording.toGif;
      const dir = cfg.general.saveDir || app.getPath('videos') || app.getPath('downloads');
      const ext = wantGif ? 'gif' : 'webm';
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存录屏',
        defaultPath: path.join(dir, `困困录屏-${Date.now()}.${ext}`),
        filters: wantGif
          ? [{ name: 'GIF 动图', extensions: ['gif'] }]
          : [
              { name: 'WebM 视频', extensions: ['webm'] },
              { name: 'MP4 视频（H.264，兼容性更好）', extensions: ['mp4'] },
            ],
      });
      if (canceled || !filePath) return { saved: false };
      try {
        if (wantGif) {
          await media.convertToGif(tmp, filePath, safeFps || cfg.recording.fps, trimArgs);
        } else if (path.extname(filePath || '').toLowerCase() === '.mp4') {
          await media.convertToMp4(tmp, filePath, trimArgs);
        } else if (trimArgs.length) {
          await media.convertImage(tmp, filePath, trimArgs.concat(['-c', 'copy']));
        } else {
          media.copyFileAtomic(tmp, filePath);
        }
        return { saved: true, path: filePath };
      } catch (err) {
        dialog.showErrorBox('保存录屏失败', err.message);
        return { saved: false, error: err.message };
      }
    } finally {
      tempFiles.cleanupTempPath(tmp);
    }
  });

  // ---- 主窗口 / 菜单栏弹窗 ----
  // 本地文件打开：请求路径必须正好等于该 sender 所属「文件贴图」的 payload。
  // 不接受渲染层自行提供的任意绝对路径，避免窗口被注入后借此打开本机文件或应用。
  ipcMain.handle(C.OPEN_PATH, (e, p) => {
    const payload = windows.getPinPayload(e.sender.id);
    if (!payload || typeof payload.file !== 'string' || typeof p !== 'string') return { ok: false };
    const allowed = path.resolve(payload.file);
    const requested = path.resolve(p);
    if (requested !== allowed || !path.isAbsolute(payload.file)) return { ok: false };
    try {
      if (!fs.statSync(allowed).isFile()) return { ok: false };
    } catch (_) {
      return { ok: false };
    }
    shell.openPath(allowed).catch(() => {});
    return { ok: true };
  });

  // 贴图拖出：把贴图内容写成临时文件，交给系统拖拽（拖进 Finder/微信/其它 App）
  ipcMain.handle(C.PIN_START_DRAG, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return { ok: false };
    const payload = windows.getPinPayload(e.sender.id) || {};
    try {
      let file = null;
      let temporary = false;
      let icon = nativeImage.createEmpty();
      if (payload.dataURL) {
        const dragImage = validatedNativeImage(payload.dataURL);
        file = tempFiles.writePrivateTempFile(media.dataURLToBuffer(payload.dataURL), 'kkshot-drag', 'png');
        temporary = true;
        icon = dragImage.resize({ width: 64, height: 64 });
      } else if (payload.text) {
        file = tempFiles.writePrivateTempFile(Buffer.from(payload.text, 'utf8'), 'kkshot-drag', 'txt');
        temporary = true;
      } else if (payload.color) {
        file = tempFiles.writePrivateTempFile(Buffer.from(payload.color, 'utf8'), 'kkshot-drag', 'txt');
        temporary = true;
      } else if (payload.file) {
        file = payload.file; // 文件贴图：直接拖原文件
      }
      if (file && fs.existsSync(file)) {
        if (temporary) tempFiles.scheduleCleanup(file, 5 * 60 * 1000);
        e.sender.startDrag({ file, icon });
      }
    } catch (err) {
      console.error('[pin-drag]', err);
    }
    return { ok: true };
  });

  // 外链打开：只放行 http(s)，其它协议一律拒绝（防 file:// 等被利用）
  ipcMain.handle(C.OPEN_EXTERNAL, (_e, url) => {
    if (typeof url !== 'string' || url.length > 4096) return { ok: false };
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return { ok: false };
      shell.openExternal(parsed.toString()).catch(() => {});
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
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
    const rawDelay = Number(payload && payload.delay);
    const delay = Math.min(300, Math.max(0, Number.isFinite(rawDelay) ? rawDelay : 0)) * 1000; // P3-2：上限 300s，防 setTimeout 溢出
    const mode = (payload && payload.mode) || 'region';
    if (!['region', 'fullscreen'].includes(mode)) throw new Error('定时截图模式无效。');
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
  ipcMain.handle(C.HISTORY_GET, (_e, id) => history.get(normalizeHistoryId(id)));
  ipcMain.handle(C.HISTORY_DELETE, (_e, id) => {
    const ok = history.remove(normalizeHistoryId(id));
    if (ok) windows.broadcast(C.HISTORY_CHANGED);
    return ok;
  });
  ipcMain.handle(C.HISTORY_DELETE_MANY, (_e, ids) => {
    const n = history.removeMany(normalizeHistoryIds(ids));
    if (n) windows.broadcast(C.HISTORY_CHANGED); // 批量删除只广播一次，避免刷新风暴
    return { deleted: n };
  });
  ipcMain.handle(C.HISTORY_CLEAR, () => {
    const ok = history.clear();
    if (ok) windows.broadcast(C.HISTORY_CHANGED);
    return ok;
  });
  ipcMain.handle(C.HISTORY_EXPORT, async (_e, id) => {
    const got = history.get(normalizeHistoryId(id));
    if (!got) return { saved: false };
    return saveImageWithDialog(got.dataURL, `困困截图-${Date.now()}.png`);
  });
  // 批量导出：只弹一次目录选择框，把所有选中图片写进该目录（避免逐张弹保存框）。
  ipcMain.handle(C.HISTORY_EXPORT_MANY, async (_e, ids) => {
    const safeIds = normalizeHistoryIds(ids);
    if (!safeIds.length) return { saved: false, count: 0 };
    const cfg = config.get();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择导出目录（批量导出 ' + safeIds.length + ' 张）',
      defaultPath: cfg.general.saveDir || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { saved: false, count: 0 };
    const dir = filePaths[0];
    let count = 0;
    for (const id of safeIds) {
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
  return { bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor || 1 };
}

// ---------- 贴图鼠标穿透兜底（穿透后窗口收不到键盘，用临时全局快捷键恢复）----------
let passthroughShortcut = false;
const passthroughPins = new Set();
function ensurePassthroughShortcut() {
  if (passthroughShortcut) return;
  try {
    passthroughShortcut = globalShortcut.register('CommandOrControl+Alt+P', () => {
      windows.pinSnapshots().forEach(({ win }) => {
        try {
          win.setIgnoreMouseEvents(false, { forward: true });
          win.webContents.send(C.PIN_CMD, { cmd: 'passthrough-off' });
        } catch (_) {}
      });
      passthroughPins.clear();
      clearPassthroughShortcut();
    });
  } catch (_) {}
}
function clearPassthroughShortcut() {
  if (!passthroughShortcut) return;
  try {
    globalShortcut.unregister('CommandOrControl+Alt+P');
  } catch (_) {}
  passthroughShortcut = false;
}

// 全部贴图保存为一个目录
async function pinSaveAll() {
  const snaps = windows.pinSnapshots();
  if (!snaps.length) return;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择目录保存全部贴图',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.get().general.saveDir || app.getPath('pictures'),
  });
  if (canceled || !filePaths[0]) return;
  const dir = filePaths[0];
  let n = 0;
  snaps.forEach(({ payload }, i) => {
    try {
      if (payload && payload.dataURL) {
        media.saveImageFile(payload.dataURL, path.join(dir, `贴图-${Date.now()}-${i}.png`));
        n++;
      } else if (payload && payload.text) {
        fs.writeFileSync(path.join(dir, `贴图文本-${Date.now()}-${i}.txt`), payload.text, 'utf-8');
        n++;
      } else if (payload && payload.color) {
        fs.writeFileSync(path.join(dir, `贴图颜色-${Date.now()}-${i}.txt`), payload.color, 'utf-8');
        n++;
      }
    } catch (err) {
      console.error('[pin-save-all]', err);
    }
  });
  if (Notification.isSupported()) {
    new Notification({ title: '困困截图', body: `已保存 ${n} 张贴图到 ${dir}` }).show();
  }
}

// 从剪贴板文本里识别颜色（#hex / rgb()），用于颜色贴图
function parseColorText(t) {
  const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    return '#' + (raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw).toUpperCase();
  }
  const rgb = t.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const h = (v) => Math.max(0, Math.min(255, +v)).toString(16).padStart(2, '0');
    return ('#' + h(rgb[1]) + h(rgb[2]) + h(rgb[3])).toUpperCase();
  }
  return null;
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
  bind(sc.pinRestore, () => {
    if (!windows.restoreLastPin()) {
      dialog.showMessageBox({ type: 'info', message: '没有可恢复的贴图', detail: '关闭过的贴图会保留最近 10 条，可用此快捷键恢复。' });
    }
  });
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
  tray.setToolTip('困困截图工具');
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
      { label: '把剪贴板图片/文字/颜色贴到屏幕', accelerator: sc.pinClipboard, click: () => pinFromClipboard() },
      { label: '恢复最近关闭的贴图', accelerator: sc.pinRestore, click: () => { if (!windows.restoreLastPin()) dialog.showMessageBox({ type: 'info', message: '没有可恢复的贴图' }); } },
      {
        label: '贴图管理（当前 ' + windows.pinCount() + ' 张）',
        submenu: [
          { label: '全部缩略图化', click: () => windows.pinAllThumbnail(true) },
          { label: '取消所有缩略图', click: () => windows.pinAllThumbnail(false) },
          { label: '全部保存为…', click: () => { pinSaveAll().catch(() => {}); } },
          { label: '全部关闭', click: () => windows.pinAllClose() },
          { label: '全部销毁（不进历史）', click: () => windows.pinAllDestroy() },
        ],
      },
      ...(process.platform === 'darwin'
        ? [{ label: '划词翻译（选中文字后）', accelerator: sc.translate, click: () => { triggerGlobalTranslate().catch(() => {}); } }]
        : []),
      { type: 'separator' },
      { label: '设置…', click: () => windows.createMain('settings') },
      { label: '打开数据文件夹（历史/配置）', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: '退出困困截图工具', click: () => app.quit() },
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
    // 冒烟自检不注册全局快捷键、不改开机启动项、也不创建菜单栏常驻图标。
    if (!process.env.KK_SMOKE) {
      buildTray();
      registerShortcuts();
      applyLoginItem();
    }
    // 启动即打开桌面主窗口（快捷截图首页）——可在设置里关闭（纯托盘驻留）。
    // （KK_SMOKE 自检模式下由自检流程自行开窗，这里跳过避免重复）
    if (!process.env.KK_SMOKE && config.get().general.openMainAtLaunch !== false) windows.createMain('capture');

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
    tempFiles.cleanupAll();
    if (ownedSmokeUserData) {
      const resolved = path.resolve(ownedSmokeUserData);
      if (path.basename(resolved).startsWith('kkshot-smoke-') && path.dirname(resolved) === path.resolve(os.tmpdir())) {
        try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) {}
      }
      ownedSmokeUserData = null;
    }
  });
}
