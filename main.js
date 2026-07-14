'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const tools = require('./lib/tools.js');
const analyze = require('./lib/analyze.js');
const exporter = require('./lib/exporter.js');
const transcriber = require('./lib/transcribe.js');
const translateReg = require('./lib/translate/index.js');
const settings = require('./lib/settings.js');
const ops = require('./src/videoOps.js');

let mainWindow = null;
const BOM = '\uFEFF'; // UTF-8 BOM so picky Windows players detect SRT encoding

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#15181d',
    title: 'VIDEO EDITOR v' + app.getVersion(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.removeMenu(); // clean tool chrome; shortcuts handled in-app
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  settings.init(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function sendProgress(jobId, pct, detail) {
  if (mainWindow) mainWindow.webContents.send('progress', { jobId, pct, detail: detail || '' });
}

// ---- IPC ---------------------------------------------------------------------
// The renderer never touches the filesystem or spawns anything; it asks main.

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('check-tools', () => tools.loadManifest());

ipcMain.handle('open-video', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const manifest = tools.loadManifest();
  if (!manifest.ok) return { path: filePath, name: path.basename(filePath), probe: null };
  const probe = await analyze.probe(manifest, filePath);
  return { path: filePath, name: path.basename(filePath), probe };
});

// Waveform peaks + silence/freeze detection in one job.
ipcMain.handle('analyze', async (_evt, { path: file, opts }) => {
  const manifest = tools.loadManifest();
  if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
  let peaks = null;
  if (opts.hasAudio !== false) {
    sendProgress('analyze', 0, 'Reading audio waveform…');
    peaks = await analyze.waveform(manifest, file, 4096, 'analyze');
  }
  sendProgress('analyze', 0, 'Detecting silence & frozen frames…');
  const det = await analyze.detect(manifest, file, opts,
    (pct) => sendProgress('analyze', pct, 'Detecting silence & frozen frames…'), 'analyze');
  sendProgress('analyze', 1, 'done');
  return { peaks, silences: det.silences, freezes: det.freezes };
});

ipcMain.handle('export-video', async (_evt, { path: file, keeps, opts }) => {
  const manifest = tools.loadManifest();
  if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export trimmed video',
    defaultPath: opts.suggestedName || 'trimmed.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const useNvenc = settings.get().useNvenc;
  return exporter.exportVideo(manifest, file, keeps, res.filePath,
    { hasAudio: opts.hasAudio, useNvenc },
    (pct, speed) => sendProgress('export', pct, speed ? speed.toFixed(1) + '× realtime' : ''),
    'export');
});

ipcMain.handle('transcribe', async (_evt, { path: file }) => {
  const manifest = tools.loadManifest();
  if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
  return transcriber.transcribe(manifest, file, {},
    (pct) => sendProgress('transcribe', pct, 'Transcribing on ' +
      (manifest.whisperBackend === 'gpu' ? 'GPU' : 'CPU') + '…'), 'transcribe');
});

/*
 * Translate the cue texts into targetCode.
 * - Text providers (claude, mymemory) return {texts} aligned with the cues.
 * - 'whisperEn' re-runs Whisper on the video audio with --translate and
 *   returns {cues} (its own segmentation/timestamps).
 */
ipcMain.handle('translate', async (_evt, { cues, providerId, targetCode, srcCode, videoPath }) => {
  if (providerId === 'whisperEn') {
    const manifest = tools.loadManifest();
    if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
    const r = await transcriber.transcribe(manifest, videoPath, { translate: true },
      (pct) => sendProgress('translate', pct, 'Whisper offline translation…'), 'translate');
    return { cues: r.cues };
  }
  const provider = translateReg.getTextProvider(providerId);
  if (!provider) throw new Error('Unknown translation provider: ' + providerId);
  const texts = await provider.translate(cues, targetCode, settings.get(),
    (pct) => sendProgress('translate', pct, 'Translating…'), srcCode);
  return { texts };
});

ipcMain.handle('save-text', async (_evt, { text, suggestedName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save subtitles',
    defaultPath: suggestedName || 'subtitles.srt',
    filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, BOM + text, 'utf8');
  return res.filePath;
});

// "Save all": write name.<lang>.srt next to the video, no dialogs.
ipcMain.handle('save-srt-bundle', async (_evt, { videoPath, files }) => {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
  const written = [];
  for (const f of files) {
    const p = path.join(dir, base + '.' + f.code + '.srt');
    await fs.writeFile(p, BOM + f.text, 'utf8');
    written.push(p);
  }
  return written;
});

ipcMain.handle('mux-subtitles', async (_evt, { videoPath, tracks, suggestedName }) => {
  const manifest = tools.loadManifest();
  if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save video with subtitle tracks',
    defaultPath: suggestedName || 'with-subs.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return exporter.muxSubtitles(manifest, videoPath, tracks, res.filePath,
    (pct) => sendProgress('mux', pct, 'Embedding subtitle tracks…'), 'mux');
});

ipcMain.handle('burn-subtitles', async (_evt, { videoPath, text, duration, suggestedName }) => {
  const manifest = tools.loadManifest();
  if (!manifest.ok) throw new Error('Tools missing — run: npm run setup');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save video with burned-in subtitles',
    defaultPath: suggestedName || 'burned.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return exporter.burnSubtitles(manifest, videoPath, text, res.filePath,
    { duration, useNvenc: settings.get().useNvenc },
    (pct) => sendProgress('burn', pct, 'Burning subtitles…'), 'burn');
});

ipcMain.handle('get-settings', () => settings.getSanitized());
ipcMain.handle('set-settings', (_evt, patch) => settings.set(patch));

ipcMain.handle('cancel-job', (_evt, jobId) => tools.cancelJob(jobId));
