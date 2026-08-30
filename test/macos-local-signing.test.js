const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');

test('default local macOS packaging uses the stable signed pipeline', () => {
  assert.equal(
    packageJson.scripts['dist:mac:local'],
    'node scripts/build-macos-local-signed.js'
  );
  assert.match(packageJson.scripts['dist:mac:adhoc'], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(packageJson.scripts['dist:mac:adhoc'], /--config\.mac\.identity=null/);
  assert.equal(
    packageJson.scripts['verify:mac:local'],
    'node scripts/verify-macos-local-signed.js'
  );
});

test('stable local builder config signs before archives without notarization or hardened runtime', () => {
  const configPath = path.join(root, 'build', 'electron-builder.local-signed.js');
  const source = fs.readFileSync(configPath, 'utf8');
  const previousIdentity = process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY;
  process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY = 'A'.repeat(40);
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  if (previousIdentity === undefined) delete process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY;
  else process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY = previousIdentity;

  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.directories.output, 'dist/local-signed-mac');
  assert.equal(config.mac.identity, 'A'.repeat(40));
  assert.equal(config.mac.sign, require('../scripts/sign-macos-local'));
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.timestamp, 'none');
  assert.doesNotMatch(source, /[A-Fa-f0-9]{40}/, 'machine certificate hashes stay out of git');
});

test('stable local signer preserves the validated fingerprint through codesign', () => {
  const {
    buildStableLocalSignOptions,
    resolvedIdentity
  } = require('../scripts/sign-macos-local');
  const identity = 'A'.repeat(40);
  const env = { KK_MAC_RESOLVED_SIGNING_IDENTITY: identity };

  assert.equal(resolvedIdentity(env), identity);
  assert.deepEqual(
    buildStableLocalSignOptions({ app: '/tmp/Test.app', identity }, env),
    { app: '/tmp/Test.app', identity, identityValidation: false }
  );
  assert.throws(
    () => buildStableLocalSignOptions({ identity: 'B'.repeat(40) }, env),
    /differs from the validated fingerprint/i
  );
  assert.throws(() => resolvedIdentity({}), /40-character certificate fingerprint/i);
});

test('local signing preflight resolves one explicit valid identity and fails closed', () => {
  const {
    isAppleManagedSigningIdentity,
    parseSecurityIdentities,
    resolveSigningIdentity,
    validateLocalSigningInput
  } = require('../scripts/build-macos-local-signed');

  const securityOutput = [
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Local Signing One"',
    '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Local Signing Two"',
    '     2 valid identities found'
  ].join('\n');

  assert.deepEqual(parseSecurityIdentities(securityOutput), [
    { hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'Local Signing One' },
    { hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'Local Signing Two' }
  ]);
  assert.equal(
    resolveSigningIdentity('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', securityOutput),
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  );
  assert.equal(
    resolveSigningIdentity('Local Signing Two', securityOutput),
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  );
  assert.throws(() => resolveSigningIdentity('Signing Two', securityOutput), /not found/i);
  assert.throws(() => resolveSigningIdentity('missing', securityOutput), /not found/i);
  assert.throws(
    () => resolveSigningIdentity(
      'Duplicate',
      securityOutput.replace('Local Signing One', 'Duplicate').replace('Local Signing Two', 'Duplicate')
    ),
    /ambiguous/i
  );
  assert.throws(() => validateLocalSigningInput('', 'darwin'), /required/i);
  assert.throws(() => validateLocalSigningInput('-', 'darwin'), /ad-hoc/i);
  assert.throws(() => validateLocalSigningInput('Local Signing One', 'linux'), /macOS/i);
  assert.equal(validateLocalSigningInput(' Local Signing One ', 'darwin'), 'Local Signing One');
  assert.equal(isAppleManagedSigningIdentity('Developer ID Application: Example (TEAM123456)'), true);
  assert.equal(isAppleManagedSigningIdentity('Apple Development: Example (TEAM123456)'), true);
  assert.equal(isAppleManagedSigningIdentity('Local Signing One'), false);
  assert.throws(
    () => resolveSigningIdentity(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      securityOutput.replace('Local Signing One', 'Developer ID Application: Example (TEAM123456)')
    ),
    /no-Team-ID self-signed certificate/i
  );
});

test('local artifact verifier requires a certificate-anchored stable requirement', () => {
  const {
    assertStableLocalSignature,
    extractDesignatedRequirement
  } = require('../scripts/verify-macos-local-signed');
  const expectedHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const signed = [
    'Identifier=com.kunkun.shot',
    'CodeDirectory v=20400 size=616 flags=0x0(none) hashes=9+7 location=embedded',
    'Authority=Local Signing One',
    'TeamIdentifier=not set'
  ].join('\n');
  const stableRequirement =
    'designated => identifier "com.kunkun.shot" and certificate leaf = H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';

  assert.doesNotThrow(() =>
    assertStableLocalSignature(signed, stableRequirement, expectedHash, '/tmp/Test.app')
  );
  assert.equal(
    extractDesignatedRequirement(
      `Executable=/tmp/Test.app/Contents/MacOS/Test\n${stableRequirement}`,
      '/tmp/Test.app'
    ),
    stableRequirement
  );
  assert.throws(
    () => assertStableLocalSignature(
      `${signed}\nSignature=adhoc`,
      'designated => cdhash H"1111111111111111111111111111111111111111"',
      expectedHash,
      '/tmp/Test.app'
    ),
    /ad-hoc|certificate-anchored/i
  );
  assert.throws(
    () => assertStableLocalSignature(
      signed.replace('flags=0x0(none)', 'flags=0x10000(runtime)'),
      stableRequirement,
      expectedHash,
      '/tmp/Test.app'
    ),
    /hardened runtime/i
  );
  assert.throws(
    () => assertStableLocalSignature(
      `${signed}\nTimestamp=Aug 29, 2026 at 11:45:00`,
      stableRequirement,
      expectedHash,
      '/tmp/Test.app'
    ),
    /timestamp/i
  );
  assert.throws(
    () => assertStableLocalSignature(
      signed.replace('TeamIdentifier=not set', 'TeamIdentifier=TEAM123456'),
      stableRequirement,
      expectedHash,
      '/tmp/Test.app'
    ),
    /no-Team-ID/i
  );
  assert.throws(
    () => assertStableLocalSignature(
      signed.replace('Identifier=com.kunkun.shot', 'Identifier=com.example.other'),
      stableRequirement.replace('identifier "com.kunkun.shot"', 'identifier "com.example.other"'),
      expectedHash,
      '/tmp/Test.app'
    ),
    /bundle identifier|designated requirement/i
  );
  assert.throws(
    () => assertStableLocalSignature(
      signed,
      stableRequirement.replace(/a/g, 'b'),
      expectedHash,
      '/tmp/Test.app'
    ),
    /certificate/i
  );
});

test('stable local build sanitizes ambient signing keychain overrides', () => {
  const { localBuildEnvironment } = require('../scripts/build-macos-local-signed');
  const env = localBuildEnvironment('A'.repeat(40), {
    PATH: '/usr/bin',
    CSC_KEYCHAIN: '/tmp/unrelated.keychain-db',
    CSC_LINK: '/tmp/unrelated.p12'
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CSC_KEYCHAIN, undefined);
  assert.equal(env.CSC_LINK, undefined);
  assert.equal(env.KK_MAC_RESOLVED_SIGNING_IDENTITY, 'A'.repeat(40));
});
