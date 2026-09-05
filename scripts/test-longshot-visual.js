'use strict';

// Run with: env -u ELECTRON_RUN_AS_NODE electron scripts/test-longshot-visual.js
// All windows are hidden and load the actual production renderer HTML/CSS/JS.
// Frames contain only locally generated row textures and test text. This harness
// never starts the production main process or reads the user's desktop/data.
// Optional KK_LONGSHOT_VISUAL_ARTIFACTS=/absolute/output/parent retains PNGs of
// these test-owned renderer windows in a unique subdirectory for visual review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'longshot-visual-preload.cjs');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-longshot-visual-'));
const windows = new Set();
const contexts = new Map();
const runtimeErrors = [];
const checks = [];
const pixelEvidence = [];
const artifacts = [];
let artifactDirectory = null;
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const STEP = 80;
let fixtureWindow;
let finishing = false;
let activeStage = 'startup';

app.setPath('userData', path.join(TEMP_ROOT, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(description, probe, timeout = 7000) {
  activeStage = description;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(35);
  }
  throw new Error(`${description}: timed out after ${timeout} ms; renderer errors: ${JSON.stringify(runtimeErrors)}`);
}

function contextFor(event) {
  const context = contexts.get(event.sender.id);
  assert.ok(context, 'only a registered fixture renderer may use the test bridge');
  return context;
}

ipcMain.handle('longshot-visual:capture', async (event, payload) => {
  const context = contextFor(event);
  assert.equal(event.sender.id, context.controls.webContents.id);
  assert.deepEqual(payload.rect, context.init.rect);
  assert.equal(payload.displayId, 'synthetic-display');
  context.captureCalls += 1;
  if (context.pendingCapture) await context.pendingCapture;
  if (context.blockAfterCapture && context.captureCalls > context.blockAfterCapture) await context.blockedCapture;
  return context.frames[context.frameIndex];
});

ipcMain.handle('longshot-visual:present', (event, payload) => {
  const context = contextFor(event);
  assert.equal(event.sender.id, context.controls.webContents.id);
  context.updates.push(payload);
  if (context.updates.length > 100) context.updates.shift();
  context.latest = { ...(context.latest || {}), ...payload };
  if (context.guide && !context.guide.isDestroyed()) {
    context.guide.webContents.send('longshot-visual:update', payload);
  }
  return { ok: true, previewAvailable: true };
});

ipcMain.handle('longshot-visual:save', (event, dataURL) => {
  const context = contextFor(event);
  assert.ok(dataURL.startsWith('data:image/png;base64,'));
  context.saveCalls += 1;
  return { saved: true };
});

ipcMain.handle('longshot-visual:copy', (event, dataURL) => {
  const context = contextFor(event);
  assert.ok(dataURL.startsWith('data:image/png;base64,'));
  context.copyCalls += 1;
  return context.copySucceeds;
});

ipcMain.handle('longshot-visual:close', (event) => {
  const context = contextFor(event);
  context.closeCalls += 1;
  for (const win of [context.controls, context.guide]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  return { ok: true };
});

function createHiddenWindow(width, height, withBridge = true) {
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: withBridge ? PRELOAD : undefined,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  win.webContents.on('render-process-gone', (_event, details) => runtimeErrors.push(details));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && !String(event.message).includes('复制到剪贴板失败')) {
      runtimeErrors.push(event.message);
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

async function createFrames() {
  fixtureWindow = createHiddenWindow(800, 800, false);
  await fixtureWindow.loadURL('data:text/html;charset=utf-8,<title>Synthetic longshot fixture</title>');
  return fixtureWindow.webContents.executeJavaScript(`(() => {
    const width = ${FRAME_WIDTH};
    const height = ${FRAME_HEIGHT};
    const source = document.createElement('canvas');
    source.width = width; source.height = height + ${STEP} * 3;
    const ctx = source.getContext('2d');
    const image = ctx.createImageData(source.width, source.height);
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const hash = Math.imul(y + 1, 1103515245) ^ Math.imul(Math.floor(x / 4) + 7, 2654435761);
        const tone = x < width * .18 ? 0 : x >= width * .82 ? 255 : 35 + ((hash >>> 8) & 191);
        const i = (y * width + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = tone;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    ctx.font = 'bold 12px sans-serif';
    for (let y = 24; y < source.height; y += 48) {
      ctx.fillStyle = '#fff'; ctx.fillRect(74, y - 14, 170, 20);
      ctx.fillStyle = '#111'; ctx.fillText('Synthetic document row ' + y, 78, y);
    }
    return [0, ${STEP}, ${STEP * 2}].map((top) => {
      const frame = document.createElement('canvas');
      frame.width = width; frame.height = height;
      frame.getContext('2d').drawImage(source, 0, top, width, height, 0, 0, width, height);
      return frame.toDataURL('image/png');
    });
  })()`);
}

async function createControls(frames, { width = 660, height = 76, autoStart = true } = {}) {
  activeStage = 'create and load hidden controls';
  const controls = createHiddenWindow(width, height);
  const context = {
    controls, guide: null, frames, frameIndex: 0, captureCalls: 0,
    updates: [], latest: null, saveCalls: 0, copyCalls: 0, closeCalls: 0,
    copySucceeds: true, pendingCapture: null,
    init: {
      rect: { x: 100, y: 70, width: FRAME_WIDTH, height: FRAME_HEIGHT },
      displayId: 'synthetic-display', scaleFactor: 1, autoStart, previewAvailable: true,
      displayBounds: { x: 0, y: 0, width: 1200, height: 800 },
    },
  };
  contexts.set(controls.webContents.id, context);
  await controls.loadFile(path.join(ROOT, 'src/renderer/longshot/longshot.html'));
  controls.webContents.send('longshot-visual:init', context.init);
  return context;
}

async function createGuide(context) {
  const guide = createHiddenWindow(1200, 800);
  context.guide = guide;
  contexts.set(guide.webContents.id, context);
  await guide.loadFile(path.join(ROOT, 'src/renderer/longshot/longshot-guide.html'));
  guide.webContents.send('longshot-visual:init', {
    ...context.init, surface: 'guide',
    layout: {
      rect: context.init.rect,
      preview: { x: 460, y: 70, width: 210, height: 350 },
      toolbar: { x: 60, y: 450, width: 660, height: 76 },
    },
    presentation: context.latest,
  });
  guide.webContents.send('longshot-visual:update', context.latest);
  return guide;
}

const execute = (context, code) => context.controls.webContents.executeJavaScript(code);
const click = (context, id) => execute(context, `document.getElementById(${JSON.stringify(id)}).click()`);

async function clickToClose(context, id) {
  activeStage = `click ${id} and await owned window closure`;
  const win = context.controls;
  let onClosed;
  const closed = new Promise((resolve) => { onClosed = resolve; win.once('closed', onClosed); });
  try {
    // A click can synchronously destroy its own renderer before the JS result
    // reaches Electron. The owned window's closed event is authoritative; do
    // not wait forever for a reply from the destroyed execution context.
    await Promise.race([closed, click(context, id).catch((error) => {
      if (!win.isDestroyed()) throw error;
    })]);
    await until(`${id} must destroy its owned controls window`, () => win.isDestroyed());
  } finally {
    win.removeListener('closed', onClosed);
  }
}

async function captureArtifact(win, name) {
  if (!artifactDirectory) return;
  const target = path.join(artifactDirectory, name + '.png');
  assert.equal(fs.existsSync(target), false, 'fixture screenshots must never overwrite existing files');
  const screenshot = await win.webContents.capturePage();
  fs.writeFileSync(target, screenshot.toPNG(), { flag: 'wx', mode: 0o600 });
  artifacts.push(target);
}

async function assertNoOverflow(context, description) {
  const state = await execute(context, `(() => {
    const visible = (element) => element && !element.hidden && getComputedStyle(element).display !== 'none' && element.getClientRects().length;
    const controls = Array.from(document.querySelectorAll('#bar button, #bar input, #bar select')).filter((element) => {
      for (let node = element; node; node = node.parentElement) if (!visible(node)) return false;
      return true;
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      overflow: controls.map((element) => ({ id: element.id, rect: element.getBoundingClientRect().toJSON() }))
        .filter(({rect}) => rect.x < -1 || rect.y < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) };
  })()`);
  assert.ok(state.scrollWidth <= state.width, `${description}: document overflows: ${JSON.stringify(state)}`);
  assert.deepEqual(state.overflow, [], `${description}: visible controls must fit: ${JSON.stringify(state)}`);
}

async function assertGuidePixels(context) {
  activeStage = 'await guide DOM, image decode and compositor pixels';
  const expectedPreview = context.latest.previewDataURL;
  const started = Date.now();
  const timeout = 3500;
  const observations = [];
  let attempts = 0;
  let imageRect;
  let pixels;
  while (Date.now() - started < timeout) {
    attempts += 1;
    const dom = await context.guide.webContents.executeJavaScript(`(() => {
    const image = document.getElementById('previewImage');
    const panel = document.getElementById('previewPanel');
    const outline = document.getElementById('selectionOutline');
    const state = { readyState: document.readyState, visibility: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      image: image && { currentSource: image.src === ${JSON.stringify(expectedPreview)},
        complete: image.complete, hidden: image.hidden, display: getComputedStyle(image).display,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        rect: image.getBoundingClientRect().toJSON() },
      panel: panel && { hidden: panel.hidden, display: getComputedStyle(panel).display,
        rect: panel.getBoundingClientRect().toJSON() },
      outline: outline && { display: getComputedStyle(outline).display, rect: outline.getBoundingClientRect().toJSON() },
      masks: ['shadeTop', 'shadeBottom', 'shadeLeft', 'shadeRight'].map((id) => {
        const mask = document.getElementById(id);
        return mask && { id, rect: mask.getBoundingClientRect().toJSON(),
          display: getComputedStyle(mask).display, background: getComputedStyle(mask).backgroundColor };
      }), ready: false };
    if (!image || !state.image.currentSource || !image.complete || !image.naturalWidth || image.hidden || state.image.display === 'none' || !panel || panel.hidden || state.panel.display === 'none') return state;
    const r = image.getBoundingClientRect();
    if (!r.width || !r.height || !outline || state.outline.display === 'none') return state;
    const scale = Math.min(r.width / image.naturalWidth, r.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    state.ready = true;
    state.imageRect = { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      size: document.getElementById('previewSize').textContent,
      count: document.getElementById('previewCount').textContent };
    return state;
  })()`);
    imageRect = dom.imageRect;
    pixels = dom.ready ? inspectGuidePixels(await context.guide.webContents.capturePage(), imageRect, context.init.rect) : null;
    if (pixels && pixels.failures.length === 0) break;
    observations.push({ attempt: attempts, elapsedMs: Date.now() - started,
      layer: dom.ready ? 'compositor-pixels' : 'dom-layout-image-decode', dom, pixels });
    // Preserve the first observation and the most recent seven without logging
    // synthetic PNG payloads or flooding normal successful test output.
    if (observations.length > 8) observations.splice(1, 1);
    await delay(35);
  }
  // A hidden Electron window may return its initial fully transparent surface
  // after DOM layout and image decoding are already ready. Await only the real
  // pixels of this presentation, not a new test/session or a fixed sleep. The
  // original strict pixel conditions are unchanged; persistent defects time out
  // with separate DOM/decode/layout and compositor evidence.
  assert.ok(pixels && pixels.failures.length === 0,
    `guide did not paint the expected pixels within ${timeout} ms: ${JSON.stringify({
      expected: { frameCount: context.latest.frameCount, outputWidth: context.latest.outputWidth, outputHeight: context.latest.outputHeight },
      attempts, observations, rendererErrors: runtimeErrors,
    })}`);
  assert.ok(imageRect.width > 20 && imageRect.height > 20);
  pixelEvidence.push({ size: imageRect.size, count: imageRect.count,
    preview: { width: imageRect.naturalWidth, height: imageRect.naturalHeight },
    capture: pixels.size, tones: pixels.preview.map((sample) => sample.tone),
    selectionAlpha: 0, maskAlpha: pixels.mask.alpha, compositorAttempts: attempts });
  return imageRect;
}

function inspectGuidePixels(capture, imageRect, selection) {
  const size = capture.getSize();
  const bitmap = capture.toBitmap();
  const failures = [];
  if (capture.isEmpty() || !size.width || !size.height || bitmap.length !== size.width * size.height * 4) {
    return { size, bitmapBytes: bitmap.length, failures: ['capture is empty or its bitmap dimensions are inconsistent'] };
  }
  const bitmapOffset = (x, y) => (Math.floor(y * size.height / imageRect.viewportHeight) * size.width + Math.floor(x * size.width / imageRect.viewportWidth)) * 4;
  const selectionPixels = [
    [selection.x + 1, selection.y + 1],
    [selection.x + selection.width - 2, selection.y + selection.height - 2],
    [selection.x + Math.floor(selection.width / 2), selection.y + Math.floor(selection.height / 2)],
  ].map(([x, y]) => ({ x, y, alpha: bitmap[bitmapOffset(x, y) + 3] }));
  if (selectionPixels.some((sample) => sample.alpha !== 0)) failures.push('the guide must leave the actual capture selection fully transparent');
  const mask = { x: 20, y: 20, alpha: bitmap[bitmapOffset(20, 20) + 3] };
  if (!(mask.alpha > 20)) failures.push('the area outside the selection should have a visible visual mask');
  const preview = [[0.08, 0], [0.92, 255]].map(([fraction, expected]) => {
    const x = Math.floor(imageRect.x + imageRect.width * fraction);
    const y = Math.floor(imageRect.y + imageRect.height * 0.5);
    const offset = bitmapOffset(x, y);
    if (!(Math.abs(bitmap[offset] - expected) <= 24)) failures.push(`actual guide pixels at ${fraction}: expected ${expected}, got ${bitmap[offset]}`);
    if (!(bitmap[offset + 3] > 240)) failures.push('preview pixels must not be transparent');
    return { x, y, expected, tone: bitmap[offset], alpha: bitmap[offset + 3] };
  });
  return { size, bitmapBytes: bitmap.length, selection: selectionPixels, mask, preview, failures };
}

async function run() {
  await app.whenReady();
  if (process.env.KK_LONGSHOT_VISUAL_ARTIFACTS) {
    const parent = process.env.KK_LONGSHOT_VISUAL_ARTIFACTS;
    assert.ok(path.isAbsolute(parent), 'KK_LONGSHOT_VISUAL_ARTIFACTS must be an absolute output directory');
    fs.mkdirSync(parent, { recursive: true });
    artifactDirectory = fs.mkdtempSync(path.join(parent, 'kk-longshot-visual-'));
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const frames = await createFrames();
  const context = await createControls(frames);

  // This is the deliberate red/green gate: the old UI ignores autoStart entirely.
  await until('entering longshot must capture the first frame without clicking Start', () => context.captureCalls > 0);
  await until('automatic first frame must publish its actual preview', () => context.latest && context.latest.frameCount === 1 && context.latest.previewDataURL && context.latest.capturing === true);
  assert.equal(context.latest.outputWidth, FRAME_WIDTH);
  assert.equal(context.latest.outputHeight, FRAME_HEIGHT);
  assert.equal(context.latest.capturing, true);
  const firstPreview = context.latest.previewDataURL;
  const initial = await execute(context, `({
    label: document.querySelector('#btnStart .label').textContent,
    adjustHidden: document.getElementById('adjustPanel').hidden,
    adjustDisplay: getComputedStyle(document.getElementById('adjustPanel')).display,
    hiddenLeaks: Array.from(document.querySelectorAll('[hidden]')).filter((element) => getComputedStyle(element).display !== 'none').map((element) => element.id),
  })`);
  assert.equal(initial.label, '暂停');
  assert.equal(initial.adjustHidden, true);
  assert.equal(initial.adjustDisplay, 'none');
  assert.deepEqual(initial.hiddenLeaks, []);
  await assertNoOverflow(context, 'collapsed controls');
  checks.push('auto-first-frame-and-hidden-controls');
  await captureArtifact(context.controls, '01-controls-first-frame');

  await createGuide(context);
  await assertGuidePixels(context);
  await captureArtifact(context.guide, '02-guide-first-frame');
  // Freeze later requests so a third/idle capture cannot accidentally repair a
  // disabled Adjust button left behind by the second-frame completion path.
  let releaseLaterCapture;
  context.blockAfterCapture = context.captureCalls + 1;
  context.blockedCapture = new Promise((resolve) => { releaseLaterCapture = resolve; });
  context.frameIndex = 1;
  await until('scrolling the source must append a second frame and grow the live preview', () => context.latest && context.latest.frameCount === 2 && context.latest.outputHeight === FRAME_HEIGHT + STEP);
  assert.equal(await execute(context, `document.getElementById('btnAdjust').disabled`), false, 'Adjust must be immediately usable after the second frame, without first pausing or waiting for another capture');
  await click(context, 'btnAdjust');
  await until('clicking Adjust directly after the second frame must pause capture', () => context.latest.capturing === false && context.latest.expanded === true);
  context.blockAfterCapture = 0;
  releaseLaterCapture();
  checks.push('second-frame-adjust-without-pause-or-idle');
  assert.notEqual(context.latest.previewDataURL, firstPreview);
  const preview = nativeImage.createFromDataURL(context.latest.previewDataURL);
  assert.ok(!preview.isEmpty());
  assert.ok(preview.getSize().height > 0);
  assert.ok(preview.getSize().width <= 240 && preview.getSize().height <= 480, 'IPC thumbnails must stay bounded independently of final output size');
  const secondGuide = await assertGuidePixels(context);
  assert.ok(secondGuide.size.includes(String(FRAME_HEIGHT + STEP)));
  await captureArtifact(context.guide, '03-guide-two-frames');
  checks.push('scroll-appends-and-actual-guide-pixels');

  await delay(150);
  const pausedCalls = context.captureCalls;
  await delay(1100);
  assert.equal(context.captureCalls, pausedCalls, 'paused capture must have no active polling timer');
  await click(context, 'btnStart');
  await until('resume must continue the retained timeline', () => context.latest.capturing === true && context.latest.frameCount === 2);
  await click(context, 'btnAdjust');
  context.controls.setContentSize(660, 300);
  await until('adjustment controls must expand visibly', () => execute(context, `!document.getElementById('adjustPanel').hidden && getComputedStyle(document.getElementById('adjustPanel')).display !== 'none'`));
  await until('opening adjustments must pause the active capture', () => context.latest.capturing === false);
  await assertNoOverflow(context, 'expanded adjustments');
  await captureArtifact(context.controls, '04-controls-adjustments');
  await click(context, 'btnDeleteSegment');
  await until('deleting a retained frame must rebuild and shrink the preview', () => context.latest.frameCount === 1 && context.latest.outputHeight === FRAME_HEIGHT);
  await click(context, 'btnUndo');
  await until('undo must restore the original preview geometry', () => context.latest.frameCount === 2 && context.latest.outputHeight === FRAME_HEIGHT + STEP);
  assert.equal(await execute(context, `document.getElementById('btnDir').disabled`), true, 'direction must lock after multiple stitched frames');
  await execute(context, `(() => {
    const field = document.getElementById('fixedTop');
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await delay(100);
  assert.equal(context.saveCalls, 0, 'pressing Enter in an adjustment input must not unexpectedly export');
  await execute(context, `(() => { const crop = document.getElementById('cropTop'); crop.value = '20'; crop.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until('crop changes must immediately update the visible output size', () => context.latest.outputHeight === FRAME_HEIGHT + STEP - 20);
  await execute(context, `(() => { const crop = document.getElementById('cropTop'); crop.value = '0'; crop.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until('resetting crop must restore full preview size', () => context.latest.outputHeight === FRAME_HEIGHT + STEP);
  await click(context, 'btnAdjust');
  context.controls.setContentSize(320, 76);
  await assertNoOverflow(context, 'narrow collapsed controls');
  await captureArtifact(context.controls, '05-controls-narrow');
  checks.push('pause-resume-edit-undo-crop-and-narrow-layout');

  context.copySucceeds = false;
  await click(context, 'btnDone');
  await until('clipboard error must keep the captured image retryable', () => execute(context, `document.getElementById('hint').textContent.includes('复制到剪贴板失败')`));
  assert.equal(context.closeCalls, 0);
  assert.equal(context.saveCalls, 1);
  assert.equal(context.copyCalls, 1);
  context.copySucceeds = true;
  await clickToClose(context, 'btnDone');
  await until('successful retry must close the controls and guide', () => context.controls.isDestroyed() && context.guide.isDestroyed());
  assert.equal(context.saveCalls, 1, 'copy retry must reuse the successful in-memory save checkpoint');
  assert.equal(context.copyCalls, 2);
  checks.push('copy-failure-retry-and-owned-window-cleanup');

  const cancel = await createControls(frames);
  await until('cancel fixture must start automatically', () => cancel.latest && cancel.latest.frameCount === 1);
  let releaseCapture;
  cancel.pendingCapture = new Promise((resolve) => { releaseCapture = resolve; });
  const captureCount = cancel.captureCalls;
  await until('one synthetic frame must be in flight before cancel', () => cancel.captureCalls > captureCount);
  await clickToClose(cancel, 'btnCancel');
  await until('cancel must destroy the owned controls', () => cancel.controls.isDestroyed());
  const updatesAtCancel = cancel.updates.length;
  releaseCapture();
  await delay(150);
  assert.equal(cancel.updates.length, updatesAtCancel, 'a late captured frame must not publish a preview after cancellation');
  assert.equal(cancel.saveCalls, 0);
  assert.equal(cancel.copyCalls, 0);
  checks.push('cancel-drops-in-flight-frame');

  const horizontal = await createControls(frames);
  await until('horizontal fixture must first auto-capture the default vertical frame', () => horizontal.latest && horizontal.latest.frameCount === 1 && horizontal.latest.capturing === true);
  const beforeDirectionSwitch = horizontal.captureCalls;
  await click(horizontal, 'btnDir');
  await until('switching the first frame to horizontal must automatically recapture', () => horizontal.captureCalls > beforeDirectionSwitch && horizontal.latest.frameCount === 1 && horizontal.latest.capturing === true);
  assert.equal(await execute(horizontal, `document.querySelector('#btnDir .label').textContent`), '横向');
  assert.equal(horizontal.latest.outputWidth, FRAME_WIDTH, 'horizontal preview must restore original source orientation');
  assert.equal(horizontal.latest.outputHeight, FRAME_HEIGHT);
  await clickToClose(horizontal, 'btnCancel');
  checks.push('horizontal-first-frame-orientation');
  assert.deepEqual(runtimeErrors, [], 'production renderers must not emit unexpected errors');
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  for (const win of [...windows]) if (!win.isDestroyed()) win.destroy();
  assert.equal(windows.size, 0, 'all test-owned Electron windows must be destroyed');
  console.log('LONGSHOT_VISUAL_RESULT ' + JSON.stringify({ ok: !error, checks, pixelEvidence, artifacts,
    error: error && error.stack, failureStage: error && activeStage }));
  app.exit(error ? 1 : 0);
}

const timeout = setTimeout(() => finish(new Error('longshot visual test exceeded its 55 second budget')), 55_000);
run().then(() => { clearTimeout(timeout); return finish(); }, (error) => { clearTimeout(timeout); return finish(error); });
// Only our uniquely named test cache is removed. No production app data is read.
process.on('exit', () => {
  if (path.dirname(TEMP_ROOT) === os.tmpdir() && path.basename(TEMP_ROOT).startsWith('kk-longshot-visual-')) {
    try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  }
});
