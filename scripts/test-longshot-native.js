'use strict';

// Native longshot diagnostic. Default mode reads permission only and never
// requests access. Visible fixture mode is deliberately opt-in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Run via Node so the owner can remove Chromium caches after Electron exits;
// deleting them from Electron's quit event can race Chromium's final writes.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-longshot-native-'));
  const env = { ...process.env, KK_LONGSHOT_NATIVE_OWNED_TEMP: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
      env, stdio: 'inherit', timeout: 45000,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('LONGSHOT_NATIVE_CLEANUP ' + JSON.stringify({ ownedDirectoryRemoved: !fs.existsSync(root) }));
  process.exit(result && Number.isInteger(result.status) ? result.status : 1);
}

const { app, BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tempRoot = process.env.KK_LONGSHOT_NATIVE_OWNED_TEMP
  || fs.mkdtempSync(path.join(os.tmpdir(), 'kk-longshot-native-'));
const factory = require('../src/main/windows');
const C = require('../src/shared/channels');
const { selectDisplaySource } = require('../src/main/capture-source-matcher');
const ownedWindows = new Set();
const evidence = { checks: [], permission: null, physicalWheelPassthroughTested: false, focusEvents: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let closing = false;
let activeStage = 'permission check';
let timeout;
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

async function until(stage, probe, budget = 7000) {
  activeStage = stage;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(35);
  }
  throw new Error('Timed out: ' + stage);
}

function track(win, role) {
  ownedWindows.add(win);
  for (const event of ['focus', 'blur']) {
    win.on(event, () => evidence.focusEvents.push({ role, event, stage: activeStage }));
  }
  win.once('closed', () => ownedWindows.delete(win));
  return win;
}

function fingerprint(image) {
  return crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
}

function pixelDelta(a, b) {
  assert.deepEqual(a.getSize(), b.getSize());
  const first = a.toBitmap();
  const second = b.toBitmap();
  let total = 0;
  let changed = 0;
  for (let i = 0; i < first.length; i += 4) {
    const difference = Math.abs(first[i] - second[i]) + Math.abs(first[i + 1] - second[i + 1]) + Math.abs(first[i + 2] - second[i + 2]);
    total += difference;
    if (difference > 9) changed += 1;
  }
  return { meanChannelError: total / (first.length / 4 * 3), changedPixelRatio: changed / (first.length / 4) };
}

async function runVisibleFixture() {
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor || 1;
  const rect = { x: 80, y: 100, width: 420, height: 260 };
  assert.ok(display.size.width >= 800 && display.size.height >= 600, 'native fixture needs an 800 x 600 display');
  const fixture = track(new BrowserWindow({
    ...rect, x: display.bounds.x + rect.x, y: display.bounds.y + rect.y,
    frame: false, show: false, hasShadow: false, resizable: false, roundedCorners: false,
    backgroundColor: '#ffffff', alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  }), 'fixture');
  await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Longshot native owned fixture</title><style>*{box-sizing:border-box}body{margin:0;background:#fff}::-webkit-scrollbar{display:none}canvas{display:block;width:420px;height:1200px}</style><canvas id="document" width="420" height="1200"></canvas>'));
  await fixture.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('document');
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const hash = Math.imul(y + 1, 1103515245) ^ Math.imul(Math.floor(x / 4) + 7, 2654435761);
      const tone = x < 50 ? 0 : x >= 370 ? 255 : 35 + ((hash >>> 8) & 191);
      const index = (y * canvas.width + x) * 4;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = tone;
      pixels.data[index + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.font = 'bold 14px sans-serif';
    for (let y = 26; y < canvas.height; y += 48) {
      ctx.fillStyle = '#fff'; ctx.fillRect(78, y - 16, 260, 22);
      ctx.fillStyle = '#111'; ctx.fillText('NATIVE OWNED FIXTURE ROW ' + y, 82, y);
    }
  })()`);
  fixture.setAlwaysOnTop(true, 'screen-saver');
  fixture.show();
  fixture.focus();
  await until('owned fixture visible and focused', () => fixture.isVisible() && fixture.isFocused());
  await delay(200);

  // The OS API necessarily returns a full display thumbnail. Discard it directly
  // after cropping the exact, opaque, test-owned window. Never log/save the full
  // display image, source titles or any user-window pixels.
  const captureOwnedRect = async () => {
    assert.ok(fixture.isVisible() && !fixture.isDestroyed());
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
      fetchWindowIcons: false,
    });
    const source = selectDisplaySource(sources, display, screen.getAllDisplays());
    assert.ok(source && !source.thumbnail.isEmpty());
    return source.thumbnail.crop({ x: Math.round(rect.x * sf), y: Math.round(rect.y * sf),
      width: Math.round(rect.width * sf), height: Math.round(rect.height * sf) });
  };
  const beforeGuide = await captureOwnedRect();
  evidence.captureSize = beforeGuide.getSize();
  evidence.scaleFactor = sf;
  evidence.checks.push('native-desktop-capturer-returned-nonempty-owned-region');

  let captures = 0;
  let firstFrame;
  let lastFrame;
  let savedData = null;
  let copiedData = null;
  ipcMain.handle(C.CAPTURE_REGION, (event) => factory.withLongShotCapture(event.sender.id, async () => {
    lastFrame = await captureOwnedRect();
    if (!firstFrame) firstFrame = lastFrame;
    captures += 1;
    return lastFrame.toDataURL();
  }));
  ipcMain.handle(C.LONGSHOT_UPDATE, (event, payload) => factory.updateLongshotPresentation(event.sender.id, payload));
  ipcMain.handle(C.IMAGE_SAVE, (_event, dataURL) => { savedData = dataURL; return { saved: true }; });
  ipcMain.handle(C.CLIPBOARD_WRITE_IMAGE, (_event, dataURL) => { copiedData = dataURL; return true; });
  ipcMain.handle(C.WINDOW_CLOSE_SELF, () => { factory.closeLongShot(); return { ok: true }; });
  const controls = track(factory.createLongShot({ rect, displayId: display.id, displayBounds: display.bounds, scaleFactor: sf, autoStart: true }), 'controls');
  const snapshot = factory.getLongShotSnapshot();
  track(snapshot.guide, 'guide');
  await until('automatic real first frame', () => {
    const state = factory.getLongShotSnapshot();
    return state && state.presentation.frameCount === 1 && state.presentation.capturing && captures >= 3;
  });
  evidence.nativeGeometry = {
    displayBounds: display.bounds, displayWorkArea: display.workArea,
    guideBounds: snapshot.guide.getBounds(), guideContentBounds: snapshot.guide.getContentBounds(),
    fixtureBounds: fixture.getBounds(), fixtureContentBounds: fixture.getContentBounds(),
    controlsBounds: controls.getBounds(), controlsContentBounds: controls.getContentBounds(),
    guideDOM: await snapshot.guide.webContents.executeJavaScript('({ x: window.screenX, y: window.screenY, innerWidth, innerHeight, outerWidth, outerHeight, outline: document.getElementById("selectionOutline").getBoundingClientRect().toJSON() })'),
  };
  assert.equal(evidence.nativeGeometry.guideContentBounds.x + evidence.nativeGeometry.guideDOM.outline.x,
    display.bounds.x + rect.x, 'guide outline must align with the native capture origin horizontally');
  assert.equal(evidence.nativeGeometry.guideContentBounds.y + evidence.nativeGeometry.guideDOM.outline.y,
    display.bounds.y + rect.y, 'guide outline must align with the native capture origin vertically');
  assert.equal(snapshot.guide.isFocusable(), false);
  evidence.nativeFocusAtFirstFrames = {
    fixture: fixture.isFocused(), controls: controls.isFocused(), guide: snapshot.guide.isFocused(),
    anyOwnedWindow: !!BrowserWindow.getFocusedWindow(),
  };
  assert.equal(fixture.isFocused(), true, 'production guide/control opening must not steal fixture focus');
  assert.equal(controls.isFocused(), false);
  evidence.focusPreserved = true;
  evidence.checks.push('production-windows-auto-first-frame-and-preserve-native-focus');
  evidence.guidePixelDelta = pixelDelta(beforeGuide, lastFrame);
  if (process.env.KK_NATIVE_DIAGNOSTIC_ARTIFACTS) {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-native-owned-crops-'));
    fs.writeFileSync(path.join(artifacts, 'before-guide.png'), beforeGuide.toPNG());
    fs.writeFileSync(path.join(artifacts, 'with-guide.png'), lastFrame.toPNG());
    evidence.artifacts = artifacts;
    evidence.fixtureBounds = fixture.getBounds();
    evidence.productionLayout = factory.getLongShotSnapshot().layout;
  }
  assert.ok(evidence.guidePixelDelta.meanChannelError < 1, 'guide/toolbar must not contaminate owned region');
  evidence.stationaryCaptureCount = captures;
  evidence.checks.push('stationary-native-frames-remain-capturing-without-false-fixed-bands');

  // This scroll is deliberately sent only to our WebContents. It verifies actual
  // compositor scrolling + OS screenshots, NOT physical mouse-wheel passthrough.
  fixture.webContents.sendInputEvent({ type: 'mouseWheel', x: 210, y: 130, deltaX: 0, deltaY: -80, canScroll: true });
  await until('owned fixture actually scrolls', () => fixture.webContents.executeJavaScript('window.scrollY > 0'));
  await until('real scrolled pixels append to the production longshot', () => {
    const state = factory.getLongShotSnapshot();
    return state && state.presentation.frameCount >= 2 && state.presentation.outputHeight > rect.height * sf;
  });
  evidence.scrollTop = await fixture.webContents.executeJavaScript('window.scrollY');
  evidence.scrolledPixelDelta = pixelDelta(firstFrame, lastFrame);
  assert.ok(evidence.scrolledPixelDelta.changedPixelRatio > 0.1);
  evidence.firstFrameHash = fingerprint(firstFrame);
  evidence.scrolledFrameHash = fingerprint(lastFrame);
  evidence.stitched = factory.getLongShotSnapshot().presentation;
  delete evidence.stitched.previewDataURL;
  evidence.checks.push('scoped-wheel-changes-native-screenshot-and-appends-real-pixels');
  await controls.webContents.executeJavaScript("document.getElementById('btnStart').click()");
  await until('paused before overlap probe', () => !factory.getLongShotSnapshot().presentation.capturing);
  await delay(500);
  const stableScrolledFrame = await captureOwnedRect();
  const priorControlsBounds = controls.getBounds();
  controls.setBounds({ ...priorControlsBounds, x: display.bounds.x + rect.x, y: display.bounds.y + rect.y + 30 });
  await delay(80);
  let hiddenDuringCapture = false;
  const hiddenOverlapFrame = await factory.withLongShotCapture(controls.webContents.id, async () => {
    hiddenDuringCapture = !controls.isVisible();
    return captureOwnedRect();
  });
  assert.equal(hiddenDuringCapture, true);
  evidence.overlapPixelDelta = pixelDelta(stableScrolledFrame, hiddenOverlapFrame);
  assert.ok(evidence.overlapPixelDelta.meanChannelError < 1, 'overlapping controls must be hidden from OS screenshot');
  assert.equal(controls.isVisible(), true);
  evidence.checks.push('overlapping-controls-hidden-during-native-capture-and-restored');

  await controls.webContents.executeJavaScript("document.getElementById('btnDone').click()").catch(() => {});
  await until('done exports and destroys production session', () => !factory.getLongShotSnapshot());
  assert.ok(savedData && savedData === copiedData, 'export must save/copy same longshot without touching real clipboard/files');
  evidence.checks.push('production-done-exports-and-closes-both-session-windows');
}

async function finish(error) {
  if (closing) return;
  closing = true;
  clearTimeout(timeout);
  const finalSnapshot = factory.getLongShotSnapshot();
  if (finalSnapshot) {
    evidence.finalState = { ...finalSnapshot.presentation };
    delete evidence.finalState.previewDataURL;
    try { evidence.finalHint = await finalSnapshot.controls.webContents.executeJavaScript('document.getElementById("hint").textContent'); } catch (_) {}
  }
  factory.closeLongShot();
  for (const win of [...ownedWindows]) if (!win.isDestroyed()) win.destroy();
  evidence.ownedWindowsRemaining = ownedWindows.size;
  console.log('LONGSHOT_NATIVE_RESULT ' + JSON.stringify({ ok: !error, ...evidence,
    failureStage: error && activeStage, error: error && error.stack, accessRequested: false }));
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  evidence.permission = systemPreferences.getMediaAccessStatus('screen');
  if (!process.argv.includes('--visible-owned-fixture')) {
    evidence.permissionOnly = true;
    return;
  }
  if (evidence.permission !== 'granted') {
    evidence.skipped = 'Screen permission is not already granted; no prompt or capture requested.';
    return;
  }
  timeout = setTimeout(() => finish(new Error('Native fixture exceeded 30 second budget')), 30000);
  await runVisibleFixture();
}).then(() => finish(), (error) => finish(error));

function cleanupOwnedData() {
  if (path.dirname(tempRoot) === path.resolve(os.tmpdir()) && path.basename(tempRoot).startsWith('kk-longshot-native-')) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}
app.on('quit', cleanupOwnedData);
process.on('exit', cleanupOwnedData);
