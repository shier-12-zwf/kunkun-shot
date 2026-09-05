// 窗口工厂：集中创建截图层 / 贴图 / 设置 / AI 面板 / 录屏控制条。
const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');
const { version: APP_VERSION } = require('../../package.json');
const C = require('../shared/channels');
const { requireImageDataURL, normalizePinBounds } = require('./ipc-validation');
const { normalizePinWorkspaceState } = require('./pin-workspace-store');
const { calculateLongshotLayout, rectanglesOverlap, normalizeLongshotPresentation } = require('./longshot-presentation');
const {
  RECORDER_STATES,
  decideRecorderWindowOpen,
  canCloseRecorderWindow,
  normalizeRecorderLifecycleSnapshot,
} = require('../shared/recorder-lifecycle');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

function rfile(...p) {
  return path.join(RENDERER, ...p);
}

// 单例窗口引用
const refs = { settings: null, ai: null, main: null, formula: null };
let popoverWin = null;
// 截图层一次一个
let overlayWin = null;
// 截图来源只由主进程窗口工厂登记，渲染层提交结果时不能伪造历史类型。
const overlayCaptureTypes = new Map();
// 贴图窗口可以有多个
const pins = new Set();
// 贴图内容登记：webContents.id -> 原始 payload（批量保存 / 历史恢复用）
const pinPayloads = new Map();
// 折叠状态只属于当前会话，绝不持久化（否则恢复工作区后可能得到不可见且无入口的窗口）。
// 每组始终保留 anchorId 对应的可见贴图，用户可从它重新展开整组。
const collapsedPinGroups = new Map();
let pinGroupSequence = 0;
// 最近关闭的贴图（Ctrl+3 / 托盘「恢复最近关闭的贴图」）
const pinHistory = [];
// 明确销毁的贴图不得进入恢复历史；WeakSet 不延长窗口或敏感 payload 的生命周期。
const suppressPinHistory = new WeakSet();
// 主进程里的穿透快捷键按 webContents.id 跟踪贴图；窗口关闭/销毁时必须同步除名，
// 否则最后一张穿透贴图消失后仍会永久占用全局恢复快捷键。
const pinRemovedListeners = new Set();
// 贴图的内容、状态或实时窗口位置发生变化时通知持久化层。
const pinWorkspaceChangedListeners = new Set();
// 应用退出前，每个贴图都要确认 renderer 的最新合成图已进入主进程。
// Map 只保留当前轮次，超时、回执或窗口销毁都会立即清理。
const pinCloseWaiters = new Map();
let pinCloseRequestSequence = 0;
// “保存全部”只需要一个不冻结编辑的时点快照，使用独立 waiter，避免与退出屏障互相覆盖。
const pinSyncWaiters = new Map();
let pinSyncRequestSequence = 0;
// 录屏控制条
let recorderWin = null;
let recorderLifecycleState = null;
const forceClosingRecorderWindows = new WeakSet();

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

function normalizeOverlayCaptureType(captureData, fallback) {
  const raw = captureData && typeof captureData === 'object' ? captureData : {};
  const requested = raw.captureType || (raw.mode === 'fullscreen' ? 'fullscreen' : fallback);
  return ['region', 'fullscreen', 'window'].includes(requested) ? requested : fallback;
}

function trackOverlayCaptureType(win, captureType) {
  if (!win || win.isDestroyed()) return;
  const id = win.webContents.id;
  overlayCaptureTypes.set(id, captureType);
  win.webContents.once('destroyed', () => overlayCaptureTypes.delete(id));
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

function hydratePinOnEveryLoad(win, webContentsId) {
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    const latestPayload = pinPayloads.get(webContentsId);
    if (latestPayload) win.webContents.send(C.WINDOW_INIT, latestPayload);
  });
}

function calculateImageEditorLayout(display, image) {
  const workArea = display && (display.workArea || display.bounds);
  const x = Number(workArea && workArea.x);
  const y = Number(workArea && workArea.y);
  const workWidth = Number(workArea && workArea.width);
  const workHeight = Number(workArea && workArea.height);
  if (
    !Number.isFinite(x) || !Number.isFinite(y) ||
    !Number.isFinite(workWidth) || !Number.isFinite(workHeight) ||
    Math.abs(x) > 100000 || Math.abs(y) > 100000 ||
    workWidth < 1 || workHeight < 1 || workWidth > 16384 || workHeight > 16384
  ) throw new Error('编辑器显示区域无效。');

  const pixelWidth = Number(image && image.pixelWidth);
  const pixelHeight = Number(image && image.pixelHeight);
  if (
    !Number.isInteger(pixelWidth) || !Number.isInteger(pixelHeight) ||
    pixelWidth < 1 || pixelHeight < 1 ||
    pixelWidth > 32768 || pixelHeight > 32768 ||
    pixelWidth * pixelHeight > 100000000
  ) throw new Error('图片尺寸无效或过大。');

  const availableWidth = Math.max(1, Math.min(8192, Math.floor(workWidth)));
  const availableHeight = Math.max(1, Math.min(8192, Math.floor(workHeight)));
  const fit = Math.min(1, availableWidth / pixelWidth, availableHeight / pixelHeight);
  // 两轴分别向下取整，保证永不越过 workArea。不同的有效采样比例随 payload
  // 一起传给 overlay，从而避免非整数缩放时丢掉原图最后一行/列。
  const width = Math.max(1, Math.floor(pixelWidth * fit));
  const height = Math.max(1, Math.floor(pixelHeight * fit));
  const bounds = {
    x: Math.round(x + Math.floor((workWidth - width) / 2)),
    y: Math.round(y + Math.floor((workHeight - height) / 2)),
    width,
    height,
  };
  const scaleFactorX = pixelWidth / width;
  const scaleFactorY = pixelHeight / height;
  return {
    bounds,
    pixelWidth,
    pixelHeight,
    scaleFactor: scaleFactorX,
    scaleFactorX,
    scaleFactorY,
  };
}

function calculateCaptureControlBounds({ rect, displayBounds, width, height, gap = 10 }) {
  const db = displayBounds && typeof displayBounds === 'object' ? displayBounds : {};
  const selection = rect && typeof rect === 'object' ? rect : {};
  const displayX = Number(db.x);
  const displayY = Number(db.y);
  const displayWidth = Number(db.width);
  const displayHeight = Number(db.height);
  const rectX = Number(selection.x);
  const rectY = Number(selection.y);
  const rectWidth = Number(selection.width);
  const rectHeight = Number(selection.height);
  const requestedWidth = Number(width);
  const requestedHeight = Number(height);
  const spacing = Math.max(0, Math.round(Number(gap) || 0));
  const values = [
    displayX, displayY, displayWidth, displayHeight,
    rectX, rectY, rectWidth, rectHeight,
    requestedWidth, requestedHeight,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('控制条窗口参数无效。');
  }
  if (displayWidth < 1 || displayHeight < 1 || requestedWidth < 1 || requestedHeight < 1) {
    throw new RangeError('控制条窗口尺寸无效。');
  }

  const controlWidth = Math.min(Math.floor(displayWidth), Math.floor(requestedWidth));
  const controlHeight = Math.min(Math.floor(displayHeight), Math.floor(requestedHeight));
  const minX = Math.round(displayX);
  const minY = Math.round(displayY);
  const maxX = Math.round(displayX + displayWidth - controlWidth);
  const maxY = Math.round(displayY + displayHeight - controlHeight);
  const preferredX = Math.round(displayX + rectX + rectWidth / 2 - controlWidth / 2);
  const belowY = Math.round(displayY + rectY + rectHeight + spacing);
  const aboveY = Math.round(displayY + rectY - controlHeight - spacing);

  let controlY;
  if (belowY <= maxY) controlY = belowY;
  else if (aboveY >= minY) controlY = aboveY;
  else controlY = Math.max(minY, Math.min(belowY, maxY));

  return {
    x: Math.max(minX, Math.min(preferredX, maxX)),
    y: controlY,
    width: controlWidth,
    height: controlHeight,
  };
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
  trackOverlayCaptureType(win, normalizeOverlayCaptureType(captureData, 'region'));
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

// ---- 任意窗口/整屏图像的独立编辑窗 ----
// 和显示器覆盖层共用 overlay 角色、预加载安全设置与单例生命周期。
function createImageEditor(display, captureData) {
  const raw = captureData && typeof captureData === 'object' && !Array.isArray(captureData)
    ? captureData
    : {};
  const dataURL = requireImageDataURL(raw.dataURL);
  const layout = calculateImageEditorLayout(display, raw);
  const mode = raw.mode === 'fullscreen' ? 'fullscreen' : 'image';
  closeOverlay();

  const b = layout.bounds;
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
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'overlay');
  trackOverlayCaptureType(win, normalizeOverlayCaptureType(raw, mode === 'fullscreen' ? 'fullscreen' : 'region'));
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(rfile('overlay', 'overlay.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    const actual = typeof win.getBounds === 'function' ? win.getBounds() : b;
    const width = Math.max(1, Math.round(actual.width));
    const height = Math.max(1, Math.round(actual.height));
    win.webContents.send(C.WINDOW_INIT, {
      ...raw,
      dataURL,
      mode,
      displayId: raw.displayId != null ? raw.displayId : display && display.id,
      width,
      height,
      pixelWidth: layout.pixelWidth,
      pixelHeight: layout.pixelHeight,
      scaleFactor: layout.pixelWidth / width,
      scaleFactorX: layout.pixelWidth / width,
      scaleFactorY: layout.pixelHeight / height,
      displayBounds: {
        x: Math.round(actual.x),
        y: Math.round(actual.y),
        width,
        height,
      },
    });
  });
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
function onPinRemoved(listener) {
  if (typeof listener !== 'function') throw new TypeError('贴图移除监听器必须是函数。');
  pinRemovedListeners.add(listener);
  return () => pinRemovedListeners.delete(listener);
}

function onPinWorkspaceChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('贴图工作区监听器必须是函数。');
  pinWorkspaceChangedListeners.add(listener);
  return () => pinWorkspaceChangedListeners.delete(listener);
}

function notifyPinWorkspaceChanged(reason) {
  pinWorkspaceChangedListeners.forEach((listener) => {
    try { listener(reason); } catch (err) { console.error('[pin] 工作区监听器失败：', err); }
  });
}

function settlePinCloseWaiter(webContentsId, result) {
  const waiter = pinCloseWaiters.get(webContentsId);
  if (!waiter) return false;
  pinCloseWaiters.delete(webContentsId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
  return true;
}

function settlePinSyncWaiter(webContentsId, result) {
  const waiter = pinSyncWaiters.get(webContentsId);
  if (!waiter) return false;
  pinSyncWaiters.delete(webContentsId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
  return true;
}

function removeTrackedPin(win, webContentsId, payload) {
  // closed 与显式 destroy 可能先后触发；以 Set.delete 的返回值保证只清理、通知一次。
  if (!pins.has(win)) return false;
  const removedGroupId = payload && payload.state && payload.state.groupId;
  if (removedGroupId && collapsedPinGroups.has(removedGroupId)) expandPinGroup(removedGroupId);
  pins.delete(win);
  settlePinCloseWaiter(webContentsId, {
    ok: false,
    webContentsId,
    error: '贴图窗口在退出同步完成前已关闭。',
  });
  settlePinSyncWaiter(webContentsId, {
    ok: false,
    webContentsId,
    error: '贴图窗口在内容同步完成前已关闭。',
  });
  pinPayloads.delete(webContentsId);
  if (removedGroupId) {
    const remaining = pinGroupMembers(removedGroupId);
    if (remaining.length < 2) remaining.forEach((member) => setPinGroupId(member, ''));
  }
  const shouldSuppressHistory = suppressPinHistory.delete(win);
  if (!shouldSuppressHistory && payload) {
    // 正常关闭的贴图进历史（最多保留 10 条），供 Ctrl+3 恢复
    pinHistory.push(payload);
    if (pinHistory.length > 10) pinHistory.shift();
  }
  pinRemovedListeners.forEach((listener) => {
    try { listener(webContentsId); } catch (err) { console.error('[pin] 移除监听器失败：', err); }
  });
  notifyPinWorkspaceChanged('remove');
  return true;
}

function applyPinWorkspaceState(win, state) {
  if (!win || win.isDestroyed() || !state) return;
  if (state.onTop != null) win.setAlwaysOnTop(state.onTop, 'floating');
  if (state.opacity != null && typeof win.setOpacity === 'function') win.setOpacity(state.opacity);
  if (state.locked != null && typeof win.setResizable === 'function') win.setResizable(!state.locked);
  if (state.title != null && typeof win.setTitle === 'function') win.setTitle(state.title);
}

function createPin(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('贴图数据无效。');
  const bounds = normalizePinBounds(payload.bounds);
  const safePayload = { bounds };
  if (payload.dataURL) {
    safePayload.dataURL = requireImageDataURL(payload.dataURL);
    safePayload.contentRevision = Number.isSafeInteger(payload.contentRevision) && payload.contentRevision >= 0
      ? payload.contentRevision
      : 0;
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
  const state = normalizePinWorkspaceState(payload.state);
  if (state) safePayload.state = state;
  const keepOnTop = !state || state.onTop !== false;
  const win = newTrackedWindow({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(40, Math.round(bounds.width)),
    height: Math.max(40, Math.round(bounds.height)),
    frame: false,
    transparent: true,
    alwaysOnTop: keepOnTop,
    skipTaskbar: true,
    resizable: true,
    hasShadow: true,
    minWidth: 32,
    minHeight: 32,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  }, 'pin');
  if (safePayload.dataURL && typeof win.setAspectRatio === 'function') {
    // 图片贴图的 bounds 由原图尺寸等比计算；把该比例交给原生窗口管理器，
    // 避免用户拖拽边缘后出现“图片正常解码但窗口把它拉伸成空白/变形”的错觉。
    win.setAspectRatio(bounds.width / bounds.height);
  }
  win.setAlwaysOnTop(keepOnTop, 'floating');
  applyPinWorkspaceState(win, state);
  pins.add(win);
  const webContentsId = win.webContents.id;
  pinPayloads.set(webContentsId, safePayload);
  hydratePinOnEveryLoad(win, webContentsId);
  win.loadFile(rfile('pin', 'pin.html'));
  win.on('move', () => notifyPinWorkspaceChanged('bounds'));
  win.on('resize', () => notifyPinWorkspaceChanged('bounds'));
  win.on('closed', () => {
    removeTrackedPin(win, webContentsId, safePayload);
  });
  notifyPinWorkspaceChanged('create');
  return win;
}

function updatePinWorkspaceState(webContentsId, patch) {
  const payload = pinPayloads.get(webContentsId);
  if (!payload) throw new Error('贴图窗口不存在。');
  const patchState = normalizePinWorkspaceState(patch);
  if (!patchState) return payload.state || {};
  const merged = normalizePinWorkspaceState({ ...(payload.state || {}), ...patchState }) || {};
  payload.state = merged;
  const win = Array.from(pins).find((candidate) => (
    !candidate.isDestroyed() && candidate.webContents.id === webContentsId
  ));
  applyPinWorkspaceState(win, merged);
  notifyPinWorkspaceChanged('state');
  return merged;
}

function updatePinContent(webContentsId, update) {
  const payload = pinPayloads.get(webContentsId);
  if (!payload || typeof payload.dataURL !== 'string') throw new Error('图片贴图窗口不存在。');
  if (!update || typeof update !== 'object') throw new Error('贴图内容更新无效。');

  const current = Number.isSafeInteger(payload.contentRevision) ? payload.contentRevision : 0;
  const isExactReplay = (
    update.revision === current &&
    update.baseRevision === current - 1 &&
    update.dataURL === payload.dataURL
  );
  if (isExactReplay) return { revision: current };

  if (update.baseRevision !== current || update.revision !== current + 1) {
    throw new Error('贴图内容版本已过期，请重试。');
  }
  payload.dataURL = update.dataURL;
  payload.contentRevision = update.revision;
  notifyPinWorkspaceChanged('content');
  return { revision: update.revision };
}

function findPin(webContentsId) {
  return Array.from(pins).find((candidate) => (
    !candidate.isDestroyed() && candidate.webContents.id === webContentsId
  )) || null;
}

function pinGroupIdOf(win) {
  const payload = win && !win.isDestroyed() ? pinPayloads.get(win.webContents.id) : null;
  return payload && payload.state && typeof payload.state.groupId === 'string'
    ? payload.state.groupId
    : '';
}

function pinGroupMembers(groupId) {
  if (!groupId) return [];
  return Array.from(pins).filter((win) => !win.isDestroyed() && pinGroupIdOf(win) === groupId);
}

function sendPinGroupState(win, collapsed, anchorId) {
  if (!win || win.isDestroyed()) return;
  const groupId = pinGroupIdOf(win);
  try {
    win.webContents.send(C.PIN_CMD, {
      cmd: 'group-state',
      groupId,
      collapsed: Boolean(groupId && collapsed),
      anchor: Boolean(groupId && anchorId === win.webContents.id),
      count: groupId ? pinGroupMembers(groupId).length : 1,
    });
  } catch (_) {}
}

function setPinGroupId(win, groupId) {
  if (!win || win.isDestroyed()) return;
  const payload = pinPayloads.get(win.webContents.id);
  if (!payload) return;
  const next = { ...(payload.state || {}) };
  if (groupId) next.groupId = groupId;
  else delete next.groupId;
  if (Object.keys(next).length) payload.state = next;
  else delete payload.state;
}

function showPinWithoutFocus(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (typeof win.showInactive === 'function') win.showInactive();
    else if (typeof win.show === 'function') win.show();
  } catch (_) {}
}

function expandPinGroup(groupId) {
  const members = pinGroupMembers(groupId);
  members.forEach(showPinWithoutFocus);
  collapsedPinGroups.delete(groupId);
  members.forEach((member) => sendPinGroupState(member, false, null));
  return members;
}

function nextPinGroupId() {
  pinGroupSequence = (pinGroupSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `group-${Date.now().toString(36)}-${pinGroupSequence.toString(36)}`;
}

function pinGroupAction(webContentsId, action) {
  const caller = findPin(webContentsId);
  if (!caller) throw new Error('贴图窗口不存在。');

  if (action === 'create') {
    const members = Array.from(pins).filter((win) => !win.isDestroyed());
    if (members.length < 2) throw new Error('至少需要两张贴图才能分组。');
    const oldGroups = new Set(members.map(pinGroupIdOf).filter(Boolean));
    oldGroups.forEach(expandPinGroup);
    const groupId = nextPinGroupId();
    members.forEach((member) => setPinGroupId(member, groupId));
    members.forEach((member) => sendPinGroupState(member, false, null));
    notifyPinWorkspaceChanged('group');
    return { ok: true, groupId, collapsed: false, count: members.length };
  }

  const groupId = pinGroupIdOf(caller);
  if (!groupId) throw new Error('当前贴图尚未分组。');
  const members = pinGroupMembers(groupId);

  if (action === 'toggle-visibility') {
    const current = collapsedPinGroups.get(groupId);
    if (current) {
      expandPinGroup(groupId);
      return { ok: true, groupId, collapsed: false, count: members.length };
    }
    members.forEach((member) => {
      if (member.webContents.id === webContentsId) showPinWithoutFocus(member);
      else if (typeof member.hide === 'function') member.hide();
    });
    collapsedPinGroups.set(groupId, { anchorId: webContentsId });
    members.forEach((member) => sendPinGroupState(member, true, webContentsId));
    return { ok: true, groupId, collapsed: true, count: members.length };
  }

  if (action === 'ungroup') {
    if (collapsedPinGroups.has(groupId)) expandPinGroup(groupId);
    setPinGroupId(caller, '');
    sendPinGroupState(caller, false, null);
    const remaining = pinGroupMembers(groupId);
    let count = remaining.length;
    if (remaining.length < 2) {
      remaining.forEach((member) => {
        setPinGroupId(member, '');
        sendPinGroupState(member, false, null);
      });
      count = 0;
    } else {
      remaining.forEach((member) => sendPinGroupState(member, false, null));
    }
    notifyPinWorkspaceChanged('group');
    return { ok: true, groupId: '', collapsed: false, count };
  }

  throw new Error('贴图分组操作无效。');
}

function movePinGroup(webContentsId, dx, dy) {
  const caller = findPin(webContentsId);
  if (!caller) return 0;
  const groupId = pinGroupIdOf(caller);
  const members = groupId ? pinGroupMembers(groupId) : [caller];
  members.forEach((win) => {
    const bounds = win.getBounds();
    win.setBounds({
      x: Math.round(bounds.x + dx),
      y: Math.round(bounds.y + dy),
      width: bounds.width,
      height: bounds.height,
    });
  });
  notifyPinWorkspaceChanged(groupId ? 'group-bounds' : 'bounds');
  return members.length;
}

function replacePinImage(webContentsId, update) {
  const payload = pinPayloads.get(webContentsId);
  const win = findPin(webContentsId);
  if (!payload || typeof payload.dataURL !== 'string' || !win) throw new Error('图片贴图窗口不存在。');
  if (!update || typeof update !== 'object') throw new Error('贴图图片替换无效。');
  const current = Number.isSafeInteger(payload.contentRevision) ? payload.contentRevision : 0;
  const currentBounds = win.getBounds();
  const isExactReplay = update.revision === current
    && update.baseRevision === current - 1
    && update.dataURL === payload.dataURL;
  if (isExactReplay) return { revision: current, bounds: currentBounds };
  if (update.baseRevision !== current || update.revision !== current + 1) {
    throw new Error('贴图内容版本已过期，请重试。');
  }
  for (const key of ['sourceWidth', 'sourceHeight', 'width', 'height']) {
    if (!Number.isSafeInteger(update[key]) || update[key] < 1 || update[key] > 32768) {
      throw new Error('贴图图片尺寸无效。');
    }
  }

  const currentScale = Math.min(
    currentBounds.width / update.sourceWidth,
    currentBounds.height / update.sourceHeight
  );
  const minimumScale = Math.max(40 / update.width, 40 / update.height);
  const maximumScale = Math.min(8000 / update.width, 8000 / update.height);
  const nextScale = Math.max(minimumScale, Math.min(maximumScale, currentScale));
  const width = Math.max(40, Math.min(8000, Math.round(update.width * nextScale)));
  const height = Math.max(40, Math.min(8000, Math.round(update.height * nextScale)));
  const centerX = currentBounds.x + currentBounds.width / 2;
  const centerY = currentBounds.y + currentBounds.height / 2;
  const nextBounds = {
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
    width,
    height,
  };

  try {
    if (typeof win.setAspectRatio === 'function') win.setAspectRatio(update.width / update.height);
    win.setBounds(nextBounds);
  } catch (error) {
    try {
      if (typeof win.setAspectRatio === 'function') win.setAspectRatio(update.sourceWidth / update.sourceHeight);
      win.setBounds(currentBounds);
    } catch (_) {}
    throw error;
  }
  payload.dataURL = update.dataURL;
  payload.contentRevision = update.revision;
  payload.bounds = nextBounds;
  notifyPinWorkspaceChanged('content');
  return { revision: update.revision, bounds: nextBounds };
}

function normalizePinCloseReady(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('贴图退出回执无效。');
  const allowed = new Set(['requestId', 'ok', 'error']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`贴图退出回执包含未知字段：${key}`);
  }
  if (typeof raw.requestId !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(raw.requestId)) {
    throw new Error('贴图退出回执标识无效。');
  }
  if (typeof raw.ok !== 'boolean') throw new Error('贴图退出回执状态无效。');
  if (raw.error != null && (typeof raw.error !== 'string' || raw.error.length > 1000)) {
    throw new Error('贴图退出回执错误无效。');
  }
  return { requestId: raw.requestId, ok: raw.ok, error: raw.error || '' };
}

function acknowledgePinClose(webContentsId, raw) {
  const payload = pinPayloads.get(webContentsId);
  if (!payload) throw new Error('贴图窗口不存在。');
  const reply = normalizePinCloseReady(raw);
  const waiter = pinCloseWaiters.get(webContentsId);
  if (!waiter || waiter.requestId !== reply.requestId) throw new Error('贴图退出回执已过期。');
  settlePinCloseWaiter(webContentsId, {
    ok: reply.ok,
    webContentsId,
    error: reply.ok ? '' : (reply.error || '贴图内容同步失败。'),
  });
  return { ok: true };
}

function normalizePinSyncReady(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('贴图同步回执无效。');
  const allowed = new Set(['requestId', 'ok', 'error']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`贴图同步回执包含未知字段：${key}`);
  }
  if (typeof raw.requestId !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(raw.requestId)) {
    throw new Error('贴图同步回执标识无效。');
  }
  if (typeof raw.ok !== 'boolean') throw new Error('贴图同步回执状态无效。');
  if (raw.error != null && (typeof raw.error !== 'string' || raw.error.length > 1000)) {
    throw new Error('贴图同步回执错误无效。');
  }
  return { requestId: raw.requestId, ok: raw.ok, error: raw.error || '' };
}

function acknowledgePinSync(webContentsId, raw) {
  const payload = pinPayloads.get(webContentsId);
  if (!payload) throw new Error('贴图窗口不存在。');
  const reply = normalizePinSyncReady(raw);
  const waiter = pinSyncWaiters.get(webContentsId);
  if (!waiter || waiter.requestId !== reply.requestId) throw new Error('贴图同步回执已过期。');
  settlePinSyncWaiter(webContentsId, {
    ok: reply.ok,
    webContentsId,
    error: reply.ok ? '' : (reply.error || '贴图内容同步失败。'),
  });
  return { ok: true };
}

function syncPinsContent({ timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) {
    throw new Error('贴图同步等待时间无效。');
  }
  const livePins = Array.from(pins).filter((win) => !win.isDestroyed());
  if (!livePins.length) return Promise.resolve({ ok: true, results: [] });

  const tasks = livePins.map((win) => new Promise((resolve) => {
    const webContentsId = win.webContents.id;
    settlePinSyncWaiter(webContentsId, {
      ok: false,
      webContentsId,
      error: '贴图同步已被新请求取代。',
    });
    pinSyncRequestSequence = (pinSyncRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    const requestId = `${Date.now().toString(36)}-${pinSyncRequestSequence.toString(36)}-${webContentsId.toString(36)}`;
    const timer = setTimeout(() => {
      settlePinSyncWaiter(webContentsId, {
        ok: false,
        webContentsId,
        error: '等待贴图内容同步超时。',
      });
    }, timeoutMs);
    pinSyncWaiters.set(webContentsId, { requestId, timer, resolve });
    try {
      win.webContents.send(C.PIN_CMD, { cmd: 'sync-content', requestId });
    } catch (error) {
      settlePinSyncWaiter(webContentsId, {
        ok: false,
        webContentsId,
        error: (error && error.message) || String(error),
      });
    }
  }));

  return Promise.all(tasks).then((results) => ({
    ok: results.every((result) => result.ok === true),
    results,
  }));
}

function preparePinsForClose({ timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) {
    throw new Error('贴图退出等待时间无效。');
  }
  const livePins = Array.from(pins).filter((win) => !win.isDestroyed());
  if (!livePins.length) return Promise.resolve({ ok: true, results: [] });

  const tasks = livePins.map((win) => new Promise((resolve) => {
    const webContentsId = win.webContents.id;
    settlePinCloseWaiter(webContentsId, {
      ok: false,
      webContentsId,
      error: '贴图退出同步已被新请求取代。',
    });
    pinCloseRequestSequence = (pinCloseRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    const requestId = `${Date.now().toString(36)}-${pinCloseRequestSequence.toString(36)}-${webContentsId.toString(36)}`;
    const timer = setTimeout(() => {
      settlePinCloseWaiter(webContentsId, {
        ok: false,
        webContentsId,
        error: '等待贴图内容同步超时。',
      });
    }, timeoutMs);
    pinCloseWaiters.set(webContentsId, { requestId, timer, resolve });
    try {
      win.webContents.send(C.PIN_CMD, { cmd: 'prepare-close', requestId });
    } catch (error) {
      settlePinCloseWaiter(webContentsId, {
        ok: false,
        webContentsId,
        error: (error && error.message) || String(error),
      });
    }
  }));

  return Promise.all(tasks).then((results) => ({
    ok: results.every((result) => result.ok === true),
    results,
  }));
}

function cancelPinClosePreparation() {
  let notified = 0;
  for (const win of pins) {
    if (win.isDestroyed()) continue;
    const webContentsId = win.webContents.id;
    settlePinCloseWaiter(webContentsId, {
      ok: false,
      webContentsId,
      error: '应用退出已取消。',
    });
    try {
      win.webContents.send(C.PIN_CMD, { cmd: 'cancel-prepare-close' });
      notified += 1;
    } catch (_) {}
  }
  return notified;
}

// ---- 设置 ----
// 统一走桌面主窗口的「设置」页（src/renderer/main + main/pages/settings.js）。
// 旧的独立设置窗（原 src/renderer/settings/）已退役并删除：所有设置入口都进新页，
// 彻底消除「两套设置页枚举不一致 → 回显错乱」（MED-3/8）以及「新页修了、旧页没修」的分叉。
function openSettings() {
  return createMain('settings');
}

// ---- AI 面板 ----
// 主进程按模式固定 payload 形状：图片任务不能夹带 text/prompt，
// 文本任务不能夹带图片。特别是 table/formula 的任务提示词只存在主进程，
// 不接受渲染层自定义 prompt。
function normalizeAIPanelPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('AI 面板参数无效。');
  }
  const allowedFields = new Set(['mode', 'dataURL', 'text']);
  for (const key of Object.keys(payload)) {
    if (!allowedFields.has(key)) throw new Error(`AI 面板参数包含不支持字段：${key}`);
  }
  const mode = typeof payload.mode === 'string' ? payload.mode : '';
  const imageModes = new Set(['ask', 'ocr', 'translateImage', 'table', 'formula']);
  const textModes = new Set(['translate', 'polish']);
  if (!imageModes.has(mode) && !textModes.has(mode)) throw new Error('AI 面板模式无效。');

  if (imageModes.has(mode)) {
    if (payload.text != null) throw new Error('图片 AI 模式不支持文本字段。');
    return { mode, dataURL: requireImageDataURL(payload.dataURL) };
  }

  if (payload.dataURL != null) throw new Error('文本 AI 模式不支持图片字段。');
  if (typeof payload.text !== 'string' || payload.text.length > 1024 * 1024) {
    throw new Error('AI 文本无效或过长。');
  }
  return { mode, text: payload.text };
}

// payload: { mode:'ask'|'ocr'|'translate'|'polish'|'translateImage'|'table'|'formula', dataURL?|text? }
function openAIPanel(payload) {
  const safePayload = normalizeAIPanelPayload(payload);
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

// ---- LaTeX 公式贴图 ----
// 公式编辑器是本地单例窗口：不持有 API Key，不具备网络 IPC，只能把
// renderer 内由 KaTeX 生成的 PNG 交给主进程创建贴图。
function createFormula() {
  if (refs.formula && !refs.formula.isDestroyed()) {
    refs.formula.show();
    refs.formula.focus();
    return refs.formula;
  }
  const win = newTrackedWindow({
    width: 620,
    height: 500,
    minWidth: 480,
    minHeight: 400,
    title: 'LaTeX 公式贴图 · 困困截图',
    autoHideMenuBar: true,
    backgroundColor: '#f6f2ea',
    webPreferences: baseWebPrefs(),
  }, 'formula');
  win.loadFile(rfile('formula', 'formula.html'));
  win.on('closed', () => {
    if (refs.formula === win) refs.formula = null;
  });
  refs.formula = win;
  return win;
}

// ---- 录屏控制条 ----
// 放在录制区域下方（区域外），避免把控制条录进画面。
function createRecorder(initData) {
  const existing = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  const decision = decideRecorderWindowOpen({
    hasWindow: !!existing,
    state: recorderLifecycleState && recorderLifecycleState.state,
  });
  if (decision.action === 'focus-existing') {
    try { existing.show(); } catch (_) {}
    try { existing.focus(); } catch (_) {}
    return {
      win: existing,
      created: false,
      busy: true,
      state: decision.state,
    };
  }
  if (decision.action === 'replace-existing') {
    existing.close();
  }
  const r = initData.rect;
  const db = initData.displayBounds;
  const barW = 520;
  const barH = 56;
  const controlBounds = calculateCaptureControlBounds({
    rect: r,
    displayBounds: db,
    width: barW,
    height: barH,
  });
  const win = newTrackedWindow({
    ...controlBounds,
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
  recorderLifecycleState = {
    state: RECORDER_STATES.OPENING,
    generation: 0,
    saveAttempt: 0,
  };
  win.on('close', (event) => {
    if (recorderWin !== win || forceClosingRecorderWindows.has(win)) return;
    const state = recorderLifecycleState && recorderLifecycleState.state;
    if (!canCloseRecorderWindow(state)) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      try { win.show(); } catch (_) {}
      try { win.focus(); } catch (_) {}
    }
  });
  win.on('closed', () => {
    forceClosingRecorderWindows.delete(win);
    if (recorderWin === win) {
      recorderWin = null;
      recorderLifecycleState = null;
    }
  });
  recorderWin = win;
  return {
    win,
    created: true,
    busy: false,
    state: RECORDER_STATES.OPENING,
  };
}

function updateRecorderState(webContentsId, rawSnapshot) {
  const win = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  if (!win || win.webContents.id !== webContentsId) throw new Error('录屏窗口不存在。');
  const next = normalizeRecorderLifecycleSnapshot(rawSnapshot);
  const current = recorderLifecycleState || {
    state: RECORDER_STATES.OPENING,
    generation: 0,
    saveAttempt: 0,
  };
  if (
    next.generation < current.generation
    || (next.generation === current.generation && next.saveAttempt < current.saveAttempt)
  ) {
    throw new Error('录屏生命周期状态已过期。');
  }
  recorderLifecycleState = next;
  return { ok: true, ...next };
}

function requestRecorderClose(webContentsId) {
  const win = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  if (!win || win.webContents.id !== webContentsId) return { ok: false, error: '录屏窗口不存在。' };
  const state = recorderLifecycleState && recorderLifecycleState.state;
  if (!canCloseRecorderWindow(state)) {
    try { win.show(); } catch (_) {}
    try { win.focus(); } catch (_) {}
    return { ok: false, busy: true, state };
  }
  win.close();
  return { ok: true, state };
}

function closeRecorder({ force = false } = {}) {
  const win = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  if (!win) return false;
  if (force) forceClosingRecorderWindows.add(win);
  win.close();
  return true;
}

function canCloseRecorder() {
  const win = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  return !win || canCloseRecorderWindow(recorderLifecycleState && recorderLifecycleState.state);
}

function focusRecorder() {
  const win = recorderWin && !recorderWin.isDestroyed() ? recorderWin : null;
  if (!win) return false;
  try { win.show(); } catch (_) {}
  try { win.focus(); } catch (_) {}
  return true;
}

// ---- 可视长截图：穿透辅助层与交互控制条属于同一个原子会话 ----
let longShotSession = null;
function createLongShot(initData) {
  const layout = calculateLongshotLayout(initData);
  closeLongShot();
  const sharedOptions = {
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
    show: false,
    backgroundColor: '#00000000',
    webPreferences: baseWebPrefs(),
  };
  const guide = newTrackedWindow({
    ...sharedOptions,
    ...initData.displayBounds,
    focusable: false,
  }, 'longshot-guide');
  // 原生窗口级穿透，而不是 CSS pointer-events。真实滚轮/触控板必须进入下方应用。
  guide.setIgnoreMouseEvents(true);
  const win = newTrackedWindow({
    ...sharedOptions,
    ...layout.toolbarBounds,
  }, 'longshot');
  const group = {
    controls: win,
    guide,
    initData: { ...initData, rect: { ...layout.rect }, displayBounds: { ...initData.displayBounds } },
    layout,
    presentation: { previewDataURL: null, outputWidth: 0, outputHeight: 0, frameCount: 0, capturing: false, expanded: false },
    closing: false,
    captureInFlight: false,
    captureSettled: false,
  };
  longShotSession = group;
  const closeGroup = () => {
    if (group.closing) return;
    group.closing = true;
    if (longShotSession === group) longShotSession = null;
    for (const member of [group.controls, group.guide]) {
      if (!member.isDestroyed()) member.destroy();
    }
  };
  group.close = closeGroup;
  for (const [member, surface, filename] of [
    [guide, 'guide', 'longshot-guide.html'],
    [win, 'controls', 'longshot.html'],
  ]) {
    member.setAlwaysOnTop(true, 'screen-saver');
    member.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    member.on('closed', closeGroup);
    member.webContents.on('render-process-gone', closeGroup);
    member.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame !== false && code !== -3) closeGroup();
    });
    member.webContents.on('did-finish-load', () => {
      if (group.closing || member.isDestroyed()) return;
      member.webContents.send(C.WINDOW_INIT, {
        ...group.initData,
        surface,
        autoStart: group.initData.autoStart !== false,
        previewAvailable: !!group.layout.preview,
        layout: group.layout,
        presentation: group.presentation,
      });
      member.showInactive();
      // guide 可能比 controls 晚完成加载；只调整层级，不把焦点从原页面抢回来。
      if (!win.isDestroyed() && win.isVisible()) win.moveTop();
    });
    member.loadFile(rfile('longshot', filename));
  }
  return win;
}

function closeLongShot() {
  if (longShotSession) longShotSession.close();
}

function requireLongshotSession(webContentsId) {
  const group = longShotSession;
  if (!group || group.closing || group.controls.isDestroyed()
    || group.controls.webContents.id !== webContentsId) throw new Error('长截图会话不存在或已失效。');
  return group;
}

function syncLongshotPresentation(group) {
  if (group.closing) return;
  group.layout = calculateLongshotLayout({ ...group.initData, expanded: group.presentation.expanded });
  const bounds = group.controls.getBounds();
  if (['x', 'y', 'width', 'height'].some((key) => bounds[key] !== group.layout.toolbarBounds[key])) {
    group.controls.setBounds(group.layout.toolbarBounds);
  }
  const state = { ...group.presentation, layout: group.layout };
  // 暂停/静止帧只同步状态，避免重复传输和解码同一缩略图。
  // guide 首次加载或 reload 仍从 WINDOW_INIT 接收完整 presentation。
  if (group.lastSentPreview === state.previewDataURL) delete state.previewDataURL;
  group.guide.webContents.send(C.LONGSHOT_STATE, state);
  group.lastSentPreview = group.presentation.previewDataURL;
}

function updateLongshotPresentation(webContentsId, payload) {
  const group = requireLongshotSession(webContentsId);
  const patch = normalizeLongshotPresentation(payload);
  group.presentation = { ...group.presentation, ...patch };
  // 采集期间不能把原本位于选区外的工具条突然展开进选区。
  if (!group.captureInFlight) syncLongshotPresentation(group);
  return { ok: true, previewAvailable: !!group.layout.preview };
}

async function withLongShotCapture(webContentsId, capture) {
  const group = requireLongshotSession(webContentsId);
  if (group.captureInFlight) throw new Error('上一帧长截图采集仍在进行中。');
  group.captureInFlight = true;
  let hiddenControls = false;
  try {
    // overlay:result 的 invoke 成功后，旧静态选区层才由 renderer 关闭。
    // 自动首帧必须等待这一生命周期，不可把旧截图再次拼入结果。
    const startedAt = Date.now();
    while (overlayWin && !overlayWin.isDestroyed()) {
      if (group.closing) throw new Error('长截图会话已经结束。');
      if (Date.now() - startedAt >= 2000) throw new Error('截图选区层尚未关闭，请重试长截图。');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (group.closing) throw new Error('长截图会话已经结束。');
    if (rectanglesOverlap(group.controls.getBounds(), group.layout.captureBounds) && group.controls.isVisible()) {
      group.controls.hide();
      hiddenControls = true;
    }
    if (hiddenControls || !group.captureSettled) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      group.captureSettled = true;
    }
    if (group.closing) throw new Error('长截图会话已经结束。');
    const result = await capture({ ...group.initData, rect: { ...group.initData.rect } });
    if (group.closing) throw new Error('长截图会话已经结束。');
    return result;
  } finally {
    group.captureInFlight = false;
    if (!group.closing && !group.controls.isDestroyed()) {
      syncLongshotPresentation(group);
      if (hiddenControls) group.controls.showInactive();
    }
  }
}

function getLongShotSnapshot() {
  const group = longShotSession;
  if (!group || group.closing) return null;
  return { controls: group.controls, guide: group.guide, layout: group.layout, presentation: { ...group.presentation } };
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
  // package.json is the single version source for both source and packaged runs.
  // Passing it through the existing trusted init channel avoids a renderer-side
  // hard-coded value drifting away from the bundle metadata.
  whenLoaded(win, { page: safePage, appVersion: APP_VERSION });
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
    if (w.isDestroyed()) return;
    const payload = pinPayloads.get(w.webContents.id) || {};
    out.push({
      win: w,
      payload,
      bounds: typeof w.getBounds === 'function' ? w.getBounds() : payload.bounds,
      state: payload.state,
    });
  });
  return out;
}

function savePinWorkspace(store) {
  if (!store || typeof store.save !== 'function') throw new TypeError('贴图工作区存储无效。');
  const snapshots = pinSnapshots().map(({ payload, bounds, state }) => ({ payload, bounds, state }));
  return store.save(snapshots);
}

function restorePinWorkspace(store) {
  if (!store || typeof store.load !== 'function') throw new TypeError('贴图工作区存储无效。');
  const snapshots = store.load();
  if (!Array.isArray(snapshots)) return 0;
  let restored = 0;
  snapshots.forEach((payload) => {
    try {
      createPin(payload);
      restored += 1;
    } catch (error) {
      console.error('[pin] 跳过无效的工作区贴图：', error.message);
    }
  });
  return restored;
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
  // 让 renderer 先 flush 尚在合成的最后一笔标注，再关闭窗口。
  pinBroadcast({ cmd: 'close' });
}
function pinAllDestroy() {
  // 销毁：不进历史
  pinSnapshots().forEach(({ win, payload }) => {
    suppressPinHistory.add(win);
    // 先显式清理，不能依赖 BrowserWindow.destroy() 之后异步/平台相关的 closed 时序。
    removeTrackedPin(win, win.webContents.id, payload);
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
  closeRecorder({ force: true });
  closeLongShot();
  if (refs.formula && !refs.formula.isDestroyed()) refs.formula.close();
  refs.formula = null;
  hidePopover();
  closeTranslatePopup();
  for (const p of pins) if (!p.isDestroyed()) p.close();
}

module.exports = {
  createOverlay,
  createImageEditor,
  calculateImageEditorLayout,
  calculateCaptureControlBounds,
  closeOverlay,
  createPin,
  openSettings,
  openAIPanel,
  createFormula,
  normalizeAIPanelPayload,
  createRecorder,
  closeRecorder,
  requestRecorderClose,
  updateRecorderState,
  canCloseRecorder,
  focusRecorder,
  getRecorderState: () => (recorderLifecycleState ? { ...recorderLifecycleState } : null),
  createLongShot,
  closeLongShot,
  updateLongshotPresentation,
  withLongShotCapture,
  getLongShotSnapshot,
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
  getOverlayCaptureType: (id) => overlayCaptureTypes.get(id) || null,
  pinSnapshots,
  savePinWorkspace,
  restorePinWorkspace,
  pinBroadcast,
  pinAllThumbnail,
  pinAllClose,
  pinAllDestroy,
  restoreLastPin,
  pinCount,
  onPinRemoved,
  onPinWorkspaceChanged,
  updatePinWorkspaceState,
  updatePinContent,
  replacePinImage,
  pinGroupAction,
  movePinGroup,
  acknowledgePinClose,
  acknowledgePinSync,
  preparePinsForClose,
  syncPinsContent,
  cancelPinClosePreparation,
  getPinPayload: (id) => pinPayloads.get(id) || null,
  getOverlay: () => overlayWin,
  getMain: () => refs.main,
};
