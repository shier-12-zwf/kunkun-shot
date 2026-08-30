'use strict';

function normalizeWindowCaptureDetail(stderr) {
  return String(stderr || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function classifyWindowCaptureClose({ code, signal, hasFile, stderr } = {}) {
  const detail = normalizeWindowCaptureDetail(stderr);

  if (code === 0 && !signal && hasFile) {
    return { kind: 'success', detail };
  }

  if (!signal && !hasFile) {
    const explicitlyCanceled = /\b(?:cancel(?:led|ed|ing)?|no selection)\b/i.test(detail);
    if (code === 0 || explicitlyCanceled || (code === 1 && !detail)) {
      return { kind: 'canceled', detail };
    }
  }

  return { kind: 'failed', detail };
}

module.exports = {
  classifyWindowCaptureClose,
  normalizeWindowCaptureDetail,
};
