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
    arch: 3,
    appOutDir,
    packager: { projectDir: root, appInfo: { productFilename: 'Test' } }
  }, {
    packageElectronLicenses: async () => {},
    packageSwiftHelpers: async () => {}
  });

  const value = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads', plistPath],
    { encoding: 'utf8' }
  ).trim();
  assert.equal(value, 'false');
});

test('mac afterPack hook copies and verifies Electron runtime licenses', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS packaging layout only exists on macOS');
    return;
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-license-source-'));
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-license-app-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const electronDistDir = path.join(projectDir, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(electronDistDir, { recursive: true });
  fs.writeFileSync(path.join(electronDistDir, 'LICENSE'), 'electron-license-fixture');
  fs.writeFileSync(
    path.join(electronDistDir, 'LICENSES.chromium.html'),
    '<html>chromium-license-fixture</html>'
  );

  const appContentsDir = path.join(appOutDir, 'Test.app', 'Contents');
  fs.mkdirSync(appContentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(appContentsDir, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>',
      '</dict></plist>',
      ''
    ].join('\n')
  );

  const afterPack = require('../scripts/after-pack');
  await afterPack({
    electronPlatformName: 'darwin',
    arch: 3,
    appOutDir,
    packager: {
      projectDir,
      appInfo: { productFilename: 'Test' }
    }
  }, {
    packageSwiftHelpers: async () => {}
  });

  const packagedLicenseDir = path.join(appContentsDir, 'Resources', 'licenses', 'Electron');
  assert.equal(
    fs.readFileSync(path.join(packagedLicenseDir, 'LICENSE'), 'utf8'),
    'electron-license-fixture'
  );
  assert.equal(
    fs.readFileSync(path.join(packagedLicenseDir, 'LICENSES.chromium.html'), 'utf8'),
    '<html>chromium-license-fixture</html>'
  );
});

test('mac afterPack restores lazily downloaded Electron license sources on a clean install', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS packaging layout only exists on macOS');
    return;
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-lazy-electron-source-'));
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-lazy-electron-app-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const appContentsDir = path.join(appOutDir, 'Test.app', 'Contents');
  fs.mkdirSync(appContentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(appContentsDir, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>'
  );

  let ensureCalls = 0;
  const afterPack = require('../scripts/after-pack');
  await afterPack({
    electronPlatformName: 'darwin',
    arch: 3,
    appOutDir,
    packager: { projectDir, appInfo: { productFilename: 'Test' } }
  }, {
    packageSwiftHelpers: async () => {},
    ensureElectronRuntime: (requestedProjectDir) => {
      ensureCalls += 1;
      assert.equal(requestedProjectDir, projectDir);
      const distDir = path.join(projectDir, 'node_modules', 'electron', 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'LICENSE'), 'lazy-electron-license');
      fs.writeFileSync(path.join(distDir, 'LICENSES.chromium.html'), 'lazy-chromium-licenses');
    }
  });

  assert.equal(ensureCalls, 1);
  assert.equal(
    fs.readFileSync(path.join(appContentsDir, 'Resources', 'licenses', 'Electron', 'LICENSE'), 'utf8'),
    'lazy-electron-license'
  );
  assert.equal(
    fs.readFileSync(path.join(appContentsDir, 'Resources', 'licenses', 'Electron', 'LICENSES.chromium.html'), 'utf8'),
    'lazy-chromium-licenses'
  );
});

test('Electron license recovery repairs a partial runtime without replacing its executable', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-partial-electron-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  const electronDir = path.join(projectDir, 'node_modules', 'electron');
  const distDir = path.join(electronDir, 'dist');
  const platformPath = process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron';
  fs.mkdirSync(path.join(distDir, path.dirname(platformPath)), { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({
    name: 'electron',
    version: '42.9.0'
  }));
  fs.writeFileSync(path.join(electronDir, 'checksums.json'), '{}');
  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath);
  fs.writeFileSync(path.join(distDir, 'version'), '42.9.0');
  const executablePath = path.join(distDir, platformPath);
  fs.writeFileSync(executablePath, 'original-electron-executable');

  let extractedDirectory = null;
  const afterPack = require('../scripts/after-pack');
  await afterPack.ensureElectronRuntime(projectDir, {
    downloadElectronArtifact: async (options) => {
      assert.equal(options.version, '42.9.0');
      assert.equal(options.artifactName, 'electron');
      assert.equal(options.platform, process.platform);
      assert.equal(options.arch, process.arch);
      return path.join(projectDir, 'electron-fixture.zip');
    },
    extractElectronArchive: async (_archivePath, options) => {
      extractedDirectory = options.dir;
      fs.writeFileSync(path.join(options.dir, 'LICENSE'), 'restored-electron-license');
      fs.writeFileSync(
        path.join(options.dir, 'LICENSES.chromium.html'),
        'restored-chromium-licenses'
      );
    }
  });

  assert.equal(fs.readFileSync(executablePath, 'utf8'), 'original-electron-executable');
  assert.equal(fs.readFileSync(path.join(distDir, 'LICENSE'), 'utf8'), 'restored-electron-license');
  assert.equal(
    fs.readFileSync(path.join(distDir, 'LICENSES.chromium.html'), 'utf8'),
    'restored-chromium-licenses'
  );
  assert.ok(extractedDirectory);
  assert.equal(fs.existsSync(extractedDirectory), false, 'temporary extraction directory must be removed');
});

test('electron-builder stages project license materials before afterPack adds runtime licenses', () => {
  const expectedResources = [
    ['LICENSE', 'licenses/LICENSE'],
    ['THIRD_PARTY_NOTICES.md', 'licenses/THIRD_PARTY_NOTICES.md'],
    ['LICENSES', 'licenses/LICENSES']
  ];

  for (const [from, to] of expectedResources) {
    assert.equal(hasExtraResource(from, to), true, `missing ${from} -> ${to}`);
  }

  assert.equal(
    packageJson.build.extraResources.some((entry) => entry.to.startsWith('licenses/Electron/')),
    false,
    'Electron runtime licenses are copied and verified by afterPack instead of optional extraResources'
  );
});

test('mac afterPack waits for Swift helper packaging and propagates its failure', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS packaging layout only exists on macOS');
    return;
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-helper-hook-source-'));
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-helper-hook-app-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));

  const electronDistDir = path.join(projectDir, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(electronDistDir, { recursive: true });
  fs.writeFileSync(path.join(electronDistDir, 'LICENSE'), 'electron-license-fixture');
  fs.writeFileSync(path.join(electronDistDir, 'LICENSES.chromium.html'), 'chromium-license-fixture');

  const appContentsDir = path.join(appOutDir, 'Test.app', 'Contents');
  fs.mkdirSync(appContentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(appContentsDir, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>'
  );

  const expectedError = new Error('fake swiftc failure');
  const afterPack = require('../scripts/after-pack');
  await assert.rejects(
    afterPack({
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir,
      packager: { projectDir, appInfo: { productFilename: 'Test' } }
    }, {
      packageSwiftHelpers: async () => {
        throw expectedError;
      }
    }),
    (error) => error === expectedError
  );
});

test('mac hardened-runtime entitlements explicitly allow opt-in microphone capture', () => {
  const entitlements = fs.readFileSync(
    path.join(root, 'build/entitlements.mac.plist'),
    'utf8'
  );
  assert.match(
    entitlements,
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/
  );
});
