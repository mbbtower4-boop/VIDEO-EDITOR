'use strict';
/*
 * localllm.js — run the local llama.cpp model (offline alternative to the
 * Claude API for the tasks report). The prompt is written to a temp file to
 * dodge the Windows command-line length limit.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ops = require('../src/videoOps.js');
const tools = require('./tools.js');

function available(manifest) {
  return !!(manifest.llamaExe && manifest.models && manifest.models.llm);
}

async function generate(manifest, prompt, jobId) {
  if (!available(manifest)) {
    throw new Error('Local AI model not installed — run: npm run setup (or use the Claude API in Settings).');
  }
  const promptFile = path.join(os.tmpdir(), 'video-editor-llm-' + Date.now() + '.txt');
  await fs.writeFile(promptFile, prompt, 'utf8');
  try {
    const r = await tools.run(manifest.llamaExe,
      ops.buildLlamaArgs(manifest.models.llm, promptFile), { jobId });
    if (r.killed) throw new Error('cancelled');
    if (r.code !== 0) throw new Error('local model failed: ' + (r.stderr || '').slice(-400));
    return r.stdout;
  } finally {
    fs.unlink(promptFile).catch(() => {});
  }
}

module.exports = { available, generate };
