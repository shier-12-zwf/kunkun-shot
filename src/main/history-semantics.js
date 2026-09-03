'use strict';

function shouldAutoSaveOverlayHistory({ imageDataURL, savedToHistory } = {}) {
  return !!imageDataURL && !savedToHistory;
}

function historyTypeForImageSaveRole(role) {
  if (role === 'longshot') return 'long';
  if (role === 'pin') return 'pin';
  return 'region';
}

async function persistRecordingHistory(filePath, {
  addMedia,
  broadcast,
  onError,
  width = 0,
  height = 0,
} = {}) {
  const report = (error) => {
    if (typeof onError !== 'function') return;
    try { onError(error); } catch (_) {}
  };
  if (typeof addMedia !== 'function') {
    report(new Error('录屏历史写入器不可用。'));
    return null;
  }

  let item = null;
  try {
    item = await addMedia(filePath, 'recording', { width, height });
  } catch (error) {
    report(error);
    return null;
  }
  if (!item) {
    report(new Error('录屏受管历史副本写入失败。'));
    return null;
  }
  if (typeof broadcast === 'function') {
    try { broadcast(item); } catch (error) { report(error); }
  }
  return item;
}

module.exports = {
  shouldAutoSaveOverlayHistory,
  historyTypeForImageSaveRole,
  persistRecordingHistory,
};
