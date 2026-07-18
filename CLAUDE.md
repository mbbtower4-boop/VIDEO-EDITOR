# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app (English UI, dark theme, vanilla HTML/CSS/JS, **zero runtime npm
dependencies** — keep it that way): removes dead time (silence / frozen picture) from
videos, transcribes speech locally with whisper.cpp, translates subtitles
(he/en/ru/be), and extracts a "mission tasks" Word checklist from the speech via a
local llama.cpp model or the Claude API. Local-first: video/audio never leave the
machine; only subtitle/transcript *text* may be sent to a translation/API provider
the user selected.

## Commands

```bash
npm install                  # Electron only (the single devDependency)
npm start                    # launch the app
npm test                     # node test/ops.test.js — headless engine tests, needs Node only
npm run setup                # one-time: download ffmpeg + whisper.cpp + llama.cpp + models
                             #   into gitignored tools/, smoke-test, write tools/manifest.json
                             #   flags: --full-model (offline en-translation), --no-llm, --force
node scripts/verify.js       # headless end-to-end pipeline check (detect→cut→export→transcribe)
                             #   on the smallest video in gitignored samples/
npm run pack                 # build zero-install portable folder in gitignored dist-portable/
                             #   flags: --zip, --no-llm, --no-full-model
```

Tests are one plain-Node file (no framework, `check(name, cond)` pattern); there is no
way to run a single test other than editing the file. `VideoEditor.vbs` is the end-user
launcher — the app must NOT run as administrator (breaks Explorer drag-and-drop and
hides mapped network drives).

## Architecture

- **`src/videoOps.js` is the pure-logic engine** (UMD: `window.VideoOps` in the
  renderer, `require`d by lib/ and tests). ALL parsing (silencedetect/freezedetect
  stderr, whisper JSON, SRT, ffmpeg `-progress`), segment math (cuts/keeps/padding/
  remap), ffmpeg/llama argument builders, translation-prompt plumbing, and the
  DOCX/ZIP writer live here. It never spawns anything and has zero imports — that is
  what makes `npm test` run with nothing installed. New logic goes here, not in
  app.js or lib/.
- **`main.js`** — window + native dialogs + all IPC handlers; every subprocess spawn
  and filesystem/network access happens main-side. **`preload.js`** exposes the small
  `window.api` bridge (contextIsolation on, nodeIntegration off). Renderer
  (`src/app.js`) holds UI state and the canvas timeline only.
- **`lib/`** — main-process modules: `tools.js` (manifest loading + `run()` spawn
  helper + one-cancellable-job-per-id registry), `analyze.js`, `exporter.js`,
  `transcribe.js`, `localllm.js`, `tasks.js`, `settings.js`,
  `translate/{index,claude,mymemory}.js`.
- **`tools/manifest.json`** (written by `scripts/setup.js`) is the single source of
  truth for binary/model paths and backend choices (gpu/cpu, nvenc). The portable
  package ships it with RELATIVE paths — `tools.js` resolves them against the tools
  dir; never hardcode tool paths.
- **Settings** live in `userData/settings.json`, owned by main (`lib/settings.js`).
  The Claude API key never enters the renderer (masked copy only; a `****`-prefixed
  key echoed back from the UI is ignored on save).

### Pipeline order (matters)

detect (one ffmpeg pass: silencedetect + freezedetect) → user reviews cuts on the
canvas timeline → export re-encode → **transcribe the TRIMMED output** (avoids
remapping subtitle timestamps across cuts) → translate → .srt / soft-mux / burn-in /
tasks docx. Derivation parameters (padding, min-cut, mode) recompute instantly in the
renderer from cached raw detections; only threshold changes re-run ffmpeg.

### Resilience ladder (don't break it)

Every GPU path has an automatic CPU fallback at runtime, because the portable package
runs on machines different from the one that wrote the manifest: NVENC export retries
once with libx264; whisper retries with `whisperCpuExe`; llama retries with
`llamaCpuExe`; setup falls back GPU→CPU→small speech model (low-RAM PCs).

## Hard-won facts (do not re-learn these)

- whisper.cpp release zips ship a `main.exe` that is a **deprecation stub that exits
  non-zero** — always prefer `whisper-cli.exe` when scanning.
- ffmpeg 8 (BtbN "latest" builds) **removed `-filter_complex_script`**; use
  `-/filter_complex <file>`. The filtergraph always goes via a temp file (Windows
  32 KB command-line limit).
- ffmpeg's `out_time_ms` progress key is **microseconds**, not milliseconds.
- llama-cli **echoes the whole prompt** (including any JSON template inside it) into
  stdout — `parseTasksResponse` must take the LAST valid JSON block, scanning from
  the end. The tasks prompt demands one checklist item per distinct instruction;
  small models otherwise collapse everything into one summary task.
- Long transcripts: llama runs with `-c 32768`; anything longer is chunked by
  `splitCuesForTasks` and merged with `mergeTaskReports` — full-length coverage is a
  user-reported bug class, keep it covered.
- SRT files are written UTF-8 **with BOM** (picky Windows players); burn-in uses
  libass with `force_style='FontName=Segoe UI'` (covers Hebrew + Cyrillic); Hebrew is
  RTL — cue list uses `dir="rtl"`, docx uses `w:bidi`.
- CSP deviation from the Paperweight template: `media-src 'self' file: blob:` (the
  `<video>` element streams the opened file). Keep the rest strict.

## Conventions

- Release: bump `package.json` version + dated CHANGELOG.md entry + version in the
  commit message (e.g. `... (v1.2.3)`). The running version must stay visible in the
  window title bar (set in app.js init) — the user relies on it to identify builds.
- Commits go directly to `main`, pushed to github.com/mbbtower4-boop/VIDEO-EDITOR
  (push = distribution; users install from the GitHub ZIP, or receive the ~9 GB
  portable zip from `npm run pack`).
- `INSTRUCTIONS.md` is the end-user guide, bilingual **English + Hebrew** — update
  BOTH halves when it changes. README.md is developer-facing.
- Gitignored and never committed: `tools/`, `samples/` (test videos), `node_modules/`,
  `dist-portable/`, `*.mp4`, `*.srt`.
