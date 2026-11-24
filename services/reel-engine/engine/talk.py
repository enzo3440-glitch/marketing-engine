"""Talking-to-camera / podcast prep: transcript, dead-air removal, word timings on the cut timeline."""
import re
import subprocess

from .common import FFMPEG, jload

_model = None


def transcribe(path, model="base.en"):
    """Word-level transcript via faster-whisper. Returns [{w, t0, t1}] or None if unavailable."""
    global _model
    try:
        from faster_whisper import WhisperModel
        if _model is None:
            _model = WhisperModel(model, device="cpu", compute_type="int8")
        segs, _ = _model.transcribe(str(path), word_timestamps=True, vad_filter=True)
        words = []
        for s in segs:
            for w in s.words or []:
                words.append(dict(w=w.word.strip(), t0=round(w.start, 3), t1=round(w.end, 3)))
        return words
    except Exception as e:  # model download blocked, lib missing, etc.
        print(f"[talk] transcription unavailable: {e.__class__.__name__}: {str(e)[:120]}")
        return None


def silences(path, noise_db=-32, min_d=0.35):
    r = subprocess.run([FFMPEG, "-v", "info", "-i", str(path), "-af",
                        f"silencedetect=noise={noise_db}dB:d={min_d}", "-f", "null", "-"],
                       stderr=subprocess.PIPE)
    log = r.stderr.decode(errors="ignore")
    st = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", log)]
    en = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    return list(zip(st, en + [None] * (len(st) - len(en))))


def speech_ranges(path, duration, words=None, pad=0.08, merge_gap=0.28, min_len=0.35):
    """Ranges of the source to keep (dead air and long pauses removed)."""
    if words:
        rng = []
        for w in words:
            a, b = max(w["t0"] - pad, 0), min(w["t1"] + pad, duration)
            if rng and a - rng[-1][1] <= merge_gap:
                rng[-1][1] = b
            else:
                rng.append([a, b])
    else:
        sil = silences(path)
        rng, cur = [], 0.0
        for a, b in sil:
            if a - cur > 0:
                rng.append([max(cur - pad, 0), min(a + pad, duration)])
            cur = b if b is not None else duration
        if cur < duration:
            rng.append([max(cur - pad, 0), duration])
        merged = []
        for a, b in rng:
            if merged and a - merged[-1][1] <= merge_gap:
                merged[-1][1] = b
            else:
                merged.append([a, b])
        rng = merged
    return [[round(a, 3), round(b, 3)] for a, b in rng if b - a >= min_len]


def remap_words(words, ranges):
    """Move word timings from source time onto the jump-cut timeline."""
    out, t = [], 0.0
    for a, b in ranges:
        for w in words:
            if w["t0"] >= a - 1e-3 and w["t1"] <= b + 1e-3:
                out.append(dict(w=w["w"], t0=round(t + w["t0"] - a, 3), t1=round(t + w["t1"] - a, 3)))
        t += b - a
    return out


def script_words(script, ranges):
    """No transcript: spread a provided script over the kept speech, weighted by word length."""
    words = script.split()
    total = sum(b - a for a, b in ranges)
    if not words or total <= 0:
        return []
    wts = [len(w) + 2 for w in words]
    s = sum(wts)
    out, t = [], 0.0
    for w, k in zip(words, wts):
        d = total * k / s
        out.append(dict(w=w, t0=round(t, 3), t1=round(t + d, 3)))
        t += d
    return out


def caption_groups(words, max_words=3, max_chars=16):
    """Chunk words into 1-3 word karaoke events (the native short-form caption rhythm)."""
    ev, cur = [], []
    for w in words:
        clean = w["w"].strip()
        if not clean:
            continue
        cur.append(dict(w=clean, t0=w["t0"], t1=w["t1"]))
        txt = " ".join(x["w"] for x in cur)
        end_sentence = clean[-1] in ".?!,"
        if len(cur) >= max_words or len(txt) >= max_chars or end_sentence:
            ev.append(cur)
            cur = []
    if cur:
        ev.append(cur)
    out = []
    for i, g in enumerate(ev):
        t1 = ev[i + 1][0]["t0"] if i + 1 < len(ev) else g[-1]["t1"] + 0.3
        out.append(dict(t0=g[0]["t0"], t1=max(t1, g[-1]["t1"]), text=" ".join(x["w"] for x in g),
                        style="karaoke", pos="lower", words=g))
    return out
