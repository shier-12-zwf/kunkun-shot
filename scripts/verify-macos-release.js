'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_RELEASE_DIR = path.join(PROJECT_ROOT, 'dist', 'release-mac');

function isSafeArchiveEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) return false;
  const portable = entry.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) return false;
  return !portable.split('/').some((segment) => segment === '..');
}

function walkArtifacts(currentPath, artifacts) {
  const stat = fs.lstatSync(currentPath);
  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory() && currentPath.toLowerCase().endsWith('.app')) {
    artifacts.apps.push(currentPath);
    return;
  }
  if (stat.isFile()) {
    const lower = currentPath.toLowerCase();
    if (lower.endsWith('.dmg')) artifacts.dmgs.push(currentPath);
    if (lower.endsWith('.zip')) artifacts.zips.push(currentPath);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(currentPath).sort()) {
    walkArtifacts(path.join(currentPath, entry), artifacts);
  }
}

function discoverReleaseArtifacts(releasePath) {
  const resolved = path.resolve(releasePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Release output does not exist: ${resolved}`);
  }
  const artifacts = { apps: [], dmgs: [], zips: [] };
  walkArtifacts(resolved, artifacts);

  if (artifacts.apps.length === 0) throw new Error('No unpacked .app artifact was found.');
  if (artifacts.dmgs.length === 0) throw new Error('No DMG artifact was found.');
  if (artifacts.zips.length === 0) throw new Error('No ZIP artifact was found.');
  return artifacts;
}

function discoverApps(searchPath) {
  const artifacts = { apps: [], dmgs: [], zips: [] };
  walkArtifacts(searchPath, artifacts);
  if (artifacts.apps.length === 0) {
    throw new Error(`No macOS application bundle was found inside ${searchPath}.`);
  }
  return artifacts.apps;
}

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

function verifySignedApp(appPath) {
  runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const signature = runCommand(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', appPath],
    { capture: true }
  );
  if (!/^Authority=Developer ID Application:/m.test(signature)) {
    throw new Error(`App is not signed with a Developer ID Application certificate: ${appPath}`);
  }
  if (!/^TeamIdentifier=(?!not set$)[A-Z0-9]+$/m.test(signature)) {
    throw new Error(`App has no valid signing TeamIdentifier: ${appPath}`);
  }
  if (!/flags=.*\bruntime\b/m.test(signature)) {
    throw new Error(`App signature does not enable hardened runtime: ${appPath}`);
  }
  if (/^Signature=adhoc$/m.test(signature)) {
    throw new Error(`Ad-hoc signatures are forbidden for formal releases: ${appPath}`);
  }

  runCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  runCommand('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
}

function verifyDmg(dmgPath) {
  runCommand('/usr/bin/hdiutil', ['verify', dmgPath]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-release-dmg-'));
  const mountPoint = path.join(tempRoot, 'mount');
  fs.mkdirSync(mountPoint);
  let attached = false;
  let failure = null;
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
    for (const appPath of discoverApps(mountPoint)) verifySignedApp(appPath);
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
}

function verifyZip(zipPath) {
  runCommand('/usr/bin/unzip', ['-t', zipPath]);
  const listing = runCommand('/usr/bin/unzip', ['-Z1', zipPath], { capture: true });
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => !isSafeArchiveEntry(entry));
  if (unsafe) {
    throw new Error(`ZIP contains an unsafe archive path: ${JSON.stringify(unsafe)}`);
  }
  if (!listing.split(/\r?\n/).some((entry) => entry.includes('.app/Contents/'))) {
    throw new Error(`ZIP does not contain a macOS application bundle: ${zipPath}`);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunkun-release-zip-'));
  try {
    runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    for (const appPath of discoverApps(extractDir)) verifySignedApp(appPath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function printChecksum(artifactPath) {
  const result = runCommand('/usr/bin/shasum', ['-a', '256', artifactPath], { capture: true }).trim();
  process.stdout.write(`${result}\n`);
}

function verifyRelease(releasePath, platform = process.platform) {
  if (platform !== 'darwin') {
    throw new Error('macOS release verification requires a macOS host.');
  }
  const artifacts = discoverReleaseArtifacts(releasePath);
  for (const appPath of artifacts.apps) verifySignedApp(appPath);
  for (const dmgPath of artifacts.dmgs) verifyDmg(dmgPath);
  for (const zipPath of artifacts.zips) verifyZip(zipPath);
  for (const filePath of [...artifacts.dmgs, ...artifacts.zips]) printChecksum(filePath);
  return artifacts;
}

function main() {
  const releasePath = process.argv[2] || DEFAULT_RELEASE_DIR;
  const artifacts = verifyRelease(releasePath);
  process.stdout.write(
    `Verified ${artifacts.apps.length} app bundle(s), ${artifacts.dmgs.length} DMG(s), and ${artifacts.zips.length} ZIP(s).\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`macOS release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_RELEASE_DIR,
  discoverReleaseArtifacts,
  isSafeArchiveEntry,
  verifyRelease,
  verifySignedApp
};
