'use strict';
/*
 * tasks.js — extract "mission tasks" for workers from the video transcript
 * using the Claude API, for the Word (.docx) report. Only the transcript TEXT
 * is sent; the .docx itself is generated locally by videoOps.makeDocx.
 */
const ops = require('../src/videoOps.js');
const { callClaude } = require('./translate/claude.js');

async function generateTasks(cues, langName, settings, onProgress) {
  if (!settings.claudeApiKey) {
    throw new Error('The tasks report needs a Claude API key — add one in Settings.');
  }
  const transcript = cues.map((c) => String(c.text).trim()).filter(Boolean).join('\n');
  if (!transcript) throw new Error('The transcript is empty.');
  if (onProgress) onProgress(0.15);
  const reply = await callClaude(settings.claudeApiKey, settings.claudeModel,
    ops.buildTasksPrompt(transcript, langName), 8192);
  if (onProgress) onProgress(0.9);
  return ops.parseTasksResponse(reply);
}

module.exports = { generateTasks };
