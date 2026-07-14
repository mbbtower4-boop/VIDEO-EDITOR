/*
 * videoOps.js — the pure-logic engine of VIDEO EDITOR.
 *
 * Everything here is deterministic and dependency-free: parsing ffmpeg
 * detection output, segment math for cuts/keeps, waveform peak computation,
 * ffmpeg argument builders (build only — never spawn), SRT handling, and the
 * text plumbing for subtitle translation. It runs both in the renderer
 * (as window.VideoOps) and under plain Node for tests (npm test).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VideoOps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- detection-output parsing ---------------------------------------------
  // Segments are always plain {start, end} objects in seconds, start < end.

  // silencedetect logs "silence_start: X" then "silence_end: Y | silence_duration: Z".
  // A silence still open at end-of-file has no silence_end line — close it at
  // `duration` when provided.
  function parseSilence(stderr, duration) {
    const out = [];
    let open = null;
    for (const line of String(stderr).split(/\r?\n/)) {
      let m = line.match(/silence_start:\s*(-?[\d.]+)/);
      if (m) { open = Math.max(0, parseFloat(m[1])); continue; }
      m = line.match(/silence_end:\s*(-?[\d.]+)/);
      if (m && open !== null) {
        const end = parseFloat(m[1]);
        if (end > open) out.push({ start: open, end });
        open = null;
      }
    }
    if (open !== null && duration != null && duration > open) {
      out.push({ start: open, end: duration });
    }
    return out;
  }

  // freezedetect logs "lavfi.freezedetect.freeze_start: X" / "...freeze_end: Y".
  function parseFreeze(stderr, duration) {
    const out = [];
    let open = null;
    for (const line of String(stderr).split(/\r?\n/)) {
      let m = line.match(/freezedetect\.freeze_start:\s*(-?[\d.]+)/);
      if (m) { open = Math.max(0, parseFloat(m[1])); continue; }
      m = line.match(/freezedetect\.freeze_end:\s*(-?[\d.]+)/);
      if (m && open !== null) {
        const end = parseFloat(m[1]);
        if (end > open) out.push({ start: open, end });
        open = null;
      }
    }
    if (open !== null && duration != null && duration > open) {
      out.push({ start: open, end: duration });
    }
    return out;
  }

  // ---- segment math -----------------------------------------------------------

  function sortSegments(segs) {
    return segs.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // Merge overlapping segments; `gap` also merges segments closer than gap seconds.
  function mergeSegments(segs, gap) {
    gap = gap || 0;
    const sorted = sortSegments(segs);
    const out = [];
    for (const s of sorted) {
      const last = out[out.length - 1];
      if (last && s.start <= last.end + gap) last.end = Math.max(last.end, s.end);
      else out.push({ start: s.start, end: s.end });
    }
    return out;
  }

  function intersectSegments(a, b) {
    const A = mergeSegments(a), B = mergeSegments(b);
    const out = [];
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      const start = Math.max(A[i].start, B[j].start);
      const end = Math.min(A[i].end, B[j].end);
      if (end > start) out.push({ start, end });
      if (A[i].end < B[j].end) i++; else j++;
    }
    return out;
  }

  function unionSegments(a, b) {
    return mergeSegments(a.concat(b));
  }

  // Shrink each silence inward so a little of it is kept around speech:
  // `leadKeep` seconds survive at the segment start (right after speech ends),
  // `tailKeep` seconds survive at the segment end (right before speech resumes).
  function applyPadding(segs, leadKeep, tailKeep) {
    const out = [];
    for (const s of segs) {
      const start = s.start + (leadKeep || 0);
      const end = s.end - (tailKeep || 0);
      if (end > start) out.push({ start, end });
    }
    return out;
  }

  function filterMinDuration(segs, min) {
    return segs.filter((s) => s.end - s.start >= (min || 0));
  }

  function clampSegments(segs, duration) {
    const out = [];
    for (const s of segs) {
      const start = Math.max(0, s.start);
      const end = Math.min(duration, s.end);
      if (end > start) out.push({ start, end });
    }
    return out;
  }

  // Derive the proposed cut list from raw detections + user parameters.
  // mode: 'silence' | 'freeze' | 'both' ('both' = silent AND frozen — the
  // conservative intersection, so slides with narration are never cut).
  function proposeCuts(opts) {
    const silences = mergeSegments(opts.silences || []);
    const freezes = mergeSegments(opts.freezes || []);
    let base;
    if (opts.mode === 'freeze') base = freezes;
    else if (opts.mode === 'both') base = intersectSegments(silences, freezes);
    else base = silences;
    let cuts = clampSegments(base, opts.duration);
    cuts = applyPadding(cuts, opts.padLead, opts.padTail);
    cuts = filterMinDuration(cuts, opts.minCut);
    return mergeSegments(cuts);
  }

  // Complement of the cuts inside [0, duration] — what the export keeps.
  // Keeps shorter than minKeep are dropped (absorbed into the surrounding cut)
  // to avoid single-frame blips between two cuts.
  function invertToKeeps(cuts, duration, minKeep) {
    const merged = mergeSegments(clampSegments(cuts, duration));
    const keeps = [];
    let pos = 0;
    for (const c of merged) {
      if (c.start > pos) keeps.push({ start: pos, end: c.start });
      pos = c.end;
    }
    if (pos < duration) keeps.push({ start: pos, end: duration });
    const filtered = keeps.filter((k) => k.end - k.start >= (minKeep || 0));
    if (!filtered.length) throw new Error('These cuts would remove the entire video.');
    return filtered;
  }

  function totalDuration(segs) {
    return segs.reduce((sum, s) => sum + (s.end - s.start), 0);
  }

  // Map a source-video time to the time it lands at in the exported video.
  // Times inside a removed region map to the moment the region collapses to.
  function remapTime(t, keeps) {
    let out = 0;
    for (const k of keeps) {
      if (t < k.start) return out;
      if (t <= k.end) return out + (t - k.start);
      out += k.end - k.start;
    }
    return out;
  }

  // ---- waveform ---------------------------------------------------------------

  // Downsample raw s16le mono PCM into per-bucket min/max envelopes (normalized
  // to [-1, 1]) for canvas drawing. `samples` is an Int16Array (or array-like).
  function computePeaks(samples, buckets) {
    const n = samples.length;
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    if (!n) return { min, max };
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor((b * n) / buckets);
      const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
      let lo = 32767, hi = -32768;
      for (let i = from; i < to && i < n; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo / 32768;
      max[b] = hi / 32768;
    }
    return { min, max };
  }

  // ---- ffmpeg argument builders (never spawn from here) ------------------------

  function fmtSec(x) { return x.toFixed(3); }

  function buildProbeArgs(input) {
    return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
  }

  // 8 kHz mono s16le to stdout — cheap to decode, plenty for a waveform.
  function buildWaveformArgs(input) {
    return ['-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-'];
  }

  // Single analysis pass: silencedetect on audio + freezedetect on video.
  // Detection lines arrive on stderr (default loglevel), progress on stdout.
  function buildDetectArgs(input, opts) {
    const o = opts || {};
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', input];
    if (o.hasAudio !== false) {
      args.push('-af', 'silencedetect=noise=' + (o.noiseDb != null ? o.noiseDb : -35) +
        'dB:d=' + (o.minSilence != null ? o.minSilence : 1));
    }
    if (o.hasVideo !== false) {
      args.push('-vf', 'freezedetect=n=' + (o.freezeNoise != null ? o.freezeNoise : -60) +
        'dB:d=' + (o.freezeDur != null ? o.freezeDur : 2));
    }
    args.push('-f', 'null', '-');
    return args;
  }

  // trim/atrim + concat filtergraph, returned as filter-script TEXT. The caller
  // writes it to a temp file and passes -filter_complex_script — a long cut list
  // would blow past the Windows 32 KB command-line limit otherwise.
  function buildExportFilter(keeps, hasAudio) {
    if (!keeps || !keeps.length) throw new Error('No segments to keep.');
    const audio = hasAudio !== false;
    const parts = [];
    keeps.forEach((k, i) => {
      parts.push('[0:v]trim=start=' + fmtSec(k.start) + ':end=' + fmtSec(k.end) +
        ',setpts=PTS-STARTPTS[v' + i + ']');
      if (audio) {
        parts.push('[0:a]atrim=start=' + fmtSec(k.start) + ':end=' + fmtSec(k.end) +
          ',asetpts=PTS-STARTPTS[a' + i + ']');
      }
    });
    const refs = keeps.map((_, i) => (audio ? '[v' + i + '][a' + i + ']' : '[v' + i + ']')).join('');
    parts.push(refs + 'concat=n=' + keeps.length + ':v=1:a=' + (audio ? 1 : 0) +
      '[v]' + (audio ? '[a]' : ''));
    return parts.join(';\n');
  }

  function buildExportArgs(input, output, opts) {
    const o = opts || {};
    const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', input,
      '-filter_complex_script', o.filterScript, '-map', '[v]'];
    if (o.hasAudio !== false) args.push('-map', '[a]');
    if (o.useNvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
    if (o.hasAudio !== false) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart', output);
    return args;
  }

  // 16 kHz mono WAV — exactly what whisper.cpp wants.
  function buildAudioExtractArgs(input, wavOut) {
    return ['-y', '-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1',
      '-ar', '16000', '-c:a', 'pcm_s16le', wavOut];
  }

  // Soft subtitles: copy streams, add each SRT as a mov_text track with
  // language + title metadata so players show a proper track menu.
  function buildMuxArgs(video, tracks, output) {
    const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', video];
    for (const t of tracks) args.push('-i', t.path);
    args.push('-map', '0:v', '-map', '0:a?');
    tracks.forEach((_, i) => args.push('-map', String(i + 1) + ':0'));
    args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text');
    tracks.forEach((t, i) => {
      args.push('-metadata:s:s:' + i, 'language=' + t.iso3);
      args.push('-metadata:s:s:' + i, 'title=' + t.title);
    });
    args.push(output);
    return args;
  }

  // ffmpeg filter-option escaping for a Windows path used inside subtitles=…
  // Backslashes become '/', the drive colon needs a backslash, and the whole
  // value is single-quoted at the filter level.
  function escapeFilterPath(p) {
    return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  }

  function buildBurnArgs(video, srtPath, output, opts) {
    const o = opts || {};
    const font = o.fontName || 'Segoe UI';
    const vf = "subtitles=filename='" + escapeFilterPath(srtPath) +
      "':force_style='FontName=" + font + "'";
    const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', video,
      '-vf', vf];
    if (o.useNvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
    args.push('-c:a', 'copy', '-movflags', '+faststart', output);
    return args;
  }

  // Parse a block of `-progress pipe:1` output; returns the latest values seen.
  // Note: ffmpeg's out_time_ms is actually MICROseconds (long-standing quirk).
  function parseProgress(text) {
    const res = { timeSec: null, speed: null, done: false };
    for (const line of String(text).split(/\r?\n/)) {
      let m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) { res.timeSec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]); continue; }
      m = line.match(/^out_time_ms=(\d+)/);
      if (m && res.timeSec === null) { res.timeSec = (+m[1]) / 1e6; continue; }
      m = line.match(/^speed=\s*([\d.]+)x/);
      if (m) { res.speed = +m[1]; continue; }
      if (/^progress=end/.test(line)) res.done = true;
    }
    return res;
  }

  // ---- SRT / transcript ---------------------------------------------------------

  function formatTimestamp(sec) {
    if (!(sec >= 0)) sec = 0;
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const frac = ms % 1000;
    const p = (n, w) => String(n).padStart(w, '0');
    return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(frac, 3);
  }

  function parseTimestamp(str) {
    const m = String(str).trim().match(/^(\d+):(\d+):(\d+)[,.](\d{1,3})$/);
    if (!m) throw new Error('Bad SRT timestamp: ' + str);
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  }

  function serializeSrt(cues) {
    const blocks = cues.map((c, i) =>
      (i + 1) + '\r\n' +
      formatTimestamp(c.start) + ' --> ' + formatTimestamp(c.end) + '\r\n' +
      String(c.text).trim());
    return blocks.join('\r\n\r\n') + '\r\n';
  }

  function parseSrt(text) {
    const cues = [];
    const blocks = String(text).replace(/^﻿/, '').split(/\r?\n\r?\n+/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      let idx = 0;
      if (/^\d+$/.test(lines[0].trim())) idx = 1; // sequence number line
      const tm = lines[idx] && lines[idx].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
      if (!tm) continue;
      const text2 = lines.slice(idx + 1).join('\n').trim();
      cues.push({ start: parseTimestamp(tm[1]), end: parseTimestamp(tm[2]), text: text2 });
    }
    return cues;
  }

  // whisper-cli -oj output → cues + detected language.
  function whisperJsonToCues(json) {
    const segs = json.transcription || [];
    const cues = [];
    for (const s of segs) {
      const text = String(s.text || '').trim();
      if (!text) continue;
      let start, end;
      if (s.offsets) { start = s.offsets.from / 1000; end = s.offsets.to / 1000; }
      else { start = parseTimestamp(s.timestamps.from); end = parseTimestamp(s.timestamps.to); }
      cues.push({ start, end, text });
    }
    const language = (json.result && json.result.language) ||
      (json.params && json.params.language) || null;
    return { cues, language };
  }

  // Trim text, drop empties, resolve overlaps, enforce a minimum display time.
  function sanitizeCues(cues, opts) {
    const minDur = (opts && opts.minDur) != null ? opts.minDur : 0.3;
    const out = [];
    for (const c of cues) {
      const text = String(c.text).trim();
      if (!text || !(c.end > c.start)) continue;
      out.push({ start: c.start, end: c.end, text });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const next = out[i + 1];
      if (next && out[i].end > next.start) out[i].end = next.start;
      if (out[i].end - out[i].start < minDur) {
        const limit = next ? next.start : Infinity;
        out[i].end = Math.min(out[i].start + minDur, limit);
      }
    }
    return out.filter((c) => c.end > c.start);
  }

  // ---- translation plumbing (pure text side) --------------------------------------

  const LANGS = [
    { code: 'he', iso3: 'heb', name: 'Hebrew', rtl: true },
    { code: 'en', iso3: 'eng', name: 'English', rtl: false },
    { code: 'ru', iso3: 'rus', name: 'Russian', rtl: false },
    { code: 'be', iso3: 'bel', name: 'Belarusian', rtl: false },
  ];

  function langByCode(code) {
    return LANGS.find((l) => l.code === code) || null;
  }

  // Which target languages each provider can produce. Providers themselves live
  // in lib/translate/ (main process); this matrix is UI/pure logic.
  const PROVIDERS = [
    { id: 'claude', label: 'Claude API', offline: false, needsKey: true, targets: ['he', 'en', 'ru', 'be'] },
    { id: 'mymemory', label: 'MyMemory (free web)', offline: false, needsKey: false, targets: ['he', 'en', 'ru', 'be'] },
    { id: 'whisperEn', label: 'Whisper offline (English only)', offline: true, needsKey: false, targets: ['en'] },
  ];

  function providerSupports(providerId, code) {
    const p = PROVIDERS.find((x) => x.id === providerId);
    return !!p && p.targets.includes(code);
  }

  // Split cues into translation batches, preserving original indices so replies
  // can be written back even if some chunks fail.
  function chunkCuesForTranslation(cues, opts) {
    const maxChars = (opts && opts.maxChars) || 3500;
    const maxLines = (opts && opts.maxLines) || 25;
    const chunks = [];
    let cur = { indices: [], lines: [], chars: 0 };
    cues.forEach((c, i) => {
      const line = String(c.text).replace(/\s+/g, ' ').trim();
      if (cur.lines.length && (cur.lines.length >= maxLines || cur.chars + line.length > maxChars)) {
        chunks.push(cur);
        cur = { indices: [], lines: [], chars: 0 };
      }
      cur.indices.push(i);
      cur.lines.push(line);
      cur.chars += line.length;
    });
    if (cur.lines.length) chunks.push(cur);
    return chunks;
  }

  function buildClaudePrompt(lines, targetLangName) {
    return 'Translate the following numbered subtitle lines into ' + targetLangName + '.\n' +
      'Rules: reply with ONLY the translated lines, using the exact same numbering ' +
      '(one line per number, same count). Keep the tone natural and concise like ' +
      'real subtitles. Do not add explanations, notes, or extra lines.\n\n' +
      lines.map((l, i) => (i + 1) + '. ' + l).join('\n');
  }

  // Parse a numbered reply back into an array aligned with the request lines.
  function parseNumberedResponse(text, expectedCount) {
    const out = [];
    let curIdx = null, curText = [];
    const flush = () => {
      if (curIdx !== null) out[curIdx] = curText.join(' ').trim();
      curIdx = null; curText = [];
    };
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)[.)]\s*(.*)$/);
      if (m) {
        flush();
        curIdx = parseInt(m[1], 10) - 1;
        curText = [m[2]];
      } else if (curIdx !== null) {
        curText.push(line); // continuation of a wrapped line
      }
    }
    flush();
    const got = out.filter((x) => x !== undefined && x !== '').length;
    if (got !== expectedCount) {
      throw new Error('Translation reply had ' + got + ' lines, expected ' + expectedCount);
    }
    return out;
  }

  return {
    parseSilence, parseFreeze,
    sortSegments, mergeSegments, intersectSegments, unionSegments,
    applyPadding, filterMinDuration, clampSegments,
    proposeCuts, invertToKeeps, totalDuration, remapTime,
    computePeaks,
    buildProbeArgs, buildWaveformArgs, buildDetectArgs,
    buildExportFilter, buildExportArgs, buildAudioExtractArgs,
    buildMuxArgs, buildBurnArgs, escapeFilterPath, parseProgress,
    formatTimestamp, parseTimestamp, serializeSrt, parseSrt,
    whisperJsonToCues, sanitizeCues,
    LANGS, langByCode, PROVIDERS, providerSupports,
    chunkCuesForTranslation, buildClaudePrompt, parseNumberedResponse,
  };
});
