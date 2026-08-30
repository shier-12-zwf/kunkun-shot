'use strict';

const SCREEN_PERMISSION_STATUSES = new Set([
  'granted',
  'denied',
  'restricted',
  'not-determined',
  'unknown',
]);
const BLOCKED_SCREEN_PERMISSION_STATUSES = new Set(['denied', 'restricted']);

class ScreenPermissionError extends Error {
  constructor(status, cause) {
    const normalized = SCREEN_PERMISSION_STATUSES.has(status) ? status : 'unknown';
    const message = normalized === 'restricted'
      ? '屏幕录制权限受到系统策略限制。'
      : '屏幕录制权限未开启。';
    super(message, cause ? { cause } : undefined);
    this.name = 'ScreenPermissionError';
    this.code = 'SCREEN_PERMISSION_DENIED';
    this.status = normalized;
  }
}

function readScreenPermissionStatus(systemPreferences, logger = console) {
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (SCREEN_PERMISSION_STATUSES.has(status)) return status;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[screen-permission] unexpected status: ${String(status)}`);
    }
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[screen-permission] could not read TCC status:', error);
    }
  }
  return 'unknown';
}

function isBlockedScreenPermissionStatus(status) {
  return BLOCKED_SCREEN_PERMISSION_STATUSES.has(status);
}

function requireScreenCaptureAttempt(status, cause) {
  if (isBlockedScreenPermissionStatus(status)) {
    throw new ScreenPermissionError(status, cause);
  }
  // not-determined and unknown deliberately proceed to the real capture API.
  // That API is what causes macOS to issue the first Screen Recording request.
  return status;
}

function isScreenPermissionError(error) {
  return error instanceof ScreenPermissionError
    || !!(error && error.code === 'SCREEN_PERMISSION_DENIED' && typeof error.status === 'string');
}

module.exports = {
  BLOCKED_SCREEN_PERMISSION_STATUSES,
  SCREEN_PERMISSION_STATUSES,
  ScreenPermissionError,
  isBlockedScreenPermissionStatus,
  isScreenPermissionError,
  readScreenPermissionStatus,
  requireScreenCaptureAttempt,
};
