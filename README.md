# Captioner

A self-hosted auto-subtitle editor in the style of online tools like VEED: upload a video, get word-timed captions, style them with animated templates, then export SRT/VTT or an MP4 with the captions burned in.

## Features

- **Transcription**: Whisper (`faster-whisper`, default `large-v3-turbo`) with word-level timestamps, VAD, hallucination guards, 99 languages with auto-detect, translate-to-English, and a custom vocabulary prompt for names and jargon.
- **Word timing refinement**: Whisper's word boundaries are tightened against the audio energy envelope, so captions don't linger into pauses.
- **Smart caption grouping**: splits on sentence ends, clause punctuation, pauses, character/line limits, max words and max duration, and avoids one-word orphans. Captions stay on screen across short gaps so they don't flicker.
- **Editor**: inline text editing (word timings are kept through an LCS alignment), split with Enter at the cursor, merge with Backspace at the start, add and delete subtitles, editable start/end times, find & replace, global timing shift, undo/redo, and low-confidence words flagged for review.
- **Timeline**: drag subtitle blocks to move them, drag the edges to trim, click to seek, zoom.
- **15 templates**: Classic, Boxed, Karaoke, Punch, Word Box, Highlight, Typewriter, Bounce, Neon, Comic, Retro, One Word, Minimal, Marker and Elegant. Every parameter is editable: font, weight, size, colors, outline, shadow, background (per line, block or word), letter spacing, word effects (highlight, karaoke sweep, word box, pop, reveal, bounce, underline), caption entrance animations, and position (drag on the video).
- **Export**: burned-in MP4 at the source resolution and frame rate with the audio kept, SRT, VTT, plain transcript, word-timing JSON, and project save/load.

### Preview = export

`public/js/captions.js` is one engine that both the browser preview and the server renderer (`render.js`, Skia via `@napi-rs/canvas`) use to draw every frame. The overlay frames are streamed into ffmpeg as raw RGBA, so the exported video matches the editor pixel for pixel. In tests, under 0.5% of text pixels differed, all on anti-aliased edges.

## Run

Requires Node 18+, Python 3.9+ and ffmpeg/ffprobe on `PATH`.

```bash
npm install
pip install -r requirements.txt
npm start            # http://localhost:3000
```

The first transcription downloads the selected Whisper model (~800 MB for `large-v3-turbo`). Optional environment variables: `PORT`, `PYTHON`, `WHISPER_DEVICE` (`cpu`/`cuda`), `WHISPER_COMPUTE` (e.g. `float16`, `int8`).

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Express API: upload (with an H.264 preview proxy for codecs browsers can't play), job queue, downloads |
| `transcribe.py` | Whisper worker → word timestamps (NDJSON progress on stdout) |
| `render.js` | Burn-in renderer: Skia canvas → raw RGBA → ffmpeg overlay |
| `public/js/captions.js` | Shared engine: grouping, layout, animation, drawing, SRT/VTT I/O |
| `public/js/app.js` | Editor UI |
| `public/fonts/` | Bundled OFL/Apache fonts so preview and export use identical glyphs |
