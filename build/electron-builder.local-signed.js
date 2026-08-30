'use strict';

const packageBuild = require('../package.json').build;
const signMacLocal = require('../scripts/sign-macos-local');

const identity = process.env.KK_MAC_RESOLVED_SIGNING_IDENTITY;
if (!/^[A-F0-9]{40}$/.test(identity || '')) {
  throw new Error(
    'KK_MAC_RESOLVED_SIGNING_IDENTITY must contain the validated 40-character certificate fingerprint.'
  );
}

// A locally trusted certificate gives macOS TCC a stable designated requirement,
// unlike electron-builder's changing ad-hoc CDHash. This certificate has no Apple
// Team ID, so Hardened Runtime must stay off or Electron helpers cannot load the
// Electron Framework under library validation. Formal releases use the separate
// Developer ID + notarization config and keep Hardened Runtime enabled.
module.exports = {
  ...packageBuild,
  forceCodeSigning: true,
  directories: {
    ...(packageBuild.directories || {}),
    output: 'dist/local-signed-mac'
  },
  mac: {
    ...packageBuild.mac,
    identity,
    sign: signMacLocal,
    notarize: false,
    hardenedRuntime: false,
    timestamp: 'none',
    gatekeeperAssess: false
  }
};
