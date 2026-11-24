"""Procedural audio: a fallback cinematic bed plus transition SFX, all on one beat grid.

Licensed tracks / trending sounds are always preferred; this exists so a render never
fails for lack of music and so SFX sit in the same tempo as the cut.
"""
import wave
import numpy as np

SR = 44100


def _env(n, a=0.005, r=0.2):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / max(r, 1e-4))
    return e


def kick(n=None):
    n = n or int(0.45 * SR)
    t = np.arange(n) / SR
    f = 42 + 90 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 6.5)


def hit(n=None):
    """Cinematic impact: sub boom + filtered noise crack."""
    n = n or int(1.8 * SR)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * (34 + 40 * np.exp(-t * 9)) * t) * np.exp(-t * 2.2)
    nz = np.random.default_rng(1).standard_normal(n) * np.exp(-t * 14)
    nz = np.convolve(nz, np.ones(12) / 12, "same")
    return 0.9 * sub + 0.35 * nz


def whoosh(dur=0.45, rev=False):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    nz = np.random.default_rng(7).standard_normal(n)
    out = np.zeros(n)
    # sweeping one-pole lowpass
    a_vals = 0.02 + 0.5 * np.sin(np.pi * t) ** 2
    y = 0.0
    for i in range(n):
        y += a_vals[i] * (nz[i] - y)
        out[i] = y
    out *= np.sin(np.pi * t) ** 1.5
    return out[::-1] if rev else out


def _bandpass(x, lo, hi):
    """Cheap FFT band-pass (Hz) for shaping noise into recognisable textures."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def shutter(seed=11):
    """Camera shutter: two short mechanical clicks ~45 ms apart (curtain open/close) with a soft body."""
    n = int(0.16 * SR)
    rng = np.random.default_rng(seed)
    out = np.zeros(n)
    for at, g in ((0.0, 1.0), (0.045, 0.75)):
        m = int(0.018 * SR)
        click = _bandpass(rng.standard_normal(m), 1800, 9000) * np.exp(-np.arange(m) / SR * 260)
        body = _bandpass(rng.standard_normal(m), 300, 1400) * np.exp(-np.arange(m) / SR * 140) * 0.5
        i = int(at * SR)
        out[i:i + m] += g * (click + body)
    return out / (np.abs(out).max() + 1e-9)


def tap(seed=5):
    """Soft UI tap: a tiny high click, for cutting into a phone shot."""
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 120)
    nz = _bandpass(np.random.default_rng(seed).standard_normal(n), 3000, 10000) * np.exp(-t * 300) * 0.4
    y = tone + nz
    return y / (np.abs(y).max() + 1e-9)


def air(dur=0.35, seed=9):
    """Delicate airy swish (band-passed noise, smooth bell envelope): a clean-transition whoosh."""
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    y = _bandpass(np.random.default_rng(seed).standard_normal(n), 900, 6500) * np.sin(np.pi * t) ** 2.2
    return y / (np.abs(y).max() + 1e-9)


def riser(dur=2.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 200 * (2 ** (3 * t / dur))
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR)
    nz = np.random.default_rng(3).standard_normal(n)
    nz = np.convolve(nz, np.ones(6) / 6, "same")
    return (0.25 * tone + 0.4 * nz) * (t / dur) ** 2


def bed(bpm, dur, mood="cinematic", seed=0):
    """Pulse bed: sub drone chord + kick on 1 and 3 + soft 8th ticks. mood: cinematic|warm|tense."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    roots = {"cinematic": [55.0, 82.41, 110.0, 130.81],   # A minor-ish
             "warm": [65.41, 98.0, 130.81, 164.81],       # C major
             "tense": [51.91, 77.78, 103.83, 123.47]}[mood if mood in ("warm", "tense") else "cinematic"]
    pad = np.zeros(n)
    for i, f in enumerate(roots):
        det = 1 + 0.002 * (i - 1.5)
        pad += np.sin(2 * np.pi * f * det * t + rng.uniform(0, 6)) / (i + 1.3)
        pad += 0.3 * np.sin(2 * np.pi * f * 2.003 * t) / (i + 2)
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * t / (240 / bpm))
    pad *= swell * 0.22
    beat = 60.0 / bpm
    k = kick()
    drums = np.zeros(n + len(k))
    tick = np.random.default_rng(5).standard_normal(int(0.03 * SR)) * _env(int(0.03 * SR), 0.001, 0.01)
    tick = np.diff(np.concatenate([[0], tick]))  # crude highpass
    i = 0
    while i * beat < dur:
        s = int(i * beat * SR)
        if i % 2 == 0 and i * beat > 0.0:
            drums[s:s + len(k)] += 0.3 * k
        h = int((i + 0.5) * beat * SR)
        if h + len(tick) < len(drums):
            drums[h:h + len(tick)] += 0.12 * tick
        i += 1
    mix = pad + drums[:n]
    fade = np.minimum(1, np.minimum(t / 0.3, (dur - t) / 1.2))
    return mix * np.clip(fade, 0, 1)


def place(track, clip, at, gain=1.0):
    s = int(at * SR)
    if s >= len(track) or s + len(clip) <= 0:
        return
    a, b = max(0, -s), min(len(clip), len(track) - s)
    track[max(s, 0):max(s, 0) + (b - a)] += gain * clip[a:b]


def write_wav(path, y, sr=SR):
    y = np.asarray(y, float)
    peak = np.abs(y).max() or 1
    y = (y / peak * 0.89 * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(y.tobytes())
