# VIDEO EDITOR

A local, offline-first desktop video editor for one job done well: **removing
dead time** (silence and frozen picture) from MP4 videos, and producing
**translated subtitles** — Hebrew, English, Russian and Belarusian — from a
speech transcription that runs entirely on your own machine.

Built with Electron + vanilla HTML/CSS/JS, no frameworks, no build step.

**New user? See [INSTRUCTIONS.md](INSTRUCTIONS.md)** — a step-by-step install
and usage guide in English and Hebrew.

## Setup (one time)

```bash
npm install          # fetches Electron
npm run setup        # downloads external tools into tools/ (~2.5 GB, see below)
```

`npm run setup` downloads and smoke-tests:

| Tool | What for | Size |
|---|---|---|
| ffmpeg + ffprobe ([BtbN builds](https://github.com/BtbN/FFmpeg-Builds), GPL, includes NVENC + libass) | analysis, cutting, encoding, subtitles | ~170 MB |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (GPU build + small CPU fallback) | local speech-to-text | ~650 MB |
| `ggml-large-v3-turbo` model | transcription (all languages) | ~1.6 GB |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) + Qwen2.5-7B-Instruct | offline tasks report (skip with `--no-llm`) | ~4.8 GB |

The script probes the GPU build on your machine and **automatically falls back
to the CPU build** if it fails (relevant on very new GPU generations). Optional:
`npm run setup -- --full-model` also downloads `ggml-large-v3.bin` (~3.1 GB),
which is required only for the fully-offline translate-to-English provider —
the turbo model cannot translate.

After setup: `node scripts/verify.js` runs the whole pipeline headlessly on the
smallest video in `samples/` and reports each stage.

## Run

Double-click `VideoEditor.vbs`, or `npm start`. Do **not** run as
administrator — it breaks Explorer drag-and-drop and hides network drives.

## Share with others (portable package)

`npm run pack` builds `dist-portable/VideoEditor-<version>/` — a zero-install
folder (~10.5 GB with all models): the recipient unzips and double-clicks
`VideoEditor.exe`. No Node, no npm, no setup. Works with or without an NVIDIA
GPU (CPU fallback is bundled). Flags: `--zip` also produces the .zip,
`--no-llm` / `--no-full-model` shrink it by ~5 / ~3 GB.

## Workflow

1. **Open** a video → it is analyzed automatically (waveform + silence +
   frozen-picture detection).
2. Review the timeline: amber = silence, blue = frozen picture, red = proposed
   cuts. Click a cut to keep/remove it, drag its edges to adjust, **drag across
   an empty part of the cuts lane to manually mark any range for removal**,
   right-click for quick add/delete. "Preview with cuts" plays the video
   skipping everything that will be removed. Detection sliders on the right
   re-derive cuts instantly; threshold changes need "Re-analyze".
3. **Export** writes the trimmed MP4 (GPU-encoded with NVENC when available —
   a 25-minute video takes ~1–3 minutes; falls back to libx264 automatically).
4. **Transcribe** runs whisper.cpp locally on the trimmed file (audio never
   leaves your PC) and auto-detects the spoken language.
5. **Translate** each language tab with your choice of method, then save `.srt`
   files, **Embed tracks** (selectable subtitle tracks in one MP4), or
   **Burn-in** one language into the picture.
6. **Tasks report (Word)** turns the speech into an actionable task checklist
   for workers (`.docx`, in the language of the selected tab, RTL-aware).
   Runs fully offline by default on a local AI model (llama.cpp +
   Qwen2.5-7B-Instruct, installed by `npm run setup`); switch to the Claude
   API in Settings for the highest quality (only transcript text is sent).

## Translation methods

| Method | Languages | Notes |
|---|---|---|
| **Claude API** | he, en, ru, be | Best quality. Needs an API key (Settings). Only subtitle *text* is sent — never audio or video. Cost is a few cents per video. |
| **MyMemory (free)** | he, en, ru, be | No key needed. Free quota ~5,000 chars/day (anonymous) or ~50,000/day with a contact email in Settings. Machine-translation quality, weaker for Belarusian. |
| **Whisper offline** | en only | 100% offline. Re-runs Whisper with its built-in translate task; requires the `--full-model` download. |

## Hebrew / RTL notes

- `.srt` files are UTF-8 with BOM, logical order — VLC / MPC-HC / players with
  proper bidi render them correctly.
- Embedded tracks are tagged (`heb`/`eng`/`rus`/`bel`) so players show a
  proper language menu.
- Burn-in renders through libass with the Segoe UI font, which covers both
  Hebrew and Cyrillic.

## Tests

```bash
npm test        # node test/ops.test.js — 85 headless checks, needs Node only
```

All parsing, segment math, SRT and ffmpeg-argument logic lives in
`src/videoOps.js`, a dependency-free UMD module tested without any binaries.

## Architecture

```
main.js               window + dialogs + IPC; spawns all subprocesses
preload.js            tiny window.api bridge (contextIsolation on)
lib/                  main-process modules: tools/spawn registry, analysis,
                      export, whisper, translation providers, settings
src/videoOps.js       pure logic engine (UMD, runs in renderer + Node tests)
src/app.js            UI: timeline canvas, cut review, subtitles panel
scripts/setup.js      downloads tools/ and writes tools/manifest.json
scripts/verify.js     headless end-to-end pipeline check
```

Settings (including the Claude API key, stored as plain text) live in
`%APPDATA%/video-editor/settings.json` and never enter the renderer process.
