const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');

function hasExtraResource(from, to) {
  return packageJson.build.extraResources.some(
    (entry) => entry.from === from && entry.to === to
  );
}

test('electron-builder flips the production security fuses', () => {
  assert.deepEqual(packageJson.build.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    resetAdHocDarwinSignature: true
  });
});

test('mac afterPack hook restores NSAllowsArbitraryLoads=false', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Info.plist hardening only runs on macOS');
    return;
  }

  assert.equal(packageJson.build.afterPack, 'scripts/after-pack.js');

  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const plistPath = path.join(appOutDir, 'Test.app', 'Contents', 'Info.plist');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>NSAppTransportSecurity</key>',
      '  <dict>',
      '    <key>NSAllowsArbitraryLoads</key>',
      '    <true/>',
      '    <key>NSAllowsLocalNetworking</key>',
      '    <true/>',
      '  </dict>',
      '</dict>',
      '</plist>',
      ''
    ].join('\n')
  );

  const afterPack = require('../scripts/after-pack');
  await afterPack({
    electronPlatformName: 'darwin',
    appOutDir,
    packager: { appInfo: { productFilename: 'Test' } }
  });

  const value = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads', plistPath],
    { encoding: 'utf8' }
  ).trim();
  assert.equal(value, 'false');
});

test('packaged Resources include project and runtime license materials', () => {
  const expectedResources = [
    ['LICENSE', 'licenses/LICENSE'],
    ['THIRD_PARTY_NOTICES.md', 'licenses/THIRD_PARTY_NOTICES.md'],
    ['LICENSES', 'licenses/LICENSES'],
    ['node_modules/electron/dist/LICENSE', 'licenses/Electron/LICENSE'],
    [
      'node_modules/electron/dist/LICENSES.chromium.html',
      'licenses/Electron/LICENSES.chromium.html'
    ]
  ];

  for (const [from, to] of expectedResources) {
    assert.equal(hasExtraResource(from, to), true, `missing ${from} -> ${to}`);
  }
});

test('mac hardened-runtime entitlements do not request microphone access', () => {
  const entitlements = fs.readFileSync(
    path.join(root, 'build/entitlements.mac.plist'),
    'utf8'
  );
  assert.doesNotMatch(entitlements, /com\.apple\.security\.device\.audio-input/);
});
