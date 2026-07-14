'use strict';
/*
 * tasks.js — extract "mission tasks" for workers from the video transcript,
 * for the Word (.docx) report. Two engines:
 *   'local'  — llama.cpp model on this machine, fully offline (default)
 *   'claude' — Claude API (only the transcript TEXT is sent)
 * The .docx itself is always generated locally by videoOps.makeDocx.
 *
 * The full transcript is ALWAYS covered: transcripts too long for the local
 * model's context window are split into parts, each part is processed, and
 * the task lists are merged (duplicates dropped).
 */
const ops = require('../src/videoOps.js');
const { callClaude } = require('./translate/claude.js');
const localllm = require('./localllm.js');

// ~60k chars ≈ 17k tokens even for Hebrew — safely inside the 32k window
// with room for the instructions and the reply.
const LOCAL_CHUNK_CHARS = 60000;

async function runLocal(manifest, cues, langName, partLabel, jobId) {
  const transcript = cues.map((c) => String(c.text).trim()).filter(Boolean).join('\n');
  const prompt = ops.buildTasksPrompt(transcript, langName) +
    (partLabel ? '\n(Note: this is ' + partLabel + ' of a longer video.)' : '');
  try {
    return ops.parseTasksResponse(await localllm.generate(manifest, prompt, jobId));
  } catch (e) {
    // Small local models occasionally wrap or truncate the JSON — one retry
    // with an explicit reminder fixes almost all of it.
    const retry = await localllm.generate(manifest,
      prompt + '\n\nIMPORTANT: reply with ONLY the JSON object, nothing else.', jobId);
    return ops.parseTasksResponse(retry);
  }
}

async function generateTasks(engine, manifest, cues, langName, settings, onProgress, jobId) {
  const nonEmpty = cues.filter((c) => String(c.text).trim());
  if (!nonEmpty.length) throw new Error('The transcript is empty.');
  if (onProgress) onProgress(0.1);

  if (engine === 'claude') {
    if (!settings.claudeApiKey) {
      throw new Error('The Claude engine needs an API key — add one in Settings, or switch to the local model.');
    }
    const transcript = nonEmpty.map((c) => c.text.trim()).join('\n');
    const reply = await callClaude(settings.claudeApiKey, settings.claudeModel,
      ops.buildTasksPrompt(transcript, langName), 8192);
    if (onProgress) onProgress(0.9);
    return ops.parseTasksResponse(reply);
  }

  const chunks = ops.splitCuesForTasks(nonEmpty, LOCAL_CHUNK_CHARS);
  const reports = [];
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1 ? 'part ' + (i + 1) + ' of ' + chunks.length : '';
    reports.push(await runLocal(manifest, chunks[i], langName, label, jobId));
    if (onProgress) onProgress(0.1 + 0.8 * ((i + 1) / chunks.length));
  }
  return ops.mergeTaskReports(reports);
}

module.exports = { generateTasks };
