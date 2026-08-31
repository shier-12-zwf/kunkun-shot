'use strict';

async function openValidatedExternalUrl(rawUrl, dependencies) {
  const normalizeUrl = dependencies && dependencies.normalizeUrl;
  const openExternal = dependencies && dependencies.openExternal;
  const reportError = dependencies && dependencies.reportError;
  if (typeof normalizeUrl !== 'function' || typeof openExternal !== 'function') {
    throw new TypeError('外链打开器依赖无效。');
  }

  let url;
  try {
    url = normalizeUrl(rawUrl);
  } catch (error) {
    return {
      ok: false,
      error: (error && error.message) || '链接无效。',
    };
  }

  try {
    await openExternal(url);
    return { ok: true };
  } catch (error) {
    if (typeof reportError === 'function') reportError(error, url);
    return { ok: false, error: '系统浏览器未能打开该链接。' };
  }
}

module.exports = { openValidatedExternalUrl };
