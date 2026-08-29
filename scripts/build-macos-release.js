'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist', 'release-mac');

const NOTARIZATION_FAMILIES = [
  {
    method: 'api-key',
    required: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    optional: []
  },
  {
    method: 'apple-id',
    required: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    optional: []
  },
  {
    method: 'keychain-profile',
    required: ['APPLE_KEYCHAIN_PROFILE'],
    optional: ['APPLE_KEYCHAIN']
  }
];

function hasValue(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function validateReleaseEnvironment(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') {
    throw new Error('Formal macOS releases must be built on a macOS host.');
  }

  const hasCertificate = hasValue(env, 'CSC_LINK') || hasValue(env, 'CSC_KEY_PASSWORD');
  const hasIdentity = hasValue(env, 'CSC_NAME');

  if (!hasCertificate && !hasIdentity) {
    throw new Error(
      'Missing signing credentials: set CSC_LINK + CSC_KEY_PASSWORD, or set an explicit CSC_NAME.'
    );
  }
  if (hasCertificate && hasIdentity) {
    throw new Error(
      'Choose exactly one signing credential method: CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME.'
    );
  }
  if (hasCertificate) {
    const missing = ['CSC_LINK', 'CSC_KEY_PASSWORD'].filter((name) => !hasValue(env, name));
    if (missing.length > 0) {
      throw new Error(`Incomplete certificate signing credentials; missing ${missing.join(', ')}.`);
    }
  }
  if (hasIdentity && env.CSC_NAME.trim() === '-') {
    throw new Error('Ad-hoc signing is forbidden for a formal release; CSC_NAME cannot be "-".');
  }

  const activeFamilies = NOTARIZATION_FAMILIES.filter((family) =>
    [...family.required, ...family.optional].some((name) => hasValue(env, name))
  );
  if (activeFamilies.length === 0) {
    throw new Error(
      'Missing notarization credentials: configure exactly one Apple API key, Apple ID, or keychain-profile family.'
    );
  }
  if (activeFamilies.length !== 1) {
    throw new Error('Configure exactly one notarization credential family; mixed families are rejected.');
  }

  const family = activeFamilies[0];
  const missing = family.required.filter((name) => !hasValue(env, name));
  if (missing.length > 0) {
    throw new Error(`Incomplete ${family.method} notarization credentials; missing ${missing.join(', ')}.`);
  }

  return {
    signingMethod: hasCertificate ? 'certificate-file' : 'keychain-identity',
    notarizationMethod: family.method
  };
}

function assertFreshOutputDirectory(outputDir = RELEASE_OUTPUT_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(outputDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(
      `Formal release output directory is not empty: ${outputDir}. Move or remove old artifacts first.`
    );
  }
}

function releaseBuildArgs() {
  return [
    '--mac',
    '--config',
    'build/electron-builder.release.js',
    '--publish',
    'never'
  ];
}

function releaseVerificationArgs() {
  return [path.join(PROJECT_ROOT, 'scripts', 'verify-macos-release.js'), RELEASE_OUTPUT_DIR];
}

function releaseBuildEnvironment(env = process.env) {
  return {
    ...env,
    // CSC_LINK imports a temporary keychain and then needs identity discovery.
    // CSC_NAME remains explicit even when discovery is enabled.
    CSC_IDENTITY_AUTO_DISCOVERY: 'true'
  };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    env: releaseBuildEnvironment(options.env || process.env),
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit status ${result.status ?? 'unknown'}.`);
  }
}

function main() {
  const methods = validateReleaseEnvironment();
  assertFreshOutputDirectory();
  process.stdout.write(
    `Formal release preflight passed (${methods.signingMethod}, ${methods.notarizationMethod}); credential values are not logged.\n`
  );
  runChecked(path.join(PROJECT_ROOT, 'node_modules', '.bin', 'electron-builder'), releaseBuildArgs());
  runChecked(process.execPath, releaseVerificationArgs());
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Formal macOS release failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_OUTPUT_DIR,
  assertFreshOutputDirectory,
  releaseBuildArgs,
  releaseBuildEnvironment,
  releaseVerificationArgs,
  validateReleaseEnvironment
};
