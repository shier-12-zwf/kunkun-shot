'use strict';

const packageBuild = require('../package.json').build;

// package.json contains shared packaging defaults. A formal release uses this
// complete config, removes the local identity override, and makes both signing
// and notarization mandatory. Credentials remain environment-only.
const {
  identity: _localIdentity,
  notarize: _localNotarize,
  ...releaseMac
} = packageBuild.mac;

module.exports = {
  ...packageBuild,
  forceCodeSigning: true,
  directories: {
    ...(packageBuild.directories || {}),
    output: 'dist/release-mac'
  },
  mac: {
    ...releaseMac,
    type: 'distribution',
    notarize: true
  }
};
