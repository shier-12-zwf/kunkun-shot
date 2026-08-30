const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');

test('local and formal macOS packaging commands are explicitly separated', () => {
  assert.equal(packageJson.scripts.dist, 'npm run dist:mac:local');
  assert.match(packageJson.scripts['dist:mac'], /dist:mac:local/);
  assert.equal(packageJson.scripts['dist:mac:local'], 'node scripts/build-macos-local-signed.js');
  assert.match(packageJson.scripts['dist:mac:adhoc'], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(packageJson.scripts['dist:mac:adhoc'], /--config\.mac\.identity=null/);
  assert.match(packageJson.scripts['dist:mac:adhoc'], /--config\.mac\.notarize=false/);
  assert.equal(packageJson.scripts['dist:mac:release'], 'node scripts/build-macos-release.js');
  assert.equal(packageJson.scripts['verify:mac:release'], 'node scripts/verify-macos-release.js');

  assert.equal(packageJson.build.forceCodeSigning, false);
  assert.equal(packageJson.build.mac.identity, null);
  assert.equal(packageJson.build.mac.notarize, false);
});

test('formal release config requires signing and notarization without embedding secrets', () => {
  const configPath = path.join(root, 'build', 'electron-builder.release.js');
  const source = fs.readFileSync(configPath, 'utf8');
  const config = require(configPath);

  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.type, 'distribution');
  assert.equal(Object.hasOwn(config.mac, 'identity'), false);
  assert.equal(config.directories.output, 'dist/release-mac');
  assert.doesNotMatch(source, /APPLE_APP_SPECIFIC_PASSWORD\s*[:=]\s*['"][^'"]+/);
  assert.doesNotMatch(source, /CSC_KEY_PASSWORD\s*[:=]\s*['"][^'"]+/);
});

test('release entitlements do not permit DYLD environment injection', () => {
  const entitlements = fs.readFileSync(path.join(root, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.doesNotMatch(entitlements, /com\.apple\.security\.cs\.allow-dyld-environment-variables/);
});

test('formal release preflight accepts one signing and one complete notary credential family', () => {
  const { validateReleaseEnvironment } = require('../scripts/build-macos-release');

  assert.deepEqual(
    validateReleaseEnvironment({
      CSC_LINK: 'base64-or-file-reference',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_ID: 'developer@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'TEAM123456'
    }, 'darwin'),
    { signingMethod: 'certificate-file', notarizationMethod: 'apple-id' }
  );

  assert.deepEqual(
    validateReleaseEnvironment({
      CSC_NAME: 'Kunkun Distribution',
      APPLE_KEYCHAIN_PROFILE: 'notary-profile'
    }, 'darwin'),
    { signingMethod: 'keychain-identity', notarizationMethod: 'keychain-profile' }
  );
});

test('formal release preflight fails closed for missing, partial, ad-hoc, or ambiguous credentials', () => {
  const { validateReleaseEnvironment } = require('../scripts/build-macos-release');
  const appleId = {
    APPLE_ID: 'developer@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
    APPLE_TEAM_ID: 'TEAM123456'
  };

  assert.throws(() => validateReleaseEnvironment({}, 'darwin'), /signing credentials/i);
  assert.throws(
    () => validateReleaseEnvironment({ CSC_LINK: 'certificate', ...appleId }, 'darwin'),
    /CSC_KEY_PASSWORD/
  );
  assert.throws(
    () => validateReleaseEnvironment({ CSC_NAME: '-', ...appleId }, 'darwin'),
    /ad-hoc/i
  );
  assert.throws(
    () => validateReleaseEnvironment({ CSC_NAME: 'Identity', APPLE_ID: 'developer@example.test' }, 'darwin'),
    /APPLE_APP_SPECIFIC_PASSWORD.*APPLE_TEAM_ID/
  );
  assert.throws(
    () => validateReleaseEnvironment({
      CSC_NAME: 'Identity',
      ...appleId,
      APPLE_KEYCHAIN_PROFILE: 'profile'
    }, 'darwin'),
    /exactly one notarization credential family/i
  );
  assert.throws(
    () => validateReleaseEnvironment({ CSC_NAME: 'Identity', ...appleId }, 'linux'),
    /macOS host/i
  );
});

test('formal release command never publishes and always runs independent artifact verification', () => {
  const {
    RELEASE_OUTPUT_DIR,
    releaseBuildArgs,
    releaseVerificationArgs,
    releaseBuildEnvironment
  } = require('../scripts/build-macos-release');

  assert.equal(RELEASE_OUTPUT_DIR, path.join(root, 'dist', 'release-mac'));
  assert.deepEqual(releaseBuildArgs(), [
    '--mac',
    '--config',
    'build/electron-builder.release.js',
    '--publish',
    'never'
  ]);
  assert.deepEqual(releaseVerificationArgs(), [
    path.join(root, 'scripts', 'verify-macos-release.js'),
    RELEASE_OUTPUT_DIR
  ]);
  assert.equal(releaseBuildEnvironment({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }).CSC_IDENTITY_AUTO_DISCOVERY, 'true');
});

test('formal release output must be fresh so stale artifacts cannot count as evidence', () => {
  const { assertFreshOutputDirectory } = require('../scripts/build-macos-release');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-release-output-'));
  const missing = path.join(temp, 'missing');
  try {
    assert.doesNotThrow(() => assertFreshOutputDirectory(missing));
    assert.doesNotThrow(() => assertFreshOutputDirectory(temp));
    fs.writeFileSync(path.join(temp, 'old.dmg'), 'stale');
    assert.throws(() => assertFreshOutputDirectory(temp), /not empty/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('artifact verifier rejects unsafe ZIP paths and requires app, DMG, and ZIP outputs', () => {
  const { isSafeArchiveEntry, discoverReleaseArtifacts } = require('../scripts/verify-macos-release');
  assert.equal(isSafeArchiveEntry('Kunkun.app/Contents/MacOS/Kunkun'), true);
  assert.equal(isSafeArchiveEntry('../escape'), false);
  assert.equal(isSafeArchiveEntry('/absolute/path'), false);
  assert.equal(isSafeArchiveEntry('folder/../../escape'), false);
  assert.equal(isSafeArchiveEntry('folder\\..\\escape'), false);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-release-artifacts-'));
  try {
    fs.mkdirSync(path.join(temp, 'mac-arm64', 'Kunkun.app'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'Kunkun.dmg'), 'dmg');
    fs.writeFileSync(path.join(temp, 'Kunkun.zip'), 'zip');
    const artifacts = discoverReleaseArtifacts(temp);
    assert.equal(artifacts.apps.length, 1);
    assert.equal(artifacts.dmgs.length, 1);
    assert.equal(artifacts.zips.length, 1);

    fs.rmSync(path.join(temp, 'Kunkun.dmg'));
    assert.throws(() => discoverReleaseArtifacts(temp), /DMG artifact/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('artifact verifier checks Developer ID, hardened runtime, Gatekeeper, ticket, DMG, and ZIP integrity', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'verify-macos-release.js'), 'utf8');
  assert.match(source, /codesign/);
  assert.match(source, /Developer ID Application/);
  assert.match(source, /runtime/);
  assert.match(source, /spctl/);
  assert.match(source, /stapler/);
  assert.match(source, /hdiutil/);
  assert.match(source, /unzip/);
  assert.doesNotMatch(source, /notarytool\s+submit/);
});
