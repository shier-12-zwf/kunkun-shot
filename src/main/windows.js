// 窗口工厂：集中创建截图层 / 贴图 / 设置 / AI 面板 / 录屏控制条。
const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');
const C = require('../shared/channels');
const { requireImageDataURL, normalizePinBounds } = require('./ipc-validation');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

function rfile(...p) {
  return path.join(RENDERER, ...p);
}

// 单例窗口引用
const refs = { settings: null, ai: null, main: null };
let popoverWin = null;
// 截图层一次一个
let overlayWin = null;
// 贴图窗口可以有多个
const pins = new Set();
// 贴图内容登记：webContents.id -> 原始 payload（批量保存 / 历史恢复用）
const pinPayloads = new Map();
// 最近关闭的贴图（Ctrl+3 / 托盘「恢复最近关闭的贴图」）
const pinHistory = [];
// 明确销毁的贴图不得进入恢复历史；WeakSet 不延长窗口或敏感 payload 的生命周期。
const suppressPinHistory = new WeakSet();
// 录屏控制条
let recorderWin = null;

// ---- M1 修复：受信 webContents 登记表 ----
// 只有经本窗口工厂创建的窗口，其 IPC 请求才被接受；窗口销毁即除名。
// main.js 的 registerIpc 会统一拦截所有 ipcMain.handle 调用并校验 sender。
const trustedWebContents = new Map();
function trackWindow(win, role) {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  trustedWebContents.set(id, role);
  win.webContents.once('destroyed', () => trustedWebContents.delete(id));
}
function isTrustedSender(id, allowedRoles) {
  const role = trustedWebContents.get(id);
  if (!role) return false;
  return !allowedRoles || allowedRoles.includes(role);
}
// 统一创建入口：所有窗口经此创建并自动登记为受信来源
function newTrackedWindow(opts, role) {
  const win = new BrowserWindow(opts);
  trackWindow(win, role);
  return win;
}

function baseWebPrefs() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    // H1 修复：开启 Chromium OS 沙箱（纵深防御）。preload 只用 contextBridge/ipcRenderer，
    // 且通道契约已内联进 preload.js（沙箱化 preload 不能 require 本地文件）。
    sandbox: true,
  };
}

function whenLoaded(win, data) {
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send(C.WINDOW_INIT, data);
  });
}

// ---- 截图层（覆盖某个显示器）----
function createOverlay(display, captureData) {
  closeOverlay();
  const b = display.bounds;
  const win = newTrackedWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'overlay');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('overlay', 'overlay.html'));
  whenLoaded(win, { ...captureData, displayBounds: b });
  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });
  overlayWin = win;
  return win;
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
}

// ---- 贴图窗口 ----
function createPin(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('贴图数据无效。');
  const bounds = normalizePinBounds(payload.bounds);
  const safePayload = { bounds };
  if (payload.dataURL) {
    safePayload.dataURL = requireImageDataURL(payload.dataURL);
  } else if (typeof payload.text === 'string' && payload.text.length <= 1024 * 1024) {
    safePayload.text = payload.text;
  } else if (typeof payload.color === 'string' && payload.color.length <= 128) {
    safePayload.color = payload.color;
  } else if (
    typeof payload.file === 'string' &&
    payload.file.length <= 8192 &&
    path.isAbsolute(payload.file) &&
    fs.existsSync(payload.file)
  ) {
    safePayload.file = path.resolve(payload.file);
  } else {
    throw new Error('贴图内容无效。');
  }
  const win = newTrackedWindow({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(40, Math.round(bounds.width)),
    height: Math.max(40, Math.round(bounds.height)),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: true,
    minWidth: 32,
    minHeight: 32,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'pin');
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(rfile('pin', 'pin.html'));
  whenLoaded(win, safePayload);
  pins.add(win);
  pinPayloads.set(win.webContents.id, safePayload);
  win.on('closed', () => {
    pins.delete(win);
    pinPayloads.delete(win.webContents.id);
    const shouldSuppressHistory = suppressPinHistory.delete(win);
    if (!shouldSuppressHistory) {
      // 正常关闭的贴图进历史（最多保留 10 条），供 Ctrl+3 恢复
      pinHistory.push(safePayload);
      if (pinHistory.length > 10) pinHistory.shift();
    }
  });
  return win;
}

// ---- 设置 ----
// 统一走桌面主窗口的「设置」页（src/renderer/main + main/pages/settings.js）。
// 旧的独立设置窗（原 src/renderer/settings/）已退役并删除：所有设置入口都进新页，
// 彻底消除「两套设置页枚举不一致 → 回显错乱」（MED-3/8）以及「新页修了、旧页没修」的分叉。
function openSettings() {
  return createMain('settings');
}

// ---- AI 面板 ----
// payload: { mode:'ask'|'ocr'|'translate'|'polish', dataURL?, text? }
function openAIPanel(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const mode = typeof raw.mode === 'string' ? raw.mode : 'ask';
  if (!['ask', 'ocr', 'translate', 'polish', 'translateImage'].includes(mode)) {
    throw new Error('AI 面板模式无效。');
  }
  const safePayload = { mode };
  if (raw.dataURL != null) safePayload.dataURL = requireImageDataURL(raw.dataURL);
  if (raw.text != null) {
    if (typeof raw.text !== 'string' || raw.text.length > 1024 * 1024) throw new Error('AI 文本无效或过长。');
    safePayload.text = raw.text;
  }
  if (refs.ai && !refs.ai.isDestroyed()) {
    refs.ai.show();
    refs.ai.focus();
    refs.ai.webContents.send(C.WINDOW_INIT, safePayload);
    return refs.ai;
  }
  const win = newTrackedWindow({
    width: 480,
    height: 600,
    minWidth: 360,
    minHeight: 420,
    title: 'AI · 困困截图工具',
    resizable: true,
    maximizable: true,
    alwaysOnTop: true,
    webPreferences: baseWebPrefs(),
  }, 'ai');
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(rfile('ai', 'ai.html'));
  whenLoaded(win, safePayload);
  win.on('closed', () => (refs.ai = null));
  refs.ai = win;
  return win;
}

// ---- 录屏控制条 ----
// 放在录制区域下方（区域外），避免把控制条录进画面。
function createRecorder(initData) {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.close();
  const r = initData.rect;
  const db = initData.displayBounds;
  const barW = 380;
  const barH = 56;
  let x = Math.round(db.x + r.x + r.width / 2 - barW / 2);
  let y = Math.round(db.y + r.y + r.height + 10);
  // 越界则放到区域上方
  if (y + barH > db.y + db.height) y = Math.round(db.y + r.y - barH - 10);
  x = Math.max(db.x, Math.min(x, db.x + db.width - barW));
  const win = newTrackedWindow({
    x,
    y,
    width: barW,
    height: barH,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'recorder');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('recorder', 'recorder.html'));
  whenLoaded(win, initData);
  win.on('closed', () => {
    if (recorderWin === win) recorderWin = null;
  });
  recorderWin = win;
  return win;
}

function closeRecorder() {
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.close();
  recorderWin = null;
}

// ---- 长截图控制条 ----
let longShotWin = null;
function createLongShot(initData) {
  if (longShotWin && !longShotWin.isDestroyed()) longShotWin.close();
  const r = initData.rect;
  const db = initData.displayBounds;
  const barW = 460;
  const barH = 60;
  let x = Math.round(db.x + r.x + r.width / 2 - barW / 2);
  let y = Math.round(db.y + r.y + r.height + 10);
  if (y + barH > db.y + db.height) y = Math.round(db.y + r.y - barH - 10);
  x = Math.max(db.x, Math.min(x, db.x + db.width - barW));
  const win = newTrackedWindow({
    x,
    y,
    width: barW,
    height: barH,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'longshot');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('longshot', 'longshot.html'));
  whenLoaded(win, initData);
  win.on('closed', () => {
    if (longShotWin === win) longShotWin = null;
  });
  longShotWin = win;
  return win;
}

function closeLongShot() {
  if (longShotWin && !longShotWin.isDestroyed()) longShotWin.close();
  longShotWin = null;
}

// ---- 桌面主窗口（快捷截图 / 历史记录 / AI 工作台 / 设置 四页） ----
function createMain(page) {
  const safePage = ['capture', 'history', 'ai', 'settings'].includes(page) ? page : 'capture';
  if (refs.main && !refs.main.isDestroyed()) {
    refs.main.show();
    refs.main.focus();
    if (page) refs.main.webContents.send(C.MAIN_NAV, { page: safePage });
    return refs.main;
  }
  const win = newTrackedWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    title: '困困截图工具',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f7fc',
    webPreferences: baseWebPrefs(),
  }, 'main');
  win.loadFile(rfile('main', 'main.html'));
  whenLoaded(win, { page: safePage });
  win.on('closed', () => (refs.main = null));
  refs.main = win;
  return win;
}

// ---- 菜单栏弹窗 ----
function togglePopover(trayBounds) {
  if (popoverWin && !popoverWin.isDestroyed()) {
    popoverWin.close();
    popoverWin = null;
    return null;
  }
  const w = 340;
  const h = 548;
  let x = 0;
  let y = 0;
  if (trayBounds) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - w / 2);
    y = Math.round(trayBounds.y + trayBounds.height + 4);
    const disp = screen.getDisplayNearestPoint({ x: Math.round(trayBounds.x), y: Math.round(trayBounds.y) });
    const wa = disp.workArea;
    x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - w - 6));
  }
  const win = newTrackedWindow({
    x,
    y,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'popover');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('popover', 'popover.html'));
  win.on('blur', () => {
    if (popoverWin && !popoverWin.isDestroyed()) popoverWin.close();
  });
  win.on('closed', () => {
    if (popoverWin === win) popoverWin = null;
  });
  popoverWin = win;
  return win;
}

function hidePopover() {
  if (popoverWin && !popoverWin.isDestroyed()) popoverWin.close();
  popoverWin = null;
}

// ---- 划词翻译卡片 ----
// 全局划词翻译触发后，在鼠标附近弹一张小卡片显示原文+译文。
// 单例：新的一次划词会复用/重建。窗口失焦即关闭（点别处就消失，符合直觉）。
let translatePopupWin = null;
function createTranslatePopup(anchor) {
  if (translatePopupWin && !translatePopupWin.isDestroyed()) {
    translatePopupWin.close();
    translatePopupWin = null;
  }
  const w = 360;
  const h = 240;
  // anchor: 鼠标屏幕坐标。卡片出现在鼠标右下方，并收敛进当前显示器工作区。
  const pt = anchor || screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const wa = disp.workArea;
  let x = pt.x + 12;
  let y = pt.y + 16;
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - w - 6));
  y = Math.max(wa.y + 6, Math.min(y, wa.y + wa.height - h - 6));
  const win = newTrackedWindow({
    x,
    y,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'translate-popup');
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('translate-popup', 'translate-popup.html'));
  win.on('blur', () => {
    if (translatePopupWin && !translatePopupWin.isDestroyed()) translatePopupWin.close();
  });
  win.on('closed', () => {
    if (translatePopupWin === win) translatePopupWin = null;
  });
  translatePopupWin = win;
  return win;
}

function getTranslatePopup() {
  return translatePopupWin && !translatePopupWin.isDestroyed() ? translatePopupWin : null;
}

function closeTranslatePopup() {
  if (translatePopupWin && !translatePopupWin.isDestroyed()) translatePopupWin.close();
  translatePopupWin = null;
}

// 历史变动等需要广播到主窗口/弹窗
function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  });
}

// ---- 贴图批量操作（托盘菜单用）----
function pinSnapshots() {
  const out = [];
  pins.forEach((w) => {
    if (!w.isDestroyed()) out.push({ win: w, payload: pinPayloads.get(w.webContents.id) || {} });
  });
  return out;
}
function pinBroadcast(cmd) {
  pins.forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send(C.PIN_CMD, cmd);
  });
}
function pinAllThumbnail(on) {
  pinBroadcast({ cmd: 'thumb', on: !!on });
}
function pinAllClose() {
  pinSnapshots().forEach(({ win }) => win.close());
}
function pinAllDestroy() {
  // 销毁：不进历史
  pinSnapshots().forEach(({ win }) => {
    suppressPinHistory.add(win);
    pinPayloads.delete(win.webContents.id);
    win.destroy();
  });
}
function restoreLastPin() {
  while (pinHistory.length) {
    const p = pinHistory.pop();
    if (p && (p.dataURL || p.text || p.color || p.file)) {
      createPin(p);
      return true;
    }
  }
  return false;
}
function pinCount() {
  return pins.size;
}

function closeAll() {
  closeOverlay();
  closeRecorder();
  closeLongShot();
  hidePopover();
  closeTranslatePopup();
  for (const p of pins) if (!p.isDestroyed()) p.close();
}

module.exports = {
  createOverlay,
  closeOverlay,
  createPin,
  openSettings,
  openAIPanel,
  createRecorder,
  closeRecorder,
  createLongShot,
  closeLongShot,
  createMain,
  togglePopover,
  hidePopover,
  createTranslatePopup,
  getTranslatePopup,
  closeTranslatePopup,
  broadcast,
  closeAll,
  isTrustedSender,
  getTrustedRole: (id) => trustedWebContents.get(id) || null,
  pinSnapshots,
  pinBroadcast,
  pinAllThumbnail,
  pinAllClose,
  pinAllDestroy,
  restoreLastPin,
  pinCount,
  getPinPayload: (id) => pinPayloads.get(id) || null,
  getOverlay: () => overlayWin,
  getMain: () => refs.main,
};
