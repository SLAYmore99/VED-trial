/* Captioner editor */
(function () {
  'use strict';
  const C = window.Captions;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const LANGS = [
    ['auto', 'Auto-detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
    ['pt', 'Portuguese'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'],
    ['mr', 'Marathi'], ['gu', 'Gujarati'], ['pa', 'Punjabi'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
    ['pl', 'Polish'], ['cs', 'Czech'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['el', 'Greek'],
    ['he', 'Hebrew'], ['fa', 'Persian'], ['id', 'Indonesian'], ['ms', 'Malay'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['tl', 'Tagalog'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['sw', 'Swahili'],
  ];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    media: null, // { id, name, meta }
    captions: [],
    style: C.presetStyle('classic'),
    preset: 'classic',
    chunk: Object.assign({}, C.DEFAULT_CHUNK),
    language: null,
    zoom: 90, // px per second
  };
  const history = { stack: [], idx: -1, lock: false };

  const video = $('#video');
  const canvas = $('#overlay');
  const ctx = canvas.getContext('2d');

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), err ? 6000 : 2800);
  }
  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const parseT = (str) => {
    const p = String(str).trim().split(':').map(Number);
    if (p.some(isNaN)) return null;
    return p.reduce((a, b) => a * 60 + b, 0);
  };
  const download = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const baseName = () => (S.media ? S.media.name.replace(/\.[^.]+$/, '') : 'captions');
  const duration = () => (video.duration && isFinite(video.duration) ? video.duration : (S.media && S.media.meta.duration) || 0);

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  function pollJob(id, box, onDone) {
    const msg = $('.job-msg', box), bar = $('.bar', box);
    box.hidden = false;
    const cancel = $('[data-cancel]', box);
    let stopped = false;
    if (cancel) cancel.onclick = () => { stopped = true; fetch('/api/jobs/' + id, { method: 'DELETE' }); box.hidden = true; onDone(new Error('Cancelled')); };
    const tick = async () => {
      if (stopped) return;
      let j;
      try { j = await api('/api/jobs/' + id); } catch (e) { box.hidden = true; return onDone(e); }
      const pct = Math.round((j.progress || 0) * 100);
      msg.textContent = (j.message || 'Working…') + (pct ? ` — ${pct}%` : '');
      bar.classList.toggle('indeterminate', !pct && j.status === 'running');
      $('i', bar).style.width = pct + '%';
      if (j.status === 'done') { box.hidden = true; onDone(null, j); }
      else if (j.status === 'error') { box.hidden = true; onDone(new Error(j.error || 'Failed')); }
      else setTimeout(tick, 600);
    };
    tick();
  }

  // ---------------------------------------------------------------------------
  // Fonts
  // ---------------------------------------------------------------------------
  async function loadFonts() {
    const loads = C.FONTS.map((f) => {
      const desc = f.weights ? { weight: `${Math.min(...f.weights)} ${Math.max(...f.weights)}` } : { weight: String(f.weight) };
      const face = new FontFace(f.family, `url(fonts/${f.file})`, desc);
      document.fonts.add(face);
      return face.load().catch(() => console.warn('font failed', f.file));
    });
    await Promise.all(loads);
  }

  // ---------------------------------------------------------------------------
  // History / persistence
  // ---------------------------------------------------------------------------
  function snapshot() {
    return JSON.stringify({ captions: S.captions, style: S.style, preset: S.preset, chunk: S.chunk });
  }
  function pushHistory() {
    if (history.lock) return;
    const snap = snapshot();
    if (history.stack[history.idx] === snap) return;
    history.stack = history.stack.slice(0, history.idx + 1);
    history.stack.push(snap);
    if (history.stack.length > 200) history.stack.shift();
    history.idx = history.stack.length - 1;
    updateUndoButtons();
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    S.captions = o.captions; S.style = o.style; S.preset = o.preset; S.chunk = o.chunk;
    history.lock = true;
    refreshAll();
    history.lock = false;
    save(false);
  }
  function undo() { if (history.idx > 0) { history.idx--; restore(history.stack[history.idx]); updateUndoButtons(); } }
  function redo() { if (history.idx < history.stack.length - 1) { history.idx++; restore(history.stack[history.idx]); updateUndoButtons(); } }
  function updateUndoButtons() {
    $('#undoBtn').disabled = history.idx <= 0;
    $('#redoBtn').disabled = history.idx >= history.stack.length - 1;
  }

  let saveT = null, histT = null;
  // mode: undefined -> record an undo step now; 'debounce' -> coalesce rapid
  // edits (typing, sliders); false -> persist only.
  function save(mode) {
    if (!S.media) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        localStorage.setItem('captioner:' + S.media.id, JSON.stringify({ media: S.media, captions: S.captions, style: S.style, preset: S.preset, chunk: S.chunk, language: S.language }));
        localStorage.setItem('captioner:last', S.media.id);
      } catch (e) { /* quota */ }
    }, 300);
    clearTimeout(histT);
    if (mode === 'debounce') histT = setTimeout(pushHistory, 500);
    else if (mode !== false) pushHistory();
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------
  function uploadFile(file) {
    const box = $('#uploadJob');
    box.hidden = false;
    $('.job-msg', box).textContent = 'Uploading…';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        $('.bar i', box).style.width = Math.round((e.loaded / e.total) * 100) + '%';
        $('.job-msg', box).textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`;
      }
    };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) { box.hidden = true; return toast(j.error || 'Upload failed', true); }
      const media = { id: j.id, name: j.name, meta: j.meta };
      if (j.proxyJob) {
        pollJob(j.proxyJob, box, (err) => (err ? toast(err.message, true) : openMedia(media, null)));
      } else {
        box.hidden = true;
        openMedia(media, null);
      }
    };
    xhr.onerror = () => { box.hidden = true; toast('Upload failed', true); };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  }

  function openMedia(media, project) {
    S.media = media;
    S.captions = project ? project.captions : [];
    if (project) {
      S.style = Object.assign({}, C.DEFAULT_STYLE, project.style);
      S.preset = project.preset || 'custom';
      S.chunk = Object.assign({}, C.DEFAULT_CHUNK, project.chunk);
      S.language = project.language || null;
    }
    $('#projectName').textContent = media.name;
    $('#dropzone').hidden = true;
    $('#player').hidden = false;
    video.src = '/api/media/' + media.id;
    $('#transcribeBtn').disabled = false;
    history.stack = []; history.idx = -1;
    refreshAll();
    pushHistory();
    save(false);
  }

  video.addEventListener('loadedmetadata', () => {
    if (!video.videoWidth) {
      // Audio-only: render captions over a 16:9 black frame for previewing.
      canvas.width = 1280; canvas.height = 720;
    } else {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    fitPlayer();
    renderTimeline();
  });
  video.addEventListener('error', () => {
    if (S.media) toast('Could not load the video preview. If the server restarted, upload the file again.', true);
  });

  function fitPlayer() {
    const stage = $('#stage');
    const W = canvas.width || 16, H = canvas.height || 9;
    const aw = stage.clientWidth - 40, ah = stage.clientHeight - 40;
    const s = Math.min(aw / W, ah / H);
    const p = $('#player');
    p.style.width = Math.floor(W * s) + 'px';
    p.style.height = Math.floor(H * s) + 'px';
  }
  window.addEventListener('resize', fitPlayer);

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------
  function transcribe() {
    if (!S.media) return;
    if (S.captions.length && !confirm('Replace the existing subtitles with a new transcription?')) return;
    const body = {
      language: $('#langSel').value,
      model: $('#modelSel').value,
      task: $('#taskSel').value,
      prompt: $('#vocab').value.trim(),
    };
    $('#transcribeBtn').disabled = true;
    showTranscribeView(true);
    api('/api/transcribe/' + S.media.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(({ job }) =>
        pollJob(job, $('#transcribeJob'), (err, j) => {
          $('#transcribeBtn').disabled = false;
          if (err) return toast(err.message, true);
          const r = j.result;
          if (!r || !r.words.length) return toast('No speech detected', true);
          S.language = r.language;
          S.captions = C.chunkWords(r.words, S.chunk);
          refreshAll();
          save();
          toast(`Transcribed ${r.words.length} words (${r.language})`);
        })
      )
      .catch((e) => { $('#transcribeBtn').disabled = false; toast(e.message, true); });
  }

  function regroup() {
    if (!S.captions.length) return;
    S.captions = C.chunkWords(C.flattenWords(S.captions), S.chunk);
    refreshAll();
    save();
  }

  // ---------------------------------------------------------------------------
  // Caption editing helpers
  // ---------------------------------------------------------------------------
  function retime(c, ns, ne) {
    const os = c.start, oe = c.end, span = Math.max(1e-3, oe - os);
    const k = (ne - ns) / span;
    for (const w of c.words) {
      w.start = Math.round((ns + (w.start - os) * k) * 1000) / 1000;
      w.end = Math.round((ns + (w.end - os) * k) * 1000) / 1000;
    }
    c.start = Math.round(ns * 1000) / 1000;
    c.end = Math.round(ne * 1000) / 1000;
  }
  const sortCaps = () => S.captions.sort((a, b) => a.start - b.start);
  const capById = (id) => S.captions.find((c) => c.id === id);

  function splitCaption(c, wordIdx) {
    if (wordIdx <= 0 || wordIdx >= c.words.length) return toast('Place the cursor between words to split');
    const a = c.words.slice(0, wordIdx), b = c.words.slice(wordIdx);
    const nb = { id: 'c' + Math.random().toString(36).slice(2), start: b[0].start, end: c.end, words: b };
    c.words = a;
    c.end = Math.min(c.end, b[0].start);
    if (c.end <= c.start) c.end = a[a.length - 1].end;
    S.captions.splice(S.captions.indexOf(c) + 1, 0, nb);
    refreshAll(); save();
  }
  function mergeNext(c) {
    const i = S.captions.indexOf(c);
    const n = S.captions[i + 1];
    if (!n) return;
    c.words = c.words.concat(n.words);
    c.end = Math.max(c.end, n.end);
    S.captions.splice(i + 1, 1);
    refreshAll(); save();
  }
  function deleteCap(c) {
    S.captions.splice(S.captions.indexOf(c), 1);
    refreshAll(); save();
  }
  function insertAfter(c) {
    const i = c ? S.captions.indexOf(c) : -1;
    const next = S.captions[i + 1];
    const start = c ? c.end : video.currentTime;
    let end = Math.min(start + 2, next ? next.start : duration() || start + 2);
    if (end - start < 0.3) end = start + 0.3;
    const nc = C.distributeWords('New subtitle', start, end);
    S.captions.splice(i + 1, 0, nc);
    sortCaps();
    refreshAll(); save();
    const ta = $(`.cap[data-id="${nc.id}"] textarea`);
    if (ta) { ta.focus(); ta.select(); }
  }

  // ---------------------------------------------------------------------------
  // Subtitle list
  // ---------------------------------------------------------------------------
  function showTranscribeView(force) {
    const has = S.captions.length > 0 && !force;
    $('#transcribeView').hidden = has;
    $('#editorView').hidden = !has;
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function renderList() {
    showTranscribeView(false);
    const list = $('#capList');
    list.innerHTML = '';
    const words = S.captions.reduce((n, c) => n + c.words.length, 0);
    $('#subMeta').textContent = `${S.captions.length} subtitles · ${words} words` + (S.language ? ` · ${S.language.toUpperCase()}` : '');
    const frag = document.createDocumentFragment();
    S.captions.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'cap';
      el.dataset.id = c.id;
      el.innerHTML = `
        <div class="cap-head">
          <input class="ts" data-k="start" value="${fmt(c.start)}" title="Start time" />
          <span>→</span>
          <input class="ts" data-k="end" value="${fmt(c.end)}" title="End time" />
          <span class="spacer"></span>
          <button data-a="split" title="Split at cursor">✂</button>
          <button data-a="merge" title="Merge with next">⤓</button>
          <button data-a="add" title="Add subtitle after">＋</button>
          <button data-a="del" title="Delete">🗑</button>
        </div>
        <textarea rows="1" spellcheck="true"></textarea>
        <div class="warn" hidden></div>
        <div class="add-between"><button data-a="add">+ Add</button></div>`;
      const ta = $('textarea', el);
      ta.value = C.captionText(c);
      renderWarn(el, c);
      frag.appendChild(el);
    });
    list.appendChild(frag);
    $$('textarea', list).forEach(autosize);
    lastActiveId = null;
  }

  function renderWarn(el, c) {
    const low = c.words.filter((w) => w.prob != null && w.prob < 0.5);
    const box = $('.warn', el);
    if (!low.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '⚠ Check: ' + low.map((w) => `<b data-t="${w.start}">${escapeHtml(w.text)}</b>`).join(', ');
  }
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function bindList() {
    const list = $('#capList');
    list.addEventListener('input', (e) => {
      const el = e.target.closest('.cap');
      if (!el || e.target.tagName !== 'TEXTAREA') return;
      const c = capById(el.dataset.id);
      C.setCaptionText(c, e.target.value);
      autosize(e.target);
      renderWarn(el, c);
      renderTimeline();
      save('debounce');
    });
    list.addEventListener('focusout', (e) => {
      const el = e.target.closest('.cap');
      if (!el) return;
      const c = capById(el.dataset.id);
      if (!c) return;
      if (e.target.tagName === 'TEXTAREA' && !c.words.length) deleteCap(c);
    });
    list.addEventListener('change', (e) => {
      if (!e.target.classList.contains('ts')) return;
      const c = capById(e.target.closest('.cap').dataset.id);
      const v = parseT(e.target.value);
      if (v == null) { e.target.value = fmt(c[e.target.dataset.k]); return; }
      let ns = c.start, ne = c.end;
      if (e.target.dataset.k === 'start') ns = Math.min(v, ne - 0.05); else ne = Math.max(v, ns + 0.05);
      retime(c, ns, ne);
      sortCaps();
      refreshAll(); save();
    });
    list.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('ts') && e.key === 'Enter') e.target.blur();
      if (e.target.tagName === 'TEXTAREA' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const c = capById(e.target.closest('.cap').dataset.id);
        splitCaption(c, wordIndexAtCursor(e.target));
      }
      if (e.target.tagName === 'TEXTAREA' && e.key === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
        const c = capById(e.target.closest('.cap').dataset.id);
        const i = S.captions.indexOf(c);
        if (i > 0) { e.preventDefault(); mergeNext(S.captions[i - 1]); }
      }
    });
    list.addEventListener('click', (e) => {
      const el = e.target.closest('.cap');
      if (!el) return;
      const c = capById(el.dataset.id);
      const b = e.target.closest('button');
      const warnWord = e.target.closest('.warn b');
      if (warnWord) { video.currentTime = +warnWord.dataset.t + 0.001; return; }
      if (b) {
        const a = b.dataset.a;
        if (a === 'split') splitCaption(c, wordIndexAtCursor($('textarea', el)));
        else if (a === 'merge') mergeNext(c);
        else if (a === 'del') deleteCap(c);
        else if (a === 'add') insertAfter(c);
        return;
      }
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
        if (video.currentTime < c.start || video.currentTime >= c.end) video.currentTime = c.start + 0.001;
      } else video.currentTime = c.start + 0.001;
    });
  }

  function wordIndexAtCursor(ta) {
    const before = ta.value.slice(0, ta.selectionStart);
    return before.trim() ? before.trim().split(/\s+/).length - (/\S$/.test(before) && /^\S/.test(ta.value.slice(ta.selectionStart)) ? 1 : 0) : 0;
  }

  // ---------------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------------
  function renderTimeline() {
    const d = duration();
    const inner = $('#tlInner');
    const W = Math.max($('#timeline').clientWidth, d * S.zoom + 60);
    inner.style.width = W + 'px';
    // ruler
    const ruler = $('#tlRuler');
    ruler.innerHTML = '';
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * S.zoom >= 70) || 120;
    for (let t = 0; t <= d + step; t += step) {
      const tk = document.createElement('div');
      tk.className = 'tick';
      tk.style.left = t * S.zoom + 'px';
      tk.textContent = fmt(t).replace(/\.\d+$/, '');
      ruler.appendChild(tk);
    }
    // captions
    const track = $('#tlTrack');
    track.innerHTML = '';
    for (const c of S.captions) {
      const el = document.createElement('div');
      el.className = 'tl-cap';
      el.dataset.id = c.id;
      el.style.left = c.start * S.zoom + 'px';
      el.style.width = Math.max(4, (c.end - c.start) * S.zoom) + 'px';
      el.title = C.captionText(c);
      el.innerHTML = '<div class="h l"></div><div class="h r"></div>';
      el.appendChild(document.createTextNode(C.captionText(c)));
      track.appendChild(el);
    }
    lastActiveId = null;
  }

  function bindTimeline() {
    const tl = $('#timeline');
    const seekFromEvent = (e) => {
      const r = $('#tlInner').getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(duration(), (e.clientX - r.left) / S.zoom));
    };
    let drag = null;
    tl.addEventListener('pointerdown', (e) => {
      const capEl = e.target.closest('.tl-cap');
      if (!capEl) {
        seekFromEvent(e);
        drag = { mode: 'seek' };
        tl.setPointerCapture(e.pointerId);
        return;
      }
      const c = capById(capEl.dataset.id);
      const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
      const i = S.captions.indexOf(c);
      drag = { mode, c, el: capEl, x0: e.clientX, s0: c.start, e0: c.end, prev: S.captions[i - 1], next: S.captions[i + 1], moved: false };
      tl.setPointerCapture(e.pointerId);
    });
    tl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.mode === 'seek') return seekFromEvent(e);
      const dt = (e.clientX - drag.x0) / S.zoom;
      if (Math.abs(e.clientX - drag.x0) > 2) drag.moved = true;
      const lo = drag.prev ? drag.prev.end : 0;
      const hi = drag.next ? drag.next.start : duration() || Infinity;
      let ns = drag.s0, ne = drag.e0;
      if (drag.mode === 'move') {
        const len = drag.e0 - drag.s0;
        ns = Math.max(lo, Math.min(hi - len, drag.s0 + dt));
        ne = ns + len;
      } else if (drag.mode === 'l') ns = Math.max(lo, Math.min(drag.e0 - 0.1, drag.s0 + dt));
      else ne = Math.min(hi, Math.max(drag.s0 + 0.1, drag.e0 + dt));
      retime(drag.c, ns, ne);
      drag.el.style.left = ns * S.zoom + 'px';
      drag.el.style.width = (ne - ns) * S.zoom + 'px';
    });
    const end = () => {
      if (!drag) return;
      if (drag.c) {
        if (!drag.moved) video.currentTime = drag.c.start + 0.001;
        else { sortCaps(); renderList(); save(); }
      }
      drag = null;
    };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);
    $('#zoom').addEventListener('input', (e) => { S.zoom = +e.target.value; renderTimeline(); });
  }

  // ---------------------------------------------------------------------------
  // Preview render loop
  // ---------------------------------------------------------------------------
  let lastActiveId = null, hover = false, dragPos = null;
  function frame() {
    const t = video.currentTime;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (S.media) {
      if (!video.videoWidth) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
      C.drawFrame(ctx, S.captions, t, S.style, W, H);
      if (hover || dragPos) {
        const b = C.captionBounds(ctx, S.captions, t, S.style, W, H);
        if (b) {
          ctx.save();
          ctx.strokeStyle = 'rgba(124,92,255,.95)';
          ctx.lineWidth = Math.max(2, W / 500);
          ctx.setLineDash([W / 120, W / 160]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.restore();
        }
      }
    }
    // UI sync
    $('#curTime').textContent = fmt(t);
    $('#durTime').textContent = fmt(duration());
    $('#playBtn').textContent = video.paused ? '▶' : '❚❚';
    $('#tlPlayhead').style.left = t * S.zoom + 'px';
    if (!video.paused) {
      const tl = $('#timeline'), x = t * S.zoom;
      if (x > tl.scrollLeft + tl.clientWidth - 80 || x < tl.scrollLeft) tl.scrollLeft = x - 80;
    }
    const cap = C.findCaption(S.captions, t);
    const id = cap ? cap.id : null;
    if (id !== lastActiveId) {
      lastActiveId = id;
      $$('.cap.active, .tl-cap.active').forEach((e) => e.classList.remove('active'));
      if (id) {
        const el = $(`.cap[data-id="${id}"]`);
        const tel = $(`.tl-cap[data-id="${id}"]`);
        if (tel) tel.classList.add('active');
        if (el) {
          el.classList.add('active');
          if (!video.paused && !el.contains(document.activeElement)) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }
    requestAnimationFrame(frame);
  }

  function bindCanvasDrag() {
    const toVideo = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
    };
    const hit = (p) => {
      const b = C.captionBounds(ctx, S.captions, video.currentTime, S.style, canvas.width, canvas.height);
      return b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    };
    canvas.addEventListener('pointermove', (e) => {
      const p = toVideo(e);
      if (dragPos) {
        S.style.posX = Math.max(0.05, Math.min(0.95, dragPos.px + (p.x - dragPos.x) / canvas.width));
        S.style.posY = Math.max(0.05, Math.min(0.95, dragPos.py + (p.y - dragPos.y) / canvas.height));
        // Snap to horizontal centre.
        if (Math.abs(S.style.posX - 0.5) < 0.015) S.style.posX = 0.5;
        return;
      }
      hover = hit(p);
      canvas.classList.toggle('grab', hover);
    });
    canvas.addEventListener('pointerleave', () => { hover = false; });
    canvas.addEventListener('pointerdown', (e) => {
      const p = toVideo(e);
      if (!hit(p)) { togglePlay(); return; }
      dragPos = { x: p.x, y: p.y, px: S.style.posX, py: S.style.posY, moved: false };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('grabbing');
    });
    const up = () => {
      if (!dragPos) return;
      dragPos = null;
      canvas.classList.remove('grabbing');
      S.preset = S.preset; // position is a style tweak, keep preset highlight
      save();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  function togglePlay() {
    if (!S.media) return;
    if (video.paused) video.play(); else video.pause();
  }

  // ---------------------------------------------------------------------------
  // Styles panel
  // ---------------------------------------------------------------------------
  const SAMPLE = (() => {
    const words = ['Make', 'every', 'word', 'pop'];
    let t = 0;
    return [{ id: 'sample', start: 0, end: 5, words: words.map((w) => { const o = { text: w, start: t, end: t + 0.35 }; t += 0.4; return o; }) }];
  })();

  function renderPresets() {
    const grid = $('#presetGrid');
    grid.innerHTML = '';
    for (const p of C.PRESETS) {
      const b = document.createElement('button');
      b.className = 'preset' + (S.preset === p.id ? ' active' : '');
      b.dataset.id = p.id;
      const cv = document.createElement('canvas');
      cv.width = 340; cv.height = 150;
      b.appendChild(cv);
      const n = document.createElement('span');
      n.className = 'pname';
      n.textContent = p.name;
      b.appendChild(n);
      grid.appendChild(b);
      drawPresetThumb(cv, p);
    }
  }
  function drawPresetThumb(cv, p) {
    const x = cv.getContext('2d');
    const g = x.createLinearGradient(0, 0, cv.width, cv.height);
    g.addColorStop(0, '#3a3d4a'); g.addColorStop(1, '#16161c');
    x.fillStyle = g;
    x.fillRect(0, 0, cv.width, cv.height);
    const st = Object.assign(C.presetStyle(p.id), { posX: 0.5, posY: 0.5, maxWidth: 94 });
    st.fontSize = p.chunk && p.chunk.maxWords === 1 ? 26 : 15.5;
    let caps = SAMPLE;
    if (p.chunk && p.chunk.maxWords === 1) caps = [{ id: 's1', start: 0, end: 5, words: [{ text: 'Pop', start: 0, end: 5 }] }];
    C.drawFrame(x, caps, 1.0, st, cv.width, cv.height);
  }

  function applyPreset(id) {
    const p = C.PRESETS.find((x) => x.id === id);
    const keepPos = { posX: S.style.posX, posY: S.style.posY };
    S.style = C.presetStyle(id);
    if (!(p.style && p.style.posY != null)) Object.assign(S.style, keepPos);
    S.preset = id;
    const prevChunk = JSON.stringify(S.chunk);
    S.chunk = Object.assign({}, C.DEFAULT_CHUNK, p.chunk || {});
    if (JSON.stringify(S.chunk) !== prevChunk) regroup();
    syncStyleInputs();
    $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    save();
  }

  function fmtOut(key, v) {
    if (key === 'fontSize') return (+v).toFixed(1) + '%';
    if (key === 'maxWidth') return v + '%';
    if (key === 'shadowOpacity' || key === 'bgOpacity') return Math.round(v * 100) + '%';
    return (+v).toFixed(2);
  }

  function syncStyleInputs() {
    $$('[data-key]').forEach((el) => {
      const k = el.dataset.key, v = S.style[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'color') el.value = v.length === 4 ? '#' + v.slice(1).split('').map((c) => c + c).join('') : v;
      else el.value = v;
      if (el.id) { const o = $(`output[data-for="${el.id}"]`); if (o) o.textContent = fmtOut(k, v); }
    });
    $('#sFont').value = S.style.fontFamily;
    $('#sWeight').value = String(S.style.fontWeight);
    $('#chunkLines').value = String(S.chunk.maxLines);
    $('#chunkWordsSel').value = String(S.chunk.maxWords || 0);
    $('#chunkChars').value = S.chunk.maxChars;
    $('#chunkCharsOut').textContent = S.chunk.maxChars;
  }

  function bindStyles() {
    const fontSel = $('#sFont');
    fontSel.innerHTML = C.FAMILIES.map((f) => `<option style="font-family:'${f}'">${f}</option>`).join('');
    fontSel.addEventListener('change', () => { S.style.fontFamily = fontSel.value; markCustom(); });
    $('#sWeight').addEventListener('change', (e) => { S.style.fontWeight = +e.target.value; markCustom(); });
    $('#presetGrid').addEventListener('click', (e) => { const b = e.target.closest('.preset'); if (b) applyPreset(b.dataset.id); });
    $$('[data-key]').forEach((el) => {
      const handler = () => {
        const k = el.dataset.key;
        let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
        S.style[k] = v;
        if (el.id) { const o = $(`output[data-for="${el.id}"]`); if (o) o.textContent = fmtOut(k, v); }
        markCustom();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    $$('[data-pos]').forEach((b) => b.addEventListener('click', () => { S.style.posY = +b.dataset.pos; S.style.posX = 0.5; save(); }));
    const chunkChange = () => {
      S.chunk.maxLines = +$('#chunkLines').value;
      S.chunk.maxWords = +$('#chunkWordsSel').value;
      S.chunk.maxChars = +$('#chunkChars').value;
      $('#chunkCharsOut').textContent = S.chunk.maxChars;
      regroup();
    };
    $('#chunkLines').addEventListener('change', chunkChange);
    $('#chunkWordsSel').addEventListener('change', chunkChange);
    let ct;
    $('#chunkChars').addEventListener('input', () => { $('#chunkCharsOut').textContent = $('#chunkChars').value; clearTimeout(ct); ct = setTimeout(chunkChange, 150); });
  }
  function markCustom() { save('debounce'); }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  function bindExport() {
    $$('[data-dl]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.dl;
        const opts = { maxChars: S.chunk.maxChars };
        if (k === 'srt') download(baseName() + '.srt', C.toSRT(S.captions, opts), 'application/x-subrip');
        if (k === 'vtt') download(baseName() + '.vtt', C.toVTT(S.captions, opts), 'text/vtt');
        if (k === 'txt') download(baseName() + '.txt', C.toTXT(S.captions));
        if (k === 'json') download(baseName() + '.words.json', JSON.stringify(S.captions.map((c) => ({ start: c.start, end: c.end, text: C.captionText(c), words: c.words })), null, 2), 'application/json');
      })
    );
    $('#saveProject').addEventListener('click', () => {
      download(baseName() + '.captioner.json', JSON.stringify({ version: 1, media: S.media, captions: S.captions, style: S.style, preset: S.preset, chunk: S.chunk, language: S.language }, null, 2), 'application/json');
    });
    $('#openProject').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const p = JSON.parse(await f.text());
        if (S.media && p.media && p.media.id !== S.media.id && !confirm('This project was made for a different upload. Apply its subtitles and style to the current video?')) return;
        if (S.media) {
          S.captions = p.captions || []; S.style = Object.assign({}, C.DEFAULT_STYLE, p.style); S.preset = p.preset || 'custom';
          S.chunk = Object.assign({}, C.DEFAULT_CHUNK, p.chunk); S.language = p.language || null;
          refreshAll(); save();
        } else if (p.media) {
          openMedia(p.media, p);
        }
        toast('Project loaded');
      } catch (err) { toast('Invalid project file', true); }
    });
    const renderBtn = $('#renderBtn');
    renderBtn.addEventListener('click', async () => {
      if (!S.media) return;
      renderBtn.disabled = true;
      $('#downloadLink').hidden = true;
      try {
        const { job } = await api('/api/render/' + S.media.id, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captions: S.captions, style: S.style, quality: $('#qualitySel').value }),
        });
        pollJob(job, $('#renderJob'), (err, j) => {
          renderBtn.disabled = false;
          if (err) return toast(err.message, true);
          const a = $('#downloadLink');
          a.href = j.download;
          a.hidden = false;
          a.click();
          toast('Export finished');
        });
      } catch (e) { renderBtn.disabled = false; toast(e.message, true); }
    });
  }

  // ---------------------------------------------------------------------------
  // Glue
  // ---------------------------------------------------------------------------
  function refreshAll() {
    renderList();
    renderTimeline();
    syncStyleInputs();
    $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.id === S.preset));
    const has = S.captions.length > 0;
    $$('[data-dl]').forEach((b) => (b.disabled = !has));
    $('#saveProject').disabled = !has;
    $('#renderBtn').disabled = !has || !S.media || !S.media.meta.video;
    $('#exportTopBtn').disabled = !has;
  }

  function switchTab(name) {
    $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => (t.hidden = t.dataset.tab !== name));
  }

  function bindGlobal() {
    $$('.rail-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#exportTopBtn').addEventListener('click', () => switchTab('export'));
    $('#playBtn').addEventListener('click', togglePlay);
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#newBtn').addEventListener('click', () => {
      if (S.captions.length && !confirm('Start a new project? Unsaved changes are kept in this browser for the current video.')) return;
      localStorage.removeItem('captioner:last');
      location.reload();
    });
    $('#transcribeBtn').addEventListener('click', transcribe);
    $('#retranscribeBtn').addEventListener('click', () => showTranscribeView(true));
    $('#langSel').innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');

    // Upload
    const dz = $('#dropzone'), fi = $('#fileInput');
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => fi.files[0] && uploadFile(fi.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    document.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (/\.(srt|vtt)$/i.test(f.name)) return importSubs(f);
      if (S.media && !confirm('Replace the current video?')) return;
      uploadFile(f);
    });

    $('#importSubs').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSubs(f); });

    // Find & replace
    $('#toggleFind').addEventListener('click', () => ($('#findDrawer').hidden = !$('#findDrawer').hidden));
    $('#toggleShift').addEventListener('click', () => ($('#shiftDrawer').hidden = !$('#shiftDrawer').hidden));
    const findRe = () => {
      const q = $('#findIn').value;
      if (!q) return null;
      return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('#findCase').checked ? 'g' : 'gi');
    };
    const count = () => {
      const re = findRe();
      $('#findCount').textContent = re ? `${S.captions.reduce((n, c) => n + (C.captionText(c).match(re) || []).length, 0)} found` : '';
    };
    $('#findIn').addEventListener('input', count);
    $('#findCase').addEventListener('change', count);
    $('#replaceAll').addEventListener('click', () => {
      const re = findRe();
      if (!re) return;
      let n = 0;
      for (const c of S.captions) {
        const txt = C.captionText(c);
        const out = txt.replace(re, () => { n++; return $('#replIn').value; });
        if (out !== txt) C.setCaptionText(c, out);
      }
      S.captions = S.captions.filter((c) => c.words.length);
      refreshAll(); save(); count();
      toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
    });
    $$('[data-shift]').forEach((b) =>
      b.addEventListener('click', () => {
        const d = +b.dataset.shift * Math.abs(+$('#shiftAmt').value || 0);
        const minStart = Math.min(...S.captions.map((c) => c.start));
        const dd = Math.max(d, -minStart);
        for (const c of S.captions) retime(c, c.start + dd, c.end + dd);
        refreshAll(); save();
        toast(`Shifted ${dd >= 0 ? '+' : ''}${dd.toFixed(2)} s`);
      })
    );

    // Keyboard
    document.addEventListener('keydown', (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 1 / 30));
      if (e.key === 'ArrowRight') video.currentTime = Math.min(duration(), video.currentTime + (e.shiftKey ? 1 : 1 / 30));
    });
  }

  async function importSubs(f) {
    const caps = C.parseSubtitles(await f.text());
    if (!caps.length) return toast('No subtitles found in that file', true);
    if (S.captions.length && !confirm('Replace the existing subtitles?')) return;
    S.captions = caps;
    refreshAll(); save();
    toast(`Imported ${caps.length} subtitles`);
  }

  async function init() {
    bindGlobal();
    bindList();
    bindTimeline();
    bindStyles();
    bindExport();
    bindCanvasDrag();
    await loadFonts();
    renderPresets();
    syncStyleInputs();
    requestAnimationFrame(frame);
    // Restore last session if its media is still on the server.
    const last = localStorage.getItem('captioner:last');
    if (last) {
      try {
        const p = JSON.parse(localStorage.getItem('captioner:' + last));
        const r = await fetch('/api/media/' + last, { method: 'HEAD' });
        if (p && r.ok) openMedia(p.media, p);
      } catch {}
    }
  }
  init();
})();
