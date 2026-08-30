'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const LOCAL_OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist', 'local-signed-mac');
const IDENTITY_ENV = 'KK_MAC_SIGNING_IDENTITY';
const RESOLVED_IDENTITY_ENV = 'KK_MAC_RESOLVED_SIGNING_IDENTITY';

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function identityFromLocalEnv(projectRoot = PROJECT_ROOT) {
  const envPath = path.join(projectRoot, '.env.local');
  let source;
  try {
    source = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?KK_MAC_SIGNING_IDENTITY\s*=\s*(.*?)\s*$/);
    if (match) return unquoteEnvValue(match[1]);
  }
  return '';
}

function readRequestedIdentity(env = process.env, projectRoot = PROJECT_ROOT) {
  if (hasValue(env[IDENTITY_ENV])) return env[IDENTITY_ENV].trim();
  return identityFromLocalEnv(projectRoot);
}

function validateLocalSigningInput(identity, platform = process.platform) {
  if (platform !== 'darwin') {
    throw new Error('Stable local macOS packages must be built on a macOS host.');
  }
  if (!hasValue(identity)) {
    throw new Error(
      `${IDENTITY_ENV} is required. Set it in the environment or in the ignored .env.local file.`
    );
  }
  const normalized = identity.trim();
  if (normalized === '-') {
    throw new Error('Ad-hoc signing is forbidden for the stable local build.');
  }
  if (/[\0\r\n]/.test(normalized)) {
    throw new Error('The local signing identity contains unsupported control characters.');
  }
  return normalized;
}

function parseSecurityIdentities(output) {
  const identities = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/);
    if (!match) continue;
    identities.push({ hash: match[1].toUpperCase(), name: match[2] });
  }
  return identities;
}

function isAppleManagedSigningIdentity(name) {
  return /^(?:Developer ID|Apple Development|Apple Distribution|Mac Developer|iPhone Developer|iPhone Distribution)\b/i
    .test(String(name || '').trim());
}

function resolveSigningIdentity(requestedIdentity, securityOutput) {
  const requested = String(requestedIdentity || '').trim();
  const identities = parseSecurityIdentities(securityOutput);
  const requestedUpper = requested.toUpperCase();
  const matches = identities.filter(
    (item) => item.hash === requestedUpper || item.name === requested
  );
  if (matches.length === 0) {
    throw new Error(`The requested code-signing identity was not found in the login keychain: ${requested}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `The requested code-signing identity is ambiguous; use its 40-character SHA-1 fingerprint: ${requested}`
    );
  }
  if (isAppleManagedSigningIdentity(matches[0].name)) {
    throw new Error(
      `The stable local build requires a dedicated no-Team-ID self-signed certificate, not an Apple-managed identity: ${matches[0].name}`
    );
  }
  return matches[0].hash;
}

function queryCodeSigningIdentities() {
  const result = spawnSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8', stdio: 'pipe' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(
      `security find-identity failed with exit status ${result.status ?? 'unknown'}` +
      (detail ? `: ${detail}` : '.')
    );
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function assertFreshOutputDirectory(outputDir = LOCAL_OUTPUT_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(outputDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(
      `Stable local output directory is not empty: ${outputDir}. Move old artifacts aside before rebuilding.`
    );
  }
}

function localBuildArgs() {
  return [
    '--mac',
    '--config',
    'build/electron-builder.local-signed.js',
    '--publish',
    'never'
  ];
}

function localVerificationArgs(identityHash) {
  return [
    path.join(PROJECT_ROOT, 'scripts', 'verify-macos-local-signed.js'),
    LOCAL_OUTPUT_DIR,
    identityHash
  ];
}

function localBuildEnvironment(identityHash, env = process.env) {
  const result = { ...env };
  for (const name of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_KEYCHAIN',
    'CSC_NAME',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_KEYCHAIN_PROFILE',
    'APPLE_KEYCHAIN'
  ]) {
    delete result[name];
  }
  result.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  result[RESOLVED_IDENTITY_ENV] = identityHash;
  return result;
}

function runChecked(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with exit status ${result.status ?? 'unknown'}.`);
  }
}

function main() {
  const requested = validateLocalSigningInput(readRequestedIdentity());
  const resolvedHash = resolveSigningIdentity(requested, queryCodeSigningIdentities());
  assertFreshOutputDirectory();
  const buildEnv = localBuildEnvironment(resolvedHash);
  process.stdout.write(
    `Stable local signing preflight passed (certificate ${resolvedHash.slice(0, 8)}…${resolvedHash.slice(-8)}).\n`
  );
  runChecked(
    path.join(PROJECT_ROOT, 'node_modules', '.bin', 'electron-builder'),
    localBuildArgs(),
    buildEnv
  );
  runChecked(process.execPath, localVerificationArgs(resolvedHash), buildEnv);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Stable local macOS build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  IDENTITY_ENV,
  LOCAL_OUTPUT_DIR,
  assertFreshOutputDirectory,
  identityFromLocalEnv,
  isAppleManagedSigningIdentity,
  localBuildArgs,
  localBuildEnvironment,
  localVerificationArgs,
  parseSecurityIdentities,
  queryCodeSigningIdentities,
  readRequestedIdentity,
  resolveSigningIdentity,
  validateLocalSigningInput
};
