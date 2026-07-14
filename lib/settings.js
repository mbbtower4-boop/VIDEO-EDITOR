'use strict';
/*
 * settings.js — JSON settings file in Electron's userData directory, owned by
 * the main process so the Claude API key never enters the renderer. The
 * renderer receives a sanitized copy (key masked to its last 4 characters).
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // detection
  mode: 'silence',          // 'silence' | 'freeze' | 'both'
  noiseDb: -35,             // silencedetect threshold
  minSilence: 1.0,          // seconds of silence before it counts
  padLead: 0.25,            // silence kept right after speech ends
  padTail: 0.25,            // silence kept right before speech resumes
  minCut: 0.8,              // ignore cuts shorter than this
  freezeNoise: -60,
  freezeDur: 2,
  // export
  useNvenc: true,
  exportSuffix: '_trimmed',
  // translation / tasks
  provider: 'claude',
  tasksEngine: 'local',     // 'local' (offline llama.cpp) | 'claude'
  claudeApiKey: '',
  claudeModel: 'claude-opus-4-8',
  myMemoryEmail: '',
};

let filePath = null;
let cache = null;

function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');
  try {
    cache = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    cache = Object.assign({}, DEFAULTS);
  }
}

function get() { return cache; }

function getSanitized() {
  const out = Object.assign({}, cache);
  out.claudeApiKeySet = !!cache.claudeApiKey;
  out.claudeApiKey = cache.claudeApiKey
    ? '****' + cache.claudeApiKey.slice(-4)
    : '';
  return out;
}

function set(patch) {
  // A masked key echoed back from the renderer must not overwrite the real one.
  if (patch.claudeApiKey && patch.claudeApiKey.startsWith('****')) delete patch.claudeApiKey;
  cache = Object.assign({}, cache, patch);
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
  return getSanitized();
}

module.exports = { init, get, getSanitized, set, DEFAULTS };
