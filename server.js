#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const express = require('express');
const multer = require('multer');

const PORT = +process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUT = path.join(DATA, 'renders');
for (const d of [UPLOADS, OUT]) fs.mkdirSync(d, { recursive: true });

const PYTHON = process.env.PYTHON || 'python3';
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const newId = () => crypto.randomBytes(8).toString('hex');
const media = new Map(); // id -> { id, file, name, meta, preview }
const jobs = new Map(); // id -> { id, type, status, progress, message, result, error }

// --- helpers ---------------------------------------------------------------
function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], (err, out) => {
      if (err) return reject(new Error('Unsupported or corrupt media file'));
      const info = JSON.parse(out);
      const v = info.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = info.streams.find((s) => s.codec_type === 'audio');
      resolve({
        duration: +(info.format.duration || 0),
        video: v ? { codec: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt } : null,
        audio: a ? { codec: a.codec_name } : null,
        format: info.format.format_name,
      });
    });
  });
}

function runWorker(job, cmd, args, onResult) {
  job.status = 'running';
  const p = spawn(cmd, args, { cwd: __dirname, env: process.env });
  let buf = '', errTail = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'progress') job.progress = msg.progress;
      else if (msg.type === 'status') job.message = msg.message;
      else if (msg.type === 'error') job.error = msg.message;
      else if (msg.type === 'result') onResult(msg);
    }
  });
  p.stderr.on('data', (d) => (errTail = (errTail + d.toString()).slice(-4000)));
  p.on('close', (code) => {
    if (code === 0 && !job.error) {
      job.status = 'done';
      job.progress = 1;
    } else {
      job.status = 'error';
      job.error = job.error || errTail.trim().split('\n').slice(-3).join(' ') || `worker exited with ${code}`;
    }
  });
  job.proc = p;
}

function publicJob(j) {
  const { proc, ...rest } = j;
  return rest;
}

// Browsers can't play every codec (HEVC, ProRes, …). Create a lightweight H.264
// proxy for the editor in that case; the final render always uses the original.
function needsProxy(meta, name) {
  if (!meta.video) return false;
  const ok = ['h264', 'vp8', 'vp9', 'av1'].includes(meta.video.codec);
  const container = /mp4|mov|webm|matroska/.test(meta.format || '');
  const pix = /yuv420p$|^yuvj420p$/.test(meta.video.pix_fmt || '');
  return !(ok && container && pix) || /\.(mkv|avi|wmv|flv)$/i.test(name);
}

function makeProxy(entry) {
  const job = { id: newId(), type: 'proxy', status: 'running', progress: 0, message: 'Preparing preview…' };
  jobs.set(job.id, job);
  const out = path.join(UPLOADS, entry.id + '.proxy.mp4');
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', entry.file,
    '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
  const p = spawn('ffmpeg', args);
  p.stdout.on('data', (d) => {
    const m = /out_time_us=(\d+)/.exec(d.toString());
    if (m && entry.meta.duration) job.progress = Math.min(1, +m[1] / 1e6 / entry.meta.duration);
  });
  p.on('close', (code) => {
    if (code === 0) {
      entry.preview = out;
      job.status = 'done';
      job.progress = 1;
    } else {
      job.status = 'error';
      job.error = 'Could not create a browser preview for this file';
    }
  });
  return job;
}

// Media survives server restarts: look the upload up on disk if needed.
async function getMedia(id) {
  if (media.has(id)) return media.get(id);
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const f = fs.readdirSync(UPLOADS).find((n) => n.startsWith(id + '.') && !n.includes('.proxy.'));
  if (!f) return null;
  const file = path.join(UPLOADS, f);
  const meta = await ffprobe(file).catch(() => null);
  if (!meta) return null;
  const proxy = path.join(UPLOADS, id + '.proxy.mp4');
  const entry = { id, file, name: f, meta, preview: fs.existsSync(proxy) ? proxy : file };
  media.set(id, entry);
  return entry;
}

// --- routes ----------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => cb(null, newId() + path.extname(file.originalname || '').toLowerCase()),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const meta = await ffprobe(req.file.path);
    if (!meta.audio) throw new Error('This file has no audio track to transcribe');
    const id = path.parse(req.file.filename).name;
    const entry = { id, file: req.file.path, name: req.file.originalname, meta, preview: req.file.path };
    media.set(id, entry);
    let proxyJob = null;
    if (needsProxy(meta, req.file.originalname)) {
      entry.preview = null;
      proxyJob = makeProxy(entry).id;
    }
    res.json({ id, name: entry.name, meta, proxyJob });
  } catch (e) {
    fs.rm(req.file.path, () => {});
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/media/:id', async (req, res) => {
  const m = await getMedia(req.params.id);
  if (!m || !m.preview) return res.status(404).end();
  res.sendFile(m.preview);
});

app.post('/api/transcribe/:id', async (req, res) => {
  const m = await getMedia(req.params.id);
  if (!m) return res.status(404).json({ error: 'Unknown media' });
  const { model, language, task, prompt } = req.body || {};
  const job = { id: newId(), type: 'transcribe', status: 'queued', progress: 0, message: 'Starting…' };
  jobs.set(job.id, job);
  const args = ['transcribe.py', m.file];
  if (model) args.push('--model', String(model));
  if (language && language !== 'auto') args.push('--language', String(language));
  if (task === 'translate') args.push('--task', 'translate');
  if (prompt) args.push('--prompt', String(prompt).slice(0, 800));
  runWorker(job, PYTHON, args, (msg) => (job.result = msg));
  res.json({ job: job.id });
});

app.post('/api/render/:id', async (req, res) => {
  const m = await getMedia(req.params.id);
  if (!m) return res.status(404).json({ error: 'Unknown media' });
  if (!m.meta.video) return res.status(400).json({ error: 'Audio-only files cannot be rendered to video; export SRT/VTT instead.' });
  const { captions, style, quality } = req.body || {};
  const job = { id: newId(), type: 'render', status: 'queued', progress: 0, message: 'Starting…' };
  jobs.set(job.id, job);
  const output = path.join(OUT, job.id + '.mp4');
  const jobFile = path.join(OUT, job.id + '.json');
  const q = { draft: { preset: 'veryfast', crf: 23 }, high: { preset: 'medium', crf: 18 }, max: { preset: 'slow', crf: 15 } }[quality] || { preset: 'medium', crf: 18 };
  fs.writeFileSync(jobFile, JSON.stringify({ input: m.file, output, captions, style, ...q }));
  job.download = `/api/download/${job.id}?name=${encodeURIComponent(path.parse(m.name).name + '-captioned.mp4')}`;
  runWorker(job, process.execPath, ['render.js', jobFile], () => {});
  res.json({ job: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown job' });
  res.json(publicJob(j));
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (j && j.proc && j.status === 'running') j.proc.kill('SIGTERM');
  if (j) { j.status = 'error'; j.error = 'Cancelled'; }
  res.json({ ok: true });
});

app.get('/api/download/:id', (req, res) => {
  const file = path.join(OUT, path.basename(req.params.id) + '.mp4');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.download(file, String(req.query.name || 'captioned.mp4'));
});

app.listen(PORT, () => console.log(`Captioner running at http://localhost:${PORT}`));
