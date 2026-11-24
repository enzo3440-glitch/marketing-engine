"""One song, many reels: chroma fingerprints tell when two references use the same song and where each pulled
sound sits in it, so their templates merge into one and their pulls stitch into a longer stretch of the song."""
import hashlib
import subprocess
from pathlib import Path

import numpy as np

from .beats import load_audio
from .common import FFMPEG

SR = 11025
HOP = 0.1  # seconds per fingerprint frame


def fingerprint(path):
    """12 pitch-class energies per 0.1s, unit length per frame (key and timbre, not loudness). Cached beside the file."""
    cache = Path(str(path) + ".chroma.npy")
    if cache.exists() and cache.stat().st_mtime >= Path(path).stat().st_mtime:
        return np.load(cache)
    y = load_audio(path, sr=SR)
    n, hop = 4096, int(SR * HOP)
    fr = 1 + max(0, (len(y) - n) // hop)
    if fr < 10:
        return np.zeros((0, 12))
    idx = np.arange(n)[None, :] + hop * np.arange(fr)[:, None]
    S = np.abs(np.fft.rfft(y[idx] * np.hanning(n), axis=1))
    f = np.fft.rfftfreq(n, 1 / SR)
    ok = (f > 60) & (f < 4000)
    pc = (np.round(12 * np.log2(f[ok] / 440)) % 12).astype(int)
    C = np.stack([S[:, ok][:, pc == k].sum(1) for k in range(12)], 1)
    C = np.log1p(C)
    C -= C.mean(1, keepdims=True)
    C /= np.linalg.norm(C, axis=1, keepdims=True) + 1e-6
    try:
        np.save(cache, C)
    except OSError:
        pass
    return C


def match(a, b, min_overlap=5.0):
    """(similarity 0..1, where b starts in a's time in seconds) over the best alignment with 5s+ of overlap.
    The same song scores ~0.8+, different songs under ~0.6."""
    A, B = fingerprint(a), fingerprint(b)
    m = int(min_overlap / HOP)
    if len(A) < m or len(B) < m:
        return 0.0, 0.0
    # sum over offsets of frame dot products, per pitch class, then divided by the overlap length
    full = sum(np.correlate(A[:, k], B[:, k], "full") for k in range(12))
    offs = np.arange(-(len(B) - 1), len(A))
    over = np.minimum(len(A), offs + len(B)) - np.maximum(0, offs)
    s = np.where(over >= m, full / np.maximum(over, 1), -1)
    i = int(np.argmax(s))
    return float(s[i]), round(float(offs[i]) * HOP, 2)


def song_match(path, others, thr=0.75):
    """Best match of a newly pulled sound among other references' sounds: {id, score, at} or None. `at` is where the
    new sound starts measured from the other one's start (negative: it starts earlier in the song)."""
    best = None
    for o in others:
        try:
            s, off = match(o["path"], path)
        except Exception:
            continue
        if s >= thr and (best is None or s > best["score"]):
            best = dict(id=o["id"], score=round(s, 3), at=off)
    return best


def stitch(parts, out_dir):
    """One stretch of the song from pulls placed where they sit in it: [(path, at seconds)]. Each later pull adds only
    what runs past the sound so far, joined with a short crossfade. Returns (file, where the earliest pull starts
    in it = 0). Cached by its parts."""
    parts = sorted(((str(p), float(a)) for p, a in parts if p), key=lambda x: x[1])
    if len(parts) < 2:
        return parts[0][0] if parts else None
    key = hashlib.sha1(repr(parts).encode()).hexdigest()[:12]
    out = Path(out_dir) / f"song_{key}.wav"
    if out.exists():
        return str(out)
    base = parts[0][1]
    lens = [len(load_audio(p, sr=8000)) / 8000 for p, _ in parts]
    pieces, end, x = [], 0.0, 0.08
    for (p, at), L in zip(parts, lens):
        at -= base
        if at + L <= end + 0.5:
            continue  # nothing new past what's there
        t0 = max(0.0, end - at - (x if pieces else 0.0))
        pieces.append((p, t0))
        end = at + L
    if len(pieces) < 2:
        return pieces[0][0] if pieces else parts[0][0]
    cmd = [FFMPEG, "-v", "error", "-y"]
    for p, _ in pieces:
        cmd += ["-i", p]
    chains = [f"[{i}:a]atrim=start={t0:.3f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[p{i}]"
              for i, (_, t0) in enumerate(pieces)]
    prev = "p0"
    for i in range(1, len(pieces)):
        chains.append(f"[{prev}][p{i}]acrossfade=d={x}:c1=tri:c2=tri[m{i}]")
        prev = f"m{i}"
    cmd += ["-filter_complex", ";".join(chains), "-map", f"[{prev}]", str(out)]
    subprocess.run(cmd, check=True)
    return str(out)
