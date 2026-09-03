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
  session,
} = require('electron');

const C = require('../shared/channels');
const config = require('./config');
const deepseek = require('./deepseek');
const ocr = require('./ocr');
const { createAIRecognitionHandler } = require('./ai-recognition');
const media = require('./media');
const {
  exportImage,
  exportImagesToPdf,
  saveImageViaDialog,
  quickSaveImage,
  normalizeImageExportPreferences,
  preferredExtensionForFormat,
} = require('./image-export');
const {
  DEFAULT_SCREENSHOT_TEMPLATE,
  DEFAULT_RECORDING_TEMPLATE,
  buildFilename,
  nextAvailablePath,
} = require('./filename-template');
const { exportHistoryPdf } = require('./history-pdf-export');
const windows = require('./windows');
const history = require('./history');
const tempFiles = require('./temp-files');
const pasteboardPreserver = require('./pasteboard-preserver');
const {
  shouldAutoSaveOverlayHistory,
  historyTypeForImageSaveRole,
  persistRecordingHistory,
} = require('./history-semantics');
const {
  replaceShortcutBindings,
  applyConfigPatchTransaction,
} = require('./shortcut-transaction');
const { selectDisplaySource, serializeCaptureSources } = require('./capture-source-matcher');
const { createCaptureCoordinator } = require('./capture-coordinator');
const {
  ScreenPermissionError,
  isScreenPermissionError,
  readScreenPermissionStatus,
  requireScreenCaptureAttempt,
} = require('./screen-permission');
const { classifyWindowCaptureClose } = require('./window-capture-close');
const { normalizeOverlayResultEnvelope } = require('./overlay-result-contract');
const { createTimedCaptureScheduler } = require('./timed-capture-scheduler');
const { parseLaunchAction } = require('./launch-actions');
const { createLaunchActionRunner } = require('./launch-action-runner');
const { createPinWorkspaceStore } = require('./pin-workspace-store');
const { normalizePinContentUpdate } = require('../shared/pin-content-update');
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
  normalizeExternalHttpUrl,
  normalizeConfigPatch,
  normalizePinStateFlags,
  normalizePinImageReplacement,
  normalizePinGroupAction,
  normalizeFormulaPinPayload,
  normalizeProviderTestTarget,
  normalizeRecordingPayload,
  normalizeOCRLanguage,
} = require('./ipc-validation');
const { spawn } = require('child_process');
const axprobe = require('./axprobe');
const swiftcache = require('./swiftcache');
const { RECORD_ACTIONS_SOURCE } = require('./swift-helper-sources');
const {
  createRecordActionMonitor,
  createRecordActionOwnerRegistry,
} = require('./record-action-monitor');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { openValidatedExternalUrl } = require('./external-url');
const { installMediaPermissionPolicy } = require('./media-permission-policy');

const recordActionMonitor = createRecordActionMonitor({
  ensureBinary: () => swiftcache.ensureBinary({
    name: 'record-actions',
    source: RECORD_ACTIONS_SOURCE,
    language: 'c',
  }),
  spawnProcess: spawn,
  cursorPoint: () => screen.getCursorScreenPoint(),
});
const recordActionOwners = createRecordActionOwnerRegistry({
  stop: (ownerId) => recordActionMonitor.stop(ownerId),
});

async function openExternalHttpUrl(rawUrl) {
  return openValidatedExternalUrl(rawUrl, {
    normalizeUrl: normalizeExternalHttpUrl,
    openExternal: (url) => shell.openExternal(url),
    reportError: (error, url) => {
      console.error('[external-url] 系统浏览器打开失败：', url, error);
    },
  });
}

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
let smokeExitCode = null;
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

function currentScreenPermissionStatus() {
  if (process.platform !== 'darwin') return 'granted';
  return readScreenPermissionStatus(systemPreferences, console);
}

// not-determined/unknown 必须让真实捕获 API 继续执行：只有真实请求才能触发 macOS 首次授权。
// 只有系统明确返回 denied/restricted 时才在调用前阻断。
async function getScreenCaptureSources(options) {
  if (process.platform !== 'darwin') return desktopCapturer.getSources(options);
  requireScreenCaptureAttempt(currentScreenPermissionStatus());
  try {
    return await desktopCapturer.getSources(options);
  } catch (error) {
    const status = currentScreenPermissionStatus();
    if (status === 'denied' || status === 'restricted') {
      throw new ScreenPermissionError(status, error);
    }
    throw error;
  }
}

function requireUsableCaptureImage(image, message) {
  let usable = false;
  try {
    const size = image && typeof image.getSize === 'function' ? image.getSize() : null;
    usable = !!image
      && typeof image.isEmpty === 'function'
      && !image.isEmpty()
      && !!size
      && size.width > 0
      && size.height > 0;
  } catch (_) {}
  if (usable) return image;

  const status = currentScreenPermissionStatus();
  if (status === 'denied' || status === 'restricted') {
    throw new ScreenPermissionError(status);
  }
  const error = new Error(message);
  error.code = 'SCREEN_CAPTURE_EMPTY';
  throw error;
}

function showScreenPermissionDialog(status) {
  const restricted = status === 'restricted';
  const response = dialog.showMessageBoxSync({
    type: 'warning',
    title: '需要「屏幕录制」权限',
    message: restricted
      ? '屏幕录制权限受到系统策略限制。'
      : '困困截图工具还没有获得当前版本可用的「屏幕录制」权限。',
    detail: restricted
      ? '请联系此 Mac 的管理员检查隐私与安全性策略。'
      : '请在「系统设置 › 隐私与安全性 › 屏幕与系统录音」中开启「困困截图工具」。如果开关已经打开，请退出并重新打开应用，让当前进程重新读取授权。',
    buttons: restricted
      ? ['打开系统设置', '取消']
      : ['打开系统设置', '已授权，重启应用', '取消'],
    defaultId: 0,
    cancelId: restricted ? 1 : 2,
    noLink: true,
  });
  if (response === 0) {
    shell
      .openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      .catch((error) => console.error('[screen-permission] 打开系统设置失败：', error));
  } else if (!restricted && response === 1) {
    relaunchAfterSafeQuit = true;
    app.quit();
  }
}

// 保存一张图到历史并广播刷新
function saveToHistory(dataURL, type) {
  let item = null;
  try {
    item = history.add(dataURL, type);
  } catch (e) {
    console.error('[history] 保存失败：', e.message);
    return null;
  }
  // 广播失败不能抹掉“历史已经落盘”的事实，否则 quickSave finalizer 会误以为未入库并再写一次。
  if (item) {
    try { windows.broadcast(C.HISTORY_CHANGED); } catch (e) {
      console.error('[history] 已保存，但刷新广播失败：', e && e.message ? e.message : e);
    }
  }
  return item;
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
let pinWorkspaceStore = null;
let pinWorkspaceSaveTimer = null;
let pinWorkspaceClosing = false;
let quitPreparationInFlight = null;
let quitPrepared = false;
let relaunchAfterSafeQuit = false;

function savePinWorkspaceNow({ throwOnError = false } = {}) {
  if (pinWorkspaceSaveTimer) {
    clearTimeout(pinWorkspaceSaveTimer);
    pinWorkspaceSaveTimer = null;
  }
  if (!pinWorkspaceStore) return 0;
  try {
    return windows.savePinWorkspace(pinWorkspaceStore);
  } catch (error) {
    console.error('[pin-workspace] 保存失败：', error && error.message ? error.message : error);
    if (throwOnError) throw error;
    return 0;
  }
}

function schedulePinWorkspaceSave() {
  if (!pinWorkspaceStore || pinWorkspaceClosing) return;
  if (pinWorkspaceSaveTimer) clearTimeout(pinWorkspaceSaveTimer);
  pinWorkspaceSaveTimer = setTimeout(savePinWorkspaceNow, 250);
  if (pinWorkspaceSaveTimer && typeof pinWorkspaceSaveTimer.unref === 'function') pinWorkspaceSaveTimer.unref();
}

async function askAboutQuitRisk(message, detail) {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '退出前需要确认',
    message,
    detail,
    buttons: ['重试', '取消退出', '仍然退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) return 'retry';
  if (result.response === 2) return 'discard';
  return 'cancel';
}

async function prepareApplicationQuit({ interactive = true } = {}) {
  // 交互式选窗会启动 screencapture 子进程。退出时先使当前代数
  // 失效，再等待 Abort 清理（包括 SIGTERM 后的 SIGKILL 兜底）完成。
  for (;;) {
    const captureStopped = await captureCoordinator.cancelPendingAndWait('app-quit', 2000);
    if (captureStopped) break;
    if (!interactive) {
      console.error('[quit] 非交互退出：窗口截图子进程未在限时内停止。');
      break;
    }
    const choice = await askAboutQuitRisk(
      '正在进行的窗口截图未能完全停止。',
      '系统选窗子进程仍在退出清理中。'
    );
    if (choice === 'retry') continue;
    if (choice === 'cancel') {
      windows.cancelPinClosePreparation();
      return false;
    }
    break;
  }

  // renderer 中的标注合成是异步的：必须先收到每张贴图的回执，再从
  // 主进程快照工作区。超时/渲染崩溃不会默默丢数据，由用户选择重试或退出。
  for (;;) {
    const flushResult = await windows.preparePinsForClose({ timeoutMs: 5000 });
    if (flushResult.ok) break;
    if (!interactive) {
      console.error('[quit] 非交互退出：有贴图未在限时内完成内容同步。');
      break;
    }
    const failures = flushResult.results
      .filter((item) => !item.ok)
      .slice(0, 5)
      .map((item) => `贴图 ${item.webContentsId}: ${item.error || '同步失败'}`);
    if (flushResult.results.filter((item) => !item.ok).length > failures.length) {
      failures.push('还有更多贴图未能完成同步。');
    }
    const choice = await askAboutQuitRisk(
      '有贴图尚未完成最终内容同步。',
      failures.join('\n') || '贴图内容同步失败。'
    );
    if (choice === 'retry') continue;
    if (choice === 'cancel') {
      windows.cancelPinClosePreparation();
      return false;
    }
    break;
  }

  // 工作区写入失败不能像定时自动保存那样只记日志。普通退出必须给用户
  // 可恢复的选择；只有明确点击“仍然退出”才会放弃这次落盘。
  for (;;) {
    try {
      savePinWorkspaceNow({ throwOnError: true });
      break;
    } catch (error) {
      if (!interactive) {
        console.error('[quit] 非交互退出：贴图工作区保存失败：', error);
        break;
      }
      const choice = await askAboutQuitRisk(
        '贴图工作区保存失败。',
        String((error && error.message) || error || '未知错误').slice(0, 2000)
      );
      if (choice === 'retry') continue;
      if (choice === 'cancel') {
        windows.cancelPinClosePreparation();
        return false;
      }
      break;
    }
  }

  // 录屏的媒体数据只在 recorder renderer 里，不能依靠 close 事件在应用退出时
  // 保护。非 idle/saved/canceled 状态要求明确放弃，默认选项是返回录屏。
  if (!windows.canCloseRecorder()) {
    const state = windows.getRecorderState();
    if (!interactive) {
      console.error(`[quit] 非交互退出：录屏状态 ${state && state.state ? state.state : 'unknown'} 未安全保存。`);
      return true;
    }
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '录屏尚未安全保存',
      message: '当前录屏仍在进行、处理或等待重试。',
      detail: `当前状态：${state && state.state ? state.state : 'unknown'}\n强制退出会放弃尚未写入磁盘的录屏。`,
      buttons: ['返回录屏', '放弃录屏并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) {
      windows.cancelPinClosePreparation();
      windows.focusRecorder();
      return false;
    }
  }

  return true;
}

if (typeof windows.onPinWorkspaceChanged === 'function') {
  windows.onPinWorkspaceChanged(() => schedulePinWorkspaceSave());
}

const timedCaptureScheduler = createTimedCaptureScheduler({
  onFire: async ({ mode }, control) => {
    // 定时任务只负责决定何时开始捕获，完成、复制与保存仍由统一编辑器确认。
    return startCapture(mode, { trigger: 'timed', signal: control.signal });
  },
  onError: (error) => {
    const message = (error && error.message) || String(error);
    console.error('[timed-capture] 失败：', message);
    try { dialog.showErrorBox('定时截图失败', message); } catch (_) {}
  },
});

const launchActionRunner = createLaunchActionRunner({
  startCapture,
  captureWindow: doWindowCapture,
  scheduleTimedCapture: (payload) => timedCaptureScheduler.schedule(payload),
});

async function handleLaunchArguments(argv) {
  let action;
  try {
    action = parseLaunchAction(argv);
  } catch (error) {
    const message = (error && error.message) || String(error);
    console.error('[launch-action] 参数无效：', message);
    try { dialog.showErrorBox('自动截图参数无效', message); } catch (_) {}
    // 参数虽无效，但已识别为自动化请求；不得退回“打开设置”掩盖错误。
    return { handled: true, ok: false, error: message };
  }
  if (!action) return { handled: false, ok: true };

  try {
    const outcome = await launchActionRunner.run(action);
    const result = outcome.result;
    if (result && result.ok === false && result.canceled !== true) {
      const message = result.error || '自动截图未能启动。';
      if (result.dialogShown !== true) {
        try { dialog.showErrorBox('自动截图失败', message); } catch (_) {}
      }
      return { ...outcome, ok: false, error: message };
    }
    return { ...outcome, ok: true };
  } catch (error) {
    const message = (error && error.message) || String(error);
    console.error('[launch-action] 执行失败：', message);
    try { dialog.showErrorBox('自动截图失败', message); } catch (_) {}
    return { handled: true, ok: false, error: message };
  }
}

// Renderer 按窗口职责分权：即使某个本地页面因将来的 XSS/依赖漏洞被注入，也只能调用
// 自己正常工作所需的能力。所有 invoke 通道必须显式列出；遗漏即在注册时失败，绝不默认放行。
const IPC_ROLE_ALLOWLIST = {
  [C.CONFIG_GET]: ['main', 'overlay', 'ai', 'popover', 'pin'],
  [C.CONFIG_SET]: ['main', 'popover', 'overlay'],

  [C.WINDOW_CLOSE_SELF]: ['ai', 'longshot', 'pin', 'recorder', 'formula'],
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
  [C.PIN_UPDATE_CONTENT]: ['pin'],
  [C.PIN_REPLACE_IMAGE]: ['pin'],
  [C.PIN_GROUP_ACTION]: ['pin'],
  [C.PIN_CLOSE_READY]: ['pin'],
  [C.PIN_SYNC_READY]: ['pin'],
  [C.PIN_START_DRAG]: ['pin'],
  [C.FORMULA_CREATE_PIN]: ['formula'],
  [C.OPEN_PATH]: ['pin'],

  [C.OCR_RUN]: ['main', 'overlay', 'ai'],
  [C.AX_AT_POINT]: ['overlay'],
  [C.OCR_BOXES]: ['overlay', 'pin'],
  [C.TRANSLATE_TEXT]: ['overlay'],

  [C.DEEPSEEK_ASK_IMAGE]: ['main', 'overlay', 'ai'],
  [C.AI_RECOGNIZE_IMAGE]: ['ai'],
  [C.DEEPSEEK_CHAT]: ['main', 'overlay', 'ai'],
  [C.DEEPSEEK_CANCEL]: ['main', 'overlay', 'ai'],
  [C.DEEPSEEK_TEST]: ['main'],
  [C.AI_FETCH_MODELS]: ['main'],

  [C.TRANSLATE_POPUP_CLOSE]: ['translate-popup'],
  [C.RECORD_SAVE]: ['recorder'],
  [C.RECORD_STATE]: ['recorder'],
  [C.RECORD_ACTION_START]: ['recorder'],
  [C.RECORD_ACTION_STOP]: ['recorder'],
  [C.OPEN_EXTERNAL]: ['overlay'],

  [C.OPEN_MAIN]: ['popover'],
  [C.POPOVER_TOGGLE]: [],
  [C.POPOVER_HIDE]: ['popover'],
  [C.CAPTURE_FULLSCREEN_NOW]: ['main', 'popover'],
  [C.CAPTURE_WINDOW]: ['main', 'popover'],
  [C.CAPTURE_TIMED]: ['main'],
  [C.CAPTURE_TIMED_CANCEL]: ['main'],

  [C.HISTORY_LIST]: ['main', 'overlay', 'popover'],
  [C.HISTORY_GET]: ['main', 'overlay', 'popover'],
  [C.HISTORY_DELETE]: ['main'],
  [C.HISTORY_DELETE_MANY]: ['main'],
  [C.HISTORY_CLEAR]: ['main'],
  [C.HISTORY_EXPORT]: ['main'],
  [C.HISTORY_EXPORT_MANY]: ['main'],
  [C.HISTORY_EXPORT_PDF]: ['main'],
};

// ---------- 屏幕捕获 ----------
// 抓取光标所在显示器的整屏，返回截图层需要的数据。
async function grabDisplay() {
  // 所有「整屏抓取」都经此函数。首次状态为 not-determined 时必须实际调用捕获 API，
  // 让 macOS 显示授权请求；denied/restricted 才会在 helper 内失败关闭。
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const sf = display.scaleFactor || 1;
  const sources = await getScreenCaptureSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    },
  });
  const src = selectDisplaySource(sources, display, screen.getAllDisplays());
  if (!src) {
    requireUsableCaptureImage(null, '没有找到与当前显示器匹配的屏幕源。');
  }
  const thumbnail = requireUsableCaptureImage(
    src.thumbnail,
    '屏幕源返回了空画面，请重试或重新连接显示器。'
  );
  return {
    display,
    dataURL: thumbnail.toDataURL(),
    scaleFactor: sf,
    displayId: display.id,
    sourceId: src.id,
    width: display.size.width,
    height: display.size.height,
  };
}

function grabWindowFrame({ signal } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error('交互式窗口截图目前仅支持 macOS'));
      return;
    }
    if (signal && signal.aborted) {
      resolve(null);
      return;
    }
    try {
      requireScreenCaptureAttempt(currentScreenPermissionStatus());
    } catch (error) {
      reject(error);
      return;
    }
    const tmp = tempFiles.createPrivateTempPath('kkshot-window', 'png');
    let child;
    let settled = false;
    let aborted = false;
    let forceKillTimer = null;
    let stderr = '';
    const cleanup = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      tempFiles.cleanupTempPath(tmp);
    };
    const finish = (error, frame) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      if (error) reject(error);
      else resolve(frame);
    };
    const onAbort = () => {
      aborted = true;
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
      // screencapture 在系统选窗面板异常时可能不响应 SIGTERM。不让已取消任务
      // 永久占住 coordinator；宽限后强制结束并回收私有临时文件。
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { if (child) child.kill('SIGKILL'); } catch (_) {}
        finish(null, null);
      }, 750);
      if (forceKillTimer && typeof forceKillTimer.unref === 'function') forceKillTimer.unref();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      child = spawn('/usr/sbin/screencapture', ['-w', '-x', '-o', tmp], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish(error);
      return;
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length >= 4096) return;
        stderr += String(chunk || '').slice(0, 4096 - stderr.length);
      });
    }
    child.once('error', (error) => finish(error));
    child.once('close', (code, closeSignal) => {
      if (aborted || (signal && signal.aborted)) {
        finish(null, null);
        return;
      }
      try {
        const hasFile = fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
        const closeOutcome = classifyWindowCaptureClose({
          code,
          signal: closeSignal,
          hasFile,
          stderr,
        });
        if (closeOutcome.kind !== 'success') {
          // TCC 拒绝有时也会表现为退出码 1 且无 stderr。先保留权限错误，
          // 再把 macOS 交互选窗的 Esc/无选区结果当作正常取消。
          const status = currentScreenPermissionStatus();
          if (status === 'denied' || status === 'restricted') {
            finish(new ScreenPermissionError(status));
            return;
          }
          if (closeOutcome.kind === 'canceled') {
            finish(null, null);
            return;
          }
          const detail = closeOutcome.detail;
          const error = new Error(
            `窗口截图未完成（退出码 ${code == null ? 'unknown' : code}`
              + `${closeSignal ? `，信号 ${closeSignal}` : ''}）${detail ? `：${detail}` : ''}`
          );
          error.code = 'WINDOW_CAPTURE_FAILED';
          finish(error);
          return;
        }
        const dataURL = 'data:image/png;base64,' + fs.readFileSync(tmp).toString('base64');
        const image = validatedNativeImage(dataURL);
        const size = image.getSize();
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        finish(null, {
          display,
          dataURL,
          pixelWidth: size.width,
          pixelHeight: size.height,
          displayId: display.id,
        });
      } catch (error) {
        finish(error);
      }
    });
  });
}

const captureCoordinator = createCaptureCoordinator({
  getEditorState: () => {
    const editor = windows.getOverlay();
    const open = !!editor && !editor.isDestroyed();
    // 目前 overlay 没有独立 dirty IPC；保守把任何已打开编辑器视为不可覆盖。
    return { open, dirty: open };
  },
  captureFrame: ({ mode, signal }) => (
    mode === 'window' ? grabWindowFrame({ signal }) : grabDisplay()
  ),
  openEditor: (frame, { mode }) => {
    if (mode === 'window') {
      return windows.createImageEditor(frame.display, {
        dataURL: frame.dataURL,
        pixelWidth: frame.pixelWidth,
        pixelHeight: frame.pixelHeight,
        mode: 'image',
        captureType: 'window',
        displayId: frame.displayId,
      });
    }
    return windows.createOverlay(frame.display, {
      dataURL: frame.dataURL,
      scaleFactor: frame.scaleFactor,
      displayId: frame.displayId,
      sourceId: frame.sourceId,
      width: frame.width,
      height: frame.height,
      mode,
    });
  },
});

async function startCapture(mode, options = {}) {
  const safeMode = mode == null ? 'region' : mode;
  if (quitPreparationInFlight || quitPrepared) {
    return { ok: false, canceled: true, reason: 'app-quit', mode: safeMode };
  }
  if (!['region', 'long', 'record', 'ocr', 'fullscreen', 'window'].includes(safeMode)) {
    return { ok: false, error: '截图模式无效。' };
  }
  try {
    return await captureCoordinator.start(safeMode, options);
  } catch (e) {
    console.error('[capture] 失败：', e);
    if (isScreenPermissionError(e)) {
      showScreenPermissionDialog(e.status);
      return {
        ok: false,
        error: e.message || '屏幕录制权限未开启。',
        code: e.code,
        status: e.status,
        dialogShown: true,
      };
    }
    const message = e && e.message ? e.message : String(e);
    dialog.showErrorBox('截图失败', message);
    return { ok: false, error: message, code: e && e.code, dialogShown: true };
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

// 立即整屏截图 → 进入统一编辑器；确认动作后才复制或存历史。
async function doFullscreenNow() {
  return startCapture('fullscreen');
}

// 交互式窗口截图（macOS screencapture -w）→ 进入统一编辑器。
function doWindowCapture(options = {}) {
  return startCapture('window', options);
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
async function saveImageWithDialog(dataURL, filenameContext = {}) {
  const cfg = config.get();
  const dir = cfg.general.saveDir || app.getPath('pictures');
  const preferences = normalizeImageExportPreferences(cfg);
  const filename = buildFilename({
    template: (cfg.capture && cfg.capture.fileNameTemplate) || DEFAULT_SCREENSHOT_TEMPLATE,
    extension: preferredExtensionForFormat(preferences.format),
    now: filenameContext.now == null ? Date.now() : filenameContext.now,
    type: filenameContext.type || 'screenshot',
    index: filenameContext.index == null ? 1 : filenameContext.index,
    width: filenameContext.width == null ? 0 : filenameContext.width,
    height: filenameContext.height == null ? 0 : filenameContext.height,
  });
  return saveImageViaDialog(
    {
      dataURL,
      config: cfg,
      defaultDirectory: dir,
      suggestName: path.basename(nextAvailablePath(dir, filename)),
    },
    {
      showSaveDialog: (options) => dialog.showSaveDialog(options),
      showErrorBox: (title, message) => dialog.showErrorBox(title, message),
      exportImage,
    },
  );
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
    const outcome = applyConfigPatchTransaction({
      patch: safePatch,
      getConfig: () => config.get(),
      setConfig: (nextPatch) => config.set(nextPatch),
      getPublicConfig: () => config.publicView(),
      applyShortcuts: (next, previous) => registerShortcuts(next, previous),
    });
    // 快捷键冲突时 outcome 是结构化失败，并且配置/真实绑定已回滚；
    // 不得再返回普通 config 让设置页误报“已保存”。
    if (outcome && outcome.ok === false) return outcome;
    applyLoginItem();
    return outcome;
  });

  ipcMain.handle(C.WINDOW_CLOSE_SELF, (e) => {
    if (windows.getTrustedRole(e.sender.id) === 'recorder') {
      return windows.requestRecorderClose(e.sender.id);
    }
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) {
      w.close();
      return { ok: true };
    }
    return { ok: false };
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
    const { dx, dy } = normalizeWindowMove(payload);
    return { moved: windows.movePinGroup(e.sender.id, dx, dy) };
  });
  ipcMain.handle(C.OPEN_SETTINGS, () => windows.openSettings());
  ipcMain.handle(C.OPEN_AI_PANEL, (_e, payload) => windows.openAIPanel(payload));

  ipcMain.handle(C.CAPTURE_TRIGGER, (_e, mode) => {
    const safeMode = mode == null ? 'region' : mode;
    if (!['region', 'long', 'record', 'ocr', 'fullscreen'].includes(safeMode)) throw new Error('截图模式无效。');
    return startCapture(safeMode);
  });
  ipcMain.handle(C.CAPTURE_REGION, async (_e, payload) => {
    const { rect, displayId } = payload && typeof payload === 'object' ? payload : {};
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(displayId));
    if (!display) throw new Error('目标显示器已断开，请重新开始长截图。');
    const safeRect = normalizeCaptureRect(rect, display.size);
    const sf = display.scaleFactor || 1;
    const sources = await getScreenCaptureSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const src = selectDisplaySource(sources, display, displays);
    if (!src) requireUsableCaptureImage(null, '未获取到目标显示器的屏幕源。');
    const thumbnail = requireUsableCaptureImage(
      src.thumbnail,
      '屏幕源返回了空画面，请重试或重新连接显示器。'
    );
    const crop = thumbnail.crop({
      x: Math.round(safeRect.x * sf),
      y: Math.round(safeRect.y * sf),
      width: Math.round(safeRect.width * sf),
      height: Math.round(safeRect.height * sf),
    });
    return requireUsableCaptureImage(crop, '截取区域为空，请重新选择截图范围。').toDataURL();
  });
  ipcMain.handle(C.CAPTURE_GET_SOURCES, async () => {
    const sources = await getScreenCaptureSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return serializeCaptureSources(sources);
  });

  ipcMain.handle(C.OVERLAY_CANCEL, () => {
    captureCoordinator.cancelPending('overlay-canceled');
    windows.closeOverlay();
    return { ok: true };
  });
  ipcMain.handle(C.OVERLAY_RESULT, async (_e, result) => {
    let action = '';
    try {
      const normalized = normalizeOverlayResultEnvelope(result);
      ({ action } = normalized);
      const { imageDataURL, bounds, displayId, rect } = normalized;
      const captureType = windows.getOverlayCaptureType(_e.sender.id);
      if (!captureType) throw new Error('截图编辑上下文已失效，请重新截图。');
      const cfg = config.get();
      const isLiveCapture = normalized.kind === 'live';
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
      let savedToHistory = false; // 当前动作是否已真正入历史，用于避免与下面自动入历史重复
      switch (action) {
        case 'copy':
          clipboard.writeImage(image);
          break;
        case 'save': {
          const imageSize = image.getSize();
          const r = await saveImageWithDialog(imageDataURL, {
            type: captureType,
            width: imageSize.width,
            height: imageSize.height,
          });
          if (!r || r.saved !== true) {
            return {
              ok: false,
              canceled: !r || !r.error,
              error: r && r.error ? r.error : undefined,
            };
          }
          savedToHistory = !!saveToHistory(imageDataURL, captureType);
          break;
        }
        case 'quickSave': {
          // 快速保存：免对话框直接存到保存目录，并弹系统通知。
          // 写盘失败抛给统一错误分支，不确认成功，overlay 会保留并可重试。
          const dir = cfg.general.saveDir || app.getPath('pictures');
          const exported = await quickSaveImage({
            dataURL: imageDataURL,
            config: cfg,
            defaultDirectory: dir,
            timestamp: Date.now(),
            type: captureType,
            width: image.getSize().width,
            height: image.getSize().height,
          }, { exportImage });
          const file = exported.path;
          // 历史库始终保留截图阶段的原始 PNG data URL，不因磁盘导出格式而二次压缩。
          savedToHistory = !!saveToHistory(imageDataURL, captureType);
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
          const recorderResult = windows.createRecorder({
            rect: safeRect,
            displayBounds: dd.bounds,
            scaleFactor: dd.scaleFactor,
            displayId,
            // 显示器序号：macOS 上 source.display_id 可能为空，录屏端据此按序号兜底匹配，避免录错屏。
            displayIndex: screen.getAllDisplays().findIndex((d) => String(d.id) === String(displayId)),
            fps: cfg.recording.fps,
            toGif: cfg.recording.toGif,
            systemAudio: cfg.recording.systemAudio,
            microphone: cfg.recording.microphone,
          });
          if (recorderResult.busy) {
            return { ok: true, busy: true, state: recorderResult.state };
          }
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
      if (normalized.kind === 'static' && cfg.capture.copyAfterCapture && action !== 'copy') {
        clipboard.writeImage(image);
      }
      // 自动贴图：截完把图钉到屏幕原位。pin 动作本身即贴图、record/long 无静态图，均跳过。
      if (normalized.kind === 'static' && cfg.capture.autoPin && safeBounds && action !== 'pin') {
        windows.createPin({ dataURL: imageDataURL, bounds: safeBounds });
      }
      // 所有已明确入库的动作（save / quickSave）都必须跳过自动入历史，
      // guard 只看真实持久化状态，不再硬编码单一 action。
      if (normalized.kind === 'static' && shouldAutoSaveOverlayHistory({ imageDataURL, savedToHistory })) {
        autoSaveToHistory(imageDataURL, action === 'pin' ? 'pin' : captureType);
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
  ipcMain.handle(C.IMAGE_SAVE, async (e, dataURL) => {
    const image = validatedNativeImage(dataURL);
    const role = windows.getTrustedRole(e.sender.id);
    const type = historyTypeForImageSaveRole(role);
    const imageSize = image.getSize();
    const r = await saveImageWithDialog(dataURL, {
      type,
      width: imageSize.width,
      height: imageSize.height,
    });
    if (r && r.saved) {
      saveToHistory(dataURL, type); // 长截图/贴图保留真实类型
    }
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
  // 贴图窗状态：置顶 / 透明度 / 锁定 / 标题会进入工作区持久化；鼠标穿透仅属当前会话。
  ipcMain.handle(C.PIN_SET_STATE, (e, flags) => {
    try {
      flags = normalizePinStateFlags(flags);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return { ok: false };
    try {
      if (typeof flags.ignoreMouse === 'boolean') {
        w.setIgnoreMouseEvents(flags.ignoreMouse, { forward: true });
        passthroughShortcutLifecycle.setPinPassthrough(w.webContents.id, flags.ignoreMouse);
      }
      const workspacePatch = { ...flags };
      delete workspacePatch.ignoreMouse;
      const state = Object.keys(workspacePatch).length
        ? windows.updatePinWorkspaceState(w.webContents.id, workspacePatch)
        : windows.getPinPayload(w.webContents.id) && windows.getPinPayload(w.webContents.id).state;
      return { ok: true, state: state || {} };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // 贴图标注后的合成图由主进程按 revision 原子接收；工作区持久化、
  // OCR / AI / 拖拽都因此只会看到已确认的最新内容。
  ipcMain.handle(C.PIN_UPDATE_CONTENT, (e, rawUpdate) => {
    try {
      const update = normalizePinContentUpdate(rawUpdate, (dataURL) => {
        validatedNativeImage(dataURL);
        return dataURL;
      });
      const result = windows.updatePinContent(e.sender.id, update);
      return { ok: true, revision: result.revision };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // 裁剪、旋转与翻转会同时改变图片像素和窗口宽高比。两端尺寸都以
  // Electron 实际解码结果为准，避免 renderer 伪造尺寸导致越界窗口或伸缩畸变。
  ipcMain.handle(C.PIN_REPLACE_IMAGE, (e, rawUpdate) => {
    try {
      const update = normalizePinImageReplacement(rawUpdate);
      const payload = windows.getPinPayload(e.sender.id);
      if (!payload || typeof payload.dataURL !== 'string') throw new Error('图片贴图窗口不存在。');
      const nextSize = validatedNativeImage(update.dataURL).getSize();
      if (nextSize.width !== update.width || nextSize.height !== update.height) {
        throw new Error('新图片尺寸与申报不一致。');
      }
      const currentRevision = Number.isSafeInteger(payload.contentRevision) ? payload.contentRevision : 0;
      // invoke 回执丢失后 renderer 会重放完全相同的替换。此时 payload 已是新图，
      // 不能再用旧 sourceWidth/sourceHeight 去校验它，应交给 windows 的幂等分支。
      const isExactReplay = update.revision === currentRevision
        && update.baseRevision === currentRevision - 1
        && update.dataURL === payload.dataURL;
      if (!isExactReplay) {
        const sourceSize = validatedNativeImage(payload.dataURL).getSize();
        if (sourceSize.width !== update.sourceWidth || sourceSize.height !== update.sourceHeight) {
          throw new Error('原图片尺寸已变更，请重试。');
        }
      }
      const result = windows.replacePinImage(e.sender.id, update);
      return { ok: true, revision: result.revision, bounds: result.bounds };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle(C.PIN_GROUP_ACTION, (e, rawAction) => {
    try {
      const { action } = normalizePinGroupAction(rawAction);
      return windows.pinGroupAction(e.sender.id, action);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle(C.FORMULA_CREATE_PIN, (_e, rawPayload) => {
    try {
      const { dataURL } = normalizeFormulaPinPayload(rawPayload);
      if (!dataURL.startsWith('data:image/png;base64,')) throw new Error('公式贴图必须是 PNG 图片。');
      const image = validatedNativeImage(dataURL);
      const size = image.getSize();
      // 公式页以 2x 像素渲染，贴图创建时还原为逻辑尺寸，并保持宽高比。
      const logicalWidth = size.width / 2;
      const logicalHeight = size.height / 2;
      const grow = Math.max(1, 80 / logicalWidth, 40 / logicalHeight);
      const shrink = Math.min(1, 1600 / (logicalWidth * grow), 1000 / (logicalHeight * grow));
      const logicalScale = grow * shrink;
      const width = Math.max(1, Math.round(logicalWidth * logicalScale));
      const height = Math.max(1, Math.round(logicalHeight * logicalScale));
      const point = screen.getCursorScreenPoint();
      windows.createPin({
        dataURL,
        bounds: { x: point.x, y: point.y, width, height },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle(C.PIN_CLOSE_READY, (e, rawReply) => {
    try {
      return windows.acknowledgePinClose(e.sender.id, rawReply);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle(C.PIN_SYNC_READY, (e, rawReply) => {
    try {
      return windows.acknowledgePinSync(e.sender.id, rawReply);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // P1-8：智能 UI 元素识别——查询屏幕坐标处元素（悬停节流探测用）
  let axPrompted = false;
  ipcMain.handle(C.AX_AT_POINT, async (_e, { x, y } = {}) => {
    if (process.platform !== 'darwin') return { error: '仅支持 macOS' };
    const point = axprobe.normalizeProbePoint(x, y);
    if (!point) {
      return { error: '坐标无效' };
    }
    if (!checkAccessibilityPermission(!axPrompted)) {
      axPrompted = true;
      return { error: '需要「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）' };
    }
    try {
      const r = await axprobe.probeAtPoint(point.x, point.y, 700);
      return axprobe.normalizeProbeResult(r);
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle(C.OCR_RUN, async (_e, payload) => {
    const dataURL = payload && payload.dataURL;
    validatedNativeImage(dataURL);
    const cfg = config.get();
    const lang = normalizeOCRLanguage((payload && payload.lang) || cfg.ocr.lang);
    const engine = (payload && payload.engine) || (cfg.ocr && cfg.ocr.engine) || 'local';
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
    ipcMain.handle(C.AI_RECOGNIZE_IMAGE, createAIRecognitionHandler({
      streamChannel: C.DEEPSEEK_STREAM,
      aiProvider,
      getLanguage: () => config.get().ocr.lang,
      downscaleDataURL: (dataURL, maxSide) => {
        validatedNativeImage(dataURL);
        return downscaleDataURL(dataURL, maxSide);
      },
      imageMessage: deepseek.imageMessage,
      recognize: (dataURL, language) => ocr.recognize(dataURL, language),
      streamWithAbort,
    }));

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
    const { buffer, toGif, fps: safeFps, trimStart: ss, trimEnd: te, width, height } = normalized;
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
      const filename = buildFilename({
        template: (cfg.recording && cfg.recording.fileNameTemplate) || DEFAULT_RECORDING_TEMPLATE,
        extension: ext,
        now: Date.now(),
        type: 'recording',
        index: 1,
        width,
        height,
      });
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存录屏',
        defaultPath: nextAvailablePath(dir, filename),
        filters: wantGif
          ? [{ name: 'GIF 动图', extensions: ['gif'] }]
          : [
              { name: 'WebM 视频', extensions: ['webm'] },
              { name: 'MP4 视频（H.264，兼容性更好）', extensions: ['mp4'] },
            ],
      });
      if (canceled || !filePath) return { saved: false, canceled: true };
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
        // 录屏是一种独立的历史类型，不得完全消失于图片历史之外。
        // 受管副本写入失败不能否定用户导出已成功的事实，但会返回 historySaved=false
        // 并记录日志，避免为了历史副本让录屏窗口误以为整个保存失败。
        const historyItem = await persistRecordingHistory(filePath, {
          addMedia: (source, type, metadata) => history.addMedia(source, type, metadata),
          broadcast: () => windows.broadcast(C.HISTORY_CHANGED),
          onError: (error) => console.error(
            '[history] 录屏已导出，但受管历史副本写入失败：',
            (error && error.message) || String(error),
          ),
          width,
          height,
        });
        return { saved: true, path: filePath, historySaved: !!historyItem };
      } catch (err) {
        dialog.showErrorBox('保存录屏失败', err.message);
        return { saved: false, error: err.message };
      }
    } finally {
      tempFiles.cleanupTempPath(tmp);
    }
  });

  ipcMain.handle(C.RECORD_STATE, (e, payload) => {
    try {
      return windows.updateRecorderState(e.sender.id, payload);
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  });

  ipcMain.handle(C.RECORD_ACTION_START, async (e) => {
    const ownerId = e.sender.id;
    let releaseOwner;
    try {
      // 同一 WebContents 重试只保留一个 destroyed 监听器；helper 的任何终止路径
      // 都通过 onStopped 释放它，避免长时间运行后触发 EventEmitter 泄漏告警。
      releaseOwner = recordActionOwners.watch(e.sender);
      return await recordActionMonitor.start({
        ownerId,
        send: (payload) => {
          if (!e.sender.isDestroyed()) e.sender.send(C.RECORD_ACTION_EVENT, payload);
        },
        onStopped: releaseOwner,
      });
    } catch (error) {
      if (typeof releaseOwner === 'function') releaseOwner();
      return {
        ok: false,
        active: false,
        error: (error && error.message) || String(error),
      };
    }
  });

  ipcMain.handle(C.RECORD_ACTION_STOP, (e) => {
    const result = recordActionMonitor.stop(e.sender.id);
    recordActionOwners.release(e.sender.id, e.sender);
    return result;
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
  ipcMain.handle(C.OPEN_EXTERNAL, (_e, url) => openExternalHttpUrl(url));

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
      return await doFullscreenNow();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle(C.CAPTURE_WINDOW, () => doWindowCapture());
  ipcMain.handle(C.CAPTURE_TIMED, (_e, payload) => {
    const job = timedCaptureScheduler.schedule(payload);
    return { ok: true, ...job };
  });
  ipcMain.handle(C.CAPTURE_TIMED_CANCEL, (_e, jobId) => {
    if (typeof jobId !== 'string' || jobId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error('定时截图任务标识无效。');
    }
    return { ok: timedCaptureScheduler.cancel(jobId) };
  });

  // ---- 历史记录 ----
  ipcMain.handle(C.HISTORY_LIST, (_e, options) => history.list({
    includeMedia: !!(options && options.includeMedia === true),
  }));
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
    const safeId = normalizeHistoryId(id);
    const got = history.get(safeId);
    if (!got) return { saved: false };
    if (got.item && got.item.kind === 'media') {
      const source = history.filePathOf(safeId);
      if (!source) return { saved: false };
      const ext = path.extname(source).toLowerCase();
      const cfg = config.get();
      const dir = cfg.general.saveDir || app.getPath('videos') || app.getPath('downloads');
      const filename = buildFilename({
        template: (cfg.recording && cfg.recording.fileNameTemplate) || DEFAULT_RECORDING_TEMPLATE,
        extension: ext,
        now: got.item.time || Date.now(),
        type: 'recording',
        index: 1,
        width: got.item.width || 0,
        height: got.item.height || 0,
      });
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出录屏',
        defaultPath: nextAvailablePath(dir, filename),
        filters: [{ name: '录屏文件', extensions: [ext.slice(1)] }],
      });
      if (canceled || !filePath) return { saved: false };
      try {
        media.copyFileAtomic(source, filePath);
        return { saved: true, path: filePath };
      } catch (err) {
        dialog.showErrorBox('导出录屏失败', (err && err.message) || String(err));
        return { saved: false, error: (err && err.message) || String(err) };
      }
    }
    return saveImageWithDialog(got.dataURL, {
      now: got.item.time || Date.now(),
      type: got.item.type || 'screenshot',
      index: 1,
      width: got.item.width || 0,
      height: got.item.height || 0,
    });
  });
  // 批量导出：只弹一次目录选择框，图片与录屏都从受管历史副本导出。
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
    const imagePreferences = normalizeImageExportPreferences(cfg);
    const imageExtension = preferredExtensionForFormat(imagePreferences.format);
    const reservedPaths = new Set();
    let count = 0;
    for (const [itemIndex, id] of safeIds.entries()) {
      try {
        const got = history.get(id);
        if (got && got.item && got.item.kind === 'media') {
          const source = history.filePathOf(id);
          if (source) {
            const extension = path.extname(source).toLowerCase();
            const filename = buildFilename({
              template: (cfg.recording && cfg.recording.fileNameTemplate) || DEFAULT_RECORDING_TEMPLATE,
              extension,
              now: got.item.time || Date.now(),
              type: 'recording',
              index: itemIndex + 1,
              width: got.item.width || 0,
              height: got.item.height || 0,
            });
            media.copyFileAtomic(source, nextAvailablePath(dir, filename, { reserved: reservedPaths }));
            count++;
          }
        } else if (got && got.dataURL) {
          const filename = buildFilename({
            template: (cfg.capture && cfg.capture.fileNameTemplate) || DEFAULT_SCREENSHOT_TEMPLATE,
            extension: imageExtension,
            now: got.item.time || Date.now(),
            type: got.item.type || 'screenshot',
            index: itemIndex + 1,
            width: got.item.width || 0,
            height: got.item.height || 0,
          });
          await exportImage({
            dataURL: got.dataURL,
            outputPath: nextAvailablePath(dir, filename, { reserved: reservedPaths }),
            format: imagePreferences.format,
            quality: imagePreferences.quality,
          });
          count++;
        }
      } catch (err) { console.error('[history] 批量导出单张失败', id, err); }
    }
    return { saved: count > 0, count, dir };
  });
  ipcMain.handle(C.HISTORY_EXPORT_PDF, async (_e, ids) => {
    const cfg = config.get();
    try {
      return await exportHistoryPdf({
        ids,
        config: cfg,
        defaultDirectory: cfg.general.saveDir || app.getPath('pictures'),
      }, {
        history,
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        exportImagesToPdf,
      });
    } catch (err) {
      const message = (err && err.message) || String(err);
      dialog.showErrorBox('合并 PDF 失败', message);
      return { saved: false, error: message };
    }
  });
}

function boundsToDisplay(displayId) {
  const d =
    screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) ||
    screen.getPrimaryDisplay();
  return { bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor || 1 };
}

// ---------- 贴图鼠标穿透兜底（穿透后窗口收不到键盘，用临时全局快捷键恢复）----------
function createPassthroughShortcutLifecycle({
  registerShortcut,
  unregisterShortcut,
  restoreAllPins,
  accelerator = 'CommandOrControl+Alt+P',
} = {}) {
  if (typeof registerShortcut !== 'function' || typeof unregisterShortcut !== 'function' || typeof restoreAllPins !== 'function') {
    throw new TypeError('穿透快捷键生命周期依赖无效。');
  }

  const passthroughPins = new Set();
  let shortcutRegistered = false;

  function clearShortcut() {
    if (!shortcutRegistered) return;
    try {
      unregisterShortcut(accelerator);
    } catch (_) {
      // Electron 正在退出或快捷键已被系统清走时也要收敛本地状态。
    } finally {
      shortcutRegistered = false;
    }
  }

  function restoreAndRelease() {
    try {
      restoreAllPins();
    } finally {
      passthroughPins.clear();
      clearShortcut();
    }
  }

  function ensureShortcut() {
    if (shortcutRegistered) return true;
    try {
      shortcutRegistered = registerShortcut(accelerator, restoreAndRelease) === true;
    } catch (_) {
      shortcutRegistered = false;
    }
    return shortcutRegistered;
  }

  function removePin(webContentsId) {
    passthroughPins.delete(webContentsId);
    if (!passthroughPins.size) clearShortcut();
  }

  return {
    setPinPassthrough(webContentsId, enabled) {
      if (enabled) {
        passthroughPins.add(webContentsId);
        return ensureShortcut();
      }
      removePin(webContentsId);
      return true;
    },
    removePin,
    // registerShortcuts() 调用 unregisterAll() 后，Electron 的真实注册已清空；必须先
    // 丢弃本地布尔状态并立即恢复兜底键，随后普通配置快捷键才能安全地避开该冲突。
    onGlobalShortcutsReset() {
      shortcutRegistered = false;
      return passthroughPins.size ? ensureShortcut() : true;
    },
    dispose() {
      passthroughPins.clear();
      clearShortcut();
    },
  };
}

const passthroughShortcutLifecycle = createPassthroughShortcutLifecycle({
  registerShortcut: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
  restoreAllPins: () => {
    windows.pinSnapshots().forEach(({ win }) => {
      try {
        win.setIgnoreMouseEvents(false, { forward: true });
        win.webContents.send(C.PIN_CMD, { cmd: 'passthrough-off' });
      } catch (_) {}
    });
  },
});
windows.onPinRemoved((webContentsId) => passthroughShortcutLifecycle.removePin(webContentsId));

// 全部贴图保存为一个目录
async function pinSaveAll() {
  if (!windows.pinCount()) return;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择目录保存全部贴图',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.get().general.saveDir || app.getPath('pictures'),
  });
  if (canceled || !filePaths[0]) return;
  const syncResult = await windows.syncPinsContent({ timeoutMs: 5000 });
  if (!syncResult.ok) {
    const failures = syncResult.results
      .filter((item) => !item.ok)
      .slice(0, 5)
      .map((item) => `贴图 ${item.webContentsId}: ${item.error}`)
      .join('\n');
    dialog.showErrorBox('保存全部贴图失败', failures || '贴图内容同步失败，请重试。');
    return;
  }
  const snaps = windows.pinSnapshots();
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
function shortcutBindings(sc) {
  const bindings = [
    { key: 'capture', accelerator: sc.capture, callback: () => startCapture('region') },
    { key: 'ocr', accelerator: sc.ocr, callback: () => startCapture('ocr') },
    { key: 'longShot', accelerator: sc.longShot, callback: () => startCapture('long') },
    { key: 'record', accelerator: sc.record, callback: () => startCapture('record') },
    { key: 'pinClipboard', accelerator: sc.pinClipboard, callback: () => pinFromClipboard() },
    {
      key: 'pinRestore',
      accelerator: sc.pinRestore,
      callback: () => {
        if (!windows.restoreLastPin()) {
          dialog.showMessageBox({ type: 'info', message: '没有可恢复的贴图', detail: '关闭过的贴图会保留最近 10 条，可用此快捷键恢复。' });
        }
      },
    },
  ];
  if (process.platform === 'darwin') {
    bindings.push({
      key: 'translate',
      accelerator: sc.translate,
      callback: () => { triggerGlobalTranslate().catch(() => {}); },
    });
  }
  return bindings;
}

function registerShortcuts(nextShortcuts, previousShortcuts) {
  const next = nextShortcuts || config.get().shortcuts;
  const previous = previousShortcuts ? shortcutBindings(previousShortcuts) : [];
  const result = replaceShortcutBindings({
    reset: () => globalShortcut.unregisterAll(),
    // 穿透恢复键必须每次在普通可配置快捷键之前重注册；
    // 若用户配置撞了这个保留键，新配置会失败并回滚，脱困能力仍优先。
    restoreReserved: () => passthroughShortcutLifecycle.onGlobalShortcutsReset(),
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  }, shortcutBindings(next), previous);
  if (!result.ok) {
    const failed = result.error && result.error.failed && result.error.failed[0];
    console.error('[shortcut] 快捷键替换失败，已尝试回滚：', failed || result.error);
  }
  return result;
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
      { label: 'LaTeX 公式贴图…', click: () => windows.createFormula() },
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
  // 安全：统一拦截所有窗口的「新窗口打开」与「页内导航」——外链走系统浏览器，禁止导航到非本地(file://)页面，
  // 即使渲染层被注入也无法把窗口导到外部 URL。必须在恢复贴图或创建任何其他窗口之前注册。
  // P1-1(M4) 收紧：file:// 也只允许导航到应用自身渲染层目录（防被注入后把窗口导到本机任意本地文件渲染）。
  const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
  const ALLOWED_FILE_PREFIX = pathToFileURL(RENDERER_ROOT + path.sep).toString();
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void openExternalHttpUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev, url) => {
      const okLocal = url.startsWith('file:') && url.startsWith(ALLOWED_FILE_PREFIX);
      if (!okLocal) {
        ev.preventDefault();
        void openExternalHttpUrl(url);
      }
    });
  });

  // 第二实例可能在首实例仍初始化 IPC/托盘时抵达：先排队，初始化完成后按到达顺序处理。
  let resolveLaunchHandlingReady;
  const launchHandlingReady = new Promise((resolve) => { resolveLaunchHandlingReady = resolve; });
  let secondInstanceQueue = Promise.resolve();
  app.on('second-instance', (_event, argv) => {
    secondInstanceQueue = secondInstanceQueue.then(async () => {
      await launchHandlingReady;
      const outcome = await handleLaunchArguments(argv);
      // 普通重复双击仍给出可见反馈；带自动化参数时只执行指定动作。
      if (!outcome.handled) windows.openSettings();
    }).catch((error) => {
      console.error('[second-instance] 处理失败：', error);
    });
  });

  app.whenReady().then(async () => {
    config.get();
    pinWorkspaceClosing = false;
    pinWorkspaceStore = createPinWorkspaceStore({
      rootDir: path.join(app.getPath('userData'), 'pin-workspace'),
    });
    installMediaPermissionPolicy(session.defaultSession, {
      allowedRecorderUrl: pathToFileURL(
        path.join(RENDERER_ROOT, 'recorder', 'recorder.html')
      ).toString(),
      getTrustedRole: windows.getTrustedRole,
    });
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
    registerIpc();
    const restoredPins = windows.restorePinWorkspace(pinWorkspaceStore);
    if (restoredPins) console.log(`[pin-workspace] 已恢复 ${restoredPins} 张贴图。`);
    if (process.platform === 'darwin' && app.dock) {
      try {
        const _ic = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
        if (!_ic.isEmpty()) app.dock.setIcon(_ic);
      } catch (_) {}
    }
    // 冒烟自检不注册全局快捷键、不改开机启动项、也不创建菜单栏常驻图标。
    if (!process.env.KK_SMOKE) {
      buildTray();
      registerShortcuts();
      applyLoginItem();
    }
    const initialLaunch = process.env.KK_SMOKE
      ? { handled: false, ok: true }
      : await handleLaunchArguments(process.argv);
    resolveLaunchHandlingReady();
    // 启动即打开桌面主窗口（快捷截图首页）——可在设置里关闭（纯托盘驻留）。
    // （KK_SMOKE 自检模式下由自检流程自行开窗，这里跳过避免重复）
    if (
      !process.env.KK_SMOKE
      && !initialLaunch.handled
      && config.get().general.openMainAtLaunch !== false
    ) windows.createMain('capture');

    // macOS：启动只记录明确阻断状态。not-determined 不得被当成拒绝；
    // 用户首次触发真实捕获时才由 macOS 显示系统授权请求。
    if (process.platform === 'darwin' && !process.env.KK_SMOKE) {
      const screenPermissionStatus = currentScreenPermissionStatus();
      if (screenPermissionStatus === 'denied' || screenPermissionStatus === 'restricted') {
        console.warn(`[权限] 屏幕录制状态为 ${screenPermissionStatus}，触发截图时会显示一次引导。`);
      }
    }

    // 冒烟自检：仅在 KK_SMOKE 环境变量下激活。每个页面都必须达到可观察的
    // 初始化状态才算通过；超时只用于判失败，不能再靠固定等待时间提前判绿。
    if (process.env.KK_SMOKE) {
      const problems = [];
      const checks = [];
      // 只用于回归测试：证明自检发现问题时会以非 0 退出，不会“报错但仍假绿”。
      if (process.env.KK_SMOKE_INJECT_PROBLEM) problems.push('[injected] smoke failure');
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

      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stateSummary = (state) => {
        try { return JSON.stringify(state); } catch (_) { return String(state); }
      };
      const DEFAULT_SMOKE_CHECK_TIMEOUT_MS = 3_000;
      // AI 窗口的 OCR 探针会真实冷启动 chi_sim+eng 离线 worker。GitHub 的
      // 全新 macOS runner 没有语言缓存，不能沿用普通 DOM 的 3 秒预算；这里
      // 略长于产品层 60 秒 OCR 超时，既容纳正常冷启动，也仍能让挂起明确失败。
      const OCR_SMOKE_CHECK_TIMEOUT_MS = 65_000;
      const waitForCondition = async (name, inspect, timeoutMs = DEFAULT_SMOKE_CHECK_TIMEOUT_MS) => {
        const deadline = Date.now() + timeoutMs;
        let lastState = '尚未执行';
        while (Date.now() < deadline) {
          try {
            const state = await inspect();
            if (state && state.ready === true) return state;
            lastState = stateSummary(state);
          } catch (error) {
            lastState = error && error.message ? error.message : String(error);
          }
          await delay(40);
        }
        throw new Error(`等待就绪超时；最后状态：${lastState}`);
      };
      const waitForRendererWithTimeout = (win, name, timeoutMs, probe, ...args) => waitForCondition(name, async () => {
        if (!win || win.isDestroyed()) return { ready: false, destroyed: true };
        try {
          const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(',');
          return await win.webContents.executeJavaScript(`(${probe.toString()})(${serializedArgs})`, true);
        } catch (error) {
          // 页面导航切换 execution context 时 executeJavaScript 会短暂失败；条件轮询会重试。
          return { ready: false, executionError: error && error.message };
        }
      }, timeoutMs);
      const waitForRenderer = (win, name, probe, ...args) => waitForRendererWithTimeout(
        win,
        name,
        DEFAULT_SMOKE_CHECK_TIMEOUT_MS,
        probe,
        ...args,
      );
      const recordCheck = async (name, task) => {
        try {
          const state = await task();
          checks.push(name);
          console.log(`KK_SMOKE_CHECK ${name} ok ${stateSummary(state)}`);
        } catch (error) {
          problems.push(`[${name}] ${error && error.message ? error.message : String(error)}`);
        }
      };

      const tinyPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const d = screen.getPrimaryDisplay();
      const syntheticRect = { x: 100, y: 100, width: 300, height: 200 };

      const runSmokeChecks = async () => {
        // 隔离 userData 天然为空；先创建一条真实历史，确保协议探针永远有明确样本，
        // 同时让菜单栏与设置页的历史 UI 有可验证的数据。
        await recordCheck('kkthumb', async () => {
          const fixture = history.add(tinyPng, 'region');
          if (!fixture) throw new Error('无法创建隔离历史夹具');
          const item = history.list().find((candidate) => candidate.id === fixture.id);
          if (!item || typeof item.thumb !== 'string' || !item.thumb.startsWith('kkthumb:')) {
            throw new Error('历史夹具没有生成 kkthumb URL');
          }
          const resp = await net.fetch(item.thumb);
          const buf = Buffer.from(await resp.arrayBuffer());
          const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
          const okPng = buf.length > pngMagic.length
            && pngMagic.every((byte, index) => buf[index] === byte);
          if (!resp.ok || !okPng) {
            throw new Error(`fetch status=${resp.status} bytes=${buf.length} png=${okPng}`);
          }
          return { ready: true, bytes: buf.length };
        });

        // 冒烟模式没有真实 tray，但窗口工厂本身仍必须覆盖；使用合成托盘坐标开窗。
        await recordCheck('popover', async () => {
          const popover = windows.togglePopover({
            x: d.bounds.x + 20,
            y: d.bounds.y,
            width: 24,
            height: 24,
          });
          try {
            return await waitForRenderer(popover, 'popover', function smokePopoverProbe() {
              const recentName = document.getElementById('recentName');
              const recentThumb = document.getElementById('recentThumb');
              const chipOcr = document.getElementById('chipOcr');
              const btnLong = document.getElementById('btnLong');
              const ready = location.pathname.endsWith('/popover/popover.html')
                && document.readyState === 'complete'
                && !!document.getElementById('pop')
                && !!btnLong && btnLong.textContent.trim() === '长截图'
                && !!recentName && recentName.textContent.startsWith('区域截图')
                && !!recentThumb && recentThumb.style.backgroundImage.includes('kkthumb://img/')
                && !!chipOcr && chipOcr.disabled === false;
              return { ready, page: location.pathname, recent: recentName && recentName.textContent };
            });
          } finally {
            windows.hidePopover();
          }
        });

        let mainWin = null;
        await recordCheck('main-capture', async () => {
          mainWin = windows.createMain('capture');
          return waitForRenderer(mainWin, 'main-capture', function smokeMainCaptureProbe(expectedVersion) {
            const active = document.querySelector('.nav-item[data-page="capture"].active');
            const title = document.getElementById('titlebar-page');
            const version = document.getElementById('app-version');
            const ready = location.pathname.endsWith('/main/main.html')
              && document.readyState === 'complete'
              && !!active
              && !!title && title.textContent.trim() === '快捷截图'
              && !!version && version.textContent.trim() === `版本 ${expectedVersion}`
              && !!document.querySelector('#page .cap-stage')
              && !!document.querySelector('#page .cap-actions')
              && !!document.querySelector('#page .cap-action[data-key="long"]');
            return {
              ready,
              page: location.pathname,
              title: title && title.textContent.trim(),
              version: version && version.textContent.trim(),
            };
          }, app.getVersion());
        });

        // 必须先证明 capture renderer 已安装 onNav，再发 settings 导航；随后用页面 DOM
        // 和异步历史数量共同证明导航与 preload/IPC 都真正到达设置页。
        await recordCheck('main-settings', async () => {
          mainWin = windows.openSettings();
          return waitForRenderer(mainWin, 'main-settings', function smokeMainSettingsProbe() {
            const active = document.querySelector('.nav-item[data-page="settings"].active');
            const title = document.getElementById('titlebar-page');
            const count = document.querySelector('#page .hist-count');
            const ready = location.pathname.endsWith('/main/main.html')
              && !!active
              && !!title && title.textContent.trim() === '设置'
              && !!document.querySelector('#page .settings-page')
              && !!document.querySelector('#page .settings-grid')
              && !!count && count.textContent.trim() === '1';
            return { ready, title: title && title.textContent.trim(), historyCount: count && count.textContent.trim() };
          });
        });

        await recordCheck('ai', async () => {
          // OCR 全程只走本地引擎；等待 OCR 明确结束，避免外网/API Key 依赖，也避免
          // AI 页刚画出静态 HTML 就被误判为加载成功。
          const aiWin = windows.openAIPanel({ mode: 'ocr', dataURL: tinyPng });
          const state = await waitForRendererWithTimeout(
            aiWin,
            'ai',
            OCR_SMOKE_CHECK_TIMEOUT_MS,
            function smokeAiProbe() {
              const title = document.getElementById('modeTitle');
              const thumb = document.getElementById('thumbImg');
              const block = document.getElementById('ocrBlock');
              const text = document.getElementById('ocrText');
              const shellReady = location.pathname.endsWith('/ai/ai.html')
                && !!title && title.textContent.trim() === '文字识别 OCR'
                && !!thumb && thumb.complete && thumb.naturalWidth === 1 && thumb.naturalHeight === 1
                && !!block && block.hidden === false
                && !!text;
              const placeholder = text && text.placeholder;
              const settled = placeholder === '（未识别到文字，可手动输入）'
                || placeholder === '识别失败';
              return {
                ready: shellReady && settled,
                title: title && title.textContent.trim(),
                ocr: placeholder,
              };
            },
          );
          if (state.ocr !== '（未识别到文字，可手动输入）') {
            throw new Error(`离线 OCR 未成功结束；状态：${state.ocr || '未知'}`);
          }
          return state;
        });

        await recordCheck('overlay', async () => {
          const overlayWin = windows.createOverlay(d, {
            dataURL: tinyPng,
            scaleFactor: d.scaleFactor || 1,
            displayId: d.id,
            width: d.size.width,
            height: d.size.height,
            mode: 'region',
          });
          return waitForRenderer(overlayWin, 'overlay', function smokeOverlayProbe() {
            const canvas = document.getElementById('bgCanvas');
            const primaryActions = Array.from(
              document.querySelectorAll('#actionGroup > .action-btn[data-action]'),
              (node) => node.dataset.action
            );
            const ready = location.pathname.endsWith('/overlay/overlay.html')
              && !!canvas && canvas.width === 1 && canvas.height === 1
              && !!document.getElementById('selection')
              && !!document.getElementById('toolbar')
              && primaryActions[0] === 'translate'
              && primaryActions[1] === 'ocr';
            return { ready, canvas: canvas && `${canvas.width}x${canvas.height}`, primaryActions };
          });
        });

        await recordCheck('pin', async () => {
          const pinWin = windows.createPin({
            dataURL: tinyPng,
            bounds: { x: d.bounds.x + 120, y: d.bounds.y + 120, width: 80, height: 80 },
          });
          return waitForRenderer(pinWin, 'pin', function smokePinProbe() {
            const image = document.getElementById('pinImg');
            const ready = location.pathname.endsWith('/pin/pin.html')
              && !!image && image.complete && image.naturalWidth === 1 && image.naturalHeight === 1
              && image.src.startsWith('data:image/png;base64,')
              && !!document.getElementById('pinToolbar');
            return { ready, image: image && `${image.naturalWidth}x${image.naturalHeight}` };
          });
        });

        await recordCheck('formula', async () => {
          const formulaWin = windows.createFormula();
          return waitForRenderer(formulaWin, 'formula', function smokeFormulaProbe() {
            const input = document.getElementById('formulaInput');
            const preview = document.getElementById('formulaPreview');
            const error = document.getElementById('formulaError');
            const create = document.getElementById('btnCreate');
            const ready = location.pathname.endsWith('/formula/formula.html')
              && document.readyState === 'complete'
              && typeof window.katex === 'object'
              && !!window.FormulaModel
              && !!input && input.value.includes('\\frac')
              && !!preview && preview.hidden === false
              && preview.querySelector('math') !== null
              && !!error && error.hidden === true
              && !!create && create.disabled === false;
            return {
              ready,
              katex: !!window.katex,
              mathml: !!preview && preview.querySelector('math') !== null,
            };
          });
        });

        await recordCheck('recorder', async () => {
          const recorder = windows.createRecorder({
            rect: syntheticRect,
            displayBounds: d.bounds,
            scaleFactor: d.scaleFactor || 1,
            displayId: d.id,
            displayIndex: screen.getAllDisplays().findIndex((item) => String(item.id) === String(d.id)),
            fps: 12,
            toGif: true,
          });
          await waitForRenderer(recorder.win, 'recorder-renderer', function smokeRecorderProbe() {
            const start = document.getElementById('btnStart');
            const stop = document.getElementById('btnStop');
            const ready = location.pathname.endsWith('/recorder/recorder.html')
              && !!start && start.hidden === false && start.disabled === false
              && !!stop && stop.hidden === true && stop.disabled === true
              && !!document.getElementById('timer');
            return { ready };
          });
          return waitForCondition('recorder-lifecycle', async () => {
            const state = windows.getRecorderState();
            return { ready: !!state && state.state === 'idle', state };
          });
        });

        await recordCheck('longshot', async () => {
          // 使用无效尺寸作为只在测试环境出现的初始化哨兵：renderer 只有收到
          // WINDOW_INIT 后才会禁用开始按钮并显示这段错误提示。
          const longshotWin = windows.createLongShot({
            rect: { ...syntheticRect, width: 0, height: 0 },
            displayBounds: d.bounds,
            scaleFactor: d.scaleFactor || 1,
            displayId: d.id,
          });
          return waitForRenderer(longshotWin, 'longshot', function smokeLongshotProbe() {
            const hint = document.getElementById('hint');
            const start = document.getElementById('btnStart');
            const ready = location.pathname.endsWith('/longshot/longshot.html')
              && !!hint && hint.textContent.trim() === '选区无效，请取消重来'
              && !!start && start.disabled === true;
            return { ready, hint: hint && hint.textContent.trim(), disabled: start && start.disabled };
          });
        });

        await recordCheck('translate-popup', async () => {
          const popupWin = windows.createTranslatePopup({ x: d.bounds.x + 200, y: d.bounds.y + 200 });
          await waitForRenderer(popupWin, 'translate-popup-shell', function smokeTranslateShellProbe() {
            return {
              ready: location.pathname.endsWith('/translate-popup/translate-popup.html')
                && document.readyState === 'complete'
                && !!document.getElementById('src')
                && !!document.getElementById('trans'),
            };
          });
          popupWin.webContents.send(C.TRANSLATE_POPUP_DATA, {
            text: 'hello world',
            target: '中文',
            translation: '你好，世界',
          });
          return waitForRenderer(popupWin, 'translate-popup-data', function smokeTranslateDataProbe() {
            const source = document.getElementById('src');
            const target = document.getElementById('target');
            const translation = document.getElementById('trans');
            const copy = document.getElementById('btnCopy');
            const ready = source && source.textContent === 'hello world'
              && target && target.textContent.trim() === '→ 中文'
              && translation && translation.textContent === '你好，世界'
              && copy && copy.disabled === false;
            return { ready, source: source && source.textContent, translation: translation && translation.textContent };
          });
        });
      };

      runSmokeChecks()
        .catch((error) => {
          problems.push('[smoke-runner] ' + (error && error.message ? error.message : String(error)));
        })
        .finally(() => {
          const ok = problems.length === 0;
          console.log('KK_SMOKE_RESULT ' + JSON.stringify({ ok, problems, checks }));
          smokeExitCode = ok ? 0 : 1;
          // 保持 pin renderer 存活，让 before-quit 能先完成安全关闭握手；
          // 窗口统一由 will-quit 的正式退出链关闭。
          app.quit();
        });
    }
  }).catch((error) => {
    // 防止初始化失败时第二实例队列永久悬挂；同时给出可诊断的原生错误。
    resolveLaunchHandlingReady();
    const message = (error && error.message) || String(error);
    console.error('[startup] 初始化失败：', error);
    try { dialog.showErrorBox('困困截图启动失败', message); } catch (_) {}
  });

  // 托盘应用：关掉所有窗口也不退出
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });

  // 点击程序坞图标 → 打开/聚焦桌面主窗口
  app.on('activate', () => {
    windows.createMain();
  });

  app.on('before-quit', (event) => {
    if (quitPrepared) return;
    event.preventDefault();
    if (quitPreparationInFlight) return;
    quitPreparationInFlight = prepareApplicationQuit({ interactive: !process.env.KK_SMOKE })
      .then((ready) => {
        quitPreparationInFlight = null;
        if (!ready) {
          relaunchAfterSafeQuit = false;
          windows.cancelPinClosePreparation();
          return;
        }
        quitPrepared = true;
        if (relaunchAfterSafeQuit) {
          relaunchAfterSafeQuit = false;
          app.relaunch();
        }
        app.quit();
      })
      .catch((error) => {
        quitPreparationInFlight = null;
        relaunchAfterSafeQuit = false;
        windows.cancelPinClosePreparation();
        const message = (error && error.message) || String(error);
        console.error('[quit] 退出准备失败：', error);
        try { dialog.showErrorBox('未能安全退出', `${message}\n\n应用已保持运行，请重试或先手动保存。`); } catch (_) {}
      });
  });

  app.on('will-quit', () => {
    pinWorkspaceClosing = true;
    recordActionMonitor.stopAll();
    timedCaptureScheduler.cancelAll();
    captureCoordinator.cancelPending('app-quit');
    savePinWorkspaceNow();
    passthroughShortcutLifecycle.dispose();
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
    // Electron 的 app.quit() 固定以 0 退出，不采纳 Node 的 process.exitCode。
    // 正常/故障注入冒烟都在完成上述正式退出清理后显式结束，避免成功码 0
    // 因为 falsy 跳过 app.exit 而偶发挂住，同时保留失败码 1。
    if (process.env.KK_SMOKE && smokeExitCode !== null) app.exit(smokeExitCode);
  });
}

module.exports = { createPassthroughShortcutLifecycle };
