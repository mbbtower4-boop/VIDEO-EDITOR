'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the (untrusted) page and the OS. Deliberately tiny:
// every heavy or privileged operation runs in main; the renderer only asks.
contextBridge.exposeInMainWorld('api', {
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkTools: () => ipcRenderer.invoke('check-tools'),
  openVideo: () => ipcRenderer.invoke('open-video'),
  analyze: (path, opts) => ipcRenderer.invoke('analyze', { path, opts }),
  exportVideo: (path, keeps, opts) => ipcRenderer.invoke('export-video', { path, keeps, opts }),
  transcribe: (path) => ipcRenderer.invoke('transcribe', { path }),
  translate: (payload) => ipcRenderer.invoke('translate', payload),
  saveText: (text, suggestedName) => ipcRenderer.invoke('save-text', { text, suggestedName }),
  saveSrtBundle: (videoPath, files) => ipcRenderer.invoke('save-srt-bundle', { videoPath, files }),
  muxSubtitles: (payload) => ipcRenderer.invoke('mux-subtitles', payload),
  burnSubtitles: (payload) => ipcRenderer.invoke('burn-subtitles', payload),
  generateTasks: (payload) => ipcRenderer.invoke('generate-tasks', payload),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  onProgress: (cb) => ipcRenderer.on('progress', (_evt, data) => cb(data)),
});
