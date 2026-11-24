"""Beat grid for any track: bundled cue presets (brag format) or onset/tempo analysis."""
import subprocess
from pathlib import Path
import numpy as np

from .common import FFMPEG, MUSIC, jload

SR = 22050
HOP = 512


def load_audio(path, start=0.0, dur=None, sr=SR):
    cmd = [FFMPEG, "-v", "error", "-ss", str(start), "-i", str(path)]
    if dur:
        cmd += ["-t", str(dur)]
    cmd += ["-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, check=True)
    return np.frombuffer(r.stdout, np.float32)


def onset_envelope(y):
    n_fft = 2048
    win = np.hanning(n_fft).astype(np.float32)
    frames = 1 + max(0, (len(y) - n_fft) // HOP)
    if frames < 4:
        return np.zeros(1)
    idx = np.arange(n_fft)[None, :] + HOP * np.arange(frames)[:, None]
    S = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    S = np.log1p(10 * S)
    flux = np.maximum(0, np.diff(S, axis=0)).sum(1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, "same")
    return np.maximum(flux, 0)


def analyze_track(path, start=0.0, dur=60.0):
    """Return {'tempo', 'beats':[t], 'strong':[t], 'downbeats':[t]} relative to `start`."""
    preset = Path(MUSIC) / (Path(path).stem + ".music-cues.json")
    if preset.exists():
        d = jload(preset)
        beats = [b["time"] - start for b in d["beats"] if b["time"] >= start]
        inten = {round(b["time"] - start, 3): b["intensity"] for b in d["beats"] if b["time"] >= start}
        strong = [t for t in beats if inten.get(round(t, 3), 0) > 0.8]
        if beats and beats[-1] + 1 < dur:  # extend grid past the preset window
            step = 60.0 / d["tempo"]
            t = beats[-1]
            while t + step < dur:
                t += step
                beats.append(round(t, 3))
        return dict(tempo=d["tempo"], beats=beats, strong=strong, downbeats=beats[::4])

    y = load_audio(path, start, dur)
    env = onset_envelope(y)
    fr = SR / HOP
    # tempo by autocorrelation, 70-180 BPM, mild prior around 115
    ac = np.correlate(env, env, "full")[len(env) - 1:]
    lags = np.arange(len(ac))
    bpm = 60 * fr / np.maximum(lags, 1)
    m = (bpm >= 70) & (bpm <= 180)
    prior = np.exp(-0.5 * (np.log2(bpm / 115) / 0.6) ** 2)
    lag = int(lags[m][np.argmax((ac * prior)[m])])
    # sub-frame lag by parabolic interpolation (integer lags quantise tempo by ~2 BPM)
    if 1 <= lag < len(ac) - 1:
        a_, b_, c_ = ac[lag - 1], ac[lag], ac[lag + 1]
        den = a_ - 2 * b_ + c_
        flag = lag + (0.5 * (a_ - c_) / den if den else 0)
    else:
        flag = float(lag)
    tempo = 60 * fr / flag
    period = 60.0 / tempo
    # phase: offset that maximises onset energy on the (fractional) grid
    best, t0 = -1, 0.0
    for off in np.arange(0, period, 1 / fr):
        idx = (np.arange(off, len(env) / fr, period) * fr).astype(int)
        v = env[idx[idx < len(env)]].sum()
        if v > best:
            best, t0 = v, off
    beats = list(np.round(np.arange(t0, len(y) / SR, period), 3))
    # strong beats: top third by local onset strength
    vals = [env[min(int(t * fr), len(env) - 1)] for t in beats]
    thr = np.percentile(vals, 66) if vals else 0
    strong = [t for t, v in zip(beats, vals) if v >= thr]
    # downbeat phase: which of the 4 offsets carries the most energy
    k = int(np.argmax([sum(vals[i::4]) for i in range(4)])) if len(vals) >= 8 else 0
    return dict(tempo=round(float(tempo), 2), beats=[float(b) for b in beats],
                strong=[float(s) for s in strong], downbeats=[float(b) for b in beats[k::4]])


def drop_time(path, start=0.0, dur=30.0, skip=0.8):
    """Where a short song drops: the point (0.1s steps) where the next second is loudest compared with the second
    before it. Finer than find_drop, for template reels whose drop lands 1-6s in (after a hook like "go.").
    Seconds from `start`; None if the clip is too short to tell."""
    y = load_audio(path, start, dur)
    hop = SR // 10
    if len(y) < hop * 25:
        return None
    rms = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    sm = np.convolve(rms, np.ones(3) / 3, "same")
    lo, hi = max(10, int(skip * 10)), len(sm) - 10
    if hi <= lo:
        return None
    jump = [sm[i:i + 10].mean() - sm[i - 10:i].mean() for i in range(lo, hi)]
    return round((lo + int(np.argmax(jump))) / 10, 2)


def cut_lag(path, cuts, start=0.0):
    """How far a template's cuts sit from its song's beat onsets: the shift (-0.3..0.3s, 0.02 steps) that puts the
    cuts on the most onset energy. A reel read from its link and its pulled sound can be offset by a frame or few;
    negative = the cuts land late. 0 unless the shift clearly beats leaving them as they are (+15%)."""
    if len(cuts) < 4:
        return 0.0
    y = load_audio(path, start, float(max(cuts)) + 1.0)
    hop = SR // 100
    if len(y) < hop * 50:
        return 0.0
    e = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    on = np.convolve(np.maximum(np.diff(np.log(e + 1e-4)), 0), np.ones(3), "same")
    cuts = np.asarray(cuts, float)
    def score(lag):
        idx = ((cuts + lag) * 100).astype(int)
        idx = idx[(idx >= 0) & (idx < len(on))]
        return float(on[idx].mean()) if len(idx) else 0.0
    lags = np.round(np.arange(-0.3, 0.301, 0.02), 2)
    best = max(lags, key=score)
    return float(best) if score(best) > 1.08 * score(0.0) else 0.0


def snap_cuts(path, cuts, start=0.0, reach=0.08):
    """Each cut moved onto the strongest beat hit within +-reach seconds (when that hit is clearly stronger than
    where the cut sits), so cuts land on the music one by one, not just on average. Order is kept."""
    if not cuts:
        return list(cuts)
    y = load_audio(path, start, float(max(cuts)) + 1.0)
    hop = SR // 100
    if len(y) < hop * 50:
        return list(cuts)
    e = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    on = np.convolve(np.maximum(np.diff(np.log(e + 1e-4)), 0), np.ones(3), "same")
    out, prev = [], 0.0
    for c in cuts:
        i, r = int(round(c * 100)), int(reach * 100)
        lo, hi = max(i - r, 0), min(i + r + 1, len(on))
        if hi > lo and i < len(on):
            j = lo + int(np.argmax(on[lo:hi]))
            t = j / 100 if on[j] > 1.5 * max(on[i], 1e-6) else c
        else:
            t = c
        t = max(t, prev + 0.2)  # never squeeze a shot below a flash (the planner needs 0.2s+)
        out.append(round(t, 3))
        prev = t
    return out


def hit_rate(path, start, t0, t1):
    """Strong hits per second in [t0, t1] of a song (from `start`): ~6 for a relaxed groove that lets shots breathe,
    8+ for a busy track made for chop cuts."""
    y = load_audio(path, start, t1 + 0.5)
    hop = SR // 100
    if len(y) < hop * 50:
        return None
    e = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    on = np.maximum(np.diff(np.log(e + 1e-4)), 0)
    thr = np.percentile(on, 90)
    seg = on[int(t0 * 100):int(t1 * 100)]
    if len(seg) < 100:
        return None
    pk = sum(1 for i in range(1, len(seg) - 1) if seg[i] > thr and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1])
    return pk / (len(seg) / 100)


def hit_peaks(path, start=0.0, until=60.0):
    """The song's own hits: [(t, strength)] at each onset peak, strength over the 95th-percentile onset (1+ = a
    real hit). Where the music actually lands, which a steady tempo grid can drift away from."""
    y = load_audio(path, start, until)
    hop = SR // 100
    if len(y) < hop * 50:
        return []
    e = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    on = np.convolve(np.maximum(np.diff(np.log(e + 1e-4)), 0), np.ones(3), "same")
    ref = float(np.percentile(on, 95)) or 1e-6
    return [(i / 100, float(on[i]) / ref) for i in range(2, len(on) - 2)
            if on[i] == on[i - 2:i + 3].max() and on[i] / ref >= 0.3]


def cut_hits(path, cuts, start=0.0):
    """How hard the music hits at each cut (the strongest onset within 30ms, over the song's 95th percentile onset):
    ~1+ is a real beat hit, under 0.5 the cut sits between beats and reads as a stutter."""
    if not cuts:
        return []
    y = load_audio(path, start, float(max(cuts)) + 1.0)
    hop = SR // 100
    if len(y) < hop * 50:
        return [1.0] * len(cuts)
    e = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    on = np.convolve(np.maximum(np.diff(np.log(e + 1e-4)), 0), np.ones(3), "same")
    ref = float(np.percentile(on, 95)) or 1e-6
    return [float(on[max(int(c * 100) - 3, 0):int(c * 100) + 4].max(initial=0.0)) / ref for c in cuts]


def beat_times(path, start=0.0, until=60.0):
    """(beats from `start`, beat period) for a song, the grid carried on past the file's end at the same tempo."""
    g = analyze_track(path, start, until)
    bt = [float(b) for b in g["beats"] if b >= 0]
    period = 60.0 / float(g["tempo"] or 110)
    t = bt[-1] if bt else 0.0
    while t + period < until:
        t += period
        bt.append(round(t, 3))
    return bt, period


def find_drop(path, window=(4, 40)):
    """Seconds into the track where energy jumps most (a good 'start' so the reel opens hot)."""
    y = load_audio(path, 0, window[1] + 4)
    if len(y) < SR * 2:
        return 0.0
    hop = SR // 4
    rms = np.array([np.sqrt((y[i:i + hop] ** 2).mean()) for i in range(0, len(y) - hop, hop)])
    jump = np.convolve(rms, np.ones(8) / 8, "same")
    d = np.diff(jump)
    lo, hi = int(window[0] * 4), min(int(window[1] * 4), len(d))
    if hi <= lo:
        return 0.0
    return round((lo + int(np.argmax(d[lo:hi]))) / 4.0, 2)
