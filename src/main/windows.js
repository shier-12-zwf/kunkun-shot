// 窗口工厂：集中创建截图层 / 贴图 / 设置 / AI 面板 / 录屏控制条。
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const C = require('../shared/channels');

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
// 录屏控制条
let recorderWin = null;

// ---- M1 修复：受信 webContents 登记表 ----
// 只有经本窗口工厂创建的窗口，其 IPC 请求才被接受；窗口销毁即除名。
// main.js 的 registerIpc 会统一拦截所有 ipcMain.handle 调用并校验 sender。
const trustedWebContents = new Set();
function trackWindow(win) {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  trustedWebContents.add(id);
  win.webContents.once('destroyed', () => trustedWebContents.delete(id));
}
function isTrustedSender(id) {
  return trustedWebContents.has(id);
}
// 统一创建入口：所有窗口经此创建并自动登记为受信来源
function newTrackedWindow(opts) {
  const win = new BrowserWindow(opts);
  trackWindow(win);
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
  });
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
  const dataURL = payload && payload.dataURL;
  const bounds = payload && payload.bounds;
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
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(rfile('pin', 'pin.html'));
  whenLoaded(win, payload);
  pins.add(win);
  win.on('closed', () => pins.delete(win));
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
  if (refs.ai && !refs.ai.isDestroyed()) {
    refs.ai.show();
    refs.ai.focus();
    refs.ai.webContents.send(C.WINDOW_INIT, payload);
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
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(rfile('ai', 'ai.html'));
  whenLoaded(win, payload);
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
  });
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
  });
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
  if (refs.main && !refs.main.isDestroyed()) {
    refs.main.show();
    refs.main.focus();
    if (page) refs.main.webContents.send(C.MAIN_NAV, { page });
    return refs.main;
  }
  const win = newTrackedWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    title: '困困截屏助手',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f7fc',
    webPreferences: baseWebPrefs(),
  });
  win.loadFile(rfile('main', 'main.html'));
  whenLoaded(win, { page: page || 'capture' });
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
  });
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
  });
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
  getOverlay: () => overlayWin,
  getMain: () => refs.main,
};
