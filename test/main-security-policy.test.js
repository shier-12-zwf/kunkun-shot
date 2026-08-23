const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const windowsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'windows.js'), 'utf8');

test('custom thumbnail protocol does not bypass Content Security Policy', () => {
  assert.doesNotMatch(mainSource, /bypassCSP\s*:\s*true/);
});

test('open-path authorization is bound to the requesting pin payload', () => {
  const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle(C.OPEN_PATH'), mainSource.indexOf('ipcMain.handle(C.PIN_START_DRAG'));
  assert.match(handler, /windows\.getPinPayload\(.*sender\.id/);
});

test('high-impact IPC handlers use centralized payload validation', () => {
  assert.match(mainSource, /require\(['"]\.\/ipc-validation['"]\)/);
  assert.match(mainSource, /normalizeCaptureRect\(rect,\s*display\.size\)/);
  assert.match(mainSource, /requireImageDataURL\(imageDataURL\)/);
  assert.match(mainSource, /normalizeTranslationRequest\(payload\)/);
  assert.match(mainSource, /normalizeChatRequest\(payload\)/);
  assert.match(mainSource, /normalizeProviderBaseUrl\(baseUrl\)/);
});

test('window roles restrict page-specific IPC capabilities', () => {
  assert.match(windowsSource, /newTrackedWindow\(opts,\s*role\)/);
  assert.match(windowsSource, /trustedWebContents\.set\(id,\s*role\)/);
  assert.match(mainSource, /IPC_ROLE_ALLOWLIST/);
  assert.match(mainSource, /\[C\.OVERLAY_RESULT\]\s*:\s*\['overlay'\]/);
  assert.match(mainSource, /\[C\.RECORD_SAVE\]\s*:\s*\['recorder'\]/);
  assert.match(mainSource, /\[C\.PIN_START_DRAG\]\s*:\s*\['pin'\]/);
});

test('every IPC handler is explicitly role-declared and missing declarations fail closed', () => {
  const allowlist = mainSource.slice(mainSource.indexOf('const IPC_ROLE_ALLOWLIST'), mainSource.indexOf('// ---------- 屏幕捕获'));
  const handlers = [...mainSource.matchAll(/ipcMain\.handle\(C\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(handlers.length > 30, 'expected the complete IPC surface');
  for (const name of handlers) {
    assert.match(allowlist, new RegExp(`\\[C\\.${name}\\]\\s*:`), `missing role declaration for ${name}`);
  }
  assert.match(mainSource, /hasOwnProperty\.call\(IPC_ROLE_ALLOWLIST,\s*channel\)/);
  assert.match(mainSource, /throw new Error\(`IPC 通道缺少角色权限声明/);
});

test('configuration writes are both schema-bound and scoped to the sender role', () => {
  assert.match(mainSource, /normalizeConfigPatch\(patch,\s*windows\.getTrustedRole\(e\.sender\.id\)\)/);
});
