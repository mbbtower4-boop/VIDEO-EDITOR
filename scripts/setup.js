'use strict';
/*
 * One-time setup for VIDEO EDITOR. Downloads the external tools the app needs
 * into the gitignored tools/ directory, smoke-tests them, and records the
 * results in tools/manifest.json (read by the app at startup).
 *
 *   node scripts/setup.js            downloads ffmpeg + whisper.cpp + large-v3-turbo model
 *   node scripts/setup.js --full-model   also downloads ggml-large-v3.bin (needed only for
 *                                        the offline translate-to-English provider)
 *   node scripts/setup.js --force        re-download even if files already exist
 *
 * Zero npm dependencies: plain https + Windows' built-in tar.exe (bsdtar) for zips.
 */
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const DL = path.join(TOOLS, '_downloads');

const FULL_MODEL = process.argv.includes('--full-model');
const FORCE = process.argv.includes('--force');

const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const MODEL_TURBO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
const MODEL_FULL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';

function log(msg) { console.log(msg); }

// ---- plain-https helpers (redirect-following) -------------------------------

function request(url, headers, cb, redirects) {
  redirects = redirects || 0;
  if (redirects > 10) return cb(new Error('too many redirects for ' + url));
  const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'video-editor-setup' }, headers || {}) }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      const loc = new URL(res.headers.location, url).toString();
      return request(loc, headers, cb, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error('HTTP ' + res.statusCode + ' for ' + url));
    }
    cb(null, res);
  });
  req.on('error', cb);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    request(url, { Accept: 'application/vnd.github+json' }, (err, res) => {
      if (err) return reject(err);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
  });
}

function download(url, dest, label) {
  return new Promise((resolve, reject) => {
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log(`  ${label}: already downloaded, skipping (${fmtMB(fs.statSync(dest).size)})`);
      return resolve(dest);
    }
    log(`  ${label}: downloading ${url}`);
    const tmp = dest + '.part';
    request(url, null, (err, res) => {
      if (err) return reject(err);
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -10;
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) { lastPct = pct; log(`    ${label}: ${pct}% of ${fmtMB(total)}`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          log(`  ${label}: done (${fmtMB(got)})`);
          resolve(dest);
        });
      });
      out.on('error', reject);
      res.on('error', reject);
    });
  });
}

function fmtMB(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

// ---- zip extraction via Windows built-in bsdtar ------------------------------

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar extraction failed for ' + zipPath);
}

function findFile(dir, nameRe) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, nameRe);
      if (hit) return hit;
    } else if (nameRe.test(entry.name)) {
      return p;
    }
  }
  return null;
}

// ---- smoke tests --------------------------------------------------------------

function run(exe, args, timeoutMs) {
  return spawnSync(exe, args, { timeout: timeoutMs || 60000, encoding: 'utf8' });
}

function testFfmpeg(ffmpeg) {
  const r = run(ffmpeg, ['-version']);
  return r.status === 0 && /ffmpeg version/.test(r.stdout || '');
}

function testNvenc(ffmpeg) {
  const r = run(ffmpeg, ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.5',
    '-c:v', 'h264_nvenc', '-f', 'null', '-'], 120000);
  return r.status === 0;
}

function makeProbeWav(ffmpeg) {
  const wav = path.join(DL, 'probe.wav');
  const r = run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    '-t', '1', wav]);
  if (r.status !== 0) throw new Error('could not generate probe wav');
  return wav;
}

function testWhisper(whisperExe, model, wav, timeoutMs) {
  // A 1-second silent wav should transcribe (to nothing) quickly. On an
  // unsupported GPU the CUDA build may crash or hang in PTX JIT — the timeout
  // catches both, and the caller falls back to the CPU build.
  const r = run(whisperExe, ['-m', model, '-f', wav, '-np'], timeoutMs);
  return r.status === 0;
}

// ---- main ---------------------------------------------------------------------

(async () => {
  fs.mkdirSync(DL, { recursive: true });
  const manifest = { createdAt: new Date().toISOString() };

  // 1. ffmpeg + ffprobe
  log('[1/4] ffmpeg');
  const ffZip = path.join(DL, 'ffmpeg.zip');
  await download(FFMPEG_URL, ffZip, 'ffmpeg');
  const ffDir = path.join(TOOLS, 'ffmpeg');
  if (FORCE || !fs.existsSync(path.join(ffDir, 'ffmpeg.exe'))) {
    const tmpDir = path.join(DL, 'ffmpeg-extract');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    extractZip(ffZip, tmpDir);
    fs.mkdirSync(ffDir, { recursive: true });
    for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = findFile(tmpDir, new RegExp('^' + exe + '$', 'i'));
      if (!src) throw new Error(exe + ' not found in ffmpeg zip');
      fs.copyFileSync(src, path.join(ffDir, exe));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  manifest.ffmpeg = path.join(ffDir, 'ffmpeg.exe');
  manifest.ffprobe = path.join(ffDir, 'ffprobe.exe');
  if (!testFfmpeg(manifest.ffmpeg)) throw new Error('ffmpeg smoke test failed');
  log('  ffmpeg: OK');
  manifest.nvenc = testNvenc(manifest.ffmpeg);
  log('  h264_nvenc: ' + (manifest.nvenc ? 'available' : 'NOT available (will use libx264)'));

  // 2. whisper.cpp binaries (GPU preferred, CPU always kept as fallback)
  log('[2/4] whisper.cpp');
  const rel = await fetchJson(WHISPER_RELEASE_API);
  const assets = (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
  log('  latest release: ' + rel.tag_name + ' (' + assets.length + ' assets)');
  const gpuAsset =
    assets.find((a) => /vulkan.*x64.*\.zip$/i.test(a.name)) ||
    assets.filter((a) => /cu(blas|da).*x64\.zip$/i.test(a.name)).sort((x, y) => x.name.localeCompare(y.name)).pop() ||
    null;
  const cpuAsset =
    assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) ||
    assets.find((a) => /bin-x64\.zip$/i.test(a.name) && !/cu(blas|da)|vulkan|blas/i.test(a.name)) ||
    null;
  if (!cpuAsset) throw new Error('no CPU whisper binary found in latest release — check https://github.com/ggml-org/whisper.cpp/releases');

  const cpuZip = path.join(DL, 'whisper-cpu.zip');
  await download(cpuAsset.url, cpuZip, 'whisper (CPU)');
  const cpuDir = path.join(TOOLS, 'whisper-cpu');
  if (FORCE || !fs.existsSync(cpuDir)) extractZip(cpuZip, cpuDir);

  let gpuDir = null;
  if (gpuAsset) {
    log('  GPU build: ' + gpuAsset.name);
    const gpuZip = path.join(DL, 'whisper-gpu.zip');
    await download(gpuAsset.url, gpuZip, 'whisper (GPU)');
    gpuDir = path.join(TOOLS, 'whisper-gpu');
    if (FORCE || !fs.existsSync(gpuDir)) extractZip(gpuZip, gpuDir);
  } else {
    log('  no GPU build in this release; CPU only');
  }

  // whisper-cli.exe in modern releases; main.exe in old ones
  const cliRe = /^(whisper-cli|main)\.exe$/i;
  const cpuExe = findFile(cpuDir, cliRe);
  if (!cpuExe) throw new Error('whisper CLI exe not found in CPU zip');
  const gpuExe = gpuDir ? findFile(gpuDir, cliRe) : null;

  // 3. model(s)
  log('[3/4] speech model');
  const modelsDir = path.join(TOOLS, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const turboModel = path.join(modelsDir, 'ggml-large-v3-turbo.bin');
  await download(MODEL_TURBO_URL, turboModel, 'ggml-large-v3-turbo');
  manifest.models = { turbo: turboModel, full: null };
  if (FULL_MODEL) {
    const fullModel = path.join(modelsDir, 'ggml-large-v3.bin');
    await download(MODEL_FULL_URL, fullModel, 'ggml-large-v3');
    manifest.models.full = fullModel;
  } else {
    log('  (skipping ggml-large-v3.bin — rerun with --full-model to enable the offline English-translation provider)');
  }

  // 4. whisper smoke test: GPU first, fall back to CPU
  log('[4/4] whisper smoke test');
  const wav = makeProbeWav(manifest.ffmpeg);
  let chosenExe = null, backend = null;
  if (gpuExe) {
    log('  testing GPU build (first run may take a few minutes if the driver JIT-compiles kernels)...');
    if (testWhisper(gpuExe, turboModel, wav, 300000)) {
      chosenExe = gpuExe; backend = 'gpu';
      log('  GPU build: OK');
    } else {
      log('  GPU build FAILED on this machine — falling back to CPU build');
    }
  }
  if (!chosenExe) {
    log('  testing CPU build...');
    if (!testWhisper(cpuExe, turboModel, wav, 300000)) throw new Error('whisper CPU smoke test failed');
    chosenExe = cpuExe; backend = 'cpu';
    log('  CPU build: OK');
  }
  manifest.whisperExe = chosenExe;
  manifest.whisperBackend = backend;
  manifest.whisperCpuExe = cpuExe;
  manifest.whisperRelease = rel.tag_name;

  await fsp.writeFile(path.join(TOOLS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('');
  log('Setup complete. tools/manifest.json written:');
  log(JSON.stringify(manifest, null, 2));
})().catch((err) => {
  console.error('SETUP FAILED: ' + err.message);
  process.exit(1);
});
