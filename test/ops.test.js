/* Headless verification of videoOps.js. Run: node test/ops.test.js */
const ops = require('../src/videoOps.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name); }
}
function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}
function segEq(a, b) {
  return a.length === b.length &&
    a.every((s, i) => Math.abs(s.start - b[i].start) < 1e-9 && Math.abs(s.end - b[i].end) < 1e-9);
}

// ---- detection parsers ----
const silenceStderr = [
  'Input #0, mov,mp4,m4a from sample.mp4:',
  '[silencedetect @ 0000023a] silence_start: 3.5',
  '[silencedetect @ 0000023a] silence_end: 7.25 | silence_duration: 3.75',
  'frame=  100 fps=0.0 q=-0.0 size=N/A',
  '[silencedetect @ 0000023a] silence_start: 12',
  '[silencedetect @ 0000023a] silence_end: 14.5 | silence_duration: 2.5',
  '[silencedetect @ 0000023a] silence_start: 20.25',
].join('\n');
const sil = ops.parseSilence(silenceStderr, 25);
check('parseSilence finds 3 segments (incl. trailing open)', sil.length === 3);
check('parseSilence values', segEq(sil, [{ start: 3.5, end: 7.25 }, { start: 12, end: 14.5 }, { start: 20.25, end: 25 }]));
check('parseSilence without duration drops open tail', ops.parseSilence(silenceStderr).length === 2);
check('parseSilence clamps negative start', ops.parseSilence('[x] silence_start: -0.02\n[x] silence_end: 1.0 |')[0].start === 0);
check('parseSilence ignores garbage', ops.parseSilence('random noise\nnothing here').length === 0);

const freezeStderr = [
  '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5.005',
  '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3.0',
  '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 8.005',
  '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 18',
].join('\n');
const frz = ops.parseFreeze(freezeStderr, 20);
check('parseFreeze finds 2 segments (incl. trailing open)', frz.length === 2);
check('parseFreeze values', segEq(frz, [{ start: 5.005, end: 8.005 }, { start: 18, end: 20 }]));

// ---- segment math ----
check('mergeSegments merges overlap', segEq(
  ops.mergeSegments([{ start: 0, end: 5 }, { start: 4, end: 8 }, { start: 10, end: 11 }]),
  [{ start: 0, end: 8 }, { start: 10, end: 11 }]));
check('mergeSegments merges touching', segEq(
  ops.mergeSegments([{ start: 0, end: 5 }, { start: 5, end: 8 }]),
  [{ start: 0, end: 8 }]));
check('mergeSegments with gap', segEq(
  ops.mergeSegments([{ start: 0, end: 5 }, { start: 5.4, end: 8 }], 0.5),
  [{ start: 0, end: 8 }]));
check('mergeSegments unsorted input', segEq(
  ops.mergeSegments([{ start: 10, end: 11 }, { start: 0, end: 2 }]),
  [{ start: 0, end: 2 }, { start: 10, end: 11 }]));

check('intersectSegments basic', segEq(
  ops.intersectSegments([{ start: 0, end: 10 }], [{ start: 5, end: 15 }]),
  [{ start: 5, end: 10 }]));
check('intersectSegments containment', segEq(
  ops.intersectSegments([{ start: 0, end: 20 }], [{ start: 5, end: 6 }, { start: 8, end: 9 }]),
  [{ start: 5, end: 6 }, { start: 8, end: 9 }]));
check('intersectSegments touching endpoints = empty', ops.intersectSegments(
  [{ start: 0, end: 5 }], [{ start: 5, end: 10 }]).length === 0);
check('unionSegments', segEq(
  ops.unionSegments([{ start: 0, end: 5 }], [{ start: 3, end: 8 }]),
  [{ start: 0, end: 8 }]));

check('applyPadding shrinks both sides', segEq(
  ops.applyPadding([{ start: 10, end: 14 }], 0.5, 0.25),
  [{ start: 10.5, end: 13.75 }]));
check('applyPadding drops collapsed segments', ops.applyPadding(
  [{ start: 10, end: 10.6 }], 0.4, 0.4).length === 0);
check('filterMinDuration', ops.filterMinDuration(
  [{ start: 0, end: 1 }, { start: 2, end: 5 }], 2).length === 1);
check('clampSegments', segEq(
  ops.clampSegments([{ start: -2, end: 3 }, { start: 28, end: 40 }], 30),
  [{ start: 0, end: 3 }, { start: 28, end: 30 }]));

// proposeCuts mode matrix
const S = [{ start: 2, end: 8 }, { start: 12, end: 16 }];
const F = [{ start: 6, end: 14 }];
check('proposeCuts silence mode', segEq(
  ops.proposeCuts({ silences: S, freezes: F, mode: 'silence', duration: 20, padLead: 0, padTail: 0, minCut: 0 }), S));
check('proposeCuts freeze mode', segEq(
  ops.proposeCuts({ silences: S, freezes: F, mode: 'freeze', duration: 20, padLead: 0, padTail: 0, minCut: 0 }), F));
check('proposeCuts both = intersection', segEq(
  ops.proposeCuts({ silences: S, freezes: F, mode: 'both', duration: 20, padLead: 0, padTail: 0, minCut: 0 }),
  [{ start: 6, end: 8 }, { start: 12, end: 14 }]));
check('proposeCuts applies padding + minCut', segEq(
  ops.proposeCuts({ silences: S, freezes: [], mode: 'silence', duration: 20, padLead: 0.5, padTail: 0.5, minCut: 4 }),
  [{ start: 2.5, end: 7.5 }]));

// invertToKeeps
check('invertToKeeps middle cut', segEq(
  ops.invertToKeeps([{ start: 5, end: 10 }], 20),
  [{ start: 0, end: 5 }, { start: 10, end: 20 }]));
check('invertToKeeps cut at 0', segEq(
  ops.invertToKeeps([{ start: 0, end: 5 }], 20),
  [{ start: 5, end: 20 }]));
check('invertToKeeps cut at end', segEq(
  ops.invertToKeeps([{ start: 15, end: 20 }], 20),
  [{ start: 0, end: 15 }]));
check('invertToKeeps back-to-back cuts', segEq(
  ops.invertToKeeps([{ start: 2, end: 5 }, { start: 5, end: 9 }], 10),
  [{ start: 0, end: 2 }, { start: 9, end: 10 }]));
check('invertToKeeps drops tiny keeps', segEq(
  ops.invertToKeeps([{ start: 2, end: 5 }, { start: 5.1, end: 9 }], 10, 0.3),
  [{ start: 0, end: 2 }, { start: 9, end: 10 }]));
check('invertToKeeps refuses cutting everything', throws(() =>
  ops.invertToKeeps([{ start: 0, end: 10 }], 10)));

check('totalDuration', ops.totalDuration([{ start: 0, end: 2 }, { start: 5, end: 6.5 }]) === 3.5);

// remapTime
const keeps = [{ start: 0, end: 5 }, { start: 10, end: 20 }];
check('remapTime inside first keep', ops.remapTime(3, keeps) === 3);
check('remapTime inside a cut collapses', ops.remapTime(7, keeps) === 5);
check('remapTime inside second keep', ops.remapTime(12, keeps) === 7);
check('remapTime past end', ops.remapTime(25, keeps) === 15);

// ---- peaks ----
const sine = new Int16Array(8000);
for (let i = 0; i < 8000; i++) sine[i] = Math.round(Math.sin(i / 20) * 16384);
const flat = new Int16Array(1000); // silence
const pk = ops.computePeaks(sine, 100);
check('computePeaks bucket count', pk.min.length === 100 && pk.max.length === 100);
check('computePeaks min<=max everywhere', Array.from(pk.max).every((v, i) => v >= pk.min[i]));
check('computePeaks sine amplitude ~0.5', Math.abs(pk.max[50] - 0.5) < 0.05);
const pkFlat = ops.computePeaks(flat, 10);
check('computePeaks silence ~= 0', Math.abs(pkFlat.max[3]) < 1e-6 && Math.abs(pkFlat.min[3]) < 1e-6);
check('computePeaks empty input', ops.computePeaks(new Int16Array(0), 4).min.length === 4);

// ---- ffmpeg arg builders ----
check('buildProbeArgs', ops.buildProbeArgs('in.mp4').join(' ') ===
  '-v error -print_format json -show_format -show_streams in.mp4');
check('buildWaveformArgs s16le to stdout', ops.buildWaveformArgs('in.mp4').join(' ').endsWith('-f s16le -'));
const det = ops.buildDetectArgs('in.mp4', { noiseDb: -30, minSilence: 2, freezeNoise: -60, freezeDur: 3 });
check('buildDetectArgs has both filters', det.includes('silencedetect=noise=-30dB:d=2') &&
  det.includes('freezedetect=n=-60dB:d=3'));
const detNoVideo = ops.buildDetectArgs('in.mp4', { hasVideo: false });
check('buildDetectArgs audio-only skips freezedetect', !detNoVideo.some((a) => /freezedetect/.test(a)));

const filter1 = ops.buildExportFilter([{ start: 1, end: 2.5 }]);
check('buildExportFilter single keep', filter1 ===
  '[0:v]trim=start=1.000:end=2.500,setpts=PTS-STARTPTS[v0];\n' +
  '[0:a]atrim=start=1.000:end=2.500,asetpts=PTS-STARTPTS[a0];\n' +
  '[v0][a0]concat=n=1:v=1:a=1[v][a]');
const filter3 = ops.buildExportFilter([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }]);
check('buildExportFilter 3 keeps concat', filter3.endsWith('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]'));
check('buildExportFilter video-only', ops.buildExportFilter([{ start: 0, end: 1 }], false) ===
  '[0:v]trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v0];\n[v0]concat=n=1:v=1:a=0[v]');
check('buildExportFilter refuses empty', throws(() => ops.buildExportFilter([])));

const exp = ops.buildExportArgs('in.mp4', 'out.mp4', { filterScript: 'f.txt', useNvenc: true });
check('buildExportArgs nvenc', exp.includes('h264_nvenc') && exp.includes('-/filter_complex'));
const expSw = ops.buildExportArgs('in.mp4', 'out.mp4', { filterScript: 'f.txt', useNvenc: false });
check('buildExportArgs libx264 fallback', expSw.includes('libx264') && !expSw.includes('h264_nvenc'));

check('escapeFilterPath windows', ops.escapeFilterPath('D:\\Work\\AI\\a b.srt') === 'D\\:/Work/AI/a b.srt');
const burn = ops.buildBurnArgs('in.mp4', 'D:\\sub\\he.srt', 'out.mp4', {});
const vf = burn[burn.indexOf('-vf') + 1];
check('buildBurnArgs subtitles filter escaped', vf ===
  "subtitles=filename='D\\:/sub/he.srt':force_style='FontName=Segoe UI'");

const mux = ops.buildMuxArgs('v.mp4', [
  { path: 'a.he.srt', iso3: 'heb', title: 'Hebrew' },
  { path: 'a.en.srt', iso3: 'eng', title: 'English' },
], 'out.mp4');
check('buildMuxArgs copies codecs + mov_text', mux.includes('mov_text') && mux.includes('copy'));
check('buildMuxArgs language metadata', mux.includes('language=heb') && mux.includes('language=eng'));
check('buildMuxArgs maps both srt inputs', mux.includes('1:0') && mux.includes('2:0'));

check('parseProgress out_time', ops.parseProgress('frame=1\nout_time=00:01:02.500000\nspeed=12.3x\n').timeSec === 62.5);
check('parseProgress out_time_ms is microseconds', ops.parseProgress('out_time_ms=1500000\n').timeSec === 1.5);
check('parseProgress end flag', ops.parseProgress('progress=end\n').done === true);
check('parseProgress speed', ops.parseProgress('speed= 8.55x\n').speed === 8.55);

// ---- SRT ----
check('formatTimestamp zero', ops.formatTimestamp(0) === '00:00:00,000');
check('formatTimestamp >1h', ops.formatTimestamp(3723.042) === '01:02:03,042');
check('parseTimestamp comma', ops.parseTimestamp('01:02:03,042') === 3723.042);
check('parseTimestamp dot accepted', ops.parseTimestamp('00:00:01.5') === 1.5);
check('timestamp round trip', ops.parseTimestamp(ops.formatTimestamp(59.999)) === 59.999);

const cues = [
  { start: 0, end: 2.5, text: 'שלום עולם' },
  { start: 3, end: 5, text: 'line two\nsecond row' },
];
const srt = ops.serializeSrt(cues);
check('serializeSrt uses CRLF and numbering', srt.startsWith('1\r\n00:00:00,000 --> 00:00:02,500\r\n'));
const back = ops.parseSrt(srt);
check('SRT round trip count', back.length === 2);
check('SRT round trip text (Hebrew)', back[0].text === 'שלום עולם');
check('SRT round trip multi-line text', back[1].text === 'line two\nsecond row');
check('parseSrt tolerates missing numbers', ops.parseSrt(
  '00:00:00,000 --> 00:00:01,000\nhi\n\n00:00:02,000 --> 00:00:03,000\nbye\n').length === 2);

const wjson = {
  result: { language: 'he' },
  transcription: [
    { offsets: { from: 0, to: 2500 }, text: ' שלום' },
    { offsets: { from: 2500, to: 4000 }, text: '   ' },
    { offsets: { from: 4000, to: 6000 }, text: ' עולם' },
  ],
};
const wc = ops.whisperJsonToCues(wjson);
check('whisperJsonToCues language', wc.language === 'he');
check('whisperJsonToCues skips empty text', wc.cues.length === 2);
check('whisperJsonToCues offsets → seconds', wc.cues[1].start === 4 && wc.cues[1].end === 6);

const messy = [
  { start: 0, end: 3, text: 'a' },
  { start: 2, end: 4, text: 'b' },   // overlaps previous
  { start: 5, end: 5.05, text: 'c' }, // too short
  { start: 6, end: 7, text: '   ' },  // empty
];
const clean = ops.sanitizeCues(messy, { minDur: 0.3 });
check('sanitizeCues resolves overlap', clean[0].end === 2);
check('sanitizeCues drops empties', clean.length === 3);
check('sanitizeCues extends short cue', Math.abs(clean[2].end - 5.3) < 1e-9);

// ---- translation plumbing ----
check('LANGS has all four', ops.LANGS.map((l) => l.code).join(',') === 'he,en,ru,be');
check('langByCode rtl flag', ops.langByCode('he').rtl === true && ops.langByCode('ru').rtl === false);
check('providerSupports matrix', ops.providerSupports('claude', 'be') &&
  ops.providerSupports('mymemory', 'he') &&
  ops.providerSupports('whisperEn', 'en') && !ops.providerSupports('whisperEn', 'he'));

const manyCues = Array.from({ length: 60 }, (_, i) => ({ start: i, end: i + 1, text: 'line ' + i }));
const chunks = ops.chunkCuesForTranslation(manyCues, { maxChars: 3500, maxLines: 25 });
check('chunkCues respects maxLines', chunks.length === 3 && chunks[0].lines.length === 25);
check('chunkCues preserves indices', chunks[1].indices[0] === 25 && chunks[2].indices.at(-1) === 59);
const bigCues = [{ text: 'x'.repeat(300) }, { text: 'y'.repeat(300) }, { text: 'z'.repeat(300) }];
check('chunkCues respects maxChars', ops.chunkCuesForTranslation(bigCues, { maxChars: 500, maxLines: 25 }).length === 3);

const prompt = ops.buildClaudePrompt(['hello', 'world'], 'Hebrew');
check('buildClaudePrompt numbers lines', prompt.includes('1. hello') && prompt.includes('2. world'));
check('buildClaudePrompt names language', prompt.includes('into Hebrew'));

const reply = '1. שלום\n\n2) мир\n   continued\n3. свет\n';
const parsed = ops.parseNumberedResponse(reply, 3);
check('parseNumberedResponse basic + both number styles', parsed[0] === 'שלום' && parsed[2] === 'свет');
check('parseNumberedResponse joins continuation lines', parsed[1] === 'мир continued');
check('parseNumberedResponse count mismatch throws', throws(() => ops.parseNumberedResponse('1. only', 3)));

// ---- mission-tasks report (.docx) ----
const tprompt = ops.buildTasksPrompt('line one\nline two', 'Hebrew');
check('buildTasksPrompt embeds transcript + language', tprompt.includes('line two') && tprompt.includes('in Hebrew'));

const tr1 = ops.parseTasksResponse('{"heading":"משימות","tasks":[{"title":"לתקן את הגדר","details":"ליד שער 3","priority":"high"}]}');
check('parseTasksResponse plain JSON', tr1.heading === 'משימות' && tr1.tasks.length === 1 && tr1.tasks[0].priority === 'high');
const tr2 = ops.parseTasksResponse('```json\n{"heading":"T","tasks":[{"title":"a"},{"title":"  "},{"title":"b","priority":"urgent"}]}\n```');
check('parseTasksResponse strips fences, drops empty titles, coerces priority',
  tr2.tasks.length === 2 && tr2.tasks[1].priority === 'normal');
check('parseTasksResponse bare array accepted', ops.parseTasksResponse('[{"title":"x"}]').tasks.length === 1);
check('parseTasksResponse garbage throws', throws(() => ops.parseTasksResponse('sorry, no tasks here')));
// llama-cli echoes the prompt (with its JSON template) before the reply —
// the parser must take the LAST valid JSON block, not the first.
const echoed = 'banner noise\n> Reply ONLY as {"heading": "<title>", "tasks": [{"title": "<task>", ' +
  '"priority": "high" | "normal" | "low"}]} ... return {"heading": "...", "tasks": []}.\n' +
  'Transcript: fix the fence\n' +
  '{"heading":"Site tasks","tasks":[{"title":"Fix the fence","details":"gate 3","priority":"high"}]}\n' +
  '[ Prompt: 664.8 t/s ]\nExiting...';
const trEcho = ops.parseTasksResponse(echoed);
check('parseTasksResponse skips echoed prompt, takes final JSON',
  trEcho.heading === 'Site tasks' && trEcho.tasks.length === 1 && trEcho.tasks[0].priority === 'high');

const manyCues2 = Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 1, text: 'x'.repeat(100) }));
const split = ops.splitCuesForTasks(manyCues2, 1000);
check('splitCuesForTasks respects budget, drops nothing',
  split.length === 4 && split.flat().length === 30 && split[0].length === 9);
check('splitCuesForTasks single chunk when it fits', ops.splitCuesForTasks(manyCues2, 1e6).length === 1);

const merged = ops.mergeTaskReports([
  { heading: 'A', tasks: [{ title: 'Fix fence', details: 'x', priority: 'high' }] },
  { heading: 'B', tasks: [{ title: 'fix FENCE', details: 'dup', priority: 'normal' }, { title: 'Order sand', details: '', priority: 'normal' }] },
]);
check('mergeTaskReports dedupes titles, keeps first heading',
  merged.heading === 'A' && merged.tasks.length === 2 && merged.tasks[1].title === 'Order sand');

const llargs = ops.buildLlamaArgs('D:\\m\\q.gguf', 'D:\\t\\p.txt');
check('buildLlamaArgs prompt via file + single turn + GPU offload',
  llargs.join(' ').includes('-f D:\\t\\p.txt') && llargs.includes('-st') && llargs.includes('-ngl'));

check('xmlEscape', ops.xmlEscape('a<b>&"c"') === 'a&lt;b&gt;&amp;&quot;c&quot;');
check('crc32 known value', ops.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926);

function findBytes(hay, needleStr) {
  const needle = new TextEncoder().encode(needleStr);
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const docx = ops.makeDocx({
  heading: 'משימות לעובדים', videoName: 'site.mp4', generatedOn: '14/07/2026', rtl: true,
  tasks: [
    { title: 'לתקן את הגדר', details: 'ליד שער 3, עד יום חמישי', priority: 'high' },
    { title: 'Order <cement> & "sand"', details: '', priority: 'normal' },
  ],
});
check('makeDocx returns zip (PK header)', docx[0] === 0x50 && docx[1] === 0x4B && docx[2] === 3 && docx[3] === 4);
check('makeDocx contains document.xml part', findBytes(docx, 'word/document.xml') !== -1);
check('makeDocx contains Hebrew heading (UTF-8)', findBytes(docx, 'משימות לעובדים') !== -1);
check('makeDocx escapes XML specials', findBytes(docx, '&lt;cement&gt; &amp; &quot;sand&quot;') !== -1);
check('makeDocx rtl paragraphs', findBytes(docx, '<w:bidi/>') !== -1);
check('makeDocx high-priority marker', findBytes(docx, '❗') !== -1);
const eocd = docx.length - 22;
check('makeDocx end-of-central-directory record', docx[eocd] === 0x50 && docx[eocd + 1] === 0x4B &&
  docx[eocd + 2] === 5 && docx[eocd + 3] === 6);
check('makeDocx LTR when rtl=false', findBytes(ops.makeDocx({ heading: 'Tasks', tasks: [{ title: 'x', details: '', priority: 'normal' }] }), '<w:bidi/>') === -1);

// ---- summary ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
