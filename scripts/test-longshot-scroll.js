'use strict';

// Run: node scripts/test-longshot-scroll.js
// Unlike the texture-based visual harness, this drives Chromium's real wheel
// input, observes DOM scrollTop, captures rendered document pixels, and feeds
// them to the unmodified production longshot renderer. All windows are hidden.
// This is NOT a desktop-capture/OS click-through test: its deliberately limited
// capture bridge reads only this test's source window, never the user's screen.
// --baseline=v0.3.5 loads the released renderer from Git for a red/green check.
// --scenario=sparse-article|sparse-chat|fixed-header limits a diagnostic run.
// KK_LONGSHOT_SCROLL_ARTIFACTS=/absolute/directory retains only fixture PNGs.
// KK_LONGSHOT_SCROLL_RENDERER_DIR=/absolute/app.asar/src/renderer/longshot
// validates the exact packaged/installed renderer instead of the source tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
// A Node owner waits for Electron to fully stop before removing its unique
// cache directory. Electron exit handlers alone race Chromium's final writes.
if (!process.versions.electron) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-longshot-scroll-'));
  const env = { ...process.env, KK_LONGSHOT_SCROLL_OWNED_TEMP: ownedRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
      env, stdio: 'inherit', timeout: 110000,
    });
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
  console.log('LONGSHOT_SCROLL_CLEANUP ' + JSON.stringify({ ownedDirectoryRemoved: !fs.existsSync(ownedRoot) }));
  process.exit(result && Number.isInteger(result.status) ? result.status : 1);
}
const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'longshot-visual-preload.cjs');
const DOCUMENT = path.join(__dirname, 'fixtures', 'longshot-scroll-document.html');
const TEMP_ROOT = process.env.KK_LONGSHOT_SCROLL_OWNED_TEMP
  || fs.mkdtempSync(path.join(os.tmpdir(), 'kk-longshot-scroll-'));
const WIDTH = 1100;
const HEIGHT = 650;
const STEP = 120;
const SCENARIOS = ['sparse-article', 'sparse-chat', 'fixed-header'];
const windows = new Set();
const contexts = new Map();
const checks = [];
const evidence = [];
const runtimeErrors = [];
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice('--baseline='.length);
const requestedScenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);
const requestedRendererDirectory = process.env.KK_LONGSHOT_SCROLL_RENDERER_DIR;
let rendererRoot = path.join(ROOT, 'src', 'renderer', 'longshot');
let artifactDirectory = null;
let activeStage = 'startup';
let finishing = false;

app.setPath('userData', path.join(TEMP_ROOT, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function until(description, probe, timeout = 12000) {
  activeStage = description;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(35);
  }
  throw new Error(`${description}: timed out; evidence=${JSON.stringify(evidence)}; errors=${JSON.stringify(runtimeErrors)}`);
}

function createWindow(width, height, bridge = false) {
  const win = new BrowserWindow({
    width, height, show: false, frame: false,
    webPreferences: {
      preload: bridge ? PRELOAD : undefined,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  win.webContents.on('render-process-gone', (_event, details) => runtimeErrors.push(details));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') runtimeErrors.push(event.message);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function contextFor(event) {
  const context = contexts.get(event.sender.id);
  assert.ok(context, 'only test-owned controls may access this isolated bridge');
  return context;
}

const scrollTop = (win) => win.webContents.executeJavaScript("document.getElementById('scrollArea').scrollTop");

async function capturePainted(win) {
  // Hidden native windows can finish load before their first compositor surface
  // exists. Retry that explicit startup condition; never show/focus the window.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const image = await win.webContents.capturePage();
      if (!image.isEmpty()) {
        // macOS capturePage can return Retina pixels despite the Chromium scale
        // switch. Normalize both live and oracle captures to fixture CSS pixels.
        const [width, height] = win.getContentSize();
        return image.getSize().width === width && image.getSize().height === height
          ? image : image.resize({ width, height, quality: 'best' });
      }
    } catch (error) {
      if (!String(error.message).includes('UnknownVizError')) throw error;
    }
    await delay(35);
  }
  throw new Error('owned hidden document compositor did not produce pixels within 7 seconds');
}

function retainImage(name, image) {
  if (!artifactDirectory) return;
  const target = path.join(artifactDirectory, name + '.png');
  assert.equal(fs.existsSync(target), false, 'fixture artifacts may not overwrite existing files');
  fs.writeFileSync(target, image.toPNG(), { flag: 'wx', mode: 0o600 });
}

ipcMain.handle('longshot-visual:capture', async (event, payload) => {
  const context = contextFor(event);
  assert.deepEqual(payload.rect, context.init.rect);
  assert.equal(payload.displayId, 'owned-document');
  const topBefore = await scrollTop(context.source);
  const image = await capturePainted(context.source);
  const topAfter = await scrollTop(context.source);
  assert.deepEqual(image.getSize(), { width: WIDTH, height: HEIGHT });
  assert.equal(image.isEmpty(), false, 'the source must produce actual compositor pixels');
  const hash = sha256(image.toPNG());
  context.captureCalls += 1;
  context.evidence.captureCalls = context.captureCalls;
  // DOM observation and compositor capture are asynchronous. Record both sides
  // of every actual capture; neither observation is an exact image timestamp.
  // Keep the original offset-based assertions, but never discard diagnostics
  // when the same DOM offset later produces a different compositor image.
  if (!context.frameHashes.has(topBefore)) context.frameHashes.set(topBefore, hash);
  const captureId = context.captureCalls;
  context.evidence.frames.push({ captureId, scrollTop: topBefore, topBefore, topAfter, sha256: hash });
  retainImage(`${context.scenario}-capture-${String(captureId).padStart(3, '0')}-${topBefore}-to-${topAfter}`, image);
  return image.toDataURL();
});

ipcMain.handle('longshot-visual:present', (event, payload) => {
  const context = contextFor(event);
  context.latest = { ...(context.latest || {}), ...payload };
  context.evidence.lastPresentation = {
    capturing: context.latest.capturing, expanded: context.latest.expanded,
    frameCount: context.latest.frameCount, outputHeight: context.latest.outputHeight,
    status: context.latest.status,
  };
  return { ok: true, previewAvailable: true };
});
ipcMain.handle('longshot-visual:save', (event, dataURL) => {
  const context = contextFor(event);
  assert.equal(context.savedDataURL, undefined, 'successful completion saves exactly once');
  context.saveCalls += 1;
  context.savedDataURL = dataURL;
  return { saved: true };
});
ipcMain.handle('longshot-visual:copy', (event, dataURL) => {
  const context = contextFor(event);
  assert.equal(context.copiedDataURL, undefined, 'successful completion copies exactly once');
  context.copiedDataURL = dataURL;
  context.copyCalls += 1;
  return true;
});
ipcMain.handle('longshot-visual:close', (event) => {
  const context = contextFor(event);
  context.closeCalls += 1;
  context.controls.destroy();
  return { ok: true };
});

async function wheelTo(source, previousTop, nextTop) {
  // Crucially: no DOM assignment to scrollTop and no precomputed frame index.
  source.webContents.sendInputEvent({
    type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2,
    deltaX: 0, deltaY: previousTop - nextTop, canScroll: true,
  });
  await until(`real wheel must move source scrollTop from ${previousTop} to ${nextTop}`, async () => (await scrollTop(source)) === nextTop);
}

async function canvasNormalizedImage(win, image) {
  // Native screenshots can carry a display color profile. Production decodes
  // them into a Canvas (sRGB) before composition. Apply that same conversion to
  // the independent full-document oracle, not a relaxed comparison threshold.
  const dataURL = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const output = document.createElement('canvas');
      output.width = canvas.width;
      output.height = canvas.height;
      output.getContext('2d', { willReadFrequently: true }).putImageData(pixels, 0, 0);
      resolve(output.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('oracle screenshot failed Canvas decoding'));
    image.src = ${JSON.stringify(image.toDataURL())};
  })`);
  return nativeImage.createFromDataURL(dataURL);
}

function compareFinalPixels(scenario, finalImage, reference) {
  const actual = finalImage.toBitmap();
  const expected = reference.toBitmap();
  assert.deepEqual(finalImage.getSize(), reference.getSize(), 'output geometry must equal the full unbroken original document');
  assert.equal(actual.length, expected.length);
  let mismatchedPixels = 0;
  const examples = [];
  for (let i = 0; i < actual.length; i += 4) {
    if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] ||
        actual[i + 2] !== expected[i + 2] || actual[i + 3] !== expected[i + 3]) {
      mismatchedPixels += 1;
      if (examples.length < 8) examples.push({ x: i / 4 % WIDTH, y: Math.floor(i / 4 / WIDTH),
        actual: [...actual.subarray(i, i + 4)], expected: [...expected.subarray(i, i + 4)] });
    }
  }
  const result = { scenario, comparedPixels: actual.length / 4, mismatchedPixels, examples };
  assert.equal(mismatchedPixels, 0, `no missing/repeated text, whitespace or fixed navigation: ${JSON.stringify(result)}`);
  return result;
}

async function runScenario(scenario) {
  const source = createWindow(WIDTH, HEIGHT);
  await source.loadFile(DOCUMENT, { query: { scenario } });
  assert.equal(await scrollTop(source), 0);
  const reference = createWindow(WIDTH, HEIGHT + 3 * STEP);
  await reference.loadFile(DOCUMENT, { query: { scenario } });
  const referenceImage = await canvasNormalizedImage(reference, await capturePainted(reference));
  retainImage(`${scenario}-reference`, referenceImage);

  const controls = createWindow(800, 300, true);
  const scenarioEvidence = { scenario, captureCalls: 0, frames: [], scrollEvents: [] };
  evidence.push(scenarioEvidence);
  const context = { source, controls, scenario, captureCalls: 0, copyCalls: 0, saveCalls: 0, closeCalls: 0,
    latest: null, frameHashes: new Map(), evidence: scenarioEvidence,
    init: { rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      displayId: 'owned-document', scaleFactor: 1, autoStart: true, previewAvailable: true,
      displayBounds: { x: 0, y: 0, width: 1600, height: 1000 } },
  };
  contexts.set(controls.webContents.id, context);
  await controls.loadFile(path.join(rendererRoot, 'longshot.html'));
  controls.webContents.send('longshot-visual:init', context.init);
  await until(`${scenario}: automatic first real document frame`, () => context.latest?.frameCount === 1 && context.latest.capturing);

  // The reported failure happened before useful scrolling: duplicate/stationary
  // ordinary document frames were mistaken for fixed bands and paused capture.
  await until(`${scenario}: three idle captures must remain active`, async () => {
    if (context.latest?.capturing === false) {
      const hint = await controls.webContents.executeJavaScript("document.getElementById('hint').textContent");
      throw new Error(`${scenario}: stationary source unexpectedly paused after ${context.captureCalls} captures: ${hint}`);
    }
    return context.captureCalls >= 3;
  });
  assert.equal(context.latest.frameCount, 1, 'idle sampling must not append duplicate frames');
  assert.equal(context.latest.outputHeight, HEIGHT);
  checks.push(`${scenario}:stationary-does-not-pause-or-duplicate`);

  for (let step = 1; step <= 3; step += 1) {
    const top = step * STEP;
    await wheelTo(source, (step - 1) * STEP, top);
    scenarioEvidence.scrollEvents.push({ requested: top, actual: await scrollTop(source) });
    await until(`${scenario}: real scroll ${step} must extend output to ${HEIGHT + top}`, () => {
      assert.notEqual(context.latest?.capturing, false, 'sampling must not require clicking Continue/Apply');
      return context.latest?.outputHeight === HEIGHT + top && context.latest?.frameCount >= step + 1 && context.frameHashes.has(top);
    });
    assert.equal(context.latest.expanded, false, 'ordinary scrolling must not open the adjustment panel');
    assert.ok(context.frameHashes.has(top), 'real DOM pixels must have been captured at this scroll offset');
    assert.notEqual(context.frameHashes.get(top), context.frameHashes.get((step - 1) * STEP), 'the source pixels must change after each real wheel event');
    checks.push(`${scenario}:wheel-${step}-grows-output`);
  }

  // Copy is the default; the fixed-navigation scenario independently saves.
  // Both paths must preserve the same exact scroll/pixel oracle below.
  const exportAction = scenario === 'fixed-header' ? 'save' : 'copy';
  const exportButton = exportAction === 'save' ? 'btnSave' : 'btnDone';
  // Do not wait on an execution reply after the renderer closes itself.
  const closed = new Promise((resolve) => controls.once('closed', resolve));
  await Promise.race([closed, controls.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(exportButton)}).click()`).catch((error) => {
    if (!controls.isDestroyed()) throw error;
  })]);
  await until(`${scenario}: independent ${exportAction} closes owned controls`, () => controls.isDestroyed());
  assert.equal(context.copyCalls, exportAction === 'copy' ? 1 : 0, 'saving must not invoke the clipboard');
  assert.equal(context.saveCalls, exportAction === 'save' ? 1 : 0, 'default copy must not open a save dialog');
  assert.equal(context.closeCalls, 1);
  checks.push(`${scenario}:independent-${exportAction}-without-other-action`);
  const finalDataURL = exportAction === 'save' ? context.savedDataURL : context.copiedDataURL;
  assert.ok(finalDataURL?.startsWith('data:image/png;base64,'));
  const finalImage = nativeImage.createFromDataURL(finalDataURL);
  assert.deepEqual(finalImage.getSize(), { width: WIDTH, height: HEIGHT + STEP * 3 });
  retainImage(`${scenario}-final`, finalImage);
  scenarioEvidence.final = compareFinalPixels(scenario, finalImage, referenceImage);
  scenarioEvidence.final.sha256 = sha256(finalImage.toPNG());
  checks.push(`${scenario}:final-png-equals-complete-original-document`);
  source.destroy();
  reference.destroy();
}

async function run() {
  if (requestedRendererDirectory) {
    assert.ok(path.isAbsolute(requestedRendererDirectory), 'KK_LONGSHOT_SCROLL_RENDERER_DIR must be an absolute directory');
    assert.equal(baseline, undefined, 'a packaged renderer and a Git baseline cannot both be selected');
    rendererRoot = requestedRendererDirectory;
    for (const file of ['longshot.html', 'longshot.css', 'longshot.js', 'longshot-stitch.js']) {
      assert.equal(fs.statSync(path.join(rendererRoot, file)).isFile(), true, `renderer is missing ${file}`);
    }
  }
  if (baseline) {
    assert.equal(baseline, 'v0.3.5', 'only the known released baseline is supported');
    rendererRoot = path.join(TEMP_ROOT, 'baseline-renderer');
    fs.mkdirSync(rendererRoot);
    for (const file of ['longshot.html', 'longshot.css', 'longshot.js', 'longshot-stitch.js']) {
      const bytes = execFileSync('git', ['show', `${baseline}:src/renderer/longshot/${file}`], { cwd: ROOT });
      fs.writeFileSync(path.join(rendererRoot, file), bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  if (requestedScenario) assert.ok(SCENARIOS.includes(requestedScenario), 'unknown scroll fixture scenario');
  if (process.env.KK_LONGSHOT_SCROLL_ARTIFACTS) {
    const parent = process.env.KK_LONGSHOT_SCROLL_ARTIFACTS;
    assert.ok(path.isAbsolute(parent), 'artifact parent must be an absolute path');
    fs.mkdirSync(parent, { recursive: true });
    artifactDirectory = fs.mkdtempSync(path.join(parent, 'kk-longshot-scroll-'));
  }
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  for (const scenario of requestedScenario ? [requestedScenario] : SCENARIOS) await runScenario(scenario);
  assert.deepEqual(runtimeErrors, [], 'production renderer must not report unexpected errors');
}

function finish(error) {
  if (finishing) return;
  finishing = true;
  for (const win of [...windows]) if (!win.isDestroyed()) win.destroy();
  console.log('LONGSHOT_SCROLL_RESULT ' + JSON.stringify({ ok: !error, baseline: baseline || null,
    checks, evidence, artifactDirectory, rendererRoot, temporaryRoot: TEMP_ROOT, remainingOwnedWindows: windows.size,
    failureStage: error && activeStage, error: error && error.stack }));
  app.exit(error ? 1 : 0);
}

const timeout = setTimeout(() => finish(new Error('longshot real DOM scroll test exceeded 100 second budget')), 100_000);
run().then(() => { clearTimeout(timeout); finish(); }, (error) => { clearTimeout(timeout); finish(error); });
process.on('exit', () => {
  if (process.env.KK_LONGSHOT_SCROLL_OWNED_TEMP) return;
  if (path.dirname(TEMP_ROOT) === os.tmpdir() && path.basename(TEMP_ROOT).startsWith('kk-longshot-scroll-')) {
    try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  }
});
