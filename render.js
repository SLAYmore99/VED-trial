#!/usr/bin/env node
/*
 * Burn captions into a video.
 *   node render.js job.json
 * job.json: { input, output, captions, style }
 *
 * Every frame of the caption overlay is drawn with the same engine the editor
 * uses (public/js/captions.js) on a Skia canvas, then streamed as raw RGBA into
 * ffmpeg and composited over the source video. Audio is copied untouched.
 * Progress is reported as NDJSON on stdout.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const Captions = require('./public/js/captions.js');

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function registerFonts() {
  const dir = path.join(__dirname, 'public', 'fonts');
  for (const f of Captions.FONTS) {
    const p = path.join(dir, f.file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, f.family);
  }
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const info = JSON.parse(out.toString());
  const v = info.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('The file has no video stream to burn captions into');
  let w = v.width, h = v.height;
  let rot = 0;
  if (v.tags && v.tags.rotate) rot = +v.tags.rotate;
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = +sd.rotation;
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  const [n, d] = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate).split('/').map(Number);
  let fps = d ? n / d : 30;
  if (!isFinite(fps) || fps <= 0 || fps > 120) fps = 30;
  const duration = +(info.format.duration || v.duration || 0);
  const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
  return { w, h, fps, fpsStr: d ? `${n}/${d}` : String(fps), duration, hasAudio };
}

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  registerFonts();
  const meta = probe(job.input);
  const { w: W, h: H, fps } = meta;
  const style = Object.assign({}, Captions.DEFAULT_STYLE, job.style || {});
  const caps = (job.captions || []).filter((c) => c.words && c.words.length).sort((a, b) => a.start - b.start);
  const total = Math.max(1, Math.ceil(meta.duration * fps));
  emit({ type: 'status', message: `Rendering ${W}×${H} @ ${fps.toFixed(2)} fps` });

  const args = [
    '-y', '-v', 'error', '-nostdin',
    '-i', job.input,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', meta.fpsStr, '-i', 'pipe:0',
    '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto:eof_action=pass:shortest=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', job.preset || 'medium', '-crf', String(job.crf || 18),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    job.output,
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d.toString()).length > 8000 && (stderr = stderr.slice(-8000)));
  const done = new Promise((res) => ff.on('close', res));
  ff.stdin.on('error', () => {});

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const blank = Buffer.alloc(W * H * 4);
  let lastKey = null, lastBuf = blank;

  const write = (buf) =>
    new Promise((res) => {
      if (ff.stdin.write(buf)) res();
      else ff.stdin.once('drain', res);
    });

  for (let f = 0; f < total; f++) {
    const t = f / fps;
    const cap = Captions.findCaption(caps, t);
    let buf;
    if (!cap) buf = blank;
    else {
      // Skip redraws when nothing animates between frames.
      const key = frameKey(cap, t, style);
      if (key !== null && key === lastKey) buf = lastBuf;
      else {
        ctx.clearRect(0, 0, W, H);
        Captions.drawFrame(ctx, caps, t, style, W, H);
        buf = Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);
        lastKey = key;
        lastBuf = buf;
      }
    }
    await write(buf);
    if (f % 15 === 0) emit({ type: 'progress', progress: f / total });
    if (ff.exitCode !== null) break;
  }
  ff.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error('ffmpeg failed: ' + stderr.trim().split('\n').slice(-5).join(' | '));
  emit({ type: 'result', output: job.output });
}

// Returns a cache key if the frame is static (identical to any other frame with
// the same key), or null if something is mid-animation.
function frameKey(cap, t, style) {
  const ANIM = 0.25;
  if (style.captionAnim !== 'none' && t - cap.start < ANIM) return null;
  let active = -1;
  for (let i = 0; i < cap.words.length; i++) {
    const w = cap.words[i];
    if (w.start <= t) active = i;
    if (t >= w.start && t - w.start < ANIM && style.wordAnim !== 'none') return null;
    if (style.wordAnim === 'karaoke' && t >= w.start && t < w.end) return null;
  }
  return cap.id + ':' + active;
}

main().catch((e) => {
  emit({ type: 'error', message: e.message });
  process.exit(1);
});
