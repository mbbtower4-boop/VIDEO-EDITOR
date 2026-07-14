'use strict';
/*
 * tools.js — locates the external binaries (via tools/manifest.json written by
 * scripts/setup.js) and provides spawn helpers with output capture, progress
 * callbacks and a cancellable job registry. Main-process only.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'tools', 'manifest.json');

function loadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const ok = [m.ffmpeg, m.ffprobe, m.whisperExe, m.models && m.models.turbo]
      .every((p) => p && fs.existsSync(p));
    return Object.assign({ ok }, m);
  } catch (e) {
    return { ok: false, missing: true };
  }
}

// One live child per job id; a second job with the same id kills the first.
const jobs = new Map();

function cancelJob(jobId) {
  const child = jobs.get(jobId);
  if (child) {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    jobs.delete(jobId);
    return true;
  }
  return false;
}

/*
 * Spawn a process and capture its output.
 * opts: { jobId, binaryStdout (collect stdout as Buffer instead of text),
 *         onStdout(textChunk), onStderr(textChunk) }
 * Resolves { code, stdout, stderr, killed }. Never rejects on non-zero exit —
 * callers inspect `code` so they can build good error messages from stderr.
 */
function run(exe, args, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    if (o.jobId) {
      cancelJob(o.jobId); // only one job per slot
      jobs.set(o.jobId, child);
    }
    const outChunks = [];
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => {
      if (o.binaryStdout) outChunks.push(d);
      else {
        const t = d.toString('utf8');
        stdout += t;
        if (o.onStdout) o.onStdout(t);
      }
    });
    child.stderr.on('data', (d) => {
      const t = d.toString('utf8');
      stderr += t;
      // keep memory bounded on chatty encodes
      if (stderr.length > 400000) stderr = stderr.slice(-200000);
      if (o.onStderr) o.onStderr(t);
    });
    child.on('error', (err) => {
      if (o.jobId) jobs.delete(o.jobId);
      reject(err);
    });
    child.on('close', (code, signal) => {
      const killed = o.jobId ? jobs.get(o.jobId) !== child : false;
      if (o.jobId && jobs.get(o.jobId) === child) jobs.delete(o.jobId);
      resolve({
        code,
        stdout: o.binaryStdout ? Buffer.concat(outChunks) : stdout,
        stderr,
        killed: killed || signal === 'SIGKILL',
      });
    });
  });
}

module.exports = { loadManifest, run, cancelJob, MANIFEST_PATH };
