'use strict';
/*
 * tasks.js — extract "mission tasks" for workers from the video transcript,
 * for the Word (.docx) report. Two engines:
 *   'local'  — llama.cpp model on this machine, fully offline (default)
 *   'claude' — Claude API (only the transcript TEXT is sent)
 * The .docx itself is always generated locally by videoOps.makeDocx.
 */
const ops = require('../src/videoOps.js');
const { callClaude } = require('./translate/claude.js');
const localllm = require('./localllm.js');

async function generateTasks(engine, manifest, cues, langName, settings, onProgress, jobId) {
  const transcript = cues.map((c) => String(c.text).trim()).filter(Boolean).join('\n');
  if (!transcript) throw new Error('The transcript is empty.');
  const prompt = ops.buildTasksPrompt(transcript, langName);
  if (onProgress) onProgress(0.15);

  let reply;
  if (engine === 'claude') {
    if (!settings.claudeApiKey) {
      throw new Error('The Claude engine needs an API key — add one in Settings, or switch to the local model.');
    }
    reply = await callClaude(settings.claudeApiKey, settings.claudeModel, prompt, 8192);
  } else {
    reply = await localllm.generate(manifest, prompt, jobId);
  }
  if (onProgress) onProgress(0.85);

  try {
    return ops.parseTasksResponse(reply);
  } catch (e) {
    // Small local models occasionally wrap or truncate the JSON — one retry
    // with an explicit reminder fixes almost all of it.
    if (engine === 'claude') throw e;
    const retry = await localllm.generate(manifest,
      prompt + '\n\nIMPORTANT: reply with ONLY the JSON object, nothing else.', jobId);
    return ops.parseTasksResponse(retry);
  }
}

module.exports = { generateTasks };
