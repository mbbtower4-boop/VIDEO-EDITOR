'use strict';
/*
 * exporter.js — runs the cut/concat re-encode, subtitle soft-mux and burn-in.
 * NVENC is tried first when the manifest says it's available; a fast NVENC
 * failure automatically retries once with libx264.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ops = require('../src/videoOps.js');
const tools = require('./tools.js');

async function tempFile(name, content) {
  const p = path.join(os.tmpdir(), 'video-editor-' + Date.now() + '-' + name);
  await fs.writeFile(p, content, 'utf8');
  return p;
}

function progressRelay(onProgress, outDuration) {
  return (t) => {
    if (!onProgress) return;
    const p = ops.parseProgress(t);
    if (p.timeSec != null && outDuration) {
      onProgress(Math.min(1, p.timeSec / outDuration), p.speed);
    }
  };
}

async function runEncode(manifest, args, onStdout, jobId) {
  const r = await tools.run(manifest.ffmpeg, args, { jobId, onStdout });
  if (r.killed) throw new Error('cancelled');
  return r;
}

// Cut out the removed segments and re-encode. keeps = [{start, end}] seconds.
async function exportVideo(manifest, input, keeps, output, opts, onProgress, jobId) {
  const o = opts || {};
  const filterScript = await tempFile('filter.txt', ops.buildExportFilter(keeps, o.hasAudio));
  const outDuration = ops.totalDuration(keeps);
  const relay = progressRelay(onProgress, outDuration);
  try {
    let useNvenc = o.useNvenc !== false && manifest.nvenc;
    let r = await runEncode(manifest,
      ops.buildExportArgs(input, output, { filterScript, useNvenc, hasAudio: o.hasAudio }),
      relay, jobId);
    if (r.code !== 0 && useNvenc) {
      // Driver/session NVENC failures happen; the CPU encoder always works.
      useNvenc = false;
      r = await runEncode(manifest,
        ops.buildExportArgs(input, output, { filterScript, useNvenc, hasAudio: o.hasAudio }),
        relay, jobId);
      if (r.code === 0) return { outPath: output, usedNvenc: false, nvencFellBack: true };
    }
    if (r.code !== 0) throw new Error('export failed: ' + r.stderr.slice(-600));
    return { outPath: output, usedNvenc: useNvenc, nvencFellBack: false };
  } finally {
    fs.unlink(filterScript).catch(() => {});
  }
}

// Soft subtitles: tracks = [{text, iso3, title, code}], written to temp .srt files.
async function muxSubtitles(manifest, video, tracks, output, onProgress, jobId) {
  const files = [];
  for (const t of tracks) {
    // BOM so picky Windows players detect UTF-8
    files.push({ path: await tempFile(t.code + '.srt', '\uFEFF' + t.text), iso3: t.iso3, title: t.title });
  }
  try {
    const r = await tools.run(manifest.ffmpeg, ops.buildMuxArgs(video, files, output),
      { jobId, onStdout: progressRelay(onProgress, 0) });
    if (r.killed) throw new Error('cancelled');
    if (r.code !== 0) throw new Error('subtitle mux failed: ' + r.stderr.slice(-600));
    return { outPath: output };
  } finally {
    for (const f of files) fs.unlink(f.path).catch(() => {});
  }
}

// Burn one language into the picture (re-encode).
async function burnSubtitles(manifest, video, srtText, output, opts, onProgress, jobId) {
  const o = opts || {};
  const srtPath = await tempFile('burn.srt', '\uFEFF' + srtText);
  const relay = progressRelay(onProgress, o.duration);
  try {
    let useNvenc = o.useNvenc !== false && manifest.nvenc;
    let r = await runEncode(manifest,
      ops.buildBurnArgs(video, srtPath, output, { useNvenc }), relay, jobId);
    if (r.code !== 0 && useNvenc) {
      r = await runEncode(manifest,
        ops.buildBurnArgs(video, srtPath, output, { useNvenc: false }), relay, jobId);
    }
    if (r.code !== 0) throw new Error('burn-in failed: ' + r.stderr.slice(-600));
    return { outPath: output };
  } finally {
    fs.unlink(srtPath).catch(() => {});
  }
}

module.exports = { exportVideo, muxSubtitles, burnSubtitles };
