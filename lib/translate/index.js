'use strict';
/*
 * translate/index.js — provider registry. Text providers translate cue text;
 * the 'whisperEn' provider is special: it re-runs Whisper on the video's audio
 * with the built-in any→English task, so main routes it to transcribe.js
 * instead (see main.js).
 */
const claude = require('./claude.js');
const mymemory = require('./mymemory.js');

const textProviders = { claude, mymemory };

function getTextProvider(id) {
  return textProviders[id] || null;
}

module.exports = { getTextProvider };
