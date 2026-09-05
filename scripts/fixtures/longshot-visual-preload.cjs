'use strict';

// Test-only bridge. No production IPC, desktop capture, clipboard, user settings,
// history, or disk export is exposed to the loaded production renderer.
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('kkapi', {
  onInit: (callback) => listen('longshot-visual:init', callback),
  onLongshotUpdate: (callback) => listen('longshot-visual:update', callback),
  captureRegion: (payload) => ipcRenderer.invoke('longshot-visual:capture', payload),
  updateLongshot: (payload) => ipcRenderer.invoke('longshot-visual:present', payload),
  saveImage: (dataURL) => ipcRenderer.invoke('longshot-visual:save', dataURL),
  copyImage: (dataURL) => ipcRenderer.invoke('longshot-visual:copy', dataURL),
  closeSelf: () => ipcRenderer.invoke('longshot-visual:close'),
});
