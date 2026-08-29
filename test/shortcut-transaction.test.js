const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  replaceShortcutBindings,
  applyConfigPatchTransaction,
} = require('../src/main/shortcut-transaction');

function createShortcutRegistry(blocked) {
  const callbacks = new Map();
  const resets = [];
  return {
    callbacks,
    resets,
    reset() {
      callbacks.clear();
      resets.push('reset');
    },
    restoreReserved() {},
    register(accelerator, callback) {
      if (blocked.has(accelerator)) return false;
      if (callbacks.has(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
  };
}

function bindings(values) {
  return Object.entries(values).map(([key, accelerator]) => ({
    key,
    accelerator,
    callback() {},
  }));
}

test('failed shortcut replacement restores every previous working binding', () => {
  const registry = createShortcutRegistry(new Set(['CommandOrControl+Shift+X']));
  const previous = bindings({ capture: 'CommandOrControl+Shift+A', ocr: 'CommandOrControl+Shift+O' });
  const next = bindings({ capture: 'CommandOrControl+Shift+X', ocr: 'CommandOrControl+Shift+O' });

  const result = replaceShortcutBindings({
    reset: registry.reset,
    restoreReserved: registry.restoreReserved,
    register: registry.register,
  }, next, previous);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SHORTCUT_REGISTRATION_FAILED');
  assert.deepEqual(result.error.failed, [
    { key: 'capture', accelerator: 'CommandOrControl+Shift+X', reason: 'unavailable' },
  ]);
  assert.equal(result.rollback.ok, true);
  assert.deepEqual(
    [...registry.callbacks.keys()].sort(),
    ['CommandOrControl+Shift+A', 'CommandOrControl+Shift+O'],
  );
});

test('duplicate accelerators are rejected and old shortcuts remain active', () => {
  const registry = createShortcutRegistry(new Set());
  const previous = bindings({ capture: 'CommandOrControl+Shift+A', ocr: 'CommandOrControl+Shift+O' });
  const next = bindings({ capture: 'CommandOrControl+Shift+N', ocr: 'CommandOrControl+Shift+N' });

  const result = replaceShortcutBindings({
    reset: registry.reset,
    restoreReserved: registry.restoreReserved,
    register: registry.register,
  }, next, previous);

  assert.equal(result.ok, false);
  assert.equal(result.error.failed[0].key, 'ocr');
  assert.equal(result.rollback.ok, true);
  assert.deepEqual(
    [...registry.callbacks.keys()].sort(),
    ['CommandOrControl+Shift+A', 'CommandOrControl+Shift+O'],
  );
});

test('shortcut config persistence rolls back and returns a structured renderer-safe error', () => {
  let current = {
    general: { theme: 'light' },
    shortcuts: { capture: 'CommandOrControl+Shift+A' },
  };
  const writes = [];
  const result = applyConfigPatchTransaction({
    patch: { shortcuts: { capture: 'CommandOrControl+Shift+X' } },
    getConfig: () => current,
    setConfig: (patch) => {
      current = {
        ...current,
        ...patch,
        shortcuts: { ...current.shortcuts, ...(patch.shortcuts || {}) },
      };
      writes.push(JSON.parse(JSON.stringify(patch)));
      return JSON.parse(JSON.stringify(current));
    },
    getPublicConfig: () => JSON.parse(JSON.stringify(current)),
    applyShortcuts: () => ({
      ok: false,
      error: {
        code: 'SHORTCUT_REGISTRATION_FAILED',
        failed: [{ key: 'capture', accelerator: 'CommandOrControl+Shift+X', reason: 'unavailable' }],
      },
      rollback: { ok: true },
    }),
  });

  assert.deepEqual(writes, [
    { shortcuts: { capture: 'CommandOrControl+Shift+X' } },
    { shortcuts: { capture: 'CommandOrControl+Shift+A' } },
  ]);
  assert.equal(current.shortcuts.capture, 'CommandOrControl+Shift+A');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SHORTCUT_REGISTRATION_FAILED');
  assert.equal(result.config.shortcuts.capture, 'CommandOrControl+Shift+A');
});

test('non-shortcut config patches do not churn global registrations', () => {
  let current = { general: { theme: 'light' }, shortcuts: { capture: 'CommandOrControl+Shift+A' } };
  let applyCalls = 0;
  const result = applyConfigPatchTransaction({
    patch: { general: { theme: 'dark' } },
    getConfig: () => current,
    setConfig: (patch) => {
      current = { ...current, general: { ...current.general, ...(patch.general || {}) } };
      return JSON.parse(JSON.stringify(current));
    },
    getPublicConfig: () => JSON.parse(JSON.stringify(current)),
    applyShortcuts: () => { applyCalls += 1; return { ok: true }; },
  });

  assert.equal(applyCalls, 0);
  assert.deepEqual(result, current);
});

test('settings treats a structured shortcut registration failure as an error and restores the input', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'main', 'pages', 'settings.js'),
    'utf8',
  );

  assert.match(source, /merged\.ok\s*===\s*false/);
  assert.match(source, /error\.response\s*=\s*merged/);
  assert.match(source, /shortcutInputs\[scKey\]\.value\s*=/);
});
