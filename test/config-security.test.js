const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadConfig(tempDir, encryptionAvailable = true, encryptThrows = false) {
  const electronMock = {
    app: { getPath: () => tempDir },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => {
        if (encryptThrows) throw new Error('mock keychain failure');
        return Buffer.from(`encrypted:${value}`, 'utf8');
      },
      decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
    },
  };

  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = require.resolve('../src/main/config');
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('set never returns plaintext API keys to its caller', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir);

  const result = config.set({
    deepseek: { apiKey: 'deepseek-test-secret' },
    minimax: { apiKey: 'minimax-test-secret' },
    openai: { apiKey: 'openai-test-secret' },
  });

  assert.equal(result.deepseek.apiKey, '••••••••••••');
  assert.equal(result.minimax.apiKey, '••••••••••••');
  assert.equal(result.openai.apiKey, '••••••••••••');
  const persisted = fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8');
  assert.doesNotMatch(persisted, /(?:deepseek|minimax|openai)-test-secret/);
});

test('a maximum-length encrypted key remains loadable after restart', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-long-key-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const secret = 'k'.repeat(16 * 1024);

  loadConfig(tempDir).set({ deepseek: { apiKey: secret } });
  const reloaded = loadConfig(tempDir);

  assert.equal(reloaded.get().deepseek.apiKey, secret);
  assert.equal(reloaded.publicView().deepseek.apiKey, '••••••••••••');
});

test('set does not persist a new plaintext key when OS encryption is unavailable', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir, false);

  assert.throws(
    () => config.set({ deepseek: { apiKey: 'must-remain-memory-only' } }),
    /安全存储|未保存/
  );

  assert.equal(fs.existsSync(path.join(tempDir, 'config.json')), false);
});

test('set does not persist plaintext when safeStorage reports available but encryption fails', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir, true, true);

  assert.throws(
    () => config.set({ deepseek: { apiKey: 'must-not-leak-after-encrypt-error' } }),
    /安全存储|加密|未保存/
  );

  assert.equal(fs.existsSync(path.join(tempDir, 'config.json')), false);
});

test('malformed or schema-invalid config files fail closed to defaults', (t) => {
  const tempDirs = [];
  t.after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  for (const serialized of [
    'null',
    JSON.stringify({ general: null, shortcuts: null, recording: { fps: 'twelve' } }),
  ]) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-invalid-config-test-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'config.json'), serialized, { mode: 0o600 });
    const loaded = loadConfig(tempDir).get();
    assert.equal(loaded.general.theme, 'light');
    assert.equal(loaded.shortcuts.capture, 'CommandOrControl+Shift+A');
    assert.equal(loaded.recording.fps, 12);
  }
});

test('legacy capture config gains PNG/90 export defaults without losing existing values', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-legacy-image-export-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(tempDir, 'config.json'),
    JSON.stringify({ capture: { copyAfterCapture: true, autoPin: true } }),
    { mode: 0o600 },
  );

  const capture = loadConfig(tempDir).get().capture;
  assert.equal(capture.copyAfterCapture, true);
  assert.equal(capture.autoPin, true);
  assert.equal(capture.exportFormat, 'png');
  assert.equal(capture.quality, 90);
});

test('unsupported OCR language updates fail closed without mutating memory or disk', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-ocr-lang-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir);
  config.set({ ocr: { lang: 'chi_sim' } });

  assert.throws(() => config.set({ ocr: { lang: 'chi_sim+jpn' } }), /OCR.*语言/);
  assert.equal(config.get().ocr.lang, 'chi_sim');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8')).ocr.lang, 'chi_sim');
});

test('legacy unsupported OCR language migrates only that field and preserves plaintext-era settings', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-ocr-lang-migration-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const target = path.join(tempDir, 'config.json');
  fs.writeFileSync(target, JSON.stringify({
    ocr: { engine: 'local', lang: 'jpn' },
    general: { theme: 'dark', saveDir: '/tmp/keep-this-directory' },
    shortcuts: { capture: 'CommandOrControl+Shift+7' },
    deepseek: { apiKey: 'legacy-key-that-must-be-preserved-securely' },
  }), { mode: 0o600 });

  const config = loadConfig(tempDir, true);
  const loaded = config.get();
  assert.equal(loaded.ocr.lang, 'chi_sim+eng');
  assert.equal(loaded.general.theme, 'dark');
  assert.equal(loaded.general.saveDir, '/tmp/keep-this-directory');
  assert.equal(loaded.shortcuts.capture, 'CommandOrControl+Shift+7');
  assert.equal(loaded.deepseek.apiKey, 'legacy-key-that-must-be-preserved-securely');

  const persisted = fs.readFileSync(target, 'utf8');
  assert.equal(JSON.parse(persisted).ocr.lang, 'chi_sim+eng');
  assert.doesNotMatch(persisted, /legacy-key-that-must-be-preserved-securely/);
  assert.match(JSON.parse(persisted).deepseek.apiKey, /^enc:v1:/);
});

test('legacy OCR migration preserves an existing encrypted key and unrelated settings', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-ocr-encrypted-migration-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const target = path.join(tempDir, 'config.json');

  loadConfig(tempDir, true).set({
    deepseek: { apiKey: 'already-encrypted-key' },
    general: { theme: 'dark' },
    capture: { autoPin: true },
  });
  const before = JSON.parse(fs.readFileSync(target, 'utf8'));
  before.ocr.lang = 'deu';
  fs.writeFileSync(target, JSON.stringify(before), { mode: 0o600 });

  const loaded = loadConfig(tempDir, true).get();
  assert.equal(loaded.ocr.lang, 'chi_sim+eng');
  assert.equal(loaded.general.theme, 'dark');
  assert.equal(loaded.capture.autoPin, true);
  assert.equal(loaded.deepseek.apiKey, 'already-encrypted-key');
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.ocr.lang, 'chi_sim+eng');
  assert.match(after.deepseek.apiKey, /^enc:v1:/);
});

test('schema-invalid legacy config still scrubs any plaintext API key', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-invalid-secret-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const target = path.join(tempDir, 'config.json');
  fs.writeFileSync(
    target,
    JSON.stringify({ general: null, deepseek: { apiKey: 'legacy-secret-inside-invalid-config' } }),
    { mode: 0o600 }
  );

  const loaded = loadConfig(tempDir, false).get();
  assert.equal(loaded.general.theme, 'light');
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /legacy-secret-inside-invalid-config/);
});

test('oversized config files are rejected instead of being merged into live state', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-large-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(tempDir, 'config.json'),
    JSON.stringify({ oversized: 'x'.repeat(513 * 1024) }),
    { mode: 0o600 }
  );

  const loaded = loadConfig(tempDir).get();
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, 'oversized'), false);
  assert.equal(loaded.general.theme, 'light');
});

test('legacy plaintext keys are scrubbed from disk even when OS encryption is unavailable', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(tempDir, 'config.json'),
    JSON.stringify({ deepseek: { apiKey: 'legacy-plaintext-secret' } }),
    { mode: 0o600 }
  );
  const config = loadConfig(tempDir, false);

  assert.equal(config.get().deepseek.apiKey, 'legacy-plaintext-secret', 'the current process may keep the migrated value in memory');
  const persisted = fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8');
  assert.doesNotMatch(persisted, /legacy-plaintext-secret/);
});

test('legacy plaintext migration failure is observable and never silently accepted', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-migration-failure-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const target = path.join(tempDir, 'config.json');
  fs.writeFileSync(
    target,
    JSON.stringify({ deepseek: { apiKey: 'legacy-secret-that-must-be-scrubbed' } }),
    { mode: 0o600 }
  );
  const config = loadConfig(tempDir, false);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function failMigration(from, to) {
    if (to === target) throw new Error('simulated migration commit failure');
    return originalRenameSync.call(this, from, to);
  };
  try {
    assert.throws(() => config.get(), /simulated migration commit failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.match(fs.readFileSync(target, 'utf8'), /legacy-secret-that-must-be-scrubbed/);
});

test('config file is owner-readable and owner-writable only', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir);

  config.set({ general: { theme: 'dark' } });

  const mode = fs.statSync(path.join(tempDir, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('failed atomic config commit does not mutate the live in-memory configuration', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-shot-config-rollback-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = loadConfig(tempDir);
  config.set({ general: { theme: 'light' } });

  const target = path.join(tempDir, 'config.json');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function failCommit(from, to) {
    if (to === target) throw new Error('simulated config commit failure');
    return originalRenameSync.call(this, from, to);
  };
  try {
    assert.throws(() => config.set({ general: { theme: 'dark' } }), /simulated config commit failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(config.get().general.theme, 'light');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).general.theme, 'light');
});
