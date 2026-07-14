# Changelog

## 1.0.0 — 2026-07-14

Initial release.

- Dead-time removal: automatic silence detection (ffmpeg `silencedetect`) and
  frozen-picture detection (`freezedetect`), interactive timeline review
  (toggle / drag / add / delete cuts), preview-with-cuts playback, and
  frame-accurate export with NVENC GPU encoding (automatic libx264 fallback).
- Subtitles: fully local transcription with whisper.cpp (`large-v3-turbo`,
  GPU with CPU fallback), automatic language detection.
- Translation to Hebrew, English, Russian and Belarusian with three selectable
  methods: Claude API, MyMemory free web API, and offline Whisper
  translate-to-English.
- Delivery: per-language `.srt` export (UTF-8 BOM, RTL-safe), soft subtitle
  tracks embedded into MP4 with language tags, and burn-in via libass.
- `npm run setup` downloader for ffmpeg / whisper.cpp / models with smoke
  tests and `tools/manifest.json`; `scripts/verify.js` headless end-to-end
  pipeline check; 85 headless engine tests (`npm test`).
