"""Compositor: segments -> frames (zoom, transitions, letterbox, text) -> encode -> audio mix -> deliver.

Every output frame is a pure function of its time, so renders are deterministic and any
frame (e.g. the poster) can be reasoned about from the plan alone.
"""
import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np

from . import synth
from .common import FFMPEG, FPS, H, W, ensure_dir, jdump, probe, run
from .text import TextTrack

# ---------------------------------------------------------------- looks
GRADES = {
    "clean":       "eq=contrast=1.06:saturation=1.08:gamma=0.98",
    "teal_orange": "eq=contrast=1.12:saturation=1.12:gamma=0.97,"
                   "colorbalance=rs=-0.08:gs=0.02:bs=0.12:rm=0.02:bm=-0.02:rh=0.10:gh=0.02:bh=-0.10",
    "film":        "curves=all='0/0.06 0.5/0.5 1/0.94',eq=saturation=0.88:contrast=1.04,"
                   "colorbalance=rs=0.03:bs=-0.02:rh=0.05:bh=-0.04",
    "golden":      "eq=contrast=1.05:saturation=1.18:gamma=0.96,colorbalance=rm=0.07:gm=0.02:bm=-0.09:rh=0.06:bh=-0.07",
    "moody":       "eq=contrast=1.15:saturation=0.78:brightness=-0.04,colorbalance=rs=-0.03:bs=0.06:bm=0.03",
    "tropical":    "eq=contrast=1.08:saturation=1.30:gamma=0.96,colorbalance=gs=0.02:bs=0.05:rh=0.04",
    "mono":        "hue=s=0,eq=contrast=1.25:gamma=0.95",
}


def _vf(meta, cx, rate, grade, grain, vignette):
    w, h = meta["width"], meta["height"]
    k = max(W / w, H / h)
    sw, sh = int(math.ceil(w * k / 2) * 2), int(math.ceil(h * k / 2) * 2)
    x = int(min(max(cx * sw - W / 2, 0), sw - W))
    y = int(max((sh - H) / 2, 0))
    f = [f"fps={rate}", f"scale={sw}:{sh}:flags=lanczos", f"crop={W}:{H}:{x}:{y}"]
    if grade and grade in GRADES:
        f.append(GRADES[grade])
    if vignette:
        f.append("vignette=PI/5.5")
    if grain:
        f.append("noise=alls=7:allf=t")
    f.append("format=bgr24")
    return ",".join(f)


class Reader:
    """Sequential frame source for one segment at `rate` fps."""

    def __init__(self, path, start, src_dur, meta, cx, rate, look):
        self.rate = rate
        vf = _vf(meta, cx, rate, *look)
        cmd = [FFMPEG, "-v", "error", "-ss", f"{max(start, 0):.3f}", "-i", str(path),
               "-t", f"{src_dur + 0.25:.3f}", "-vf", vf, "-an", "-f", "rawvideo", "-"]
        self.p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.n, self.i, self.cur = W * H * 3, -1, None

    def at(self, idx):
        while self.i < idx:
            b = self.p.stdout.read(self.n)
            if len(b) < self.n:
                break  # hold last frame
            self.cur = np.frombuffer(b, np.uint8).reshape(H, W, 3)
            self.i += 1
        if self.cur is None:
            self.cur = np.zeros((H, W, 3), np.uint8)
        return self.cur

    def close(self):
        try:
            self.p.stdout.close()
            self.p.kill()
        except Exception:
            pass


def _src_offset(speed, u, D):
    """Source seconds consumed after u output seconds. speed: number or [s0, s1] linear ramp."""
    if isinstance(speed, (list, tuple)):
        s0, s1 = speed
        return s0 * u + (s1 - s0) * u * u / (2 * D)
    return speed * u


def src_len(seg):
    return _src_offset(seg.get("speed", 1.0), seg["dur"], seg["dur"])


def _ease(x):
    return x * x * (3 - 2 * x)


def _affine(img, scale, dx=0.0, dy=0.0):
    if abs(scale - 1) < 1e-3 and abs(dx) < 0.5 and abs(dy) < 0.5:
        return img
    M = np.float32([[scale, 0, (1 - scale) * W / 2 + dx], [0, scale, (1 - scale) * H / 2 + dy]])
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _hblur(img, k):
    k = int(k) | 1
    if k < 3:
        return img
    ker = np.zeros((1, k), np.float32)
    ker[0, :] = 1.0 / k
    return cv2.filter2D(img, -1, ker)


def _zblur(img, amt):
    if amt < 0.01:
        return img
    acc = img.astype(np.float32)
    for s in (1 + amt * 0.5, 1 + amt):
        acc += _affine(img, s).astype(np.float32)
    return (acc / 3).astype(np.uint8)


TR = {"flash": 3, "whip": 5, "zoom": 7, "dip": 6, "glitch": 4, "soft": 4, "mask": 9, "squares": 10, "wipe": 8, "dissolve": 8}
# reveal transitions: the new shot opens over the last frame of the previous one
REVEALS = ("mask", "squares", "wipe", "dissolve")


def compose(plan, clips, out_video, poster_png):
    """Render silent video. clips: {id: {path, meta}}. Returns list of cut times."""
    segs = plan["segments"]
    look = (plan.get("grade", "clean"), plan.get("grain", False), plan.get("vignette", True))
    text = TextTrack(plan.get("text", []))
    total = sum(s["dur"] for s in segs)
    nframes = int(round(total * FPS))
    poster_i = int(round(plan.get("poster_t", 1.0) * FPS))
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset",
                            "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", str(out_video)],
                           stdin=subprocess.PIPE)
    lb = plan.get("letterbox", False)
    bars = 0 if not lb else (170 if lb is True else int(lb))
    cuts, t0, gi = [], 0.0, 0
    rng = np.random.default_rng(plan.get("seed", 0))
    prev = None  # last frame of the previous shot (before text), for reveal transitions
    for si, seg in enumerate(segs):
        c = clips[seg["clip"]]
        speed = seg.get("speed", 1.0)
        D = seg["dur"]
        slow = (min(speed) if isinstance(speed, (list, tuple)) else speed) < 0.95
        rate = 60 if slow and c["meta"].get("fps", 30) >= 48 else 30
        rd = Reader(c["path"], seg["start"], src_len(seg) + 0.1, c["meta"], seg.get("cx", 0.5), rate, look)
        z0, z1 = seg.get("zoom", [1.0, 1.0])
        tin = seg.get("transition", "cut") if si else "cut"
        tout = segs[si + 1].get("transition", "cut") if si + 1 < len(segs) else "end"
        n = int(round((t0 + D) * FPS)) - int(round(t0 * FPS))
        for k in range(n):
            u = k / FPS
            fr = rd.at(int(round(_src_offset(speed, u, D) * rd.rate)))
            z = z0 + (z1 - z0) * _ease(min(u / max(D, 1e-3), 1))
            dx, extra, flash, blur, dark = 0.0, 1.0, 0.0, 0, 0.0
            # head of this segment
            hk = int(seg.get("tr_frames") or TR.get(tin, 0))  # a template's dissolve lasts as long as its reference's
            if k < hk:
                x = 1 - k / hk
                if tin == "flash":
                    flash = x * 0.5
                elif tin == "soft":
                    dark = 0.35 * _ease(x)
                elif tin == "whip":
                    dx, blur = W * 0.55 * _ease(x), 60 * x
                elif tin == "zoom":
                    extra = 1 + 0.35 * _ease(x)
                elif tin == "dip":
                    dark = x
                elif tin == "glitch":
                    dx = rng.uniform(-40, 40) * x
            # tail of this segment
            tk = TR.get(tout, 0)
            if n - k <= tk:
                x = 1 - (n - k - 1) / tk
                if tout == "flash":
                    flash = max(flash, x * 0.35)
                elif tout == "soft":
                    dark = max(dark, 0.3 * _ease(x))
                elif tout == "whip":
                    dx, blur = -W * 0.55 * _ease(x), 60 * x
                elif tout == "zoom":
                    extra = 1 + 0.12 * x
                elif tout == "dip":
                    dark = max(dark, x)
            pan = seg.get("pan", 0)  # a template's sideways drift: scaled up just enough that no edge shows
            if pan:
                dx += pan * W * (_ease(min(u / max(D, 1e-3), 1)) - 0.5)
                z = max(z, 1 + abs(pan))
            img = _affine(fr, z * extra, dx + seg.get("dx", 0), seg.get("dy", 0))
            if blur:
                img = _hblur(img, blur)
            if extra > 1.02:
                img = _zblur(img, (extra - 1) * 0.6)
            if not img.flags.writeable:
                img = img.copy()
            if flash > 0:
                img = cv2.addWeighted(img, 1 - flash, np.full_like(img, 255), flash, 0)
            if dark > 0:
                img = (img * (1 - dark)).astype(np.uint8)
            if tin in REVEALS and prev is not None and k < hk:
                img = _reveal(tin, prev, img, k / hk, seg.get("cx", 0.5))
            if bars:
                img[:bars] = 0
                img[-bars:] = 0
            if k == n - 1:
                prev = img.copy()
            text.draw(img, gi / FPS)
            if gi == poster_i:
                cv2.imwrite(str(poster_png), img)
            enc.stdin.write(img.tobytes())
            gi += 1
        rd.close()
        cuts.append(round(t0, 3))
        t0 += D
    enc.stdin.close()
    enc.wait()
    if not Path(poster_png).exists():  # poster_t past the end: fall back to first frame
        run([FFMPEG, "-v", "error", "-y", "-i", str(out_video), "-frames:v", "1", str(poster_png)])
    return cuts, nframes / FPS, text.warnings()


# ---------------------------------------------------------------- audio
def build_audio(plan, clips, cuts, total, work):
    a = plan.get("audio", {})
    mode = a.get("mode", "music")
    sr = synth.SR
    n = int((total + 0.05) * sr)
    parts = {}

    # original (dialogue / natural sound): concatenate the segments' source audio
    if mode in ("original", "mix") or plan.get("format") in ("talking", "podcast"):
        orig = np.zeros(n)
        t = 0.0
        for seg in plan["segments"]:
            src = seg.get("audio_clip", seg["clip"])
            if clips[src]["meta"].get("has_audio") and seg.get("speed", 1.0) == 1.0:
                y = _decode(clips[src]["path"], seg.get("audio_start", seg["start"]), seg["dur"], sr)
                y = y * _fade_env(len(y), sr)
                synth.place(orig, y, t, 1.0)
            t += seg["dur"]
        parts["orig"] = orig

    # natural sound in music mode: live music, crowds, street life play through (music ducks under them)
    if mode == "music" and a.get("natural") == "on" and "orig" not in parts:
        nat, any_nat, t = np.zeros(n), False, 0.0
        for seg in plan["segments"]:
            c = clips[seg["clip"]]
            if c["meta"].get("has_audio") and seg.get("speed", 1.0) == 1.0 and _clip_kind(c) == "video":
                y = _decode(c["path"], seg["start"], seg["dur"], sr)
                if a.get("natural") == "on" or _interesting(y, sr):
                    synth.place(nat, y * _fade_env(len(y), sr, ms=120) * 0.6, t, 1.0)
                    any_nat = True
            t += seg["dur"]
        if any_nat:
            parts["orig"] = nat

    # music / timing track
    if mode in ("music", "mix") and a.get("music"):
        mus = a["music"]
        if mus.startswith("synth"):
            mood = mus.split(":")[1] if ":" in mus else "cinematic"
            y = synth.bed(a.get("bpm", 100), total + 0.05, mood, plan.get("seed", 0))
        else:
            y = _decode(mus, a.get("music_start", 0.0), total + 0.05, sr)
            if len(y) < sr // 2:
                raise ValueError(f"could not read the song (missing file or start past its end): {Path(mus).name}")
            if a.get("loop") and len(y) < int((total + 0.05) * sr):
                # an adaptive reel that outlasts its sound: repeat whole bars from the drop, joined on the beat
                lo, hi = (int(t * sr) for t in a["loop"])
                body, seg, x = y[:hi], y[lo:hi], int(0.03 * sr)
                while len(body) < int((total + 0.05) * sr) and len(seg) > 2 * x:
                    ramp = np.linspace(0, 1, x)
                    body = np.concatenate([body[:-x], body[-x:] * (1 - ramp) + seg[:x] * ramp, seg[x:]])
                y = body[:int((total + 0.05) * sr)]
            if a.get("drop_at"):
                y = _build_up(y, sr, a["drop_at"], a.get("bpm", 110))
            fo = min(1.2, total * 0.15)
            env = np.ones(len(y))
            k = int(fo * sr)
            env[-k:] = np.linspace(1, 0, k) ** 1.5
            env[:int(0.02 * sr)] = np.linspace(0, 1, int(0.02 * sr))
            y = y * env
        m = np.zeros(n)
        synth.place(m, y, 0, 1.0)
        parts["music"] = m

    # SFX on the same grid as the cut
    if a.get("sfx", True) and mode != "none" and plan.get("transitions_style", "clean") == "clean":
        fx = np.zeros(n)
        for i, (seg, t) in enumerate(zip(plan["segments"], cuts)):
            if t <= 0:
                continue
            kind = _clip_kind(clips[seg["clip"]])
            tr = seg.get("transition", "cut")
            if kind == "still":
                synth.place(fx, synth.shutter(seed=11 + i), t - 0.01, 0.18)   # photo: camera shutter
            elif kind == "screen":
                synth.place(fx, synth.tap(seed=5 + i), t, 0.12)               # into the phone: soft tap
            elif tr in REVEALS:
                synth.place(fx, synth.air(0.3, seed=9 + i), t - 0.12, 0.1)   # reveal: barely-there swish
            elif tr in ("soft", "dip"):
                synth.place(fx, synth.air(0.34, seed=9 + i), t - 0.17, 0.12)  # soft dip: airy swish
        if np.abs(fx).max() > 0:
            parts["sfx"] = fx
    elif a.get("sfx", True) and mode != "none":
        fx = np.zeros(n)
        for seg, t in zip(plan["segments"], cuts):
            tr = seg.get("transition", "cut")
            if t <= 0:
                continue
            if tr == "whip":
                synth.place(fx, synth.whoosh(0.42), t - 0.24, 0.55)
            elif tr == "zoom":
                synth.place(fx, synth.whoosh(0.3, rev=True), t - 0.28, 0.4)
                synth.place(fx, synth.hit(), t, 0.35)
            elif tr == "flash" and seg.get("hit"):
                synth.place(fx, synth.hit(), t, 0.4)
        for t in plan.get("hits", []):
            synth.place(fx, synth.hit(), t, 0.45)
        if np.abs(fx).max() > 0:
            parts["sfx"] = fx

    mix_path = Path(work) / "mix.wav"
    if not parts:
        synth.write_wav(mix_path, np.zeros(n) + 1e-9)
        return mix_path, None
    stems = {}
    for k, y in parts.items():
        p = Path(work) / f"{k}.wav"
        _write_float(p, y, sr)
        stems[k] = p
    gains = {"orig": a.get("original_gain", 1.0), "music": a.get("music_gain", 0.55 if "orig" in parts else 1.0),
             "sfx": a.get("sfx_gain", 0.32 if plan.get("transitions_style", "clean") == "clean" else 0.45)}
    inputs, filt, labels = [], [], []
    for i, k in enumerate(stems):
        inputs += ["-i", str(stems[k])]
        filt.append(f"[{i}:a]volume={gains[k]}[{k}]")
    if "orig" in stems and "music" in stems and a.get("duck", True):
        filt.append("[orig]asplit=2[o1][o2]")
        filt.append("[music][o2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[mduck]")
        labels = ["[o1]", "[mduck]"] + (["[sfx]"] if "sfx" in stems else [])
    else:
        labels = [f"[{k}]" for k in stems]
    mixed = f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0"
    # two-pass, linear loudness: one gain for the whole reel, so a quiet build-up stays quiet before the drop
    meas = subprocess.run([FFMPEG, "-hide_banner", "-y", *inputs, "-filter_complex",
                           ";".join(filt + [f"{mixed},loudnorm=I=-14:TP=-1.0:LRA=20:print_format=json[out]"]),
                           "-map", "[out]", "-f", "null", "-"], capture_output=True, text=True).stderr
    try:
        m = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
        ln = (f"loudnorm=I=-14:TP=-1.0:LRA=20:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    except (ValueError, KeyError):
        ln = "loudnorm=I=-14:TP=-1.0:LRA=11"
    filt.append(f"{mixed},{ln},aresample=48000[out]")
    run([FFMPEG, "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[out]",
         "-ac", "2", str(mix_path)])
    bare = None
    if "orig" in stems:  # dialogue-only stem for the "add trending sound in-app" export
        bare = Path(work) / "bare.wav"
        run([FFMPEG, "-v", "error", "-y", "-i", str(stems["orig"]), "-af",
             "loudnorm=I=-14:TP=-1.0,aresample=48000", "-ac", "2", str(bare)])
    return mix_path, bare


def _reveal(kind, prev, img, p, cx=0.5):
    """Composite the incoming shot over the previous frame. p: 0 -> 1 over the transition."""
    h, w = img.shape[:2]
    e = _ease(min(max(p, 0.0), 1.0))
    if kind == "mask":  # iris opens from the subject
        yy, xx = np.ogrid[:h, :w]
        r = e * math.hypot(w, h) * 0.75
        d = np.sqrt((xx - cx * w) ** 2 + (yy - h * 0.45) ** 2)
        a = np.clip((r - d) / 24.0, 0, 1)[..., None]  # soft edge
    elif kind == "squares":  # tiles pop in on a diagonal
        cols, rows = 4, 7
        a = np.zeros((h, w, 1), np.float32)
        for i in range(rows):
            for j in range(cols):
                delay = (i + j) / (rows + cols - 2) * 0.6
                q = min(max((p - delay) / 0.4, 0.0), 1.0)
                if q <= 0:
                    continue
                y0, y1 = i * h // rows, (i + 1) * h // rows
                x0, x1 = j * w // cols, (j + 1) * w // cols
                s = _ease(q)  # each tile grows from its centre
                cy, cxp = (y0 + y1) / 2, (x0 + x1) / 2
                hy, hx = (y1 - y0) * s / 2, (x1 - x0) * s / 2
                a[int(cy - hy):int(cy + hy) + 1, int(cxp - hx):int(cxp + hx) + 1] = 1.0
    elif kind == "dissolve":  # crossfade: the previous shot's last frame fades into this one
        a = np.full((h, w, 1), e, np.float32)
    else:  # wipe: soft vertical edge sweeping left to right
        xx = np.arange(w, dtype=np.float32)[None, :, None]
        edge = e * (w + 120) - 60
        a = np.broadcast_to(np.clip((edge - xx) / 60.0, 0, 1), (h, w, 1))
    return (img * a + prev * (1 - a)).astype(np.uint8)


def _build_up(y, sr, drop_at, bpm):
    """Before the drop the song sits muffled and low (the 'boring' part), opens up over the last beat,
    goes silent for a breath, then hits at full range on the drop."""
    d = int(drop_at * sr)
    if d <= 0 or d >= len(y):
        return y
    pre = y[:d]
    X = np.fft.rfft(pre)
    f = np.fft.rfftfreq(len(pre), 1 / sr)
    muff = np.fft.irfft(X * (1 / (1 + (f / 450.0) ** 4)), len(pre))  # ~450 Hz low-pass: song heard through a wall
    beat = int(60.0 / bpm * sr)
    w = np.zeros(d)
    w[max(0, d - beat):] = np.linspace(0, 1, d - max(0, d - beat)) ** 2  # filter opens over the last beat
    out = (muff * (1 - w) + pre * w) * 0.4
    gap = int(0.11 * sr)
    out[-gap:] *= np.linspace(1, 0, gap) ** 3  # breath before the hit
    return np.concatenate([out, y[d:]])


def _clip_kind(c):
    """'still' for photos turned into clips (no motion), 'screen' for app recordings / phone composites."""
    tags = set(c.get("tags") or [])
    if "screen" in tags or "phone" in tags:
        return "screen"
    if "still" in tags or "photo" in tags:
        return "still"
    s = c.get("meta", {}).get("samples") or []
    if s and max(x.get("motion", 0) for x in s) < 0.4:
        return "still"
    return "video"


def _interesting(y, sr):
    """Worth hearing: loud enough, and energy in the music/voice band rather than wind rumble or hiss."""
    if len(y) < sr // 4:
        return False
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-9)
    if 20 * np.log10(rms) < -32:
        return False
    X = np.abs(np.fft.rfft(y[: sr * 4])) ** 2
    f = np.fft.rfftfreq(min(len(y), sr * 4), 1 / sr)
    mid = X[(f > 200) & (f < 4000)].sum() / (X.sum() + 1e-9)
    low = X[f < 150].sum() / (X.sum() + 1e-9)
    return mid > 0.45 and low < 0.35


def _decode(path, start, dur, sr):
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{max(start, 0):.3f}", "-i", str(path), "-t",
                        f"{dur:.3f}", "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                       stdout=subprocess.PIPE)
    return np.frombuffer(r.stdout, np.float32).astype(np.float64)


def _fade_env(n, sr, ms=12):
    e = np.ones(n)
    k = min(int(sr * ms / 1000), n // 2)
    if k > 0:
        e[:k] = np.linspace(0, 1, k)
        e[-k:] = np.linspace(1, 0, k)
    return e


def _write_float(path, y, sr):
    pk = np.abs(y).max()
    if pk > 0.99:
        y = y / pk * 0.99
    import wave
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.asarray(y) * 32767).astype(np.int16).tobytes())


# ---------------------------------------------------------------- deliver
MAX_BYTES = 19 * 1024 * 1024


def mux(video, poster, audio, out, total):
    """Bake poster into frame 0 (replace, not insert) and mux audio; cap size for upload limits.
    Reels spec: 1080x1920 H.264 at ~15-20 Mbps, so the cap grows with length (16 Mbps + audio) instead of squeezing
    a 20s reel into 19 MB."""
    cap = max(MAX_BYTES, int(total * (16e6 + 192e3) / 8 * 1.05))
    for crf in (18, 21, 24):
        cmd = [FFMPEG, "-v", "error", "-y", "-i", str(video), "-i", str(poster)]
        if audio:
            cmd += ["-i", str(audio)]
        cmd += ["-filter_complex", "[0:v][1:v]overlay=enable='eq(n,0)'[v]", "-map", "[v]"]
        if audio:
            cmd += ["-map", "2:a", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-crf", str(crf), "-maxrate", "16M",
                "-bufsize", "32M", "-pix_fmt", "yuv420p", "-r", str(FPS), "-t", f"{total:.3f}",
                "-movflags", "+faststart", str(out)]
        run(cmd)
        if Path(out).stat().st_size <= cap:
            break
    return out


def _frame_size(landscape):
    """Switch composition between the Reels frame (1080x1920) and a wide 1920x1080 one for sideways templates. Shots,
    text and safe margins follow; the finished wide video is turned 90 degrees into the 1080x1920 reel afterwards."""
    global W, H
    from . import text as T
    if landscape:
        W, H = 1920, 1080
        T.W, T.SAFE = 1920, dict(left=90, right=1830, top=70, bottom=1010)
        T.POS = {"top": 200, "upper": 300, "center": 540, "lower": 800}
    else:
        W, H = 1080, 1920
        T.W, T.SAFE = 1080, dict(left=70, right=930, top=230, bottom=1460)
        T.POS = {"top": 400, "upper": 560, "center": 880, "lower": 1260}


def render(plan, clips, outdir):
    """Full render of one variant plan. Returns manifest entry."""
    out = ensure_dir(outdir)
    vid = plan["id"]
    work = ensure_dir(out / "work" / vid)
    silent = work / "video.mp4"
    poster = out / f"{vid}.jpg"
    side = plan.get("sideways")  # "cw" / "ccw": a "turn your phone" template, composed wide then turned like the original
    if side:
        _frame_size(landscape=True)
    try:
        cuts, total, warns = compose(plan, clips, silent, work / "poster.png")
    finally:
        if side:
            _frame_size(landscape=False)
    if side:
        turn = "transpose=1" if side == "cw" else "transpose=2"
        turned = work / "video_turned.mp4"
        run([FFMPEG, "-v", "error", "-y", "-i", str(silent), "-vf", turn, "-c:v", "libx264", "-preset", "fast", "-crf", "12",
             "-pix_fmt", "yuv420p", str(turned)])
        turned.replace(silent)
        run([FFMPEG, "-v", "error", "-y", "-i", str(work / "poster.png"), "-vf", turn, str(work / "poster_t.png")])
        (work / "poster_t.png").replace(work / "poster.png")
    run([FFMPEG, "-v", "error", "-y", "-i", str(work / "poster.png"), "-q:v", "3", str(poster)])
    mix, bare = build_audio(plan, clips, cuts, total, work)
    final = mux(silent, work / "poster.png", mix, out / f"{vid}.mp4", total)
    # second export: no music, for attaching a trending sound inside IG / TikTok
    bare_out = out / f"{vid}_bare.mp4"
    cmd = [FFMPEG, "-v", "error", "-y", "-i", str(final)]
    if bare:
        cmd += ["-i", str(bare), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    else:
        cmd += ["-map", "0:v"]
    run(cmd + ["-c:v", "copy", "-movflags", "+faststart", str(bare_out)])
    caption = plan.get("caption", "")
    tags = " ".join("#" + t.lstrip("#") for t in plan.get("hashtags", []))
    (out / f"{vid}.txt").write_text((caption + ("\n\n" + tags if tags else "")).strip() + "\n")
    entry = dict(id=vid, format=plan.get("format"), file=str(final), bare=str(bare_out), poster=str(poster),
                 caption_file=str(out / f"{vid}.txt"), duration=round(total, 2),
                 size_mb=round(Path(final).stat().st_size / 2 ** 20, 2), cuts=cuts, warnings=warns,
                 hook=plan.get("hook"), grade=plan.get("grade"), music=plan.get("audio", {}).get("music"),
                 timing_track=plan.get("timing_track"), tags=plan.get("test_tags", {}))
    jdump(plan, work / "plan.json")
    return entry
