'use strict';
/*
 * transcribe.js — local speech-to-text via whisper.cpp. Extracts a 16 kHz mono
 * WAV with ffmpeg, runs whisper-cli with JSON output, and returns cues.
 * Audio never leaves the machine.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ops = require('../src/videoOps.js');
const tools = require('./tools.js');

async function extractWav(manifest, video, jobId) {
  const wav = path.join(os.tmpdir(), 'video-editor-' + Date.now() + '.wav');
  const r = await tools.run(manifest.ffmpeg, ops.buildAudioExtractArgs(video, wav), { jobId });
  if (r.killed) throw new Error('cancelled');
  if (r.code !== 0) throw new Error('audio extraction failed: ' + r.stderr.slice(0, 400));
  return wav;
}

/*
 * opts: { translate: false, language: 'auto' }
 * translate=true uses Whisper's built-in any→English task, which needs the
 * full large-v3 model (the turbo model doesn't support translation).
 */
async function transcribe(manifest, video, opts, onProgress, jobId) {
  const o = opts || {};
  const model = o.translate
    ? (manifest.models && manifest.models.full)
    : (manifest.models && manifest.models.turbo);
  if (!model) {
    throw new Error(o.translate
      ? 'Offline translation needs ggml-large-v3.bin — run: npm run setup -- --full-model'
      : 'Speech model missing — run: npm run setup');
  }
  const wav = await extractWav(manifest, video, jobId);
  const outBase = path.join(os.tmpdir(), 'video-editor-whisper-' + Date.now());
  const args = ['-m', model, '-f', wav, '-l', o.language || 'auto',
    '-oj', '-of', outBase, '--print-progress'];
  if (o.translate) args.push('--translate');
  try {
    const r = await tools.run(manifest.whisperExe, args, {
      jobId,
      onStderr: (t) => {
        if (!onProgress) return;
        // whisper --print-progress logs "progress = NN%"
        const m = String(t).match(/progress\s*=\s*(\d+)%/g);
        if (m) {
          const last = m[m.length - 1].match(/(\d+)%/);
          if (last) onProgress(Math.min(1, parseInt(last[1], 10) / 100));
        }
      },
    });
    if (r.killed) throw new Error('cancelled');
    if (r.code !== 0) throw new Error('whisper failed: ' + (r.stderr || '').slice(-600));
    const json = JSON.parse(await fs.readFile(outBase + '.json', 'utf8'));
    const { cues, language } = ops.whisperJsonToCues(json);
    return { cues: ops.sanitizeCues(cues), language: o.translate ? 'en' : language };
  } finally {
    fs.unlink(wav).catch(() => {});
    fs.unlink(outBase + '.json').catch(() => {});
  }
}

module.exports = { transcribe };
