#!/usr/bin/env python3
"""Speech-to-text worker producing word-level timestamps.

Usage: transcribe.py INPUT [--model M] [--language xx] [--task transcribe|translate]
                           [--prompt "custom vocabulary"]

Emits newline-delimited JSON on stdout:
  {"type":"status","message":...}
  {"type":"progress","progress":0..1}
  {"type":"result","language":..,"duration":..,"words":[{"text","start","end","prob"}]}
"""
import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


SR = 16000
HOP = 160  # 10 ms


def decode_audio(path):
    """Decode any media file to 16 kHz mono float32 using ffmpeg."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + out.stderr.decode(errors="replace")[-400:])
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def energy_envelope(audio):
    """Short-time RMS energy in dB at 10 ms hops (20 ms windows)."""
    win = 320
    if len(audio) < win:
        return np.full(1, -100.0)
    n = 1 + (len(audio) - win) // HOP
    idx = np.arange(win)[None, :] + HOP * np.arange(n)[:, None]
    frames = audio[idx]
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-9)


def refine_word_times(words, audio):
    """Tighten word boundaries against the audio energy.

    Whisper's cross-attention timestamps commonly let the word preceding a
    pause run on into the silence, and occasionally start a word inside the
    silence before it. Captions then linger or appear early. We only ever
    *shrink* a word's span towards audible speech, so the refinement can't
    make anything worse than the raw alignment.
    """
    if not words:
        return words
    db = energy_envelope(audio)
    floor = float(np.percentile(db, 10))
    peak = float(np.percentile(db, 95))
    thresh = floor + max(6.0, 0.30 * (peak - floor))
    voiced = db > thresh
    nfr = len(voiced)

    def fr(t):
        return int(min(max(t * SR / HOP, 0), nfr - 1))

    pad = 0.04
    for w in words:
        s, e = w["start"], w["end"]
        a, b = fr(s), fr(e)
        if b - a < 3:
            continue
        seg = voiced[a : b + 1]
        if not seg.any():
            continue  # no clear speech: keep whisper's estimate
        first = a + int(np.argmax(seg))
        last = a + len(seg) - 1 - int(np.argmax(seg[::-1]))
        ns = max(s, first * HOP / SR - pad)
        ne = min(e, (last + 2) * HOP / SR + pad)
        if ne - ns >= 0.08:
            w["start"], w["end"] = round(ns, 3), round(ne, 3)
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "large-v3-turbo"))
    ap.add_argument("--language", default=None)
    ap.add_argument("--task", default="transcribe")
    ap.add_argument("--prompt", default=None)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    emit({"type": "status", "message": f"Loading model {args.model}…"})
    device = os.environ.get("WHISPER_DEVICE", "auto")
    compute = os.environ.get("WHISPER_COMPUTE", "default")
    model = WhisperModel(
        args.model,
        device=device,
        compute_type=compute if compute != "default" else ("int8" if device in ("cpu", "auto") else "float16"),
        cpu_threads=os.cpu_count() or 4,
    )

    emit({"type": "status", "message": "Decoding audio…"})
    audio = decode_audio(args.input)
    if len(audio) < SR // 10:
        raise RuntimeError("No audio track found in this file")
    duration = len(audio) / SR

    emit({"type": "status", "message": "Transcribing…"})
    segments, info = model.transcribe(
        audio,
        language=(args.language or None) if args.language not in ("", "auto") else None,
        task=args.task,
        beam_size=5,
        best_of=5,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        condition_on_previous_text=True,
        initial_prompt=args.prompt or None,
        hallucination_silence_threshold=2.0,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
    )

    words = []
    for seg in segments:
        # Drop segments that look like hallucinated filler over silence.
        if seg.no_speech_prob > 0.8 and seg.avg_logprob < -1.0:
            continue
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append(
                {
                    "text": text,
                    "start": round(float(w.start), 3),
                    "end": round(float(max(w.end, w.start + 0.05)), 3),
                    "prob": round(float(w.probability), 3),
                }
            )
        emit({"type": "progress", "progress": min(1.0, seg.end / max(duration, 1e-6))})

    # Whisper sometimes emits a stand-alone punctuation token; attach it to the
    # previous word so captions never start with a stray "," or "?".
    merged = []
    for w in words:
        if merged and re.fullmatch(r"[^\w\s]+", w["text"]):
            merged[-1]["text"] += w["text"]
            merged[-1]["end"] = max(merged[-1]["end"], w["end"])
        else:
            merged.append(w)
    words = merged

    # Enforce monotonic, non-overlapping timings.
    for i in range(1, len(words)):
        if words[i]["start"] < words[i - 1]["end"]:
            mid = round((words[i]["start"] + words[i - 1]["end"]) / 2, 3)
            words[i - 1]["end"] = max(words[i - 1]["start"] + 0.02, mid)
            words[i]["start"] = max(words[i]["start"], words[i - 1]["end"])
            words[i]["end"] = max(words[i]["end"], words[i]["start"] + 0.02)

    words = refine_word_times(words, audio)

    emit(
        {
            "type": "result",
            "language": info.language,
            "language_probability": round(float(info.language_probability), 3),
            "duration": round(duration, 3),
            "words": words,
        }
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # report to the server instead of a bare traceback
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
