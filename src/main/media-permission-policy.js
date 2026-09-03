'use strict';

function isAllowedRecorderUrl(rawUrl, allowedRecorderUrl) {
  if (typeof rawUrl !== 'string' || typeof allowedRecorderUrl !== 'string') return false;
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(allowedRecorderUrl);
    return actual.protocol === 'file:'
      && actual.origin === expected.origin
      && decodeURIComponent(actual.pathname) === decodeURIComponent(expected.pathname)
      && actual.username === ''
      && actual.password === '';
  } catch (_) {
    return false;
  }
}

function mediaTypesAreSafe(details, checkMode) {
  const value = details && typeof details === 'object' ? details : {};
  if (checkMode) {
    return value.mediaType === undefined
      || value.mediaType === 'audio'
      || value.mediaType === 'video';
  }
  if (value.mediaTypes === undefined) return true;
  return Array.isArray(value.mediaTypes)
    && value.mediaTypes.length > 0
    && value.mediaTypes.every((item) => item === 'audio' || item === 'video');
}

function createMediaPermissionPolicy(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.getTrustedRole !== 'function') throw new TypeError('getTrustedRole is required');
  if (typeof opts.allowedRecorderUrl !== 'string') throw new TypeError('allowedRecorderUrl is required');

  function allows(webContents, permission, requestingUrl, details, checkMode) {
    if (permission !== 'media' || !webContents || !Number.isInteger(webContents.id)) return false;
    if (opts.getTrustedRole(webContents.id) !== 'recorder') return false;
    const currentUrl = typeof webContents.getURL === 'function' ? webContents.getURL() : '';
    const candidateUrl = requestingUrl || (details && details.requestingUrl) || currentUrl;
    if (!isAllowedRecorderUrl(candidateUrl, opts.allowedRecorderUrl)) return false;
    if (!isAllowedRecorderUrl(currentUrl, opts.allowedRecorderUrl)) return false;
    if (details && details.isMainFrame === false) return false;
    return mediaTypesAreSafe(details, checkMode);
  }

  function requestHandler(webContents, permission, callback, details) {
    const requestUrl = details && details.requestingUrl;
    callback(allows(webContents, permission, requestUrl, details, false));
  }

  function checkHandler(webContents, permission, requestingOrigin, details) {
    const requestUrl = details && details.requestingUrl;
    // Electron passes a security origin such as "file://" separately; the concrete
    // frame URL is the only value precise enough to bind access to recorder.html.
    void requestingOrigin;
    return allows(webContents, permission, requestUrl, details, true);
  }

  return { checkHandler, requestHandler };
}

function installMediaPermissionPolicy(session, options) {
  if (!session || typeof session.setPermissionRequestHandler !== 'function'
      || typeof session.setPermissionCheckHandler !== 'function') {
    throw new TypeError('Electron session permission handlers are unavailable');
  }
  const policy = createMediaPermissionPolicy(options);
  session.setPermissionRequestHandler(policy.requestHandler);
  session.setPermissionCheckHandler(policy.checkHandler);
  return policy;
}

module.exports = {
  createMediaPermissionPolicy,
  installMediaPermissionPolicy,
  isAllowedRecorderUrl,
  mediaTypesAreSafe,
};
