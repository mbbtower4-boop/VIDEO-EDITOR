'use strict';
/*
 * analyze.js — ffprobe metadata, waveform peak extraction, and the
 * silence/freeze detection pass. Main-process only; all pure logic lives in
 * src/videoOps.js.
 */
const ops = require('../src/videoOps.js');
const tools = require('./tools.js');

async function probe(manifest, file) {
  const r = await tools.run(manifest.ffprobe, ops.buildProbeArgs(file));
  if (r.code !== 0) throw new Error('ffprobe failed: ' + r.stderr.slice(0, 400));
  const json = JSON.parse(r.stdout);
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = parseFloat((json.format && json.format.duration) ||
    (v && v.duration) || (a && a.duration) || 0);
  let fps = null;
  if (v && v.r_frame_rate) {
    const [num, den] = v.r_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  }
  return {
    duration,
    hasVideo: !!v,
    hasAudio: !!a,
    width: v ? v.width : null,
    height: v ? v.height : null,
    fps,
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    sizeBytes: json.format ? parseInt(json.format.size || 0, 10) : 0,
  };
}

// Decode the audio track to 8 kHz mono s16le and reduce to canvas-ready peaks.
async function waveform(manifest, file, buckets, jobId) {
  const r = await tools.run(manifest.ffmpeg, ops.buildWaveformArgs(file),
    { binaryStdout: true, jobId });
  if (r.killed) throw new Error('cancelled');
  if (r.code !== 0) throw new Error('waveform extraction failed: ' + r.stderr.slice(0, 400));
  const buf = r.stdout;
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const peaks = ops.computePeaks(samples, buckets);
  return { min: Array.from(peaks.min), max: Array.from(peaks.max) };
}

// One ffmpeg pass with silencedetect + freezedetect. Detection lines land on
// stderr; -progress key=value blocks land on stdout for the progress bar.
async function detect(manifest, file, opts, onProgress, jobId) {
  let stderrAll = '';
  const r = await tools.run(manifest.ffmpeg, ops.buildDetectArgs(file, opts), {
    jobId,
    onStderr: (t) => { stderrAll += t; },
    onStdout: (t) => {
      if (!onProgress) return;
      const p = ops.parseProgress(t);
      if (p.timeSec != null && opts.duration) {
        onProgress(Math.min(1, p.timeSec / opts.duration));
      }
    },
  });
  if (r.killed) throw new Error('cancelled');
  if (r.code !== 0) throw new Error('detection failed: ' + r.stderr.slice(0, 400));
  return {
    silences: ops.parseSilence(stderrAll, opts.duration),
    freezes: ops.parseFreeze(stderrAll, opts.duration),
  };
}

module.exports = { probe, waveform, detect };
