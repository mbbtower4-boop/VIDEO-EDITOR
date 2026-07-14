'use strict';
/*
 * One-time setup for VIDEO EDITOR. Downloads the external tools the app needs
 * into the gitignored tools/ directory, smoke-tests them, and records the
 * results in tools/manifest.json (read by the app at startup).
 *
 *   node scripts/setup.js            downloads ffmpeg + whisper.cpp + large-v3-turbo model
 *                                    + llama.cpp with a local LLM (for the offline tasks report)
 *   node scripts/setup.js --full-model   also downloads ggml-large-v3.bin (needed only for
 *                                        the offline translate-to-English provider)
 *   node scripts/setup.js --no-llm       skip the local LLM (~5 GB); the tasks report then
 *                                        needs a Claude API key
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
const NO_LLM = process.argv.includes('--no-llm');
const FORCE = process.argv.includes('--force');

const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const MODEL_TURBO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
const MODEL_FULL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';
// last-resort model for low-RAM machines (~466 MB, runs anywhere)
const MODEL_SMALL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
const LLAMA_RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
// Multilingual instruct model (good Hebrew/Russian), single-file GGUF, ~4.7 GB
const LLM_MODEL_URL = 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf';

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
  if (r.status === 0) return true;
  // say WHY it failed, so remote debugging is possible
  if (r.error && String(r.error.code || '').includes('TIMEDOUT')) {
    log('    (test timed out after ' + Math.round((timeoutMs || 60000) / 1000) + 's)');
  } else {
    log('    (exit code ' + r.status + (r.signal ? ', signal ' + r.signal : '') + ')');
    const tail = (r.stderr || '').trim().split(/\r?\n/).slice(-4).join('\n    ');
    if (tail) log('    ' + tail);
  }
  return false;
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

  // whisper-cli.exe in modern releases; main.exe in old ones. Modern zips ALSO
  // ship a main.exe that is only a deprecation stub (exits with an error), so
  // whisper-cli.exe must be preferred, never matched alongside.
  const findCli = (dir) => findFile(dir, /^whisper-cli\.exe$/i) || findFile(dir, /^main\.exe$/i);
  const cpuExe = findCli(cpuDir);
  if (!cpuExe) throw new Error('whisper CLI exe not found in CPU zip');
  const gpuExe = gpuDir ? findCli(gpuDir) : null;

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
  let defaultModel = turboModel;
  if (!chosenExe) {
    log('  testing CPU build...');
    if (testWhisper(cpuExe, turboModel, wav, 300000)) {
      chosenExe = cpuExe; backend = 'cpu';
      log('  CPU build: OK');
    } else {
      // Most common cause: not enough free RAM for the 1.6 GB turbo model.
      // Last resort: the small model (~466 MB) runs on any machine.
      log('  CPU build failed with the large model — trying the small model (works on low-RAM PCs)...');
      const smallModel = path.join(modelsDir, 'ggml-small.bin');
      await download(MODEL_SMALL_URL, smallModel, 'ggml-small');
      if (!testWhisper(cpuExe, smallModel, wav, 300000)) {
        throw new Error('whisper failed on this machine with both models. ' +
          'Common causes: less than 4 GB free RAM, or antivirus blocking whisper-cli.exe ' +
          '(add an exclusion for the tools folder and re-run: npm run setup).');
      }
      chosenExe = cpuExe; backend = 'cpu';
      defaultModel = smallModel;
      manifest.models.small = smallModel;
      log('  CPU build with small model: OK (transcription quality will be reduced)');
    }
  }
  manifest.models.default = defaultModel;
  manifest.whisperExe = chosenExe;
  manifest.whisperBackend = backend;
  manifest.whisperCpuExe = cpuExe;
  manifest.whisperRelease = rel.tag_name;

  // 5. local LLM (llama.cpp + GGUF model) for the offline tasks report
  if (NO_LLM) {
    log('[5/5] local LLM: skipped (--no-llm) — the tasks report will need a Claude API key');
  } else {
    log('[5/5] local LLM (llama.cpp + Qwen2.5-7B)');
    const lrel = await fetchJson(LLAMA_RELEASE_API);
    const lassets = (lrel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
    log('  latest llama.cpp release: ' + lrel.tag_name);
    // Prefer Vulkan (single zip, any GPU); else CUDA (+ separate cudart zip).
    const lgpu = lassets.find((a) => /bin-win-vulkan.*x64\.zip$/i.test(a.name)) ||
      lassets.find((a) => /bin-win-cuda.*x64\.zip$/i.test(a.name)) || null;
    const lcudart = (lgpu && /cuda/i.test(lgpu.name))
      ? lassets.find((a) => /^cudart-.*win.*\.zip$/i.test(a.name)) : null;
    const lcpu = lassets.find((a) => /bin-win-cpu-x64\.zip$/i.test(a.name)) ||
      lassets.find((a) => /bin-win-(avx2|noavx)-x64\.zip$/i.test(a.name)) || null;
    if (!lgpu && !lcpu) {
      log('  WARNING: no usable llama.cpp Windows asset found — skipping local LLM.');
      log('  assets were: ' + lassets.map((a) => a.name).join(', '));
    } else {
      const llmModel = path.join(TOOLS, 'models', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf');
      await download(LLM_MODEL_URL, llmModel, 'Qwen2.5-7B-Instruct (LLM)');
      let lgpuDir = null, lcpuDir = null;
      if (lgpu) {
        const z = path.join(DL, 'llama-gpu.zip');
        await download(lgpu.url, z, 'llama.cpp (' + (/vulkan/i.test(lgpu.name) ? 'Vulkan' : 'CUDA') + ')');
        lgpuDir = path.join(TOOLS, 'llama-gpu');
        if (FORCE || !fs.existsSync(lgpuDir)) extractZip(z, lgpuDir);
        if (lcudart) {
          const cz = path.join(DL, 'llama-cudart.zip');
          await download(lcudart.url, cz, 'CUDA runtime for llama.cpp');
          extractZip(cz, lgpuDir);
        }
      }
      if (lcpu) {
        const z = path.join(DL, 'llama-cpu.zip');
        await download(lcpu.url, z, 'llama.cpp (CPU)');
        lcpuDir = path.join(TOOLS, 'llama-cpu');
        if (FORCE || !fs.existsSync(lcpuDir)) extractZip(z, lcpuDir);
      }
      const findLlama = (dir) => dir ? findFile(dir, /^llama-cli\.exe$/i) : null;
      const lgpuExe = findLlama(lgpuDir), lcpuExe = findLlama(lcpuDir);
      // smoke test: a tiny single-turn generation (-ngl 99 offloads to GPU)
      const llamaTest = (exe) => {
        const r = run(exe, ['-m', llmModel, '-p', 'Reply with the single word OK', '-n', '8',
          '-st', '--no-display-prompt', '-ngl', '99', '--temp', '0'], 300000);
        return r.status === 0;
      };
      let llamaExe = null, llamaBackend = null;
      if (lgpuExe) {
        log('  testing llama.cpp GPU build (loads the 4.7 GB model — takes a minute)...');
        if (llamaTest(lgpuExe)) { llamaExe = lgpuExe; llamaBackend = 'gpu'; log('  GPU build: OK'); }
        else log('  GPU build FAILED — falling back to CPU build');
      }
      if (!llamaExe && lcpuExe) {
        log('  testing llama.cpp CPU build...');
        if (llamaTest(lcpuExe)) { llamaExe = lcpuExe; llamaBackend = 'cpu'; log('  CPU build: OK'); }
        else log('  CPU build FAILED too — local tasks report will be unavailable');
      }
      if (llamaExe) {
        manifest.llamaExe = llamaExe;
        manifest.llamaBackend = llamaBackend;
        manifest.llamaRelease = lrel.tag_name;
        manifest.models.llm = llmModel;
      }
    }
  }

  await fsp.writeFile(path.join(TOOLS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('');
  log('Setup complete. tools/manifest.json written:');
  log(JSON.stringify(manifest, null, 2));
})().catch((err) => {
  console.error('SETUP FAILED: ' + err.message);
  process.exit(1);
});
