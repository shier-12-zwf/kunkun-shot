'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { packageSwiftHelpers } = require('./package-swift-helpers');

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const ATS_ARBITRARY_LOADS = ':NSAppTransportSecurity:NSAllowsArbitraryLoads';

function copyVerifiedFile(sourcePath, destinationPath, label) {
  let sourceStat;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch (error) {
    throw new Error(`Cannot package ${label}: missing ${sourcePath}`, { cause: error });
  }
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Cannot package ${label}: source is not a non-empty file: ${sourcePath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  const destinationStat = fs.statSync(destinationPath);
  if (!destinationStat.isFile() || destinationStat.size !== sourceStat.size) {
    throw new Error(`Failed to verify packaged ${label}: ${destinationPath}`);
  }
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function ensureElectronRuntime(projectDir, dependencies) {
  const electronPackagePath = require.resolve('electron/package.json', { paths: [projectDir] });
  const electronPackageDir = path.dirname(electronPackagePath);
  const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
  const sourceDir = path.join(electronPackageDir, 'dist');
  const requiredLicenses = ['LICENSE', 'LICENSES.chromium.html'];

  if (requiredLicenses.every((name) => isNonEmptyFile(path.join(sourceDir, name)))) return;

  // Loading `electron/index.js` only repairs a missing executable. A half-present
  // runtime (path.txt + executable, but no licenses) is therefore left broken.
  // Download and checksum-verify the matching archive, extract it in an isolated
  // temporary directory, then restore only the two license sources we need.
  const downloadArtifact = dependencies && dependencies.downloadElectronArtifact
    ? dependencies.downloadElectronArtifact
    : require(require.resolve('@electron/get', { paths: [electronPackageDir] })).downloadArtifact;
  const extractArchive = dependencies && dependencies.extractElectronArchive
    ? dependencies.extractElectronArchive
    : require(require.resolve('@electron-internal/extract-zip', {
      paths: [electronPackageDir],
    })).extract;
  const checksumsPath = path.join(electronPackageDir, 'checksums.json');
  const useRemoteChecksums =
    process.env.electron_use_remote_checksums ||
    process.env.npm_config_electron_use_remote_checksums;
  const archivePath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums: useRemoteChecksums
      ? undefined
      : JSON.parse(fs.readFileSync(checksumsPath, 'utf8')),
  });
  const extractionDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kunkun-electron-license-'));
  try {
    await extractArchive(archivePath, { dir: extractionDir });
    for (const name of requiredLicenses) {
      copyVerifiedFile(
        path.join(extractionDir, name),
        path.join(sourceDir, name),
        `restored Electron ${name}`
      );
    }
  } finally {
    fs.rmSync(extractionDir, { recursive: true, force: true });
  }
}

async function packageElectronLicenses(context, appContentsDir, dependencies) {
  const projectDir = context.packager && context.packager.projectDir;
  if (!projectDir) {
    throw new Error('Cannot package Electron licenses: electron-builder projectDir is unavailable');
  }

  const sourceDir = path.join(projectDir, 'node_modules', 'electron', 'dist');
  const destinationDir = path.join(appContentsDir, 'Resources', 'licenses', 'Electron');
  const sources = [
    path.join(sourceDir, 'LICENSE'),
    path.join(sourceDir, 'LICENSES.chromium.html')
  ];

  if (!sources.every(isNonEmptyFile)) {
    const runtimeInstaller =
      dependencies && dependencies.ensureElectronRuntime
        ? dependencies.ensureElectronRuntime
        : ensureElectronRuntime;
    await runtimeInstaller(projectDir, dependencies);
  }

  copyVerifiedFile(
    sources[0],
    path.join(destinationDir, 'LICENSE'),
    'Electron license'
  );
  copyVerifiedFile(
    sources[1],
    path.join(destinationDir, 'LICENSES.chromium.html'),
    'Chromium third-party licenses'
  );
}

module.exports = async function hardenMacAppTransportSecurity(context, dependencies) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appContentsDir = path.join(context.appOutDir, `${appName}.app`, 'Contents');
  const plistPath = path.join(appContentsDir, 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Cannot harden App Transport Security: missing ${plistPath}`);
  }

  try {
    execFileSync(
      PLIST_BUDDY,
      ['-c', `Set ${ATS_ARBITRARY_LOADS} false`, plistPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const value = execFileSync(
      PLIST_BUDDY,
      ['-c', `Print ${ATS_ARBITRARY_LOADS}`, plistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();

    if (value !== 'false') {
      throw new Error(`unexpected value ${JSON.stringify(value)}`);
    }
  } catch (error) {
    throw new Error(`Failed to enforce NSAllowsArbitraryLoads=false in ${plistPath}`, {
      cause: error
    });
  }

  const electronLicensePackager =
    dependencies && dependencies.packageElectronLicenses
      ? dependencies.packageElectronLicenses
      : packageElectronLicenses;
  await electronLicensePackager(context, appContentsDir, dependencies);
  const nativeHelperPackager =
    dependencies && dependencies.packageSwiftHelpers
      ? dependencies.packageSwiftHelpers
      : packageSwiftHelpers;
  await nativeHelperPackager(context, appContentsDir);
};

module.exports.copyVerifiedFile = copyVerifiedFile;
module.exports.packageElectronLicenses = packageElectronLicenses;
module.exports.ensureElectronRuntime = ensureElectronRuntime;
