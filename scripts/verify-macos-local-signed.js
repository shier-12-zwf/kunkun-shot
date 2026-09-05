'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertPackagedResources,
  discoverReleaseArtifacts,
  isSafeArchiveEntry
} = require('./verify-macos-release');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_LOCAL_DIR = path.join(PROJECT_ROOT, 'dist', 'local-signed-mac');

function runCommand(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    throw new Error(
      `${path.basename(command)} failed with exit status ${result.status ?? 'unknown'}` +
      (detail ? `: ${detail}` : '.')
    );
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function normalizeExpectedHash(expectedHash) {
  const normalized = String(expectedHash || '').trim().toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(normalized)) {
    throw new Error('Expected local signing identity must be a 40-character SHA-1 fingerprint.');
  }
  return normalized;
}

function assertStableLocalSignature(signature, requirement, expectedHash, appPath) {
  const expected = normalizeExpectedHash(expectedHash);
  if (/^Signature=adhoc$/m.test(signature)) {
    throw new Error(`Local app is still ad-hoc signed: ${appPath}`);
  }
  if (!/^Authority=.+$/m.test(signature)) {
    throw new Error(`Local app has no certificate authority in its signature: ${appPath}`);
  }
  if (!/^TeamIdentifier=not set$/m.test(signature)) {
    throw new Error(
      `Stable local app must use the configured no-Team-ID self-signed certificate: ${appPath}`
    );
  }
  if (/flags=.*\bruntime\b/m.test(signature)) {
    throw new Error(
      `Stable local app unexpectedly enables Hardened Runtime with a no-Team-ID certificate: ${appPath}`
    );
  }
  if (/^Timestamp=/m.test(signature)) {
    throw new Error(`Stable local app unexpectedly contains a signing timestamp: ${appPath}`);
  }
  const normalizedRequirement = String(requirement || '').toLowerCase();
  const identifierClause = 'identifier "com.kunkun.shot"';
  const expectedClause = `certificate leaf = h"${expected.toLowerCase()}"`;
  if (
    normalizedRequirement.includes('cdhash') ||
    !normalizedRequirement.includes(identifierClause) ||
    !normalizedRequirement.includes(expectedClause)
  ) {
    throw new Error(
      `Local app does not have the expected bundle identifier and certificate-anchored designated requirement: ${appPath}`
    );
  }
}

function extractDesignatedRequirement(requirement, appPath) {
  const match = /^designated => .*$/m.exec(String(requirement || ''));
  if (!match) {
    throw new Error(`Local app has no readable designated requirement: ${appPath}`);
  }
  return match[0].trim();
}

function verifySignedApp(appPath, expectedHash) {
  assertPackagedResources(appPath);
  runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const signature = runCommand(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', appPath],
    { capture: true }
  );
  const requirement = runCommand(
    '/usr/bin/codesign',
    ['--display', '--requirements', '-', appPath],
    { capture: true }
  );
  assertStableLocalSignature(signature, requirement, expectedHash, appPath);
  return extractDesignatedRequirement(requirement, appPath);
}

function discoverApps(currentPath, apps = []) {
  const stat = fs.lstatSync(currentPath);
  if (stat.isSymbolicLink()) return apps;
  if (stat.isDirectory() && currentPath.toLowerCase().endsWith('.app')) {
    apps.push(currentPath);
    return apps;
  }
  if (!stat.isDirectory()) return apps;
  for (const entry of fs.readdirSync(currentPath).sort()) {
    discoverApps(path.join(currentPath, entry), apps);
  }
  return apps;
}

function requireApps(searchPath) {
  const apps = discoverApps(searchPath);
  if (apps.length === 0) {
    throw new Error(`No macOS application bundle was found inside ${searchPath}.`);
  }
  return apps;
}

function verifyDmg(dmgPath, expectedHash) {
  runCommand('/usr/bin/hdiutil', ['verify', dmgPath]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-local-dmg-'));
  const mountPoint = path.join(tempRoot, 'mount');
  fs.mkdirSync(mountPoint);
  let attached = false;
  let failure = null;
  const requirements = [];
  try {
    runCommand('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountPoint,
      dmgPath
    ]);
    attached = true;
    for (const appPath of requireApps(mountPoint)) {
      requirements.push(verifySignedApp(appPath, expectedHash));
    }
  } catch (error) {
    failure = error;
  } finally {
    if (attached) {
      const detached = spawnSync('/usr/bin/hdiutil', ['detach', mountPoint], { stdio: 'inherit' });
      if ((detached.error || detached.status !== 0) && !failure) {
        failure = detached.error || new Error(`Could not detach verification mount: ${mountPoint}`);
      }
      if (!detached.error && detached.status === 0) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  if (failure) throw failure;
  return requirements;
}

function verifyZip(zipPath, expectedHash) {
  runCommand('/usr/bin/unzip', ['-t', zipPath]);
  const listing = runCommand('/usr/bin/unzip', ['-Z1', zipPath], { capture: true });
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => !isSafeArchiveEntry(entry));
  if (unsafe) {
    throw new Error(`ZIP contains an unsafe archive path: ${JSON.stringify(unsafe)}`);
  }
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-local-zip-'));
  const requirements = [];
  try {
    runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    for (const appPath of requireApps(extractDir)) {
      requirements.push(verifySignedApp(appPath, expectedHash));
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  return requirements;
}

function printChecksum(artifactPath) {
  const result = runCommand('/usr/bin/shasum', ['-a', '256', artifactPath], { capture: true }).trim();
  process.stdout.write(`${result}\n`);
}

function verifyLocalArtifacts(localPath, expectedHash, platform = process.platform) {
  if (platform !== 'darwin') {
    throw new Error('Stable local macOS artifact verification requires a macOS host.');
  }
  const expected = normalizeExpectedHash(expectedHash);
  const artifacts = discoverReleaseArtifacts(localPath);
  const requirements = [];
  for (const appPath of artifacts.apps) requirements.push(verifySignedApp(appPath, expected));
  for (const dmgPath of artifacts.dmgs) requirements.push(...verifyDmg(dmgPath, expected));
  for (const zipPath of artifacts.zips) requirements.push(...verifyZip(zipPath, expected));
  if (requirements.length === 0 || new Set(requirements).size !== 1) {
    throw new Error('Stable local artifacts do not share one identical designated requirement.');
  }
  for (const artifactPath of [...artifacts.dmgs, ...artifacts.zips]) printChecksum(artifactPath);
  return artifacts;
}

function resolveExpectedHashFromLocalConfiguration() {
  const {
    queryCodeSigningIdentities,
    readRequestedIdentity,
    resolveSigningIdentity,
    validateLocalSigningInput,
  } = require('./build-macos-local-signed');
  const requested = validateLocalSigningInput(readRequestedIdentity());
  return resolveSigningIdentity(requested, queryCodeSigningIdentities());
}

function main() {
  const localPath = process.argv[2] || DEFAULT_LOCAL_DIR;
  const expectedHash = process.argv[3]
    || process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY
    || resolveExpectedHashFromLocalConfiguration();
  const artifacts = verifyLocalArtifacts(localPath, expectedHash);
  process.stdout.write(
    `Verified stable local signature in ${artifacts.apps.length} app bundle(s), ` +
    `${artifacts.dmgs.length} DMG(s), and ${artifacts.zips.length} ZIP(s).\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Stable local macOS verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_LOCAL_DIR,
  assertStableLocalSignature,
  discoverApps,
  extractDesignatedRequirement,
  normalizeExpectedHash,
  resolveExpectedHashFromLocalConfiguration,
  verifyLocalArtifacts,
  verifySignedApp
};
