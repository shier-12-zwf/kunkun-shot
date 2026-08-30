const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const channelsSource = fs.readFileSync(path.join(root, 'src/shared/channels.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const capturePageSource = fs.readFileSync(path.join(root, 'src/renderer/main/pages/capture.js'), 'utf8');
const { normalizeOverlayResultEnvelope } = require('../src/main/overlay-result-contract');

function between(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section ${start}`);
  return mainSource.slice(from, to);
}

test('all screen capture entry points use the deterministic source matcher', () => {
  assert.match(mainSource, /require\(['"]\.\/capture-source-matcher['"]\)/);
  const grab = between('async function grabDisplay()', 'function grabWindowFrame');
  assert.match(grab, /selectDisplaySource\(/);
  assert.doesNotMatch(grab, /sources\s*\[\s*0\s*\]/);

  const region = between('ipcMain.handle(C.CAPTURE_REGION', 'ipcMain.handle(C.CAPTURE_GET_SOURCES');
  assert.match(region, /selectDisplaySource\(/);
  assert.doesNotMatch(region, /sources\s*\[\s*0\s*\]/);

  const serialized = between('ipcMain.handle(C.CAPTURE_GET_SOURCES', 'ipcMain.handle(C.OVERLAY_CANCEL');
  assert.match(serialized, /serializeCaptureSources\(/);
});

test('screen capture reaches the real API when permission is undetermined and centralizes permission UI', () => {
  assert.match(mainSource, /require\(['"]\.\/screen-permission['"]\)/);
  assert.match(mainSource, /async function getScreenCaptureSources\(/);
  assert.doesNotMatch(mainSource, /function checkScreenPermission\(/);

  const grab = between('async function grabDisplay()', 'function grabWindowFrame');
  assert.match(grab, /getScreenCaptureSources\(/);
  assert.doesNotMatch(grab, /showMessageBox|showErrorBox/);

  const start = between('async function startCapture(mode, options = {})', 'function pinFromClipboard');
  assert.match(start, /isScreenPermissionError\(e\)/);
  assert.match(start, /showScreenPermissionDialog\(e\.status\)/);
  assert.doesNotMatch(start, /如果在 macOS 上/);
});

test('timed captures are scheduled and canceled by the main process', () => {
  assert.match(channelsSource, /CAPTURE_TIMED_CANCEL:\s*'capture:timed-cancel'/);
  assert.match(preloadSource, /cancelTimedCapture:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(C\.CAPTURE_TIMED_CANCEL/);
  assert.match(mainSource, /createTimedCaptureScheduler\(/);
  assert.match(mainSource, /timedCaptureScheduler\.schedule\(/);
  assert.match(mainSource, /timedCaptureScheduler\.cancel\(/);
  assert.match(mainSource, /timedCaptureScheduler\.cancelAll\(\)/);

  const scheduler = between('const timedCaptureScheduler', '// Renderer 按窗口职责分权');
  assert.match(scheduler, /onFire:\s*async\s*\(\{\s*mode\s*\},\s*control\)/);
  assert.match(scheduler, /startCapture\(mode,\s*\{\s*trigger:\s*['"]timed['"],\s*signal:\s*control\.signal\s*\}\)/);

  assert.match(capturePageSource, /captureTimed\(\{\s*delay:\s*delaySec/);
  assert.match(capturePageSource, /cancelTimedCapture\(/);
  assert.doesNotMatch(capturePageSource, /captureTimed\(\{\s*delay:\s*0/);
});

test('fullscreen, window, and timed captures all enter the shared editor before side effects', () => {
  const fullscreen = between('async function doFullscreenNow()', '// 交互式窗口截图');
  assert.match(fullscreen, /return\s+startCapture\(['"]fullscreen['"]\)/);
  assert.doesNotMatch(fullscreen, /clipboard\.writeImage|autoSaveToHistory/);

  const windowCapture = between('function doWindowCapture(options = {})', '// ---------- 大图降采样');
  assert.match(windowCapture, /return\s+startCapture\(['"]window['"],\s*options\)/);
  assert.doesNotMatch(windowCapture, /clipboard\.writeImage|autoSaveToHistory/);

  const coordinator = between('const captureCoordinator', 'async function startCapture');
  assert.match(coordinator, /mode\s*===\s*['"]window['"]\s*\?\s*grabWindowFrame\(\{\s*signal\s*\}\)\s*:\s*grabDisplay\(\)/);
  assert.match(coordinator, /windows\.createImageEditor\(frame\.display,[\s\S]*?mode:\s*['"]image['"],[\s\S]*?captureType:\s*['"]window['"]/);
  assert.match(coordinator, /return\s+windows\.createOverlay\(frame\.display/);

  const start = between('async function startCapture(mode, options = {})', 'function pinFromClipboard');
  assert.match(start, /return\s+await\s+captureCoordinator\.start\(safeMode,\s*options\)/);
  assert.doesNotMatch(start, /closeOverlay\(\)|clipboard\.writeImage|autoSaveToHistory/);
});

test('capture startup and fullscreen IPC delegate to the coordinator result contract', () => {
  const fullscreenIpc = between('ipcMain.handle(C.CAPTURE_FULLSCREEN_NOW', 'ipcMain.handle(C.CAPTURE_WINDOW');
  assert.match(fullscreenIpc, /return\s+await\s+doFullscreenNow\(\)/);
  assert.doesNotMatch(fullscreenIpc, /item\s*=/);
  assert.match(mainSource, /async function startCapture\(mode, options = \{\}\)/);
  assert.match(mainSource, /return\s+await\s+captureCoordinator\.start\(safeMode,\s*options\)/);
});

test('overlay result envelope keeps static image actions separate from live capture actions', () => {
  const staticResult = normalizeOverlayResultEnvelope({
    action: 'save', imageDataURL: 'data:image/png;base64,AAAA',
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    rect: { x: 1, y: 2, width: 30, height: 40 }, displayId: 7,
  });
  assert.equal(staticResult.kind, 'static');
  assert.equal(staticResult.action, 'save');
  assert.equal(staticResult.imageDataURL, 'data:image/png;base64,AAAA');
  assert.deepEqual(staticResult.bounds, { x: 1, y: 2, width: 30, height: 40 });

  const liveResult = normalizeOverlayResultEnvelope({
    action: 'record', rect: { x: 3, y: 4, width: 50, height: 60 }, displayId: 'display-2',
  });
  assert.equal(liveResult.kind, 'live');
  assert.equal(liveResult.action, 'record');
  assert.equal(liveResult.displayId, 'display-2');
  assert.equal('imageDataURL' in liveResult, false);

  assert.throws(() => normalizeOverlayResultEnvelope({
    action: 'long', rect: { x: 0, y: 0, width: 10, height: 10 }, displayId: 1,
    imageDataURL: 'data:image/png;base64,AAAA',
  }), /互斥/);
});

test('overlay result IPC normalizes envelopes and uses trusted main capture context', () => {
  const overlayResult = between('ipcMain.handle(C.OVERLAY_RESULT', 'ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE');
  assert.match(overlayResult, /normalizeOverlayResultEnvelope\(result\)/);
  assert.match(overlayResult, /const isLiveCapture\s*=\s*normalized\.kind\s*===\s*['"]live['"]/);
  assert.match(overlayResult, /windows\.getOverlayCaptureType\(_e\.sender\.id\)/);
  assert.match(overlayResult, /image\s*=\s*validatedNativeImage\(imageDataURL\)/);
  assert.match(overlayResult, /safeRect\s*=\s*normalizeCaptureRect\(rect,\s*displayData\.size\)/);
});

test('overlay history uses main-owned capture context instead of renderer claims', () => {
  const overlayResult = between('ipcMain.handle(C.OVERLAY_RESULT', 'ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE');
  assert.match(overlayResult, /windows\.getOverlayCaptureType\(_e\.sender\.id\)/);
  assert.match(overlayResult, /saveToHistory\(imageDataURL,\s*captureType\)/);
  assert.doesNotMatch(overlayResult, /saveToHistory\(imageDataURL,\s*result\.(?:captureType|type)\)/);
});

test('active pin workspace is restored on ready and flushed before pin windows close', () => {
  assert.match(mainSource, /createPinWorkspaceStore\(/);
  assert.match(mainSource, /windows\.restorePinWorkspace\(/);
  assert.match(mainSource, /windows\.onPinWorkspaceChanged\(/);
  const beforeQuit = between("app.on('before-quit'", "app.on('will-quit'");
  assert.match(beforeQuit, /event\.preventDefault\(\)/);
  assert.match(mainSource, /windows\.preparePinsForClose\(\{\s*timeoutMs:\s*5000\s*\}\)/);
  assert.match(mainSource, /captureCoordinator\.cancelPendingAndWait\(['"]app-quit['"],\s*2000\)/);
  assert.match(mainSource, /savePinWorkspaceNow\(\{\s*throwOnError:\s*true\s*\}\)/);
  assert.match(mainSource, /windows\.canCloseRecorder\(\)/);
  assert.match(mainSource, /windows\.cancelPinClosePreparation\(\)/);
  assert.match(beforeQuit, /quitPrepared\s*=\s*true;[\s\S]*?app\.quit\(\)/);
  const quit = between("app.on('will-quit'", '\n  });\n}');
  assert.match(quit, /captureCoordinator\.cancelPending\(['"]app-quit['"]\)/);
  const saveAt = quit.indexOf('savePinWorkspaceNow(');
  const closeAt = quit.indexOf('windows.closeAll()');
  assert.ok(saveAt >= 0 && closeAt > saveAt, 'workspace must be saved before closing live pin windows');
});
