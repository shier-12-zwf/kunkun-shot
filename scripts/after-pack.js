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

function packageElectronLicenses(context, appContentsDir) {
  const projectDir = context.packager && context.packager.projectDir;
  if (!projectDir) {
    throw new Error('Cannot package Electron licenses: electron-builder projectDir is unavailable');
  }

  const sourceDir = path.join(projectDir, 'node_modules', 'electron', 'dist');
  const destinationDir = path.join(appContentsDir, 'Resources', 'licenses', 'Electron');
  copyVerifiedFile(
    path.join(sourceDir, 'LICENSE'),
    path.join(destinationDir, 'LICENSE'),
    'Electron license'
  );
  copyVerifiedFile(
    path.join(sourceDir, 'LICENSES.chromium.html'),
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

  packageElectronLicenses(context, appContentsDir);
  const nativeHelperPackager =
    dependencies && dependencies.packageSwiftHelpers
      ? dependencies.packageSwiftHelpers
      : packageSwiftHelpers;
  await nativeHelperPackager(context, appContentsDir);
};

module.exports.copyVerifiedFile = copyVerifiedFile;
