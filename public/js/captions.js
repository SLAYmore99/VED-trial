/*
 * Caption engine shared by the browser preview and the server-side renderer.
 * The exact same code lays out and draws every frame in both places, so the
 * burned-in export matches the editor preview pixel for pixel.
 *
 * Works with any Canvas 2D context (browser <canvas> or @napi-rs/canvas).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Captions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Fonts
  // ---------------------------------------------------------------------------
  const FONTS = [
    { family: 'Montserrat', file: 'Montserrat-VF.ttf', weights: [400, 500, 600, 700, 800, 900] },
    { family: 'Poppins', file: 'Poppins-Regular.ttf', weight: 400 },
    { family: 'Poppins', file: 'Poppins-SemiBold.ttf', weight: 600 },
    { family: 'Poppins', file: 'Poppins-Bold.ttf', weight: 700 },
    { family: 'Poppins', file: 'Poppins-ExtraBold.ttf', weight: 800 },
    { family: 'Poppins', file: 'Poppins-Black.ttf', weight: 900 },
    { family: 'Anton', file: 'Anton-Regular.ttf', weight: 400 },
    { family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', weight: 400 },
    { family: 'Bangers', file: 'Bangers-Regular.ttf', weight: 400 },
    { family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', weight: 400 },
    { family: 'Lilita One', file: 'LilitaOne-Regular.ttf', weight: 400 },
    { family: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf', weight: 400 },
    { family: 'Permanent Marker', file: 'PermanentMarker-Regular.ttf', weight: 400 },
    { family: 'DM Serif Display', file: 'DMSerifDisplay-Regular.ttf', weight: 400 },
    { family: 'Rubik Mono One', file: 'RubikMonoOne-Regular.ttf', weight: 400 },
  ];
  const FAMILIES = [...new Set(FONTS.map((f) => f.family))];
  // Single-weight display fonts: forcing a bold weight would make the browser
  // synthesize faux-bold while Skia would not, breaking preview/export parity.
  function effectiveWeight(family, weight) {
    const faces = FONTS.filter((f) => f.family === family);
    const avail = faces.flatMap((f) => f.weights || [f.weight]);
    if (!avail.length) return weight;
    return avail.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), avail[0]);
  }

  // ---------------------------------------------------------------------------
  // Style presets (modelled on the template gallery of popular online editors)
  // ---------------------------------------------------------------------------
  const DEFAULT_STYLE = {
    fontFamily: 'Montserrat',
    fontWeight: 800,
    fontSize: 6.5, // % of the shorter video side
    uppercase: false,
    lineHeight: 1.18,
    letterSpacing: 0, // em
    textColor: '#FFFFFF',
    highlightColor: '#FFE600',
    strokeColor: '#000000',
    strokeWidth: 0.12, // em
    shadowColor: '#000000',
    shadowOpacity: 0.6,
    shadowBlur: 0.12, // em
    shadowX: 0,
    shadowY: 0.05, // em
    background: 'none', // none | line | block | word
    bgColor: '#000000',
    bgOpacity: 0.75,
    bgRadius: 0.22, // em
    bgPadX: 0.32, // em
    bgPadY: 0.12, // em
    boxColor: '#7C3AED', // active-word box (wordAnim = box)
    boxTextColor: '#FFFFFF',
    wordAnim: 'none', // none | highlight | karaoke | box | pop | reveal | bounce | underline
    captionAnim: 'none', // none | fade | pop | slide
    posX: 0.5, // centre of caption block, fraction of width
    posY: 0.78, // centre of caption block, fraction of height
    maxWidth: 82, // % of video width
  };

  const PRESETS = [
    { id: 'classic', name: 'Classic', style: { fontFamily: 'Montserrat', fontWeight: 700, fontSize: 5.2, strokeWidth: 0.1, shadowOpacity: 0.5 } },
    {
      id: 'boxed', name: 'Boxed',
      style: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 4.8, strokeWidth: 0, shadowOpacity: 0, background: 'line', bgOpacity: 0.78, bgRadius: 0.18 },
    },
    {
      id: 'karaoke', name: 'Karaoke',
      style: { fontFamily: 'Montserrat', fontWeight: 900, fontSize: 6, uppercase: true, wordAnim: 'karaoke', highlightColor: '#22D3EE', strokeWidth: 0.13 },
    },
    {
      id: 'punch', name: 'Punch',
      style: {
        fontFamily: 'Montserrat', fontWeight: 900, fontSize: 7.5, uppercase: true, wordAnim: 'pop', captionAnim: 'pop',
        highlightColor: '#39FF14', strokeWidth: 0.16, shadowBlur: 0.18, shadowOpacity: 0.8, posY: 0.68,
      },
      chunk: { maxWords: 3, maxChars: 16, maxLines: 2 },
    },
    {
      id: 'wordbox', name: 'Word Box',
      style: {
        fontFamily: 'Poppins', fontWeight: 800, fontSize: 6.5, uppercase: true, wordAnim: 'box', boxColor: '#7C3AED',
        strokeWidth: 0.0, shadowOpacity: 0.7, shadowBlur: 0.1, captionAnim: 'pop',
      },
      chunk: { maxChars: 22, maxLines: 2 },
    },
    {
      id: 'highlight', name: 'Highlight',
      style: { fontFamily: 'Montserrat', fontWeight: 800, fontSize: 6.5, wordAnim: 'highlight', highlightColor: '#FFE600', strokeWidth: 0.12 },
    },
    {
      id: 'typewriter', name: 'Typewriter',
      style: { fontFamily: 'Poppins', fontWeight: 700, fontSize: 5.5, wordAnim: 'reveal', strokeWidth: 0, shadowOpacity: 0.85, shadowBlur: 0.18 },
    },
    {
      id: 'bounce', name: 'Bounce',
      style: { fontFamily: 'Lilita One', fontWeight: 400, fontSize: 7.5, wordAnim: 'bounce', highlightColor: '#FF4D8D', strokeWidth: 0.14, captionAnim: 'slide' },
    },
    {
      id: 'neon', name: 'Neon',
      style: {
        fontFamily: 'Montserrat', fontWeight: 800, fontSize: 6.2, textColor: '#FFFFFF', strokeWidth: 0, shadowColor: '#FF2BD6',
        shadowOpacity: 1, shadowBlur: 0.45, shadowY: 0, wordAnim: 'highlight', highlightColor: '#FFB8F3',
      },
    },
    {
      id: 'comic', name: 'Comic',
      style: { fontFamily: 'Bangers', fontWeight: 400, fontSize: 8, letterSpacing: 0.03, wordAnim: 'pop', highlightColor: '#FFD400', strokeWidth: 0.16, shadowX: 0.06, shadowY: 0.06, shadowBlur: 0, shadowOpacity: 1 },
    },
    {
      id: 'retro', name: 'Retro',
      style: { fontFamily: 'Archivo Black', fontWeight: 400, fontSize: 6, textColor: '#FFF4D6', strokeWidth: 0.08, strokeColor: '#1B1B1B', shadowColor: '#E4572E', shadowOpacity: 1, shadowBlur: 0, shadowX: 0.08, shadowY: 0.08, wordAnim: 'underline', highlightColor: '#E4572E' },
    },
    {
      id: 'single', name: 'One Word',
      style: { fontFamily: 'Anton', fontWeight: 400, fontSize: 11, uppercase: true, strokeWidth: 0.1, captionAnim: 'pop', posY: 0.5 },
      chunk: { maxWords: 1, maxChars: 20, maxLines: 1 },
    },
    {
      id: 'minimal', name: 'Minimal',
      style: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 4.2, strokeWidth: 0, shadowOpacity: 0.9, shadowBlur: 0.25, shadowY: 0.03, posY: 0.86, captionAnim: 'fade' },
    },
    {
      id: 'marker', name: 'Marker',
      style: { fontFamily: 'Permanent Marker', fontWeight: 400, fontSize: 6.5, textColor: '#111111', strokeWidth: 0, shadowOpacity: 0, background: 'word', bgColor: '#FFE600', bgOpacity: 1, bgRadius: 0.08, bgPadX: 0.18, bgPadY: 0.04 },
    },
    {
      id: 'elegant', name: 'Elegant',
      style: { fontFamily: 'DM Serif Display', fontWeight: 400, fontSize: 6, strokeWidth: 0, shadowOpacity: 0.7, shadowBlur: 0.3, captionAnim: 'fade', wordAnim: 'reveal' },
    },
  ];

  function presetStyle(id) {
    const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
    return Object.assign({}, DEFAULT_STYLE, p.style);
  }

  // ---------------------------------------------------------------------------
  // Chunking: word stream -> caption blocks
  // ---------------------------------------------------------------------------
  const DEFAULT_CHUNK = {
    maxChars: 32, // characters per line
    maxLines: 2,
    maxWords: 0, // 0 = no limit
    maxDuration: 6, // seconds
    pauseSplit: 0.7, // start a new caption after a silence this long
    punctuation: true,
    minDuration: 0.7,
    gapFill: 0.6, // keep a caption on screen across gaps shorter than this
  };

  const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
  const CLAUSE_END = /[,;:，、；：—–-]["'”’)\]]*$/;

  let _uid = 0;
  function uid() {
    _uid = (_uid + 1) % 1e9;
    return 'c' + Date.now().toString(36) + _uid.toString(36);
  }

  function charsOf(words) {
    let n = 0;
    for (const w of words) n += w.text.length;
    return n + Math.max(0, words.length - 1);
  }

  function chunkWords(words, opts) {
    const o = Object.assign({}, DEFAULT_CHUNK, opts || {});
    const cap = o.maxChars * o.maxLines;
    const groups = [];
    let cur = [];

    const flush = (n) => {
      const take = n == null ? cur.length : n;
      if (take > 0) groups.push(cur.slice(0, take));
      cur = cur.slice(take);
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const gap = w.start - prev.end;
        const used = charsOf(cur);
        if (gap >= o.pauseSplit) flush();
        else if (o.maxWords && cur.length >= o.maxWords) flush();
        else if (o.punctuation && SENTENCE_END.test(prev.text)) flush();
        else if (o.punctuation && CLAUSE_END.test(prev.text) && used >= cap * 0.55) flush();
        else if (w.end - cur[0].start > o.maxDuration && cur.length > 1) flush();
        else if (used + 1 + w.text.length > cap) {
          // Prefer breaking at the last clause boundary if one exists in the
          // back half of the block, instead of mid-phrase.
          let br = -1;
          if (o.punctuation) {
            for (let j = cur.length - 1; j >= 1; j--) {
              if (CLAUSE_END.test(cur[j - 1].text) && charsOf(cur.slice(0, j)) >= cap * 0.4) {
                br = j;
                break;
              }
            }
          }
          flush(br > 0 ? br : null);
        }
      }
      cur.push(w);
    }
    flush();

    // Avoid a dangling single short word when it could join the previous block.
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      const p = groups[i - 1];
      if (
        g.length === 1 && !o.maxWords && p.length > 1 &&
        g[0].start - p[p.length - 1].end < o.pauseSplit &&
        !SENTENCE_END.test(p[p.length - 1].text) &&
        charsOf(p) + 1 + g[0].text.length <= cap + 6
      ) {
        p.push(g[0]);
        groups.splice(i, 1);
        i--;
      }
    }

    const caps = groups.map((g) => ({
      id: uid(),
      start: g[0].start,
      end: g[g.length - 1].end,
      words: g.map((w) => (w.prob != null ? { text: w.text, start: w.start, end: w.end, prob: w.prob } : { text: w.text, start: w.start, end: w.end })),
    }));
    return fixTimings(caps, o);
  }

  function fixTimings(caps, opts) {
    const o = Object.assign({}, DEFAULT_CHUNK, opts || {});
    caps.sort((a, b) => a.start - b.start);
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i];
      const next = caps[i + 1];
      if (c.end - c.start < o.minDuration) c.end = c.start + o.minDuration;
      if (next) {
        if (next.start - c.end < o.gapFill) c.end = next.start;
        if (c.end > next.start) c.end = next.start;
      }
      c.start = round3(c.start);
      c.end = round3(Math.max(c.end, c.start + 0.05));
    }
    return caps;
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  function flattenWords(caps) {
    const out = [];
    for (const c of caps) for (const w of c.words) out.push(Object.assign({}, w));
    return out.sort((a, b) => a.start - b.start);
  }

  function captionText(c) {
    return c.words.map((w) => w.text).join(' ');
  }

  /** Replace a caption's text, keeping word timings where the words still match. */
  function setCaptionText(c, text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) {
      c.words = [];
      return c;
    }
    const old = c.words;
    if (old.length === toks.length) {
      // Unchanged words keep their confidence; edited words count as verified.
      c.words = toks.map((t, i) => (t === old[i].text && old[i].prob != null
        ? { text: t, start: old[i].start, end: old[i].end, prob: old[i].prob }
        : { text: t, start: old[i].start, end: old[i].end }));
      return c;
    }
    // Align old->new by longest common subsequence of normalized tokens, keep
    // matched timings and interpolate the rest proportionally to length.
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
    const n = old.length, m = toks.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = norm(old[i].text) === norm(toks[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const anchor = new Array(m).fill(null);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (norm(old[i].text) === norm(toks[j])) { anchor[j] = old[i]; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    const words = toks.map((t, j) => (anchor[j]
      ? Object.assign({ text: t, start: anchor[j].start, end: anchor[j].end }, t === anchor[j].text && anchor[j].prob != null ? { prob: anchor[j].prob } : {})
      : { text: t, start: null, end: null }));
    // Fill unanchored runs between known boundaries.
    let j = 0;
    while (j < m) {
      if (words[j].start != null) { j++; continue; }
      let k = j;
      while (k < m && words[k].start == null) k++;
      const t0 = j > 0 ? words[j - 1].end : c.start;
      const t1 = k < m ? words[k].start : c.end;
      const lens = words.slice(j, k).map((w) => w.text.length + 1);
      const total = lens.reduce((a, b) => a + b, 0);
      let t = t0;
      const span = Math.max(0.05 * (k - j), t1 - t0);
      for (let q = j; q < k; q++) {
        const d = (span * lens[q - j]) / total;
        words[q].start = round3(t);
        words[q].end = round3(t + d);
        t += d;
      }
      j = k;
    }
    c.words = words;
    return c;
  }

  /** Spread words evenly over a caption (used for imported SRT/VTT). */
  function distributeWords(text, start, end) {
    const c = { id: uid(), start, end, words: [] };
    const toks = text.trim().split(/\s+/).filter(Boolean);
    const total = toks.reduce((a, t) => a + t.length + 1, 0) || 1;
    let t = start;
    for (const tok of toks) {
      const d = ((end - start) * (tok.length + 1)) / total;
      c.words.push({ text: tok, start: round3(t), end: round3(t + d) });
      t += d;
    }
    return c;
  }

  // ---------------------------------------------------------------------------
  // Subtitle file formats
  // ---------------------------------------------------------------------------
  function fmtTime(t, sep) {
    t = Math.max(0, t);
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    const p = (x, n) => String(x).padStart(n, '0');
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${sep}${p(r, 3)}`;
  }

  function lineBreakText(c, maxChars) {
    // Plain-text line breaks for SRT/VTT, balanced like the renderer's layout.
    const words = c.words.map((w) => w.text);
    const full = words.join(' ');
    if (full.length <= maxChars || words.length < 2) return full;
    let best = full, bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const score = Math.max(a.length, b.length) + (a.length > b.length ? 0.5 : 0);
      if (score < bestScore) { bestScore = score; best = a + '\n' + b; }
    }
    return best;
  }

  function toSRT(caps, opts) {
    const mc = (opts && opts.maxChars) || 42;
    return caps
      .filter((c) => c.words.length)
      .map((c, i) => `${i + 1}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${lineBreakText(c, mc)}\n`)
      .join('\n');
  }

  function toVTT(caps, opts) {
    const mc = (opts && opts.maxChars) || 42;
    return (
      'WEBVTT\n\n' +
      caps
        .filter((c) => c.words.length)
        .map((c) => `${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}\n${lineBreakText(c, mc)}\n`)
        .join('\n')
    );
  }

  function toTXT(caps) {
    return caps.map(captionText).join(' ').replace(/\s+/g, ' ').trim() + '\n';
  }

  function parseTime(s) {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return 0;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
  }

  function parseSubtitles(text) {
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    const caps = [];
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() !== '');
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) continue;
      const [a, z] = lines[ti].split('-->');
      const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (!body) continue;
      caps.push(distributeWords(body, parseTime(a), parseTime(z.trim().split(/\s+/)[0])));
    }
    return caps.sort((a, b) => a.start - b.start);
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------
  function fontString(style, px) {
    const w = effectiveWeight(style.fontFamily, style.fontWeight);
    return `${w} ${px}px "${style.fontFamily}"`;
  }

  function displayText(style, t) {
    return style.uppercase ? t.toLocaleUpperCase() : t;
  }

  function measure(ctx, style, px, text) {
    const ls = (style.letterSpacing || 0) * px;
    return ctx.measureText(text).width + ls * Math.max(0, [...text].length - 1);
  }

  function balancedBreaks(widths, space, maxW) {
    const n = widths.length;
    const lineW = (i, j) => {
      let s = 0;
      for (let k = i; k < j; k++) s += widths[k];
      return s + space * (j - i - 1);
    };
    if (lineW(0, n) <= maxW) return [[0, n]];
    // Minimum number of lines via greedy fill.
    let lines = 1, acc = 0;
    for (let k = 0; k < n; k++) {
      const add = acc === 0 ? widths[k] : acc + space + widths[k];
      if (add > maxW && acc > 0) { lines++; acc = widths[k]; } else acc = add;
    }
    // DP: split into exactly `lines` lines minimising the widest line, then
    // prefer a slightly longer bottom line (reads more naturally).
    const memo = new Map();
    const solve = (i, k) => {
      const key = i * 100 + k;
      if (memo.has(key)) return memo.get(key);
      let res;
      if (k === 1) res = { cost: lineW(i, n), bias: 0, cuts: [] };
      else {
        res = { cost: Infinity, bias: 0, cuts: [] };
        for (let j = i + 1; j <= n - k + 1; j++) {
          const w = lineW(i, j);
          const sub = solve(j, k - 1);
          const cost = Math.max(w, sub.cost);
          const bias = w > lineW(j, sub.cuts.length ? sub.cuts[0] : n) ? 1 : 0;
          if (cost < res.cost - 0.5 || (Math.abs(cost - res.cost) <= 0.5 && bias < res.bias)) {
            res = { cost, bias, cuts: [j].concat(sub.cuts) };
          }
        }
      }
      memo.set(key, res);
      return res;
    };
    const cuts = [0].concat(solve(0, lines).cuts, [n]);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) out.push([cuts[i], cuts[i + 1]]);
    return out;
  }

  function layoutCaption(ctx, cap, style, W, H) {
    let px = (style.fontSize / 100) * Math.min(W, H);
    const maxW = (style.maxWidth / 100) * W;
    const texts = cap.words.map((w) => displayText(style, w.text));
    ctx.font = fontString(style, px);
    let widths = texts.map((t) => measure(ctx, style, px, t));
    // Shrink if a single word can't fit the available width.
    const widest = Math.max(0, ...widths);
    if (widest > maxW) {
      px = (px * maxW) / widest;
      ctx.font = fontString(style, px);
      widths = texts.map((t) => measure(ctx, style, px, t));
    }
    const space = measure(ctx, style, px, ' ') + (style.letterSpacing || 0) * px;
    const ranges = balancedBreaks(widths, space, maxW);
    const lh = px * style.lineHeight;
    const blockH = lh * ranges.length;
    const cx = style.posX * W;
    const top = style.posY * H - blockH / 2;
    const lines = ranges.map(([a, b], li) => {
      let lw = 0;
      for (let k = a; k < b; k++) lw += widths[k];
      lw += space * (b - a - 1);
      let x = cx - lw / 2;
      const cy = top + lh * li + lh / 2; // vertical centre of the line
      const words = [];
      for (let k = a; k < b; k++) {
        words.push({ index: k, text: texts[k], x, width: widths[k], cy });
        x += widths[k] + space;
      }
      return { x: cx - lw / 2, width: lw, cy, words };
    });
    return { px, lh, space, lines, cx, cy: style.posY * H, top, blockH, width: Math.max(...lines.map((l) => l.width)) };
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function rgba(hex, a) {
    let h = (hex || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a == null ? 1 : a})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
  const easeOutBack = (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };

  function findCaption(caps, t) {
    let lo = 0, hi = caps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = caps[mid];
      if (t < c.start) hi = mid - 1;
      else if (t >= c.end) lo = mid + 1;
      else return c;
    }
    return null;
  }

  function fillWord(ctx, style, text, x, y, px) {
    const ls = (style.letterSpacing || 0) * px;
    if (!ls) {
      ctx.fillText(text, x, y);
      return;
    }
    for (const ch of text) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + ls;
    }
  }
  function strokeWord(ctx, style, text, x, y, px) {
    const ls = (style.letterSpacing || 0) * px;
    if (!ls) {
      ctx.strokeText(text, x, y);
      return;
    }
    for (const ch of text) {
      ctx.strokeText(ch, x, y);
      x += ctx.measureText(ch).width + ls;
    }
  }

  /**
   * Draw the caption visible at time t. Returns the layout (for hit-testing)
   * or null if nothing is on screen.
   */
  function drawFrame(ctx, caps, t, style, W, H, opts) {
    const cap = findCaption(caps, t);
    if (!cap || !cap.words.length) return null;
    const L = layoutCaption(ctx, cap, style, W, H);
    const px = L.px;

    // Active word: the last word that has started. Holding it through the
    // inter-word gap avoids the highlight flickering off between words.
    let active = -1;
    for (let i = 0; i < cap.words.length; i++) if (cap.words[i].start <= t) active = i;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    // Caption-level entrance.
    const ep = clamp01((t - cap.start) / 0.18);
    if (style.captionAnim === 'fade') ctx.globalAlpha = easeOutCubic(ep);
    else if (style.captionAnim === 'pop') {
      const s = 0.82 + 0.18 * easeOutBack(clamp01((t - cap.start) / 0.16));
      ctx.translate(L.cx, L.cy);
      ctx.scale(s, s);
      ctx.translate(-L.cx, -L.cy);
    } else if (style.captionAnim === 'slide') {
      ctx.globalAlpha = easeOutCubic(ep);
      ctx.translate(0, (1 - easeOutCubic(ep)) * px * 0.5);
    }

    const padX = style.bgPadX * px, padY = style.bgPadY * px, rad = style.bgRadius * px;
    const textH = px * 1.0; // em box used for backgrounds

    // Backgrounds.
    if (style.background === 'block') {
      ctx.fillStyle = rgba(style.bgColor, style.bgOpacity);
      roundRect(ctx, L.cx - L.width / 2 - padX, L.top + (L.lh - textH) / 2 - padY, L.width + padX * 2, L.blockH - (L.lh - textH) + padY * 2, rad);
      ctx.fill();
    } else if (style.background === 'line') {
      ctx.fillStyle = rgba(style.bgColor, style.bgOpacity);
      for (const ln of L.lines) {
        roundRect(ctx, ln.x - padX, ln.cy - textH / 2 - padY, ln.width + padX * 2, textH + padY * 2, rad);
        ctx.fill();
      }
    }

    const wa = style.wordAnim;
    const visible = (i) => {
      if (wa !== 'reveal') return 1;
      const w = cap.words[i];
      if (t < w.start) return 0;
      return easeOutCubic(clamp01((t - w.start) / 0.12));
    };

    for (const ln of L.lines) {
      for (const w of ln.words) {
        const i = w.index;
        const word = cap.words[i];
        const vis = visible(i);
        if (vis <= 0) continue;
        const isActive = i === active && t < cap.end;
        const spoken = t >= word.end;

        let x = w.x, y = ln.cy, scale = 1;
        if (wa === 'pop' && isActive) {
          // Quick overshoot then settle slightly enlarged while spoken.
          const p = clamp01((t - word.start) / 0.16);
          scale = 1 + 0.12 * easeOutBack(p) - 0.04 * p;
        } else if (wa === 'bounce' && isActive) {
          const p = clamp01((t - word.start) / 0.2);
          y -= Math.sin(Math.PI * p) * px * 0.14;
          scale = 1 + 0.08 * Math.sin(Math.PI * Math.min(1, p * 1.2));
        }

        ctx.save();
        ctx.globalAlpha *= vis;
        if (scale !== 1) {
          const cxw = x + w.width / 2;
          ctx.translate(cxw, y);
          ctx.scale(scale, scale);
          ctx.translate(-cxw, -y);
        }
        ctx.font = fontString(style, px);

        if (style.background === 'word') {
          ctx.fillStyle = rgba(style.bgColor, style.bgOpacity);
          roundRect(ctx, x - padX, y - textH / 2 - padY, w.width + padX * 2, textH + padY * 2, rad);
          ctx.fill();
        }
        if (wa === 'box' && isActive) {
          const bp = easeOutBack(clamp01((t - word.start) / 0.12));
          const bx = 0.2 * px, by = 0.09 * px;
          const cxw = x + w.width / 2;
          ctx.save();
          ctx.translate(cxw, y);
          ctx.scale(0.85 + 0.15 * bp, 0.85 + 0.15 * bp);
          ctx.fillStyle = rgba(style.boxColor, 1);
          roundRect(ctx, -w.width / 2 - bx, -textH / 2 - by, w.width + bx * 2, textH + by * 2, 0.18 * px);
          ctx.fill();
          ctx.restore();
        }

        let color = style.textColor;
        if (isActive && (wa === 'highlight' || wa === 'pop' || wa === 'bounce')) color = style.highlightColor;
        if (isActive && wa === 'box') color = style.boxTextColor;

        // Shadow + stroke pass.
        const sw = style.strokeWidth * px;
        const hasShadow = style.shadowOpacity > 0 && (style.shadowBlur > 0 || style.shadowX || style.shadowY);
        const setShadow = () => {
          ctx.shadowColor = rgba(style.shadowColor, style.shadowOpacity * ctx.globalAlpha);
          ctx.shadowBlur = style.shadowBlur * px;
          ctx.shadowOffsetX = style.shadowX * px;
          ctx.shadowOffsetY = style.shadowY * px;
        };
        const clearShadow = () => {
          ctx.shadowColor = 'rgba(0,0,0,0)';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
        };
        if (sw > 0) {
          if (hasShadow) setShadow();
          ctx.strokeStyle = rgba(style.strokeColor, 1);
          ctx.lineWidth = sw * 2;
          strokeWord(ctx, style, w.text, x, y, px);
          clearShadow();
        } else if (hasShadow) {
          setShadow();
        }
        ctx.fillStyle = rgba(color, 1);
        fillWord(ctx, style, w.text, x, y, px);
        clearShadow();

        if (wa === 'karaoke') {
          // Colour sweeps across each word over its spoken duration.
          const p = spoken ? 1 : t < word.start ? 0 : (t - word.start) / Math.max(0.05, word.end - word.start);
          if (p > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x - sw, y - px, (w.width + sw * 2) * p + (p >= 1 ? sw : 0), px * 2);
            ctx.clip();
            ctx.fillStyle = rgba(style.highlightColor, 1);
            fillWord(ctx, style, w.text, x, y, px);
            ctx.restore();
          }
        } else if (wa === 'underline' && isActive) {
          const p = easeOutCubic(clamp01((t - word.start) / 0.15));
          ctx.fillStyle = rgba(style.highlightColor, 1);
          const uh = Math.max(2, px * 0.09);
          ctx.fillRect(x, y + px * 0.48, w.width * p, uh);
        }
        ctx.restore();
      }
    }
    ctx.restore();
    return { caption: cap, layout: L };
  }

  /** Bounding box of a caption block at time t (for drag handles). */
  function captionBounds(ctx, caps, t, style, W, H) {
    const cap = findCaption(caps, t);
    if (!cap || !cap.words.length) return null;
    const L = layoutCaption(ctx, cap, style, W, H);
    const pad = L.px * 0.3;
    return { x: L.cx - L.width / 2 - pad, y: L.top - pad, w: L.width + pad * 2, h: L.blockH + pad * 2 };
  }

  return {
    FONTS, FAMILIES, DEFAULT_STYLE, DEFAULT_CHUNK, PRESETS, presetStyle,
    chunkWords, fixTimings, flattenWords, captionText, setCaptionText, distributeWords,
    toSRT, toVTT, toTXT, parseSubtitles, fmtTime,
    layoutCaption, drawFrame, captionBounds, findCaption, effectiveWeight,
  };
});
