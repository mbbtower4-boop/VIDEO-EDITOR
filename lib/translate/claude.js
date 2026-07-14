'use strict';
/*
 * claude.js — subtitle translation via the Anthropic Messages API using
 * Node's built-in fetch (no SDK dependency). Only subtitle TEXT is sent;
 * video and audio never leave the machine.
 */
const ops = require('../../src/videoOps.js');

const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(apiKey, model, prompt) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (res.status === 429 || res.status === 529) {
      lastErr = new Error('Claude API is rate-limited (HTTP ' + res.status + ')');
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (res.status === 401) throw new Error('Claude API rejected the key (401) — check it in Settings.');
    if (!res.ok) {
      const body = await res.text();
      throw new Error('Claude API error ' + res.status + ': ' + body.slice(0, 300));
    }
    const json = await res.json();
    return (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  throw lastErr;
}

// cues → array of translated strings aligned by index.
async function translate(cues, targetCode, settings, onProgress) {
  if (!settings.claudeApiKey) {
    throw new Error('No Claude API key set — add one in Settings, or pick another provider.');
  }
  const lang = ops.langByCode(targetCode);
  const chunks = ops.chunkCuesForTranslation(cues);
  const out = new Array(cues.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prompt = ops.buildClaudePrompt(chunk.lines, lang.name);
    const reply = await callClaude(settings.claudeApiKey, settings.claudeModel, prompt);
    const lines = ops.parseNumberedResponse(reply, chunk.lines.length);
    chunk.indices.forEach((cueIdx, j) => { out[cueIdx] = lines[j]; });
    if (onProgress) onProgress((i + 1) / chunks.length);
  }
  return out;
}

module.exports = { translate };
