'use strict';

const RESOLVED_IDENTITY_ENV = 'KK_MAC_RESOLVED_SIGNING_IDENTITY';

function resolvedIdentity(env = process.env) {
  const identity = String(env[RESOLVED_IDENTITY_ENV] || '').trim().toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(identity)) {
    throw new Error(
      `${RESOLVED_IDENTITY_ENV} must contain the validated 40-character certificate fingerprint.`
    );
  }
  return identity;
}

function buildStableLocalSignOptions(options, env = process.env) {
  const identity = resolvedIdentity(env);
  const suppliedIdentity = String(options && options.identity || '').trim().toUpperCase();
  if (suppliedIdentity && suppliedIdentity !== identity) {
    throw new Error('electron-builder supplied a signing identity that differs from the validated fingerprint.');
  }
  return {
    ...options,
    identity,
    identityValidation: false
  };
}

async function signMacLocal(options) {
  // electron-builder 26 resolves a fingerprint correctly, then its default signer
  // replaces it with identity.name. Two same-name certificates make codesign fail
  // as ambiguous, so keep the already validated SHA-1 all the way to codesign.
  const { signAsync } = require('@electron/osx-sign');
  return signAsync(buildStableLocalSignOptions(options));
}

module.exports = signMacLocal;
module.exports.buildStableLocalSignOptions = buildStableLocalSignOptions;
module.exports.resolvedIdentity = resolvedIdentity;
