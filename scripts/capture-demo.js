#!/usr/bin/env node
'use strict';

// Generate the public, privacy-safe README demo from the application's real
// Electron renderer pages. Run with:
//   ./node_modules/.bin/electron scripts/capture-demo.js
//
// This script never starts src/main/main.js. Instead, it loads the production
// HTML/CSS/JS in isolated hidden windows and supplies an in-memory kkapi bridge.
// No user config, API key, history file, clipboard content, or desktop pixels
// are read. HTTP(S) is blocked for every demo window.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, session } = require('electron');
const { version: APP_VERSION } = require('../package.json');

const REPO_ROOT = path.resolve(__dirname, '..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src', 'renderer');
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'assets');
const TEMP_PREFIX = path.join(os.tmpdir(), 'kunkun-shot-demo-');
const TEMP_ROOT = fs.mkdtempSync(TEMP_PREFIX);
const STAGE_DIR = path.join(TEMP_ROOT, 'stage');
const FRAME_DIR = path.join(TEMP_ROOT, 'frames');
const PRELOAD_PATH = path.join(TEMP_ROOT, 'demo-preload.cjs');
const viewportMatch = String(process.env.KK_DEMO_VIEWPORT || '').match(/^(\d+)x(\d+)$/i);
const VIEWPORT = viewportMatch
  ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
  : { width: 1600, height: 1000 };
if (VIEWPORT.width < 800 || VIEWPORT.height < 600) {
  throw new Error(`Demo viewport is too small: ${VIEWPORT.width}x${VIEWPORT.height}`);
}

fs.mkdirSync(STAGE_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(FRAME_DIR, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(TEMP_ROOT, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
// Keep the capture harness alive while it replaces one hidden renderer window
// with the next. Electron may otherwise terminate between stages.
app.on('window-all-closed', () => {});

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[char]);
}

function demoSvgDataUrl({ accent, accent2, title, subtitle, badge }) {
  const safe = {
    accent: escapeXml(accent),
    accent2: escapeXml(accent2),
    title: escapeXml(title),
    subtitle: escapeXml(subtitle),
    badge: escapeXml(badge),
  };
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1440 900">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#dce9ff"/>
          <stop offset="0.52" stop-color="#eef4ff"/>
          <stop offset="1" stop-color="#dff8ef"/>
        </linearGradient>
        <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${safe.accent}"/>
          <stop offset="1" stop-color="${safe.accent2}"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#25324a" flood-opacity="0.18"/>
        </filter>
      </defs>
      <rect width="1440" height="900" fill="url(#wall)"/>
      <circle cx="1250" cy="140" r="220" fill="#ffffff" opacity="0.33"/>
      <circle cx="120" cy="790" r="260" fill="#ffffff" opacity="0.25"/>
      <rect x="0" y="0" width="1440" height="34" fill="#f8fbff" opacity="0.95"/>
      <circle cx="20" cy="17" r="4" fill="#53627a" opacity="0.7"/>
      <text x="38" y="22" fill="#334155" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="650">Kunkun Shot · Privacy-safe demo desktop</text>
      <text x="1340" y="22" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">DEMO</text>

      <g filter="url(#shadow)">
        <rect x="118" y="86" width="1204" height="720" rx="24" fill="#f9fbff"/>
        <rect x="118" y="86" width="1204" height="58" rx="24" fill="#ffffff"/>
        <rect x="118" y="120" width="1204" height="24" fill="#ffffff"/>
        <circle cx="151" cy="115" r="7" fill="#ff6b68"/>
        <circle cx="175" cy="115" r="7" fill="#f7c84b"/>
        <circle cx="199" cy="115" r="7" fill="#52c96b"/>
        <text x="234" y="121" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14">Demo workspace · synthetic content only</text>

        <rect x="118" y="144" width="236" height="662" fill="#f1f5fb"/>
        <rect x="146" y="180" width="180" height="44" rx="12" fill="url(#hero)"/>
        <text x="170" y="208" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14" font-weight="700">Overview</text>
        <text x="170" y="272" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14">Captures</text>
        <text x="170" y="322" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14">Annotations</text>
        <text x="170" y="372" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14">AI workspace</text>
        <rect x="146" y="700" width="180" height="70" rx="14" fill="#ffffff"/>
        <circle cx="171" cy="727" r="9" fill="#3bb273"/>
        <text x="190" y="732" fill="#334155" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="650">Local demo mode</text>
        <text x="164" y="755" fill="#7c8aa0" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11">No personal data loaded</text>

        <text x="400" y="210" fill="#14213d" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="34" font-weight="760">${safe.title}</text>
        <text x="402" y="242" fill="#65758b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="16">${safe.subtitle}</text>
        <rect x="1134" y="184" width="142" height="36" rx="18" fill="${safe.accent}" opacity="0.12"/>
        <circle cx="1157" cy="202" r="6" fill="${safe.accent}"/>
        <text x="1172" y="207" fill="${safe.accent}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" font-weight="700">${safe.badge}</text>

        <rect x="396" y="284" width="260" height="152" rx="18" fill="#ffffff"/>
        <text x="422" y="321" fill="#738198" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13">CAPTURED TODAY</text>
        <text x="422" y="375" fill="#17233c" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="44" font-weight="760">24</text>
        <rect x="542" y="343" width="84" height="42" rx="12" fill="${safe.accent}" opacity="0.12"/>
        <text x="563" y="370" fill="${safe.accent}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="700">+18%</text>
        <text x="422" y="408" fill="#8b98aa" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">Private local workflow</text>

        <rect x="680" y="284" width="278" height="152" rx="18" fill="#ffffff"/>
        <text x="706" y="321" fill="#738198" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13">READY TO SHARE</text>
        <text x="706" y="375" fill="#17233c" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="44" font-weight="760">100%</text>
        <rect x="706" y="398" width="216" height="8" rx="4" fill="#e7edf6"/>
        <rect x="706" y="398" width="216" height="8" rx="4" fill="url(#hero)"/>

        <rect x="982" y="284" width="294" height="152" rx="18" fill="url(#hero)"/>
        <text x="1008" y="321" fill="#ffffff" opacity="0.76" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13">NEXT ACTION</text>
        <text x="1008" y="359" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="20" font-weight="720">Capture → Annotate</text>
        <text x="1008" y="390" fill="#ffffff" opacity="0.84" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13">Then ask AI when you choose.</text>

        <rect x="396" y="466" width="562" height="294" rx="18" fill="#ffffff"/>
        <text x="422" y="505" fill="#17233c" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="16" font-weight="720">Capture activity</text>
        <text x="422" y="529" fill="#8b98aa" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12">Synthetic values for the public demo</text>
        <path d="M430 700 C500 660 540 685 605 620 C675 550 730 630 790 570 C840 520 885 560 924 520" fill="none" stroke="${safe.accent}" stroke-width="8" stroke-linecap="round"/>
        <path d="M430 700 C500 660 540 685 605 620 C675 550 730 630 790 570 C840 520 885 560 924 520 L924 724 L430 724 Z" fill="${safe.accent}" opacity="0.10"/>
        <line x1="430" y1="724" x2="924" y2="724" stroke="#dbe3ef"/>

        <rect x="982" y="466" width="294" height="294" rx="18" fill="#ffffff"/>
        <text x="1008" y="505" fill="#17233c" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="16" font-weight="720">Demo checklist</text>
        <g font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14" fill="#334155">
          <circle cx="1020" cy="550" r="10" fill="#3bb273"/><path d="M1015 550l4 4 7-9" fill="none" stroke="#fff" stroke-width="2"/>
          <text x="1042" y="555">Select a region</text>
          <circle cx="1020" cy="596" r="10" fill="#3bb273"/><path d="M1015 596l4 4 7-9" fill="none" stroke="#fff" stroke-width="2"/>
          <text x="1042" y="601">Add an annotation</text>
          <circle cx="1020" cy="642" r="10" fill="#3bb273"/><path d="M1015 642l4 4 7-9" fill="none" stroke="#fff" stroke-width="2"/>
          <text x="1042" y="647">Review with AI</text>
          <circle cx="1020" cy="688" r="10" fill="#3bb273"/><path d="M1015 688l4 4 7-9" fill="none" stroke="#fff" stroke-width="2"/>
          <text x="1042" y="693">Share safely</text>
        </g>
      </g>
    </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const DEMO_IMAGES = [
  demoSvgDataUrl({
    accent: '#2563eb',
    accent2: '#7c3aed',
    title: 'Capture clearly. Share safely.',
    subtitle: 'A synthetic workspace made only for this open-source demo.',
    badge: 'READY',
  }),
  demoSvgDataUrl({
    accent: '#0f9f88',
    accent2: '#2563eb',
    title: 'A clean annotation workflow',
    subtitle: 'Every visible value is generated locally for documentation.',
    badge: 'LOCAL',
  }),
  demoSvgDataUrl({
    accent: '#7c3aed',
    accent2: '#e0528d',
    title: 'Optional AI, explicit control',
    subtitle: 'The public demo makes no network request and uses no real key.',
    badge: 'OFFLINE',
  }),
];

function createPreloadSource() {
  const images = JSON.stringify(DEMO_IMAGES);
  const viewport = JSON.stringify(VIEWPORT);
  const appVersion = JSON.stringify(APP_VERSION);
  return `'use strict';
const { contextBridge } = require('electron');
const kindArg = process.argv.find((arg) => arg.indexOf('--kk-demo-kind=') === 0) || '--kk-demo-kind=main';
const kind = kindArg.slice('--kk-demo-kind='.length);
const images = ${images};
const viewport = ${viewport};
const appVersion = ${appVersion};
const listeners = { stream: [], history: [], nav: [] };
const telemetry = { finishCapture: 0, cancelCapture: 0 };
const config = {
  shortcuts: {
    capture: 'CommandOrControl+Shift+A',
    pinClipboard: 'CommandOrControl+Shift+P',
    pinRestore: 'CommandOrControl+3',
    record: 'CommandOrControl+Shift+R',
    longShot: 'CommandOrControl+Shift+L',
    ocr: 'CommandOrControl+Shift+O',
    translate: 'CommandOrControl+Shift+T'
  },
  ai: { provider: 'deepseek' },
  deepseek: {
    apiKey: 'PUBLIC_DEMO_PLACEHOLDER',
    askImagePrompt: '请简洁说明这张演示截图中的内容。',
    translatePrompt: '请翻译下面的文字。',
    polishPrompt: '请润色下面的文字。'
  },
  minimax: { apiKey: '' },
  openai: { apiKey: '' },
  builtinKeys: { cancel: 'Escape', confirm: 'Enter', toolSelect: 'v', pickColor: 'c', histPrev: '<', histNext: '>', rectPrev: 'r' },
  capture: { copyAfterCapture: true, autoPin: false, autoSaveHistory: true },
  recording: { fps: 12, toGif: true },
  general: { theme: 'light', launchAtLogin: false, openMainAtLaunch: true, saveDir: '' },
  ocr: { engine: 'local', lang: 'chi_sim+eng' },
  translate: { target: '中文' }
};
const history = [
  { id: 'demo-1', time: '2026-08-24T09:30:00.000Z', width: 1600, height: 1000, type: '区域截图', thumb: images[0] },
  { id: 'demo-2', time: '2026-08-24T09:18:00.000Z', width: 1280, height: 800, type: '窗口截图', thumb: images[1] },
  { id: 'demo-3', time: '2026-08-24T09:05:00.000Z', width: 1600, height: 1000, type: '全屏截图', thumb: images[2] }
];
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function subscribe(bucket, cb) {
  listeners[bucket].push(cb);
  return () => { const i = listeners[bucket].indexOf(cb); if (i >= 0) listeners[bucket].splice(i, 1); };
}
function emitStream(streamId, chunks) {
  let delay = 120;
  chunks.forEach((chunk) => {
    setTimeout(() => listeners.stream.slice().forEach((cb) => cb({ streamId, delta: chunk })), delay);
    delay += 125;
  });
  setTimeout(() => listeners.stream.slice().forEach((cb) => cb({ streamId, done: true })), delay + 40);
}
const api = {
  uid: () => 'demo-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
  getConfig: async () => clone(config),
  setConfig: async () => clone(config),
  onInit: (cb) => {
    const payload = kind === 'overlay'
      ? { dataURL: images[0], width: viewport.width, height: viewport.height, scaleFactor: 1, displayId: 'public-demo', displayBounds: { x: 0, y: 0, width: viewport.width, height: viewport.height }, mode: 'region' }
      : { page: kind === 'ai' ? 'ai' : 'capture', appVersion };
    const timer = setTimeout(() => cb(clone(payload)), 0);
    return () => clearTimeout(timer);
  },
  onNav: (cb) => subscribe('nav', cb),
  onHistoryChanged: (cb) => subscribe('history', cb),
  onStream: (cb) => subscribe('stream', cb),
  historyList: async () => clone(history),
  historyGet: async (id) => ({ item: clone(history.find((entry) => entry.id === id) || history[0]), dataURL: images[Math.max(0, history.findIndex((entry) => entry.id === id))] || images[0] }),
  historyDelete: async () => ({ ok: true }),
  historyDeleteMany: async () => ({ ok: true }),
  historyExport: async () => ({ saved: false }),
  historyExportMany: async () => ({ saved: false }),
  historyClear: async () => ({ ok: true }),
  triggerCapture: async () => ({ ok: true }),
  captureWindow: async () => ({ ok: true }),
  captureFullscreenNow: async () => ({ ok: true }),
  captureTimed: async () => ({ ok: true }),
  captureRegion: async () => images[0],
  getSources: async () => [],
  finishCapture: async () => { telemetry.finishCapture += 1; return { ok: true }; },
  cancelCapture: async () => { telemetry.cancelCapture += 1; return { ok: true }; },
  getDemoTelemetry: async () => clone(telemetry),
  copyImage: async () => ({ ok: true }),
  copyText: async () => ({ ok: true }),
  readClipboardImage: async () => null,
  saveImage: async () => ({ saved: false }),
  chooseSaveDir: async () => ({ dir: '' }),
  createPin: async () => ({ ok: true }),
  setPinState: async () => ({ ok: true }),
  onPinCmd: () => () => {},
  pinStartDrag: async () => ({ ok: true }),
  runOCR: async () => ({ text: 'Privacy-safe demo\\nCapture → Annotate → Review' }),
  ocrBoxes: async () => ({ boxes: [] }),
  axAtPoint: async () => ({ frame: { x: 120, y: 100, w: 420, h: 260 } }),
  translateLines: async () => ({ text: '' }),
  askImage: async (payload) => {
    emitStream(payload.streamId, ['这是一个隐私安全的公开演示画布。', '截图工具已经完成选区和标注，', '你可以继续使用 OCR、翻译、总结或问图。']);
    return { ok: true };
  },
  chat: async (payload) => {
    emitStream(payload.streamId, ['演示响应由本地 mock IPC 生成，', '没有发送任何网络请求。']);
    return { ok: true };
  },
  cancelStream: async () => ({ ok: true }),
  testDeepSeek: async () => ({ ok: true, message: 'Demo only' }),
  fetchModels: async () => ({ ok: true, models: [] }),
  closeTranslatePopup: async () => ({ ok: true }),
  saveRecording: async () => ({ saved: false }),
  openExternal: async () => ({ ok: true }),
  openPath: async () => ({ ok: true }),
  openMain: async () => ({ ok: true }),
  togglePopover: async () => ({ ok: true }),
  hidePopover: async () => ({ ok: true }),
  openSettings: async () => ({ ok: true }),
  openAIPanel: async () => ({ ok: true }),
  closeSelf: async () => ({ ok: true }),
  minimizeSelf: async () => ({ ok: true }),
  resizeSelf: async () => ({ ok: true }),
  moveSelf: async () => ({ ok: true })
};
contextBridge.exposeInMainWorld('kkapi', api);
`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let ready = false;
    try {
      ready = await win.webContents.executeJavaScript(`Boolean(${expression})`, true);
    } catch (_) {
      ready = false;
    }
    if (ready) return;
    await delay(80);
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}`);
}

async function createDemoWindow(kind, relativeHtml, options = {}) {
  const partition = `kunkun-shot-demo-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: false,
    frame: options.frame !== false,
    titleBarStyle: options.frame === false ? undefined : 'hiddenInset',
    transparent: options.transparent === true,
    backgroundColor: options.backgroundColor || '#f4f7fc',
    resizable: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition,
      additionalArguments: [`--kk-demo-kind=${kind}`],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level >= 2) errors.push(event.message);
  });
  await win.loadFile(path.join(RENDERER_ROOT, relativeHtml));
  await win.webContents.insertCSS('* { caret-color: transparent !important; }');
  await delay(160);
  if (errors.length) throw new Error(`${kind} renderer console errors: ${errors.join(' | ')}`);
  return win;
}

async function capture(win, filePath) {
  await delay(80);
  const captured = await win.webContents.capturePage({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
  const size = captured.getSize();
  const expectedRatio = VIEWPORT.width / VIEWPORT.height;
  if (Math.abs(size.width / size.height - expectedRatio) > 0.001 || size.width < VIEWPORT.width || size.height < VIEWPORT.height) {
    throw new Error(`Unexpected capture size ${size.width}x${size.height} for ${filePath}`);
  }
  // capturePage returns device pixels on Retina displays. Normalize public
  // documentation assets to stable CSS-pixel dimensions on every Mac.
  const image = size.width === VIEWPORT.width && size.height === VIEWPORT.height
    ? captured
    : captured.resize({ width: VIEWPORT.width, height: VIEWPORT.height, quality: 'best' });
  fs.writeFileSync(filePath, image.toPNG(), { mode: 0o600 });
}

async function dispatchMouse(win, selector, type, x, y, buttons) {
  const source = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document';
  await win.webContents.executeJavaScript(`(() => {
    const target = ${source};
    if (!target) throw new Error('Missing event target');
    target.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
      bubbles: true,
      cancelable: true,
      clientX: ${Number(x)},
      clientY: ${Number(y)},
      button: 0,
      buttons: ${Number(buttons)}
    }));
  })()`, true);
}

async function captureMain(frames) {
  const win = await createDemoWindow('main', path.join('main', 'main.html'));
  try {
    await waitFor(win, `document.querySelector('.cap-stage') && document.querySelectorAll('.cap-thumb img').length === 3`);
    await waitFor(win, `Array.from(document.images).every((img) => img.complete)`);
    const out = path.join(STAGE_DIR, 'screenshot-main.png');
    await capture(win, out);
    const frame = path.join(FRAME_DIR, '01-main.png');
    fs.copyFileSync(out, frame);
    frames.push({ path: frame, duration: 1.8 });

    await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.cap-stage');
      stage.focus();
      stage.style.boxShadow = '0 0 0 4px rgba(37,99,235,.18), 0 24px 60px rgba(37,99,235,.22)';
    })()`, true);
    const focused = path.join(FRAME_DIR, '02-main-focused.png');
    await capture(win, focused);
    frames.push({ path: focused, duration: 0.75 });
  } finally {
    win.destroy();
  }
}

async function captureOverlay(frames) {
  const win = await createDemoWindow('overlay', path.join('overlay', 'overlay.html'), {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  try {
    await waitFor(win, `document.getElementById('bgCanvas') && document.getElementById('bgCanvas').width === 1600`);
    const empty = path.join(FRAME_DIR, '03-overlay-empty.png');
    await capture(win, empty);
    frames.push({ path: empty, duration: 0.55 });

    const start = { x: 360, y: 165 };
    const points = [
      { x: 560, y: 300 },
      { x: 790, y: 435 },
      { x: 1010, y: 570 },
      { x: 1320, y: 735 },
    ];
    await dispatchMouse(win, null, 'mousedown', start.x, start.y, 1);
    for (let i = 0; i < points.length; i += 1) {
      await dispatchMouse(win, null, 'mousemove', points[i].x, points[i].y, 1);
      const frame = path.join(FRAME_DIR, `0${4 + i}-overlay-drag.png`);
      await capture(win, frame);
      frames.push({ path: frame, duration: i === points.length - 1 ? 0.35 : 0.2 });
    }
    const end = points[points.length - 1];
    await dispatchMouse(win, null, 'mouseup', end.x, end.y, 0);
    await waitFor(win, `!document.getElementById('toolbar').hidden`);
    const selected = path.join(FRAME_DIR, '08-overlay-selected.png');
    await capture(win, selected);
    frames.push({ path: selected, duration: 0.85 });

    await win.webContents.executeJavaScript(`document.querySelector('[data-tool="rect"]').click()`, true);
    await dispatchMouse(win, '#annoCanvas', 'mousedown', 520, 318, 1);
    await dispatchMouse(win, '#annoCanvas', 'mousemove', 805, 480, 1);
    await dispatchMouse(win, '#annoCanvas', 'mouseup', 805, 480, 0);

    await win.webContents.executeJavaScript(`document.querySelector('[data-tool="arrow"]').click()`, true);
    await dispatchMouse(win, '#annoCanvas', 'mousedown', 690, 555, 1);
    await dispatchMouse(win, '#annoCanvas', 'mousemove', 1010, 365, 1);
    await dispatchMouse(win, '#annoCanvas', 'mouseup', 1010, 365, 0);

    const out = path.join(STAGE_DIR, 'screenshot-overlay.png');
    await capture(win, out);
    const annotated = path.join(FRAME_DIR, '09-overlay-annotated.png');
    fs.copyFileSync(out, annotated);
    frames.push({ path: annotated, duration: 1.8 });
  } finally {
    win.destroy();
  }
}

async function probeOverlayToolbar() {
  const win = await createDemoWindow('overlay', path.join('overlay', 'overlay.html'), {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  try {
    await waitFor(win, `document.getElementById('bgCanvas') && document.getElementById('bgCanvas').width === 1600`);
    const start = { x: Math.round(VIEWPORT.width * 0.16), y: Math.round(VIEWPORT.height * 0.14) };
    const end = { x: Math.round(VIEWPORT.width * 0.82), y: Math.round(VIEWPORT.height * 0.64) };
    await dispatchMouse(win, null, 'mousedown', start.x, start.y, 1);
    await dispatchMouse(win, null, 'mousemove', end.x, end.y, 1);
    await dispatchMouse(win, null, 'mouseup', end.x, end.y, 0);
    await waitFor(win, `!document.getElementById('toolbar').hidden`);

    const measure = async (menuId) => win.webContents.executeJavaScript(`(() => {
      const roundRect = (rect) => ({
        left: Math.round(rect.left * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100
      });
      const visible = (node) => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
      };
      const root = ${JSON.stringify(menuId)} ? document.getElementById(${JSON.stringify(menuId)}) : document.getElementById('toolbar');
      const labels = Array.from(root.querySelectorAll('span'))
        .filter((span) => visible(span) && span.textContent.trim())
        .map((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          const lineRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
          const owner = span.closest('button, label') || span.parentElement;
          const labelRect = span.getBoundingClientRect();
          const ownerRect = owner.getBoundingClientRect();
          return {
            text: span.textContent.trim(),
            lineCount: lineRects.length,
            clipped: labelRect.left < ownerRect.left - 0.5 || labelRect.right > ownerRect.right + 0.5 || labelRect.top < ownerRect.top - 0.5 || labelRect.bottom > ownerRect.bottom + 0.5,
            whiteSpace: getComputedStyle(span).whiteSpace
          };
        });
      const toolbar = document.getElementById('toolbar');
      const menu = ${JSON.stringify(menuId)} ? document.getElementById(${JSON.stringify(menuId)}) : null;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        toolbar: roundRect(toolbar.getBoundingClientRect()),
        toolbarScrollWidth: toolbar.scrollWidth,
        menu: menu && visible(menu) ? roundRect(menu.getBoundingClientRect()) : null,
        menuClientHeight: menu && visible(menu) ? menu.clientHeight : null,
        menuScrollHeight: menu && visible(menu) ? menu.scrollHeight : null,
        menuOverflowY: menu && visible(menu) ? getComputedStyle(menu).overflowY : null,
        labels,
        actions: Array.from(toolbar.querySelectorAll('[data-action]'), (node) => node.dataset.action).sort()
      };
    })()`, true);

    const base = await measure('');
    await win.webContents.executeJavaScript(`document.getElementById('btnActionMore').click()`, true);
    const action = await measure('actionMenu');
    await win.webContents.executeJavaScript(`document.getElementById('btnToolMore').click()`, true);
    const annotation = await measure('annotationMenu');

    const keyboardGuard = await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btnToolMore').click();
      const button = document.getElementById('btnActionMore');
      button.focus();
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, expanded: button.getAttribute('aria-expanded') };
    })()`, true);
    await delay(20);
    const keyboardTelemetry = await win.webContents.executeJavaScript(`window.kkapi.getDemoTelemetry()`, true);

    const options = await win.webContents.executeJavaScript(`(() => {
      const more = document.getElementById('btnActionMore');
      const ratio = document.getElementById('btnRatioLock');
      const rounded = document.getElementById('btnRounded');
      const frame = document.getElementById('btnFrame');
      const ax = document.getElementById('btnAx');
      more.click();
      ratio.click();
      const ratioOn = ratio.getAttribute('aria-pressed') === 'true' && more.classList.contains('has-active-option');
      ratio.click();
      rounded.click();
      const roundedOn = rounded.getAttribute('aria-pressed') === 'true' && more.classList.contains('has-active-option');
      rounded.click();
      frame.click();
      const frameBorder = frame.getAttribute('aria-pressed') === 'true' && frame.title.includes('当前：边框');
      frame.click();
      const frameShadow = frame.getAttribute('aria-pressed') === 'true' && frame.title.includes('当前：阴影');
      frame.click();
      const frameOff = frame.getAttribute('aria-pressed') === 'false';
      ax.click();
      return {
        ratioOn,
        roundedOn,
        frameBorder,
        frameShadow,
        frameOff,
        axOn: ax.getAttribute('aria-pressed') === 'true',
        actionMenuClosedForAx: document.getElementById('actionMenu').hidden
      };
    })()`, true);
    await dispatchMouse(win, null, 'mousemove', 200, 150, 0);
    await waitFor(win, `(() => {
      const highlight = document.getElementById('axHighlight');
      const rect = highlight.getBoundingClientRect();
      return !highlight.hidden
        && Math.round(rect.x) === 120
        && Math.round(rect.y) === 100
        && Math.round(rect.width) === 420
        && Math.round(rect.height) === 260;
    })()`);
    await dispatchMouse(win, null, 'mousedown', 200, 150, 1);
    await dispatchMouse(win, null, 'mouseup', 200, 150, 0);
    // Hidden BrowserWindows can expose the previous layout for one compositor
    // turn on hosted macOS runners. Assert the complete observable end state
    // instead of making the test depend on a single-frame layout commit.
    await waitFor(win, `(() => {
      const rect = document.getElementById('selection').getBoundingClientRect();
      return Math.round(rect.x) === 120
        && Math.round(rect.y) === 100
        && Math.round(rect.width) === 420
        && Math.round(rect.height) === 260
        && document.getElementById('btnAx').getAttribute('aria-pressed') === 'false'
        && !document.getElementById('toolbar').hidden;
    })()`);
    const axSelection = await win.webContents.executeJavaScript(`(() => {
      const rect = document.getElementById('selection').getBoundingClientRect();
      return {
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        axPressed: document.getElementById('btnAx').getAttribute('aria-pressed'),
        toolbarVisible: !document.getElementById('toolbar').hidden
      };
    })()`, true);

    // Exercise the difficult case from the real overlay: a short display, a
    // small selection in the vertical middle, and a QR item appearing after
    // the action menu has already opened.
    const middleStart = { x: VIEWPORT.width - 190, y: Math.round(VIEWPORT.height * 0.36) };
    const middleEnd = { x: VIEWPORT.width - 20, y: middleStart.y + 60 };
    await dispatchMouse(win, null, 'mousedown', middleStart.x, middleStart.y, 1);
    await dispatchMouse(win, null, 'mousemove', middleEnd.x, middleEnd.y, 1);
    await dispatchMouse(win, null, 'mouseup', middleEnd.x, middleEnd.y, 0);
    await waitFor(win, `!document.getElementById('toolbar').hidden`);
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btnActionMore').click();
      document.getElementById('btnQR').hidden = false;
    })()`, true);
    await delay(30);
    const middleAction = await measure('actionMenu');

    const failures = [];
    const expectedActions = ['ask', 'cancel', 'copy', 'formula', 'ocr', 'pin', 'polish', 'qr', 'quickSave', 'save', 'table', 'translate'];
    if (JSON.stringify(base.actions) !== JSON.stringify(expectedActions)) failures.push(`action contract changed: ${base.actions.join(',')}`);
    if (base.toolbar.left < 1 || base.toolbar.right > base.viewport.width - 1) failures.push(`toolbar leaves viewport: ${JSON.stringify(base.toolbar)}`);
    if (base.toolbar.height > 46) failures.push(`toolbar is no longer a compact single row: ${base.toolbar.height}px`);
    if (base.toolbar.width > Math.min(1000, base.viewport.width - 4)) failures.push(`toolbar is too wide: ${base.toolbar.width}px`);
    if (base.toolbarScrollWidth > Math.ceil(base.toolbar.width) + 1) failures.push(`toolbar content overflows: ${base.toolbarScrollWidth}/${base.toolbar.width}`);
    for (const sample of [base, action, annotation]) {
      for (const label of sample.labels) {
        if (label.lineCount !== 1 || label.clipped || label.whiteSpace !== 'nowrap') {
          failures.push(`label layout failed for ${label.text}: ${JSON.stringify(label)}`);
        }
      }
    }
    for (const sample of [action, annotation]) {
      if (!sample.menu) failures.push('toolbar menu did not open');
      else if (sample.menu.left < 1 || sample.menu.top < 1 || sample.menu.right > sample.viewport.width - 1 || sample.menu.bottom > sample.viewport.height - 1) {
        failures.push(`toolbar menu leaves viewport: ${JSON.stringify(sample.menu)}`);
      }
      if (Math.abs(sample.toolbar.width - base.toolbar.width) > 0.5) failures.push('opening a menu changed toolbar width');
    }
    if (!middleAction.menu || middleAction.menu.left < 1 || middleAction.menu.top < 1 || middleAction.menu.right > middleAction.viewport.width - 1 || middleAction.menu.bottom > middleAction.viewport.height - 1) {
      failures.push(`middle selection menu leaves viewport: ${JSON.stringify(middleAction.menu)}`);
    }
    if (middleAction.menuScrollHeight > middleAction.menuClientHeight && middleAction.menuOverflowY !== 'auto') {
      failures.push(`constrained menu is not scrollable: ${JSON.stringify({ client: middleAction.menuClientHeight, scroll: middleAction.menuScrollHeight, overflow: middleAction.menuOverflowY })}`);
    }
    if (keyboardGuard.defaultPrevented || keyboardTelemetry.finishCapture || keyboardTelemetry.cancelCapture) {
      failures.push(`toolbar keyboard focus triggered a capture action: ${JSON.stringify({ keyboardGuard, keyboardTelemetry })}`);
    }
    for (const [name, passed] of Object.entries(options)) {
      if (!passed) failures.push(`toolbar option interaction failed: ${name}`);
    }
    if (axSelection.rect.x !== 120 || axSelection.rect.y !== 100 || axSelection.rect.width !== 420 || axSelection.rect.height !== 260) {
      failures.push(`smart selection did not replace the current region: ${JSON.stringify(axSelection.rect)}`);
    }
    if (axSelection.axPressed !== 'false' || !axSelection.toolbarVisible) failures.push(`smart selection did not return to the toolbar: ${JSON.stringify(axSelection)}`);
    if (failures.length) throw new Error(failures.join(' | '));
    return { viewport: base.viewport, toolbar: base.toolbar, actionMenu: action.menu, annotationMenu: annotation.menu, middleActionMenu: middleAction.menu, options, axSelection };
  } finally {
    win.destroy();
  }
}

async function captureAi(frames) {
  const win = await createDemoWindow('ai', path.join('main', 'main.html'));
  try {
    await waitFor(win, `document.querySelector('.kk-ai-root') && document.querySelector('.kk-ai-preview-img')`);
    await waitFor(win, `document.querySelector('.kk-ai-preview-img').complete`);
    await win.webContents.executeJavaScript(`(() => {
      const left = document.querySelector('.kk-ai-left-toggle');
      const mid = document.querySelector('.kk-ai-mid-toggle');
      if (left) left.click();
      if (mid) mid.click();
    })()`, true);
    await delay(120);
    const ready = path.join(FRAME_DIR, '10-ai-ready.png');
    await capture(win, ready);
    frames.push({ path: ready, duration: 0.9 });

    await win.webContents.executeJavaScript(`document.querySelector('.kk-ai-chips .chip').click()`, true);
    await waitFor(win, `document.body.innerText.includes('你可以继续使用 OCR') && !document.querySelector('.kk-ai-cursor')`);
    const out = path.join(STAGE_DIR, 'screenshot-ai.png');
    await capture(win, out);
    const answered = path.join(FRAME_DIR, '11-ai-response.png');
    fs.copyFileSync(out, answered);
    frames.push({ path: answered, duration: 2.4 });
  } finally {
    win.destroy();
  }
}

function quoteConcatPath(filePath) {
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function createGif(frames) {
  const concatPath = path.join(TEMP_ROOT, 'frames.txt');
  const lines = [];
  for (const frame of frames) {
    lines.push(`file ${quoteConcatPath(frame.path)}`);
    lines.push(`duration ${frame.duration}`);
  }
  lines.push(`file ${quoteConcatPath(frames[frames.length - 1].path)}`);
  fs.writeFileSync(concatPath, `${lines.join('\n')}\n`, { mode: 0o600 });

  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary is unavailable');
  const gifPath = path.join(STAGE_DIR, 'demo.gif');
  const filter = [
    'fps=10',
    'scale=960:600:force_original_aspect_ratio=decrease:flags=lanczos',
    'pad=960:600:(ow-iw)/2:(oh-ih)/2:color=0xeff4fb',
    'split[s0][s1]',
    '[s0]palettegen=max_colors=192:stats_mode=diff[p]',
    '[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  ].join(',');
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vf', filter,
    '-loop', '0',
    gifPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`FFmpeg failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return gifPath;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Invalid PNG output');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer) {
  if (buffer.length < 10 || !/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) throw new Error('Invalid GIF output');
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function validateAndPublish(gifPath) {
  const staged = [
    path.join(STAGE_DIR, 'screenshot-main.png'),
    path.join(STAGE_DIR, 'screenshot-overlay.png'),
    path.join(STAGE_DIR, 'screenshot-ai.png'),
    gifPath,
  ];
  const forbidden = [/sk-[A-Za-z0-9_-]{12,}/g, /Bearer\s+[A-Za-z0-9._-]{12,}/gi, /api[_ -]?key\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi];
  const report = [];
  for (const filePath of staged) {
    const data = fs.readFileSync(filePath);
    if (data.length < 20_000) throw new Error(`Generated asset is unexpectedly small: ${filePath}`);
    const name = path.basename(filePath);
    const dims = name.endsWith('.png') ? pngDimensions(data) : gifDimensions(data);
    if (name.endsWith('.png') && (dims.width !== VIEWPORT.width || dims.height !== VIEWPORT.height)) {
      throw new Error(`${name} has unexpected dimensions ${dims.width}x${dims.height}`);
    }
    if (name.endsWith('.gif') && (dims.width !== 960 || dims.height !== 600)) {
      throw new Error(`${name} has unexpected dimensions ${dims.width}x${dims.height}`);
    }
    const latin = data.toString('latin1');
    for (const pattern of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(latin)) throw new Error(`Potential credential pattern found in ${name}`);
    }
    report.push(`${name}: ${dims.width}x${dims.height}, ${Math.round(data.length / 1024)} KiB`);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const stagedPath of staged) {
    const destination = path.join(OUTPUT_DIR, path.basename(stagedPath));
    fs.copyFileSync(stagedPath, destination);
    fs.chmodSync(destination, 0o644);
  }
  return report;
}

function cleanupTemp() {
  const resolvedTemp = path.resolve(TEMP_ROOT);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  const expectedPrefix = `${resolvedOsTemp}${path.sep}kunkun-shot-demo-`;
  if (!resolvedTemp.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to clean unexpected temporary path: ${resolvedTemp}`);
  }
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

async function main() {
  fs.writeFileSync(PRELOAD_PATH, createPreloadSource(), { mode: 0o600 });
  await app.whenReady();
  if (process.argv.includes('--check-overlay-toolbar')) {
    const report = await probeOverlayToolbar();
    process.stdout.write(`OVERLAY_TOOLBAR_CHECK ${JSON.stringify(report)}\n`);
    return;
  }
  const frames = [];
  await captureMain(frames);
  await captureOverlay(frames);
  await captureAi(frames);
  const gifPath = createGif(frames);
  const report = validateAndPublish(gifPath);
  process.stdout.write(`Generated privacy-safe renderer demo assets:\n${report.map((line) => `- ${line}`).join('\n')}\n`);
}

main()
  .then(() => {
    cleanupTemp();
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    try { cleanupTemp(); } catch (cleanupError) { process.stderr.write(`${cleanupError}\n`); }
    app.exit(1);
  });
