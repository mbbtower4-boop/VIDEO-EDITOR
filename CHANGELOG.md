# Changelog

## 1.2.0 — 2026-07-14

- The tasks report no longer requires an API key: new **local AI engine**
  (llama.cpp + Qwen2.5-7B-Instruct, ~4.7 GB one-time download via
  `npm run setup`, GPU-accelerated with CPU fallback, fully offline). It is
  now the default; the Claude API remains available as the quality option —
  switch in Settings → "Tasks report engine". `npm run setup -- --no-llm`
  skips the download.

## 1.1.0 — 2026-07-14

- New: **Tasks report (Word)** — extracts actionable "mission tasks" for
  workers from the video's speech (via the Claude API; only the transcript
  text is sent) and saves them as a `.docx` checklist with title, details and
  priority markers. Generated in the language of the selected tab, with full
  RTL layout for Hebrew. The .docx writer is built in (zero dependencies) and
  covered by headless tests.

## 1.0.3 — 2026-07-14

- Manual cuts: drag across an empty part of the cuts lane to mark any exact
  range for removal (live red preview while dragging). Right-click quick
  add/delete and edge-dragging still work as before.

## 1.0.2 — 2026-07-14

- The running version is now shown in the window title bar (in addition to the
  toolbar), so it's always clear which build is running.
- The post-export message now spells out the subtitle steps (Transcribe →
  Translate → Burn-in / Embed tracks).

## 1.0.1 — 2026-07-14

- Setup: prefer `whisper-cli.exe` over `main.exe` when scanning the whisper.cpp
  zip — modern releases ship `main.exe` only as a deprecation stub that exits
  with an error, which made the smoke test fail on both GPU and CPU builds.
- Export: use `-/filter_complex <file>` instead of `-filter_complex_script`,
  which was removed in ffmpeg 8 (the BtbN "latest" builds).
- Verified end-to-end on real hardware: RTX 5090 runs the CUDA whisper build
  (v1.9.1) and NVENC export at ~11× realtime.

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
