'use strict';
/*
 * mymemory.js — free translation via api.mymemory.translated.net. One request
 * per subtitle line (it is a phrase API), throttled. Free quota: ~5000
 * chars/day anonymous, ~50000/day when an email is provided in Settings.
 */

const BASE = 'https://api.mymemory.translated.net/get';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function translateLine(text, srcCode, targetCode, email) {
  const params = new URLSearchParams({ q: text, langpair: srcCode + '|' + targetCode });
  if (email) params.set('de', email);
  const res = await fetch(BASE + '?' + params.toString());
  if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
  const json = await res.json();
  if (json.responseStatus && json.responseStatus !== 200) {
    throw new Error('MyMemory: ' + (json.responseDetails || ('status ' + json.responseStatus)));
  }
  return json.responseData.translatedText;
}

// cues → array of translated strings aligned by index. srcCode is required
// (MyMemory has no auto-detect) — it comes from Whisper's detected language.
async function translate(cues, targetCode, settings, onProgress, srcCode) {
  if (!srcCode) throw new Error('Source language unknown — transcribe first.');
  const out = new Array(cues.length);
  for (let i = 0; i < cues.length; i++) {
    const text = String(cues[i].text).replace(/\s+/g, ' ').trim();
    out[i] = text ? await translateLine(text, srcCode, targetCode, settings.myMemoryEmail) : '';
    if (onProgress) onProgress((i + 1) / cues.length);
    await sleep(150); // stay polite; the free tier rate-limits
  }
  return out;
}

module.exports = { translate };
