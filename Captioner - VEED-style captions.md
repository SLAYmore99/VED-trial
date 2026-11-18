---
type: project
status: working prototype
created: 2026-11-12
updated: 2026-11-18
tags: [project, captions, subtitles, whisper, video, veed-clone]
repo: https://github.com/SLAYmore99/VED-trial/tree/claude/determined-bell-bznqms
---

# Captioner: VEED-style auto-captioning app

## What it is
A self-hosted web app that recreates VEED.io's auto-subtitle feature:
upload a video → get word-timed captions → edit them → style them with animated templates → export an MP4 with burned-in captions, or SRT/VTT files.

Built from scratch, modelled on VEED's public feature set. No VEED code was used.

## Links
- **Shareable link (code lives on this branch):** https://github.com/SLAYmore99/VED-trial/tree/claude/determined-bell-bznqms
- Repo root https://github.com/SLAYmore99/VED-trial looks **empty** because `main` has no commits. Always share the branch link, or merge to main first.
- Repo is **public**. Friends can use Code → Download ZIP without a GitHub account.
- Commit: `3df4d73` "Add VEED-style auto-captioning editor"

## How to run (Windows)
1. Install once: Node.js LTS, Python 3 (tick "Add Python to PATH"), ffmpeg (`winget install ffmpeg`), Git
2. `git clone -b claude/determined-bell-bznqms https://github.com/SLAYmore99/VED-trial.git`
3. `cd VED-trial`, then `npm install`, then `pip install -r requirements.txt`
4. `npm start`, then open http://localhost:3000. Keep the terminal open while using the app.
5. The first transcription downloads the Whisper model (~800 MB for large-v3-turbo). Later runs are fast.

## How to use
1. Drag a video onto the page
2. **Subtitles tab:** pick the language (or Auto-detect) and accuracy level, add a custom vocabulary (names/brands), then click **Auto subtitle**
3. Fix the text: type in a subtitle; **Enter** splits at the cursor, **Backspace** at the start merges with the previous one; words marked ⚠ are low-confidence (click to jump to them)
4. Timeline: drag blocks to move them, drag edges to trim, click to seek, use zoom
5. **Styles tab:** pick a template, tweak font/colours/outline/animation, set Lines and Words per caption, drag captions on the video to reposition them
6. **Export tab:** MP4 with burned-in captions, or SRT / VTT / TXT / word-timing JSON; project save/load
- Shortcuts: Space = play/pause, arrows = step frames, Ctrl+Z / Ctrl+Shift+Z = undo/redo

## Architecture
| File | Role |
|---|---|
| `server.js` | Express API: upload, job queue + progress polling, downloads, H.264 preview proxy for codecs browsers can't play (HEVC, ProRes, MKV…) |
| `transcribe.py` | faster-whisper worker → word timestamps, NDJSON progress on stdout |
| `render.js` | Burn-in: Skia canvas (`@napi-rs/canvas`) draws each frame → raw RGBA piped into ffmpeg `overlay` → H.264 MP4, audio kept |
| `public/js/captions.js` | **Shared engine** used by both browser and server: grouping, layout, animations, drawing, SRT/VTT import/export |
| `public/js/app.js` | Editor UI (list, timeline, styles, export, undo/redo, autosave to localStorage) |
| `public/fonts/` | Bundled Google Fonts (Montserrat, Poppins, Anton, Bebas Neue, Bangers, Archivo Black, Lilita One, Luckiest Guy, Permanent Marker, DM Serif Display, Rubik Mono One) |

Stack: Node 22 + Express + multer, Python 3 + faster-whisper + numpy, ffmpeg/ffprobe, vanilla JS (no build step).

## Features built
- Whisper transcription: 99 languages + auto-detect, translate-to-English, custom vocabulary prompt
- Accuracy levels: large-v3 (max), **large-v3-turbo (default)**, medium, small, base
- 15 templates: Classic, Boxed, Karaoke, Punch, Word Box, Highlight, Typewriter, Bounce, Neon, Comic, Retro, One Word, Minimal, Marker, Elegant
- Word effects: highlight, karaoke sweep, word box, pop, reveal, bounce, underline. Caption entrances: fade, pop, slide.
- Backgrounds per line / block / word; outline, shadow, letter spacing, line height, max width, uppercase
- Editor: inline edit, split/merge/add/delete, editable times, find & replace, global time shift, undo/redo, low-confidence word flags, SRT/VTT import

## Test results (11 s JFK speech clip, 1080×1920 portrait)
- large-v3-turbo transcription: every word correct, with punctuation; ~14 s on a 4-core CPU including model load
- Active-word highlight correct on every sampled frame (fellow 1.2–1.54 s, country 5.81–6.25 s, can 9.04–9.34 s)
- Natural chunks: "And so, my fellow Americans," / "ask not" / "what your country can do for you," / "ask what you can do for your country."
- Burn-in export: ~6 s for 11 s of 1080×1920 @ 30 fps
- Preview vs export pixel diff: **0.4% of text pixels**, all on anti-aliased edges
- Browser UI test (Playwright): no console errors; upload → transcribe → edit → split → undo → style → SRT → MP4 all work

## Learnings
### Accuracy (the main goal)
- **Whisper large-v3-turbo with int8 on CPU** is the sweet spot: near large-v3 accuracy, much faster
- Settings that matter: `word_timestamps=True`, `vad_filter=True` (min silence 500 ms, pad 200 ms), `beam_size=5`, temperature fallback, `hallucination_silence_threshold=2.0`, and a drop rule for segments with no_speech_prob > 0.8 and avg_logprob < -1
- **Whisper word timestamps drift into pauses**: the word before a silence "lasts" until the next speech, so captions linger. Fix: compute an RMS energy envelope (10 ms hops) and **only shrink** each word's span to the audible part. It can't make timings worse.
- Attach stand-alone punctuation tokens to the previous word; force timings to be monotonic and non-overlapping
- A custom vocabulary (`initial_prompt`) is the cheapest way to get names and brands spelled right

### VEED-like caption grouping
- Break on: pause ≥ 0.7 s, sentence end (. ! ?), a comma/clause when the block is ≥ 55% full, char capacity (chars/line × lines), max words, max 6 s
- When over capacity, break at the last comma in the back half rather than mid-phrase
- Merge one-word orphans back into the previous block
- Keep a caption on screen across gaps < 0.6 s (stops flicker); minimum 0.7 s duration
- Hold the active-word highlight through gaps between words, or it flickers
- Line breaking: balanced DP (minimise the widest line) instead of greedy fill

### Preview = export (WYSIWYG)
- The key trick: **one drawing engine for both browser and server.** Chrome's canvas and @napi-rs/canvas are both Skia, so the output is essentially pixel-identical.
- Size fonts as a **% of the shorter video side** so portrait and landscape both look right
- Single-weight display fonts: don't request bold, or the browser fakes a faux-bold that the server doesn't (snap to the nearest available weight)
- Variable fonts (Montserrat VF) work in both the browser and @napi-rs/canvas
- Render optimisation: cache the frame when nothing is animating (key = caption id + active word)

### UX gotchas found while testing
- "Pop" that hides future words leaves lines off-centre, because the layout reserves their space. Changed it to keep all words visible and pop only the active one.
- Undo bug: debouncing all history snapshots merged import + edit + split into one step, so undo emptied the project. Fix: structural edits record history immediately; only typing and sliders are debounced.
- Preset thumbnails need fixed font sizes, or big templates overflow

### Environment gotchas
- faster-whisper's built-in `decode_audio` broke with the installed PyAV version (`metadata_errors` TypeError). Fix: decode with ffmpeg directly to 16 kHz mono float32.
- Google Fonts raw URLs containing `[wght]` need `curl -g` (globbing off). Some fonts live under `apache/`, not `ofl/`.
- Browsers can't play HEVC/ProRes/MKV, so the server makes an H.264 proxy for preview while the export uses the original file
- Server uploads are re-discovered from disk after a restart

## Limitations / next ideas
- [ ] Translation only to English (a Whisper limit). VEED does many languages, which would need a translation API or model.
- [ ] Only tested on one short, clean clip. Still to try: noisy audio, music, multiple speakers, accents.
- [ ] No speaker labels (diarization); no per-word timing editor; no emoji/auto-keyword highlight
- [ ] Optional: forced alignment (WhisperX-style) for even tighter word timing
- [ ] Merge the branch into `main` so the plain repo link works
- [ ] Hosting online (currently runs locally only)
