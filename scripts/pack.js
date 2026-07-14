'use strict';
/*
 * pack.js — build a portable, zero-install package of VIDEO EDITOR.
 *
 *   node scripts/pack.js              build dist-portable/VideoEditor-<version>/
 *   node scripts/pack.js --zip        also produce a .zip next to it
 *   node scripts/pack.js --no-llm     exclude the local LLM (~5 GB smaller;
 *                                     tasks report then needs a Claude API key)
 *   node scripts/pack.js --no-full-model  exclude ggml-large-v3.bin (~3 GB smaller;
 *                                     no offline English-translation provider)
 *
 * The result runs on any Windows 10/11 x64 PC with NO installation: the
 * recipient unzips and double-clicks VideoEditor.exe. Node/npm not needed.
 * Requires `npm install` and `npm run setup` to have been run here first.
 *
 * How it works: Electron's prebuilt runtime is copied verbatim, the exe is
 * renamed, and the app (code + tools + models) is placed in resources/app —
 * the standard Electron app-folder layout. The bundled manifest uses paths
 * RELATIVE to the tools folder (lib/tools.js resolves them at load time), and
 * whisper/llama retry with their bundled CPU builds if the target PC's GPU
 * differs from this one.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ZIP = process.argv.includes('--zip');
const NO_LLM = process.argv.includes('--no-llm');
const NO_FULL = process.argv.includes('--no-full-model');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const toolsDir = path.join(ROOT, 'tools');
const manifestPath = path.join(toolsDir, 'manifest.json');

function fail(msg) { console.error('PACK FAILED: ' + msg); process.exit(1); }
function fmtGB(n) { return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'; }

if (!fs.existsSync(electronDist)) fail('Electron not installed — run: npm install');
if (!fs.existsSync(manifestPath)) fail('tools/manifest.json missing — run: npm run setup');

const outRoot = path.join(ROOT, 'dist-portable');
const name = 'VideoEditor-' + version;
const dest = path.join(outRoot, name);

console.log('[1/5] copying Electron runtime');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(electronDist, dest, { recursive: true });
fs.renameSync(path.join(dest, 'electron.exe'), path.join(dest, 'VideoEditor.exe'));
// with resources/app present the default welcome app must not shadow it
fs.rmSync(path.join(dest, 'resources', 'default_app.asar'), { force: true });

console.log('[2/5] copying app code');
const appDir = path.join(dest, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const f of ['package.json', 'main.js', 'preload.js']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
}
for (const d of ['src', 'lib']) {
  fs.cpSync(path.join(ROOT, d), path.join(appDir, d), { recursive: true });
}

console.log('[3/5] copying tools + models (this is the big part)');
const skipNames = ['_downloads'];
if (NO_LLM) skipNames.push('llama-gpu', 'llama-cpu');
fs.cpSync(toolsDir, path.join(appDir, 'tools'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(toolsDir, src);
    const top = rel.split(path.sep)[0];
    if (skipNames.includes(top)) return false;
    const base = path.basename(src);
    if (base === 'manifest.json') return false; // rewritten below
    if (NO_LLM && /\.gguf$/i.test(base)) return false;
    if (NO_FULL && base === 'ggml-large-v3.bin') return false;
    return true;
  },
});

console.log('[4/5] writing relative-path manifest');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const rel = (p) => {
  if (!p || typeof p !== 'string') return p;
  const r = path.relative(toolsDir, p);
  return r.startsWith('..') ? p : r; // outside tools/ — keep as-is
};
for (const k of ['ffmpeg', 'ffprobe', 'whisperExe', 'whisperCpuExe', 'llamaExe', 'llamaCpuExe']) {
  manifest[k] = rel(manifest[k]);
}
if (manifest.models) for (const k of Object.keys(manifest.models)) manifest.models[k] = rel(manifest.models[k]);
if (NO_LLM) { delete manifest.llamaExe; delete manifest.llamaCpuExe; delete manifest.llamaBackend; if (manifest.models) delete manifest.models.llm; }
if (NO_FULL && manifest.models) manifest.models.full = null;
manifest.portable = true;
fs.writeFileSync(path.join(appDir, 'tools', 'manifest.json'), JSON.stringify(manifest, null, 2));

fs.writeFileSync(path.join(dest, 'README.txt'),
  'VIDEO EDITOR v' + version + ' — portable\r\n\r\n' +
  'Double-click VideoEditor.exe to start. Nothing to install.\r\n' +
  'Do NOT run as administrator.\r\n\r\n' +
  'All processing happens on this computer — videos are never uploaded.\r\n' +
  'Guide: https://github.com/mbbtower4-boop/VIDEO-EDITOR/blob/main/INSTRUCTIONS.md\r\n');

// total size report
let total = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
  }
})(dest);
console.log('[5/5] done: ' + dest + ' (' + fmtGB(total) + ')');

if (ZIP) {
  const zipPath = path.join(outRoot, name + '.zip');
  console.log('zipping (several minutes for this size)...');
  fs.rmSync(zipPath, { force: true });
  const r = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', outRoot, name], { stdio: 'inherit' });
  if (r.status !== 0) fail('zip creation failed');
  console.log('zip: ' + zipPath + ' (' + fmtGB(fs.statSync(zipPath).size) + ')');
}
