'use strict';
/*
 * app.js — all UI logic. Pure calculations live in videoOps.js; anything that
 * touches disk, network or a subprocess goes through window.api to main.
 */
/* global VideoOps */
const ops = window.VideoOps;

// ---- state ---------------------------------------------------------------------

const state = {
  videoPath: null,
  name: null,
  probe: null,
  toolsOk: false,
  peaks: null,          // {min:[], max:[]} 4096 buckets over the whole file
  rawSilences: [],
  rawFreezes: [],
  analyzed: false,
  cuts: [],             // [{id, start, end, enabled, source:'auto'|'manual'}]
  cutSeq: 0,
  cues: null,           // original-language cues from whisper
  srcLang: null,        // detected language code
  translations: {},     // lang code -> {texts:[…]} or {cues:[…]}
  tab: 'orig',
  subsTarget: null,     // video the subtitles belong to (trimmed export if made)
  subsTargetDuration: null,
  settings: null,
  zoom: 1,
  viewStart: 0,
  busy: null,           // jobId of the running job
  needsReanalyze: false,
};

const els = {};
for (const id of ['version', 'btnOpen', 'btnAnalyze', 'btnExport', 'btnSettings', 'fileInfo',
  'toolsBanner', 'toolsDetail', 'progressBar', 'progressFill', 'progressText', 'btnCancel',
  'video', 'dropHint', 'btnPlay', 'btnBack5', 'btnFwd5', 'chkSkipCuts', 'timeReadout',
  'statsReadout', 'tlCanvas', 'selMode', 'inNoiseDb', 'noiseDbVal', 'inPadLead', 'inPadTail',
  'inMinCut', 'inFreezeNoise', 'inFreezeDur', 'btnReanalyze', 'btnTranscribe', 'langTabs',
  'selProvider', 'btnTranslate', 'cueList', 'btnSaveSrt', 'btnSaveAll', 'btnMux', 'btnBurn',
  'settingsModal', 'setProvider', 'setClaudeKey', 'setClaudeModel', 'setMyMemoryEmail',
  'setUseNvenc', 'btnSettingsCancel', 'btnSettingsSave', 'toast']) {
  els[id] = document.getElementById(id);
}

// ---- small helpers ---------------------------------------------------------------

function fmtTime(sec) {
  if (!(sec >= 0)) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

let toastTimer = null;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.className = isError ? 'error' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), isError ? 8000 : 4000);
}

function enabledCuts() { return state.cuts.filter((c) => c.enabled); }

function currentKeeps() {
  return ops.invertToKeeps(enabledCuts(), state.probe.duration, 0.3);
}

// ---- progress / jobs ---------------------------------------------------------------

async function withJob(jobId, label, fn) {
  if (state.busy) { toast('Another job is running — cancel it first.', true); return null; }
  state.busy = jobId;
  els.progressBar.classList.remove('hidden');
  els.progressFill.style.width = '0%';
  els.progressText.textContent = label;
  try {
    return await fn();
  } catch (err) {
    if (!/cancelled/.test(String(err.message))) toast(String(err.message), true);
    return null;
  } finally {
    state.busy = null;
    els.progressBar.classList.add('hidden');
  }
}

window.api.onProgress(({ jobId, pct, detail }) => {
  if (jobId !== state.busy) return;
  els.progressFill.style.width = Math.round(pct * 100) + '%';
  if (detail) els.progressText.textContent = detail + ' ' + Math.round(pct * 100) + '%';
});

els.btnCancel.onclick = () => { if (state.busy) window.api.cancelJob(state.busy); };

// ---- detection parameters ------------------------------------------------------------

function readParams() {
  return {
    mode: els.selMode.value,
    noiseDb: +els.inNoiseDb.value,
    padLead: +els.inPadLead.value,
    padTail: +els.inPadTail.value,
    minCut: +els.inMinCut.value,
    freezeNoise: +els.inFreezeNoise.value,
    freezeDur: +els.inFreezeDur.value,
  };
}

function fillParams(s) {
  els.selMode.value = s.mode;
  els.inNoiseDb.value = s.noiseDb;
  els.noiseDbVal.textContent = s.noiseDb + ' dB';
  els.inPadLead.value = s.padLead;
  els.inPadTail.value = s.padTail;
  els.inMinCut.value = s.minCut;
  els.inFreezeNoise.value = s.freezeNoise;
  els.inFreezeDur.value = s.freezeDur;
}

// Params that only change the derivation recompute instantly from the cached
// raw detections; threshold-style params need another ffmpeg pass.
for (const el of [els.selMode, els.inPadLead, els.inPadTail, els.inMinCut]) {
  el.addEventListener('change', () => { persistParams(); deriveCuts(); });
}
els.inNoiseDb.addEventListener('input', () => {
  els.noiseDbVal.textContent = els.inNoiseDb.value + ' dB';
});
for (const el of [els.inNoiseDb, els.inFreezeNoise, els.inFreezeDur]) {
  el.addEventListener('change', () => {
    persistParams();
    if (state.analyzed) {
      state.needsReanalyze = true;
      els.btnReanalyze.disabled = false;
    }
  });
}

function persistParams() {
  window.api.setSettings(readParams()).then((s) => { state.settings = s; });
}

function deriveCuts() {
  if (!state.analyzed) return;
  const p = readParams();
  const auto = ops.proposeCuts({
    silences: state.rawSilences,
    freezes: state.rawFreezes,
    mode: state.probe.hasAudio ? p.mode : 'freeze',
    padLead: p.padLead,
    padTail: p.padTail,
    minCut: p.minCut,
    duration: state.probe.duration,
  }).map((c) => ({ id: 'c' + (++state.cutSeq), start: c.start, end: c.end, enabled: true, source: 'auto' }));
  const manual = state.cuts.filter((c) => c.source === 'manual');
  state.cuts = ops.sortSegments(auto.concat(manual));
  refreshStats();
  draw();
}

function refreshStats() {
  const dur = state.probe ? state.probe.duration : 0;
  const cut = ops.totalDuration(ops.mergeSegments(enabledCuts()));
  els.statsReadout.textContent = cut
    ? `Will remove ${fmtTime(cut)} of ${fmtTime(dur)} (${(cut / dur * 100).toFixed(1)}%)`
    : '';
  els.btnExport.disabled = !(state.analyzed && cut > 0);
}

// ---- open / analyze -----------------------------------------------------------------

els.btnOpen.onclick = async () => {
  const res = await window.api.openVideo();
  if (!res) return;
  state.videoPath = res.path;
  state.name = res.name;
  state.probe = res.probe;
  state.peaks = null;
  state.rawSilences = [];
  state.rawFreezes = [];
  state.cuts = [];
  state.analyzed = false;
  state.cues = null;
  state.srcLang = null;
  state.translations = {};
  state.subsTarget = res.path;
  state.subsTargetDuration = res.probe ? res.probe.duration : null;
  state.zoom = 1;
  state.viewStart = 0;
  els.video.src = 'file:///' + encodeURI(res.path.replace(/\\/g, '/'))
    .replace(/#/g, '%23').replace(/\?/g, '%3F');
  els.dropHint.classList.add('hidden');
  els.fileInfo.textContent = res.probe
    ? `${res.name} · ${fmtTime(res.probe.duration)} · ${res.probe.width}×${res.probe.height}`
    : res.name;
  for (const b of [els.btnPlay, els.btnBack5, els.btnFwd5]) b.disabled = false;
  els.btnAnalyze.disabled = !state.toolsOk;
  els.btnTranscribe.disabled = !state.toolsOk;
  refreshCueUI();
  refreshStats();
  draw();
  if (state.toolsOk && res.probe) runAnalyze();
};

async function runAnalyze() {
  const p = readParams();
  const opts = {
    duration: state.probe.duration,
    hasAudio: state.probe.hasAudio,
    hasVideo: state.probe.hasVideo,
    noiseDb: p.noiseDb,
    minSilence: 0.3, // raw floor; the UI's min-cut filter works client-side
    freezeNoise: p.freezeNoise,
    freezeDur: p.freezeDur,
  };
  const res = await withJob('analyze', 'Analyzing…', () =>
    window.api.analyze(state.videoPath, opts));
  if (!res) return;
  state.peaks = res.peaks;
  state.rawSilences = res.silences;
  state.rawFreezes = res.freezes;
  state.analyzed = true;
  state.needsReanalyze = false;
  els.btnReanalyze.disabled = true;
  state.cuts = state.cuts.filter((c) => c.source === 'manual');
  deriveCuts();
  toast(`Found ${state.rawSilences.length} silent + ${state.rawFreezes.length} frozen segments`);
}

els.btnAnalyze.onclick = runAnalyze;
els.btnReanalyze.onclick = runAnalyze;

// ---- export ---------------------------------------------------------------------------

els.btnExport.onclick = async () => {
  let keeps;
  try { keeps = currentKeeps(); } catch (e) { toast(e.message, true); return; }
  const suffix = (state.settings && state.settings.exportSuffix) || '_trimmed';
  const suggestedName = state.name.replace(/\.[^.]+$/, '') + suffix + '.mp4';
  const res = await withJob('export', 'Exporting…', () =>
    window.api.exportVideo(state.videoPath, keeps, {
      suggestedName, hasAudio: state.probe.hasAudio,
    }));
  if (!res) return;
  state.subsTarget = res.outPath;
  state.subsTargetDuration = ops.totalDuration(keeps);
  toast('Exported ' + res.outPath + (res.nvencFellBack ? ' (GPU encoder failed — used CPU)' : '') +
    ' — for subtitles: Transcribe → pick a language tab → Translate → Burn-in (text on the picture) or Embed tracks.');
};

// ---- video transport --------------------------------------------------------------------

els.btnPlay.onclick = () => { els.video.paused ? els.video.play() : els.video.pause(); };
els.btnBack5.onclick = () => { els.video.currentTime = Math.max(0, els.video.currentTime - 5); };
els.btnFwd5.onclick = () => { els.video.currentTime += 5; };
els.video.addEventListener('play', () => { els.btnPlay.textContent = '❚❚'; rafLoop(); });
els.video.addEventListener('pause', () => { els.btnPlay.textContent = '▶'; });

els.video.addEventListener('timeupdate', () => {
  // "Preview with cuts": hop over any enabled cut while playing.
  if (els.chkSkipCuts.checked && !els.video.paused) {
    const t = els.video.currentTime;
    const hit = enabledCuts().find((c) => t >= c.start && t < c.end - 0.05);
    if (hit) els.video.currentTime = hit.end + 0.01;
  }
  updateReadout();
});

function updateReadout() {
  if (!state.probe) { els.timeReadout.textContent = ''; return; }
  let txt = `${fmtTime(els.video.currentTime)} / ${fmtTime(state.probe.duration)}`;
  const cuts = enabledCuts();
  if (cuts.length) {
    try {
      const keeps = currentKeeps();
      txt += ` → out ${fmtTime(ops.remapTime(els.video.currentTime, keeps))} / ${fmtTime(ops.totalDuration(keeps))}`;
    } catch (e) { /* everything cut */ }
  }
  els.timeReadout.textContent = txt;
}

function rafLoop() {
  if (els.video.paused) { draw(); return; }
  draw();
  requestAnimationFrame(rafLoop);
}

// ---- timeline canvas ---------------------------------------------------------------------

const LANES = { wave: [8, 86], silence: [92, 106], freeze: [108, 122], cuts: [126, 148] };

function viewDur() { return state.probe ? state.probe.duration / state.zoom : 1; }
function timeToX(t, w) { return (t - state.viewStart) / viewDur() * w; }
function xToTime(x, w) { return state.viewStart + (x / w) * viewDur(); }
function clampView() {
  const vd = viewDur();
  state.viewStart = Math.max(0, Math.min(state.probe.duration - vd, state.viewStart));
}

function draw() {
  const c = els.tlCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 150;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state.probe) return;

  // waveform
  const [wy0, wy1] = LANES.wave;
  const mid = (wy0 + wy1) / 2, amp = (wy1 - wy0) / 2;
  ctx.fillStyle = '#2c333d';
  ctx.fillRect(0, wy0, w, wy1 - wy0);
  if (state.peaks) {
    const buckets = state.peaks.max.length;
    const dur = state.probe.duration;
    ctx.fillStyle = '#6fa8dc';
    for (let x = 0; x < w; x++) {
      const t0 = xToTime(x, w), t1 = xToTime(x + 1, w);
      let b0 = Math.floor(t0 / dur * buckets), b1 = Math.ceil(t1 / dur * buckets);
      b0 = Math.max(0, Math.min(buckets - 1, b0));
      b1 = Math.max(b0 + 1, Math.min(buckets, b1));
      let lo = 1, hi = -1;
      for (let b = b0; b < b1; b++) {
        if (state.peaks.min[b] < lo) lo = state.peaks.min[b];
        if (state.peaks.max[b] > hi) hi = state.peaks.max[b];
      }
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
  }

  // detection lanes
  const drawLane = (segs, lane, color) => {
    ctx.fillStyle = color;
    for (const s of segs) {
      const x0 = timeToX(s.start, w), x1 = timeToX(s.end, w);
      if (x1 < 0 || x0 > w) continue;
      ctx.fillRect(x0, lane[0], Math.max(1, x1 - x0), lane[1] - lane[0]);
    }
  };
  ctx.fillStyle = '#20242b';
  ctx.fillRect(0, LANES.silence[0], w, LANES.silence[1] - LANES.silence[0]);
  ctx.fillRect(0, LANES.freeze[0], w, LANES.freeze[1] - LANES.freeze[0]);
  ctx.fillRect(0, LANES.cuts[0], w, LANES.cuts[1] - LANES.cuts[0]);
  drawLane(state.rawSilences, LANES.silence, 'rgba(217,164,65,0.75)');
  drawLane(state.rawFreezes, LANES.freeze, 'rgba(93,143,212,0.75)');
  for (const cut of state.cuts) {
    const x0 = timeToX(cut.start, w), x1 = timeToX(cut.end, w);
    if (x1 < 0 || x0 > w) continue;
    ctx.fillStyle = cut.enabled ? 'rgba(224,85,85,0.85)' : 'rgba(120,126,134,0.45)';
    ctx.fillRect(x0, LANES.cuts[0], Math.max(1, x1 - x0), LANES.cuts[1] - LANES.cuts[0]);
    ctx.strokeStyle = cut.enabled ? '#ff9d9d' : '#9aa1a9';
    ctx.strokeRect(x0 + 0.5, LANES.cuts[0] + 0.5, Math.max(1, x1 - x0) - 1, LANES.cuts[1] - LANES.cuts[0] - 1);
  }

  // live preview of a manual cut being dragged out
  if (dragCtx && dragCtx.type === 'create') {
    const a = Math.min(dragCtx.t0, dragCtx.t1), b = Math.max(dragCtx.t0, dragCtx.t1);
    const x0 = timeToX(a, w), x1 = timeToX(b, w);
    ctx.fillStyle = 'rgba(224,85,85,0.45)';
    ctx.fillRect(x0, LANES.cuts[0], Math.max(1, x1 - x0), LANES.cuts[1] - LANES.cuts[0]);
    ctx.strokeStyle = '#ff9d9d';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, LANES.cuts[0] + 0.5, Math.max(1, x1 - x0) - 1, LANES.cuts[1] - LANES.cuts[0] - 1);
    ctx.setLineDash([]);
  }

  // lane captions
  ctx.fillStyle = '#8a94a1';
  ctx.font = '10px Segoe UI';
  ctx.fillText('silence', 4, LANES.silence[1] - 3);
  ctx.fillText('freeze', 4, LANES.freeze[1] - 3);
  ctx.fillText('cuts', 4, LANES.cuts[1] - 6);

  // playhead
  const px = timeToX(els.video.currentTime || 0, w);
  if (px >= 0 && px <= w) {
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
}

window.addEventListener('resize', draw);

// hit-testing
function cutAt(x, y, w) {
  if (y < LANES.cuts[0] || y > LANES.cuts[1]) return null;
  for (const cut of state.cuts) {
    const x0 = timeToX(cut.start, w), x1 = timeToX(cut.end, w);
    if (x >= x0 - 5 && x <= x1 + 5) {
      if (Math.abs(x - x0) <= 5) return { cut, edge: 'start' };
      if (Math.abs(x - x1) <= 5) return { cut, edge: 'end' };
      if (x >= x0 && x <= x1) return { cut, edge: null };
    }
  }
  return null;
}

let dragCtx = null; // {type:'edge'|'maybeToggle'|'scrub', ...}

els.tlCanvas.addEventListener('mousedown', (e) => {
  if (!state.probe) return;
  const r = els.tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, w = r.width;
  const hit = cutAt(x, y, w);
  if (hit && hit.edge) {
    dragCtx = { type: 'edge', cut: hit.cut, edge: hit.edge, moved: false };
  } else if (hit) {
    dragCtx = { type: 'maybeToggle', cut: hit.cut, x0: x };
  } else if (y >= LANES.cuts[0] && y <= LANES.cuts[1]) {
    // drag across the empty cuts lane to mark a manual cut of that exact range
    const t = xToTime(x, w);
    dragCtx = { type: 'create', t0: t, t1: t };
  } else {
    dragCtx = { type: 'scrub' };
    els.video.currentTime = Math.max(0, Math.min(state.probe.duration, xToTime(x, w)));
    draw();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!dragCtx || !state.probe) return;
  const r = els.tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, w = r.width;
  const t = Math.max(0, Math.min(state.probe.duration, xToTime(x, w)));
  if (dragCtx.type === 'edge') {
    dragCtx.moved = true;
    const cut = dragCtx.cut;
    const snapped = Math.round(t / 0.05) * 0.05;
    if (dragCtx.edge === 'start') cut.start = Math.min(snapped, cut.end - 0.05);
    else cut.end = Math.max(snapped, cut.start + 0.05);
    refreshStats();
    draw();
  } else if (dragCtx.type === 'create') {
    dragCtx.t1 = t;
    draw();
  } else if (dragCtx.type === 'scrub') {
    els.video.currentTime = t;
    updateReadout();
    draw();
  } else if (dragCtx.type === 'maybeToggle' && Math.abs(x - dragCtx.x0) > 4) {
    dragCtx = null; // moved too far — not a click
  }
});

window.addEventListener('mouseup', () => {
  if (dragCtx && dragCtx.type === 'maybeToggle') {
    dragCtx.cut.enabled = !dragCtx.cut.enabled;
    refreshStats();
    updateReadout();
  } else if (dragCtx && dragCtx.type === 'create') {
    const a = Math.min(dragCtx.t0, dragCtx.t1), b = Math.max(dragCtx.t0, dragCtx.t1);
    if (b - a >= 0.2) {
      state.cuts.push({ id: 'c' + (++state.cutSeq), start: a, end: b, enabled: true, source: 'manual' });
      state.cuts = ops.sortSegments(state.cuts);
      refreshStats();
      updateReadout();
    }
  }
  dragCtx = null;
  draw();
});

els.tlCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.probe) return;
  const r = els.tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, w = r.width;
  const hit = cutAt(x, y, w);
  if (hit) {
    state.cuts = state.cuts.filter((c) => c !== hit.cut);
  } else {
    const t = xToTime(x, w);
    state.cuts.push({
      id: 'c' + (++state.cutSeq),
      start: Math.max(0, t - 1),
      end: Math.min(state.probe.duration, t + 1),
      enabled: true,
      source: 'manual',
    });
    state.cuts = ops.sortSegments(state.cuts);
  }
  refreshStats();
  draw();
});

els.tlCanvas.addEventListener('wheel', (e) => {
  if (!state.probe) return;
  e.preventDefault();
  const r = els.tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, w = r.width;
  if (e.shiftKey) {
    state.viewStart += (e.deltaY > 0 ? 1 : -1) * viewDur() * 0.15;
  } else {
    const tAtCursor = xToTime(x, w);
    state.zoom = Math.max(1, Math.min(200, state.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    state.viewStart = tAtCursor - (x / w) * viewDur();
  }
  clampView();
  draw();
}, { passive: false });

// ---- subtitles ---------------------------------------------------------------------------

els.btnTranscribe.onclick = async () => {
  const target = state.subsTarget || state.videoPath;
  const res = await withJob('transcribe', 'Transcribing…', () =>
    window.api.transcribe(target));
  if (!res) return;
  state.cues = res.cues;
  state.srcLang = res.language;
  state.translations = {};
  // if the source language is one of our targets, its tab is just the original
  if (res.language && ops.langByCode(res.language)) {
    state.translations[res.language] = { texts: res.cues.map((c) => c.text) };
  }
  refreshCueUI();
  toast(`Transcribed ${res.cues.length} lines (detected language: ${res.language || 'unknown'})`);
};

function getTabCues(code) {
  if (!state.cues) return null;
  if (code === 'orig') return state.cues;
  const tr = state.translations[code];
  if (!tr) return null;
  if (tr.cues) return tr.cues;
  return state.cues.map((c, i) => ({ start: c.start, end: c.end, text: tr.texts[i] || '' }));
}

function refreshCueUI() {
  // tab highlight + content dots
  for (const btn of els.langTabs.querySelectorAll('.tab')) {
    const code = btn.dataset.lang;
    btn.classList.toggle('active', code === state.tab);
    btn.classList.toggle('has-content', !!getTabCues(code));
  }
  // provider dropdown: only providers that can produce the current tab language
  const provSel = els.selProvider;
  provSel.innerHTML = '';
  for (const p of ops.PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    opt.disabled = state.tab !== 'orig' && !ops.providerSupports(p.id, state.tab);
    provSel.appendChild(opt);
  }
  if (state.settings && ops.providerSupports(state.settings.provider, state.tab)) {
    provSel.value = state.settings.provider;
  } else {
    const firstOk = ops.PROVIDERS.find((p) => ops.providerSupports(p.id, state.tab));
    if (firstOk) provSel.value = firstOk.id;
  }
  els.btnTranslate.disabled = !(state.cues && state.tab !== 'orig');
  // cue list
  const cues = getTabCues(state.tab);
  const lang = ops.langByCode(state.tab);
  els.cueList.innerHTML = '';
  if (!cues) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = state.cues
      ? 'Not translated yet — press Translate.'
      : 'Transcribe the video to see subtitles here.';
    els.cueList.appendChild(d);
  } else {
    for (const c of cues) {
      const div = document.createElement('div');
      div.className = 'cue' + (lang && lang.rtl ? ' rtl' : '');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = ops.formatTimestamp(c.start).slice(0, 8);
      const txt = document.createElement('div');
      txt.className = 'txt';
      txt.textContent = c.text;
      div.appendChild(t);
      div.appendChild(txt);
      div.onclick = () => {
        // cue times are in the subs-target timeline; only seek when previewing that same file
        if (state.subsTarget === state.videoPath) {
          els.video.currentTime = c.start;
          draw();
        }
      };
      els.cueList.appendChild(div);
    }
  }
  const any = !!state.cues;
  els.btnSaveSrt.disabled = !getTabCues(state.tab);
  els.btnSaveAll.disabled = !any;
  els.btnMux.disabled = !any;
  els.btnBurn.disabled = !getTabCues(state.tab) || state.tab === 'orig' && !state.cues;
}

els.langTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.lang;
  refreshCueUI();
});

els.btnTranslate.onclick = async () => {
  const target = state.tab;
  if (target === 'orig' || !state.cues) return;
  const providerId = els.selProvider.value;
  const payload = {
    cues: state.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    providerId,
    targetCode: target,
    srcCode: state.srcLang,
    videoPath: state.subsTarget || state.videoPath,
  };
  const res = await withJob('translate', 'Translating to ' + ops.langByCode(target).name + '…', () =>
    window.api.translate(payload));
  if (!res) return;
  state.translations[target] = res.cues ? { cues: res.cues } : { texts: res.texts };
  refreshCueUI();
  toast('Translated to ' + ops.langByCode(target).name);
};

// ---- SRT delivery ---------------------------------------------------------------------------

function srtBase() {
  return (state.subsTarget || state.videoPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

els.btnSaveSrt.onclick = async () => {
  const cues = getTabCues(state.tab);
  if (!cues) return;
  const code = state.tab === 'orig' ? (state.srcLang || 'orig') : state.tab;
  const p = await window.api.saveText(ops.serializeSrt(cues), srtBase() + '.' + code + '.srt');
  if (p) toast('Saved ' + p);
};

function collectAllTracks() {
  const tracks = [];
  const seen = new Set();
  for (const code of ['he', 'en', 'ru', 'be']) {
    const cues = getTabCues(code);
    if (!cues) continue;
    const lang = ops.langByCode(code);
    tracks.push({ code, iso3: lang.iso3, title: lang.name, text: ops.serializeSrt(cues) });
    seen.add(code);
  }
  // original language, if it isn't one of the four targets
  if (state.cues && (!state.srcLang || !seen.has(state.srcLang))) {
    tracks.unshift({
      code: state.srcLang || 'orig', iso3: 'und', title: 'Original',
      text: ops.serializeSrt(state.cues),
    });
  }
  return tracks;
}

els.btnSaveAll.onclick = async () => {
  const tracks = collectAllTracks();
  const files = tracks.map((t) => ({ code: t.code, text: t.text }));
  const written = await window.api.saveSrtBundle(state.subsTarget || state.videoPath, files);
  toast('Saved ' + written.length + ' .srt files next to the video');
};

els.btnMux.onclick = async () => {
  const tracks = collectAllTracks();
  if (!tracks.length) return;
  const res = await withJob('mux', 'Embedding subtitle tracks…', () =>
    window.api.muxSubtitles({
      videoPath: state.subsTarget || state.videoPath,
      tracks,
      suggestedName: srtBase() + '.subs.mp4',
    }));
  if (res) toast('Saved ' + res.outPath);
};

els.btnBurn.onclick = async () => {
  const cues = getTabCues(state.tab);
  if (!cues) return;
  const code = state.tab === 'orig' ? (state.srcLang || 'orig') : state.tab;
  const res = await withJob('burn', 'Burning subtitles…', () =>
    window.api.burnSubtitles({
      videoPath: state.subsTarget || state.videoPath,
      text: ops.serializeSrt(cues),
      duration: state.subsTargetDuration,
      suggestedName: srtBase() + '.' + code + '.burned.mp4',
    }));
  if (res) toast('Saved ' + res.outPath);
};

// ---- settings modal ---------------------------------------------------------------------------

function openSettings() {
  const s = state.settings;
  els.setProvider.innerHTML = '';
  for (const p of ops.PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    els.setProvider.appendChild(opt);
  }
  els.setProvider.value = s.provider;
  els.setClaudeKey.value = s.claudeApiKey;
  els.setClaudeModel.value = s.claudeModel;
  els.setMyMemoryEmail.value = s.myMemoryEmail;
  els.setUseNvenc.checked = s.useNvenc;
  els.settingsModal.classList.remove('hidden');
}

els.btnSettings.onclick = openSettings;
els.btnSettingsCancel.onclick = () => els.settingsModal.classList.add('hidden');
els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden');
});
els.btnSettingsSave.onclick = async () => {
  state.settings = await window.api.setSettings({
    provider: els.setProvider.value,
    claudeApiKey: els.setClaudeKey.value,
    claudeModel: els.setClaudeModel.value,
    myMemoryEmail: els.setMyMemoryEmail.value,
    useNvenc: els.setUseNvenc.checked,
  });
  els.settingsModal.classList.add('hidden');
  refreshCueUI();
  toast('Settings saved');
};

// ---- keyboard ----------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); els.btnPlay.click(); }
  else if (e.key === 'j' || e.key === 'J') els.video.currentTime -= 10;
  else if (e.key === 'k' || e.key === 'K') els.video.pause();
  else if (e.key === 'l' || e.key === 'L') els.video.currentTime += 10;
  else if (e.key === 'o' && e.ctrlKey) { e.preventDefault(); els.btnOpen.click(); }
  else if (e.key === 'e' && e.ctrlKey) { e.preventDefault(); if (!els.btnExport.disabled) els.btnExport.click(); }
});

// ---- init --------------------------------------------------------------------------------------

(async () => {
  const version = await window.api.getVersion();
  els.version.textContent = 'v' + version;
  document.title = 'VIDEO EDITOR v' + version; // title bar always shows the running version
  state.settings = await window.api.getSettings();
  fillParams(state.settings);
  const manifest = await window.api.checkTools();
  state.toolsOk = !!manifest.ok;
  if (!manifest.ok) {
    els.toolsBanner.classList.remove('hidden');
    els.toolsDetail.textContent = manifest.missing
      ? '' : 'Some tool files are missing — re-run setup.';
  } else {
    els.toolsDetail.textContent = '';
    if (manifest.whisperBackend === 'cpu') {
      toast('Note: whisper is using the CPU build — transcription will be slower.', false);
    }
  }
  refreshCueUI();
  draw();
  console.log('[VIDEO EDITOR] renderer ready — tools ' + (state.toolsOk ? 'ok' : 'missing'));
})();
