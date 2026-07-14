'use strict';
/*
 * verify.js — headless end-to-end check of the whole pipeline, no UI needed.
 * Run AFTER `npm run setup`:
 *
 *   node scripts/verify.js [path\to\video.mp4]
 *
 * It probes the video, detects silence/freezes, cuts the dead time into a temp
 * MP4, verifies the output duration, and transcribes the result. Nothing is
 * written next to your files — everything goes to the system temp directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../src/videoOps.js');
const tools = require('../lib/tools.js');
const analyze = require('../lib/analyze.js');
const exporter = require('../lib/exporter.js');
const transcriber = require('../lib/transcribe.js');

function pickDefaultSample() {
  const dir = path.join(__dirname, '..', 'samples');
  if (!fs.existsSync(dir)) return null;
  const vids = fs.readdirSync(dir).filter((f) => /\.mp4$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  return vids[0] || null; // smallest = fastest check
}

(async () => {
  const input = process.argv[2] || pickDefaultSample();
  if (!input) { console.error('No video given and no samples/ folder found.'); process.exit(1); }

  const manifest = tools.loadManifest();
  if (!manifest.ok) { console.error('Tools missing — run: npm run setup'); process.exit(1); }
  console.log('tools:   ffmpeg ok, whisper backend = ' + manifest.whisperBackend +
    ', nvenc = ' + manifest.nvenc);

  console.log('input:   ' + input);
  const probe = await analyze.probe(manifest, input);
  console.log('probe:   ' + probe.duration.toFixed(1) + 's, ' + probe.width + 'x' + probe.height +
    ', audio: ' + probe.hasAudio);

  console.log('detect:  running silencedetect + freezedetect…');
  const det = await analyze.detect(manifest, input, {
    duration: probe.duration, hasAudio: probe.hasAudio, hasVideo: probe.hasVideo,
    noiseDb: -35, minSilence: 0.3, freezeNoise: -60, freezeDur: 2,
  });
  console.log('detect:  ' + det.silences.length + ' silences, ' + det.freezes.length + ' freezes');

  const cuts = ops.proposeCuts({
    silences: det.silences, freezes: det.freezes, mode: 'silence',
    padLead: 0.25, padTail: 0.25, minCut: 0.8, duration: probe.duration,
  });
  const removed = ops.totalDuration(cuts);
  console.log('cuts:    ' + cuts.length + ' segments, removing ' + removed.toFixed(1) + 's (' +
    (removed / probe.duration * 100).toFixed(1) + '%)');

  let target = input;
  if (cuts.length) {
    const keeps = ops.invertToKeeps(cuts, probe.duration, 0.3);
    const out = path.join(os.tmpdir(), 'video-editor-verify.mp4');
    console.log('export:  encoding ' + keeps.length + ' kept segments → ' + out);
    const t0 = Date.now();
    const res = await exporter.exportVideo(manifest, input, keeps, out, { hasAudio: probe.hasAudio },
      (pct, speed) => process.stdout.write('\rexport:  ' + Math.round(pct * 100) + '%' +
        (speed ? ' @ ' + speed.toFixed(1) + 'x' : '') + '   '));
    console.log('\nexport:  done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's (nvenc: ' +
      res.usedNvenc + ')');
    const outProbe = await analyze.probe(manifest, out);
    const expected = ops.totalDuration(keeps);
    const diff = Math.abs(outProbe.duration - expected);
    console.log('verify:  output ' + outProbe.duration.toFixed(2) + 's, expected ' +
      expected.toFixed(2) + 's (diff ' + diff.toFixed(2) + 's) ' + (diff < 1 ? 'OK' : 'SUSPICIOUS'));
    target = out;
  } else {
    console.log('export:  skipped (no cuts proposed for this video)');
  }

  console.log('whisper: transcribing trimmed video (' + manifest.whisperBackend + ')…');
  const t1 = Date.now();
  const tr = await transcriber.transcribe(manifest, target, {},
    (pct) => process.stdout.write('\rwhisper: ' + Math.round(pct * 100) + '%   '));
  console.log('\nwhisper: done in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's — language: ' +
    tr.language + ', ' + tr.cues.length + ' lines');
  for (const c of tr.cues.slice(0, 5)) {
    console.log('   [' + ops.formatTimestamp(c.start) + '] ' + c.text);
  }
  console.log('\nAll pipeline stages OK.');
})().catch((err) => { console.error('\nVERIFY FAILED: ' + err.message); process.exit(1); });
