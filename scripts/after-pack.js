'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const ATS_ARBITRARY_LOADS = ':NSAppTransportSecurity:NSAllowsArbitraryLoads';

module.exports = async function hardenMacAppTransportSecurity(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const plistPath = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Info.plist');
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
};
