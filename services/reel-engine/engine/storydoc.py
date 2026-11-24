"""Story docs: a narrated city mini-doc in the history-documentary style.

One voice tells the story of a place. The picture is a history-channel cut made for a phone:
  - Full-frame slow pans over archive photos, paintings and maps. Each pan moves toward the thing the line is about.
    Maps and documents can sit whole on a blurred fill.
  - Archive film and modern open-licence video (Wikimedia Commons), plus your own clips when they're from the
    place. Archive material gets a warm, faded film look with grain, gate weave and flicker. Modern footage stays clean.
  - The opening statement is the hook: big serif text in the middle of the frame, each word arriving as it's said.
  - After the hook, subtitles sit in the lower third, with the key words in gold.
  - Graphics point things out on the picture and stay pinned to it while it pans: a circle that draws itself, an arrow,
    a map pin that drops and pulses, a route that draws across a map, a highlight box. Each has a label chip.
  - A date stamp at each era, a big emphasis title on the line that matters, dips to black between eras, a few low,
    warm sound hits (the kit's whoosh/thump, never sparkles), and the brand end card.

Inputs: the spoken script (paragraphs split by blank lines; the last one is the call-to-action line), the narration
audio, and a story folder with beats.json. There is one beat per paragraph (the CTA is excluded):

    {"title": "Barcelona", "sub": "CATALONIA · SPAIN", "music": "....mp3", "hook": [1, 2], "gold": ["Barcino", "Cerdà"],
     "beats": [
       {"images": ["01.jpg"]},                                    # plain: one still, a gentle push
       {"stamp": "11 SEPTEMBER 1714", "dip": true,                # era stamp, dip to black into this beat
        "emphasis": [{"on": "national day", "text": "THE DAY THEY LOST", "sub": "IS THEIR NATIONAL DAY"}],
        "images": [
          {"file": "siege.jpg", "from": [0.3, 0.5, 1.0], "to": [0.62, 0.45, 1.35],   # pan: centre x, y (0-1), zoom
           "callouts": [{"type": "circle", "at": [0.62, 0.45], "r": 0.06, "label": "THE CITADEL", "on": "fell"}]},
          {"file": "diada-2015.mp4", "in": 12.0, "look": "modern", "on": "national day"},
       ]}]}

Shot keys: file, from/to [cx, cy, zoom], fit (whole picture on a blurred fill), look ("archive" | "film" | "modern"),
in (video start, s), on (start this shot on that spoken phrase), weight (share of the beat), cut ("fade" | "dip" |
"cut"), stamp, place (a small location line under the stamp), callouts.
Callout keys: type (circle | arrow | pin | route | box), at / from / to / points / box (0-1 source-image coordinates),
r, label, sub, side ("left" | "right"), on (appear on that phrase) or t (seconds into the shot).

    python -m engine.storydoc --story reel-data/story-docs/barcelona --script knowledge/story-docs/barcelona.txt \
        --audio narration.wav --out out.mp4
"""
import argparse
import difflib
import json
import math
import os
import random
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

from .common import BRAND_CTA, BRAND_NAME, FFMPEG, FONTS, MUSIC, W, H, FPS, probe
from .talk import silences

LEAD = 0.6          # picture before the first word
TAIL = 3.4          # end card holds after the last word
XFADE = 0.5         # crossfade between shots
CAP_Y = 1380        # lower-third subtitle centre (inside the IG safe zone)
HOOK_Y = 940        # the hook's centre (text sits lower, where viewers expect it)
STAMP_Y = 1060      # date stamp, just above the subtitles
EMPH_Y = 900        # emphasis titles, centre of the frame
STILL_AT = 0.6      # where between a still's "from" and "to" views it holds (stills don't move)
GOLD = (233, 184, 96)
INK = (247, 241, 229)
KIT_SOUND = Path(__file__).resolve().parent.parent / "reel-data" / "ads" / "_kit" / "sound"


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


SERIF = lambda s: font("dm-serif-display-latin-400-normal.woff", s)
SERIF_I = lambda s: font("eb-garamond-latin-400-italic.woff", s)
SANS = lambda s: font("inter-latin-600-normal.woff", s)
SANS_B = lambda s: font("inter-latin-700-normal.woff", s)


def ease(p):
    p = min(max(p, 0.0), 1.0)
    return p * p * (3 - 2 * p)


def ease_out(p):
    p = min(max(p, 0.0), 1.0)
    return 1 - (1 - p) ** 3


def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower().replace("à", "a").replace("í", "i").replace("ç", "c").replace("é", "e"))


def comp(frame, layer, x, y):
    """alpha_composite at (x, y), clipping whatever falls outside the frame (Pillow refuses negative offsets)."""
    x, y = round(x), round(y)
    l, t = max(0, -x), max(0, -y)
    r, b = min(layer.width, frame.width - x), min(layer.height, frame.height - y)
    if r <= l or b <= t:
        return
    if (l, t, r, b) != (0, 0, layer.width, layer.height):
        layer = layer.crop((l, t, r, b))
    frame.alpha_composite(layer, (x + l, y + t))


# ---------- timing ----------

def paragraphs(text):
    return [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]


def duration(path):
    try:
        return float(probe(path)["duration"])
    except Exception:
        r = subprocess.run([FFMPEG, "-i", str(path)], stderr=subprocess.PIPE)
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr.decode(errors="ignore"))
        return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def speech_chunks(audio, dur):
    """[(start, end)] of speech between pauses of 0.25 s or more."""
    sil = [(a, b if b is not None else dur) for a, b in silences(audio, noise_db=-35, min_d=0.25)]
    out, t = [], 0.0
    for a, b in sil:
        if a - t > 0.05:
            out.append((t, a))
        t = b
    if dur - t > 0.05:
        out.append((t, dur))
    return out or [(0.0, dur)], sil


def time_words_by_pauses(paras, audio, dur):
    """Fallback timing: the script's words spread over the speech between the audio's pauses."""
    chunks, sil = speech_chunks(audio, dur)
    words = [(pi, w) for pi, p in enumerate(paras) for w in p.split(" ")]
    weight = [len(w) + 1.5 + (2.5 if re.search(r"[.?!]$", w) else 1.0 if re.search(r"[,;:]$", w) else 0) for _, w in words]
    total_w = sum(weight)
    total_s = sum(b - a for a, b in chunks)

    def real(s):
        for a, b in chunks:
            if s <= b - a:
                return a + s
            s -= b - a
        return chunks[-1][1]

    out, acc = [], 0.0
    for (pi, w), wt in zip(words, weight):
        s0 = acc / total_w * total_s
        acc += wt
        s1 = acc / total_w * total_s
        out.append(dict(p=pi, w=w, t0=real(s0), t1=real(max(s0, s1 - 0.02))))
    starts = []
    for pi in range(len(paras)):
        first = next(x for x in out if x["p"] == pi)
        t = first["t0"]
        if pi:
            near = [b for a, b in sil if abs(b - t) < 1.6]
            if near:
                t = min(near, key=lambda b: abs(b - t))
        starts.append(t)
    for x in out:
        lo = starts[x["p"]]
        hi = starts[x["p"] + 1] if x["p"] + 1 < len(starts) else dur
        x["t0"] = min(max(x["t0"], lo), hi - 0.05)
        x["t1"] = min(max(x["t1"], x["t0"] + 0.05), hi)
    return out, starts


def time_words(paras, audio, dur):
    """Each script word's (t0, t1) from a word-level transcript of the narration, aligned to the script. Falls back to
    the pause method when transcription isn't available."""
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel("small.en", device="cpu", compute_type="int8")
        pcm = subprocess.run([FFMPEG, "-v", "error", "-i", str(audio), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                             capture_output=True, check=True).stdout  # decoded here: faster-whisper's own decoder (PyAV) breaks
        segs, _ = model.transcribe(np.frombuffer(pcm, np.float32), word_timestamps=True, vad_filter=False, beam_size=5)
        heard = [dict(w=w.word.strip(), t0=float(w.start), t1=float(w.end)) for s in segs for w in (s.words or [])]
    except Exception as e:
        print(f"[storydoc] word timing from pauses ({e.__class__.__name__})", file=sys.stderr)
        return time_words_by_pauses(paras, audio, dur)
    words = [dict(p=pi, w=w) for pi, p in enumerate(paras) for w in p.split(" ")]
    a = [norm(x["w"]) for x in words]
    b = [norm(x["w"]) for x in heard]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            words[blk.a + k].update(t0=heard[blk.b + k]["t0"], t1=heard[blk.b + k]["t1"])
    known = [i for i, x in enumerate(words) if "t0" in x]
    if len(known) < len(words) * 0.5:
        print("[storydoc] transcript didn't match the script; word timing from pauses", file=sys.stderr)
        return time_words_by_pauses(paras, audio, dur)
    # unmatched words (numbers said as words, names) are spread between their matched neighbours
    for i, x in enumerate(words):
        if "t0" in x:
            continue
        lo = max([k for k in known if k < i], default=None)
        hi = min([k for k in known if k > i], default=None)
        t_lo = words[lo]["t1"] if lo is not None else 0.0
        t_hi = words[hi]["t0"] if hi is not None else dur
        n0 = lo if lo is not None else -1
        n1 = hi if hi is not None else len(words)
        f0, f1 = (i - n0) / (n1 - n0), (i - n0 + 1) / (n1 - n0)
        x.update(t0=t_lo + (t_hi - t_lo) * f0, t1=t_lo + (t_hi - t_lo) * f1 - 0.02)
    starts = [next(x["t0"] for x in words if x["p"] == pi) for pi in range(len(paras))]
    starts[0] = 0.0
    return words, starts


def caption_groups(words, max_chars=32):
    """Phrases (split at punctuation and paragraphs), each cut into balanced lines of up to ~32 characters."""
    phrases, cur = [], []
    for w in words:
        if cur and w["p"] != cur[0]["p"]:
            phrases.append(cur)
            cur = []
        cur.append(w)
        if re.search(r"[.?!,;:]$", w["w"]):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    groups = []
    for ph in phrases:
        n = math.ceil(len(" ".join(x["w"] for x in ph)) / max_chars)
        size = math.ceil(len(ph) / n)
        groups += [ph[i:i + size] for i in range(0, len(ph), size)]
    out = []
    for i, g in enumerate(groups):
        end = groups[i + 1][0]["t0"] if i + 1 < len(groups) else g[-1]["t1"] + 0.4
        end = min(end, g[-1]["t1"] + 0.7)
        out.append(dict(words=g, text=" ".join(x["w"] for x in g), t0=g[0]["t0"] - 0.05, t1=end, p=g[0]["p"]))
    return out


def sentences(words):
    out, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.?!]$", w["w"]):
            out.append(cur)
            cur = []
    return out + ([cur] if cur else [])


def find_phrase(words, phrase, after=0.0):
    """The first word (at or after `after`) where the spoken phrase starts."""
    want = [norm(x) for x in phrase.split()]
    have = [norm(x["w"]) for x in words]
    for i in range(len(words) - len(want) + 1):
        if words[i]["t0"] + 1e-3 >= after and have[i:i + len(want)] == want:
            return words[i]
    return None


# ---------- looks ----------

def _lut(fn):
    return [min(255, max(0, round(fn(v / 255) * 255))) for v in range(256)]


def grade(im, look):
    """archive/film: warm, faded, low saturation, so 1850 engravings and 1930s prints sit together. modern: clean,
    a touch warm and contrasty."""
    a = np.asarray(im.convert("RGB")).astype(np.float32) / 255
    if look in ("archive", "film"):
        lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        a = a * 0.35 + lum[..., None] * 0.65
        a = a * np.array([1.06, 1.0, 0.86], dtype=np.float32)
        a = np.clip((a - 0.5) * 1.08 + 0.5, 0, 1) * 0.90 + 0.05
    else:
        a = np.clip((a - 0.5) * 1.06 + 0.5, 0, 1)
        lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        a = a * 0.92 + lum[..., None] * 0.08
        a = a * np.array([1.02, 1.0, 0.97], dtype=np.float32)
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


FILM_VF = {  # the same looks as ffmpeg filters, for video shots
    "archive": "hue=s=0.35,colorchannelmixer=rr=1.06:gg=1.0:bb=0.86,eq=contrast=1.08,curves=all='0/0.05 1/0.95'",
    "film": "hue=s=0.35,colorchannelmixer=rr=1.06:gg=1.0:bb=0.86,eq=contrast=1.08,curves=all='0/0.05 1/0.95'",
    "modern": "eq=contrast=1.06:saturation=0.94,colorchannelmixer=rr=1.02:bb=0.97",
}
FLICKER = [_lut(lambda v, k=k: v * k) * 3 for k in (0.965, 0.98, 1.0, 1.015, 1.03)]


def cover(im, w, h):
    s = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * s)), max(h, round(im.height * s))), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def blurred_fill(im):
    bg = cover(im, W // 6, H // 6).filter(ImageFilter.GaussianBlur(6)).resize((W, H), Image.BICUBIC)
    return Image.blend(bg, Image.new("RGB", (W, H), (8, 7, 6)), 0.6)


# ---------- shots ----------

class Shot:
    """A still (or a video clip) with a planned pan, a look, and callouts pinned to its coordinates."""

    def __init__(self, story, spec, s0, s1, seed):
        self.spec, self.s0, self.s1 = spec, s0, s1
        self.t0, self.t1 = s0, s1 + XFADE
        self.cut = spec.get("cut", "fade")
        self.rnd = random.Random(seed)
        self.path = Path(story) / spec["file"]
        self.video = self.path.suffix.lower() in (".mp4", ".mov", ".webm", ".ogv", ".m4v", ".mkv")
        self.look = spec.get("look") or ("modern" if self.video else "archive")
        self.callouts = spec.get("callouts", [])
        self.proc = None
        if self.video:
            self._open_video()
        else:
            self._open_still()

    def _open_still(self):
        im = Image.open(self.path).convert("RGB")
        iw, ih = im.size
        bw0 = min(iw, ih * W / H)
        bh0 = bw0 * H / W
        fr, to = self._views(iw, ih)
        zmax = max(fr[2], to[2])
        fit = self.spec.get("fit")
        self.fit = fit if fit is not None else bh0 * zmax < H / 2.3
        if self.fit:
            self.bg = blurred_fill(grade(im, self.look))
            k = min(1.0, W * 1.7 / iw)
            im = im.resize((max(1, round(iw * k)), max(1, round(ih * k))), Image.LANCZOS)
            self.src = grade(im, self.look)
            self.band_h = min(round(ih * W / iw), round(H * 0.72))
        else:
            k = min(1.0, H * zmax * 1.1 / bh0)
            if k < 1.0:
                im = im.resize((round(iw * k), round(ih * k)), Image.LANCZOS)
            self.src = grade(im, self.look)
        self.iw, self.ih = self.src.size
        self.fr, self.to = fr, to

    def _views(self, iw, ih):
        fr, to = self.spec.get("from"), self.spec.get("to")
        if fr and to:
            return [*fr, 1.0][:3], [*to, 1.0][:3]
        r = self.rnd
        if iw / ih > 1.25:  # wide: a slow lateral pan across it
            d = r.choice([-1, 1])
            return [0.5 - d * 0.2, 0.5, 1.0], [0.5 + d * 0.2, 0.5, 1.06]
        cx, cy = 0.5 + r.uniform(-0.06, 0.06), 0.45 + r.uniform(-0.05, 0.05)
        return ([cx, cy, 1.0], [cx + r.uniform(-0.04, 0.04), cy, 1.14]) if r.random() < 0.65 else \
            ([cx, cy, 1.14], [cx, cy + r.uniform(-0.03, 0.03), 1.0])

    def _p(self, t):
        if not self.video:  # no panning photos. A still holds one framed view, aimed at its subject.
            return STILL_AT
        lin = min(max((t - self.t0) / max(self.t1 - self.t0, 0.1), 0), 1)
        return ease(lin) * 0.7 + lin * 0.3

    def _box(self, t):
        """Cover mode: the source rectangle on screen at time t, in source pixels."""
        p = self._p(t)
        cx = self.fr[0] + (self.to[0] - self.fr[0]) * p
        cy = self.fr[1] + (self.to[1] - self.fr[1]) * p
        z = math.exp(math.log(self.fr[2]) + (math.log(self.to[2]) - math.log(self.fr[2])) * p)
        bw = min(self.iw, self.ih * W / H) / z
        bh = bw * H / W
        x0 = min(max(cx * self.iw - bw / 2, 0), self.iw - bw)
        y0 = min(max(cy * self.ih - bh / 2, 0), self.ih - bh)
        if self.look in ("archive", "film"):  # gate weave
            x0 = min(max(x0 + math.sin(t * 7.3) * bw * 0.0007, 0), self.iw - bw)
            y0 = min(max(y0 + math.sin(t * 5.1 + 1) * bh * 0.0007, 0), self.ih - bh)
        return x0, y0, bw, bh

    def _band(self, t):
        """Fit mode: the visible source rectangle, the band's top on screen, and its height."""
        p = self._p(t)
        z = 1.0 + 0.06 * p
        vw, vh = self.iw / z, self.ih / z
        cx = self.iw / 2 + (self.to[0] - self.fr[0]) * self.iw * 0.08 * (p - 0.5)
        x0 = min(max(cx - vw / 2, 0), self.iw - vw)
        band_h = round(vh * W / vw)
        if band_h > self.band_h:
            vh = self.band_h * vw / W
            band_h = self.band_h
        y0 = (self.ih - vh) / 2
        top = (H - band_h) // 2 - 70
        return (x0, y0, vw, vh), top, band_h

    def to_screen(self, t, pt):
        nx, ny = pt
        if self.video:
            if self.fit:
                return nx * W, (H - self.band_vh) // 2 - 70 + ny * self.band_vh
            x0, y0, bw, bh = self._vbox(t)
            sx, sy = self.cover_map
            return ((nx * sx[0] - sx[1]) - x0) / bw * W, ((ny * sy[0] - sy[1]) - y0) / bh * H
        if self.fit:
            (x0, y0, vw, vh), top, bh = self._band(t)
            return (nx * self.iw - x0) / vw * W, top + (ny * self.ih - y0) / vh * bh
        x0, y0, bw, bh = self._box(t)
        return (nx * self.iw - x0) / bw * W, (ny * self.ih - y0) / bh * H

    def scale(self, t):
        """Screen pixels per picture width (circle radii are a share of the picture's width)."""
        return self.to_screen(t, (1.0, 0.5))[0] - self.to_screen(t, (0.0, 0.5))[0]

    def frame(self, t, fi):
        if self.video:
            fr = self._video_frame(t)
        elif self.fit:
            (x0, y0, vw, vh), top, bh = self._band(t)
            fr = self.bg.copy()
            fr.paste(self.src.resize((W, bh), Image.BILINEAR, box=(x0, y0, x0 + vw, y0 + vh)), (0, top))
        else:
            x0, y0, bw, bh = self._box(t)
            fr = self.src.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + bw, y0 + bh), reducing_gap=None)
        if self.look in ("archive", "film"):
            fr = fr.point(FLICKER[(fi * 7 + int(t * 13)) % len(FLICKER)])
        return fr

    # video: ffmpeg decodes the clip once, graded and cropped to a 9:16 window with room for a slow push
    def _open_video(self):
        info = probe(self.path)  # width/height are already turned for rotated phone clips
        iw, ih = int(info["width"]), int(info["height"])
        bh0 = min(ih, iw * H / W)
        fit = self.spec.get("fit")
        self.fit = fit if fit is not None else H / bh0 > 2.3
        fr = self.spec.get("from") or [0.5, 0.5, 1.0]
        to = self.spec.get("to") or [fr[0], fr[1], 1.07]
        fr, to = [*fr, 1.0][:3], [*to, 1.07][:3]
        dur = self.t1 - self.t0 + 0.3
        speed = float(self.spec.get("speed", 1.0))
        pre = ([f"setpts=PTS/{speed}"] if speed != 1.0 else []) + [f"fps={FPS}", FILM_VF.get(self.look, FILM_VF["modern"])]
        if self.fit:  # the whole frame as a band over a blurred copy of itself
            self.band_vh = round(ih * W / iw) // 2 * 2
            graph = ";".join([
                f"[0:v]{','.join(pre)},split=2[a][b]",
                f"[a]scale={W // 6}:{H // 6}:force_original_aspect_ratio=increase,crop={W // 6}:{H // 6},"
                f"gblur=sigma=4,scale={W}:{H},eq=brightness=-0.32[bg]",
                f"[b]scale={W}:{self.band_vh}[fg]",
                f"[bg][fg]overlay=0:{(H - self.band_vh) // 2 - 70}[v]"])
            self.vw, self.vh = W, H
            filt = ["-filter_complex", graph, "-map", "[v]"]
            self.fr, self.to = [0.5, 0.5, 1.0], [0.5, 0.5, 1.0]
        else:
            zs = 1.12
            self.vw, self.vh = round(W * zs) // 2 * 2, round(H * zs) // 2 * 2
            sc = max(self.vw / iw, self.vh / ih)
            sw, sh = round(iw * sc) // 2 * 2, round(ih * sc) // 2 * 2
            cx = min(max(fr[0] * sw - self.vw / 2, 0), sw - self.vw)
            cy = min(max(fr[1] * sh - self.vh / 2, 0), sh - self.vh)
            self.cover_map = ((sw, cx), (sh, cy))
            filt = ["-vf", ",".join(pre + [f"scale={sw}:{sh}", f"crop={self.vw}:{self.vh}:{round(cx)}:{round(cy)}"])]
            self.fr = self.to = [0.5, 0.5, fr[2]]  # real camera motion only: no added push on film
        self.args = [FFMPEG, "-v", "error", "-ss", f"{float(self.spec.get('in', 0)):.2f}", "-i", str(self.path),
                     "-t", f"{dur * speed:.2f}", *filt, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.last = None
        self.n = 0

    def _vbox(self, t):
        p = self._p(t)
        z = self.fr[2] + (self.to[2] - self.fr[2]) * p
        bw = self.vw / 1.12 / z
        bh = bw * H / W
        cx = (self.fr[0] + (self.to[0] - self.fr[0]) * p) * self.vw
        x0 = min(max(cx - bw / 2, 0), self.vw - bw)
        return x0, (self.vh - bh) / 2, bw, bh

    def _video_frame(self, t):
        want = int((t - self.t0) * FPS)
        if self.proc is None:
            self.proc = subprocess.Popen(self.args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        size = self.vw * self.vh * 3
        while self.n <= want:
            buf = self.proc.stdout.read(size)
            if len(buf) < size:
                self.n = want + 1  # the clip ran out: hold its last frame
                break
            self.last = Image.frombuffer("RGB", (self.vw, self.vh), buf)
            self.n += 1
        if self.last is None:
            self.last = Image.new("RGB", (self.vw, self.vh))
        if self.fit:
            return self.last.copy()
        x0, y0, bw, bh = self._vbox(t)
        return self.last.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + bw, y0 + bh))

    def close(self):
        if self.proc:
            self.proc.kill()
            self.proc = None


# ---------- text ----------

def shadowed(img, blur=10, strength=0.85, dy=4):
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sh.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(blur)).point(lambda a: a * strength))
    base = Image.new("RGBA", img.size, (0, 0, 0, 0))
    base.alpha_composite(sh, (0, dy))
    base.alpha_composite(img)
    return base


def tracked_width(fnt, s, track):
    return sum(fnt.getlength(ch) for ch in s) + track * max(len(s) - 1, 0)


def draw_tracked(d, xy, s, fnt, fill, track):
    x, y = xy
    for ch in s:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += fnt.getlength(ch) + track


def text_layer(lines, fnt, fill=INK, shadow=True, spacing=10, track=0):
    """An RGBA image of centred lines with a soft shadow."""
    w = round(max(tracked_width(fnt, l, track) for l in lines)) + 60
    asc, desc = fnt.getmetrics()
    lh = asc + desc + spacing
    img = Image.new("RGBA", (w, lh * len(lines) + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        draw_tracked(d, ((w - tracked_width(fnt, l, track)) / 2, 20 + i * lh), l, fnt, fill, track)
    return shadowed(img) if shadow else img


def wrap(text, fnt, maxw):
    out, cur = [], ""
    for w in text.split(" "):
        t = (cur + " " + w).strip()
        if fnt.getlength(t) > maxw and cur:
            out.append(cur)
            cur = w
        else:
            cur = t
    return out + ([cur] if cur else [])


def fade(t, t0, t1, f=0.25):
    if t < t0 or t > t1:
        return 0.0
    return min(1.0, (t - t0) / f, (t1 - t) / f)


def with_alpha(layer, alpha):
    if alpha >= 1:
        return layer
    layer = layer.copy()
    layer.putalpha(layer.getchannel("A").point(lambda a: round(a * alpha)))
    return layer


def put(frame, layer, cx, cy, alpha, scale=1.0):
    if alpha <= 0.003:
        return
    if abs(scale - 1) > 0.002:
        layer = layer.resize((max(1, round(layer.width * scale)), max(1, round(layer.height * scale))), Image.BICUBIC)
    comp(frame, with_alpha(layer, alpha), cx - layer.width / 2, cy - layer.height / 2)


class WordBlock:
    """Centred lines of words that arrive one by one as they're spoken (the hook), or all at once (subtitles)."""

    def __init__(self, words, fnt, maxw, gold, spacing=12):
        space = fnt.getlength(" ")
        lines, cur, cw = [], [], 0.0
        for w in words:
            ww = fnt.getlength(w["w"])
            if cur and cw + space + ww > maxw:
                lines.append(cur)
                cur, cw = [], 0.0
            cw += (space if cur else 0) + ww
            cur.append(w)
        if cur:
            lines.append(cur)
        asc, desc = fnt.getmetrics()
        lh = asc + desc + spacing
        self.h = lh * len(lines)
        self.pieces = []
        for li, line in enumerate(lines):
            lw = sum(fnt.getlength(w["w"]) for w in line) + space * (len(line) - 1)
            x = -lw / 2
            for w in line:
                ww = fnt.getlength(w["w"])
                col = GOLD if norm(w["w"]) in gold else INK
                img = Image.new("RGBA", (round(ww) + 40, asc + desc + 40), (0, 0, 0, 0))
                ImageDraw.Draw(img).text((20, 20), w["w"], font=fnt, fill=col)
                self.pieces.append((w, shadowed(img, blur=8, strength=0.9, dy=3), x - 20, li * lh - self.h / 2 - 20))
                x += ww + space

    def draw(self, frame, cx, cy, t, alpha=1.0, reveal=True):
        for w, img, dx, dy in self.pieces:
            q = ease((t - w["t0"] + 0.06) / 0.22) if reveal else 1.0
            a = alpha * q
            if a <= 0.003:
                continue
            comp(frame, with_alpha(img, a), cx + dx, cy + dy + (1 - q) * 14)


def chip(label, sub=None):
    """A label chip: a dark plate with a gold bar, small tracked capitals."""
    f, fs = SANS_B(34), SANS(26)
    w = round(max(tracked_width(f, label, 3), tracked_width(fs, sub, 2) if sub else 0)) + 64
    h = 108 if sub else 70
    img = Image.new("RGBA", (w + 30, h + 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((15, 15, 15 + w, 15 + h), radius=6, fill=(12, 11, 10, 205))
    d.rectangle((15, 15, 21, 15 + h), fill=GOLD)
    draw_tracked(d, (42, 30), label, f, INK, 3)
    if sub:
        draw_tracked(d, (42, 74), sub, fs, (205, 196, 180), 2)
    return shadowed(img, blur=12, strength=0.6, dy=4)


def stamp_layer(text, place=None):
    f = SERIF(50)
    tw = tracked_width(f, text, 5)
    w = round(tw) + 60
    fp = SANS(26)
    w = max(w, round(tracked_width(fp, place, 4)) + 60) if place else w
    img = Image.new("RGBA", (w, 150 if place else 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_tracked(d, ((w - tw) / 2, 8), text, f, INK, 5)
    if place:
        draw_tracked(d, ((w - tracked_width(fp, place, 4)) / 2, 104), place, fp, GOLD, 4)
    return shadowed(img), tw


# ---------- graphics ----------

def draw_callouts(frame, shot, t, words):
    """Circles, arrows, pins, routes and boxes pinned to the picture, drawn at 2x for smooth edges."""
    live = []
    for c in shot.callouts:
        start = shot.s0 + float(c.get("t", 0.6))
        if c.get("on"):
            w = find_phrase(words, c["on"], shot.s0 - 0.5)
            if w:
                start = w["t0"] - 0.1
        end = shot.s1 - 0.1
        if start <= t <= end:
            live.append((c, t - start, fade(t, start, end, 0.25)))
    if not live:
        return
    S = 2
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    chips = []
    sc = shot.scale(t)

    def P(pt):
        x, y = shot.to_screen(t, pt)
        return x * S, y * S

    def stroke(pts, width, a):
        pts = [(round(x), round(y)) for x, y in pts]
        if len(pts) > 1:
            d.line(pts, fill=(0, 0, 0, round(110 * a)), width=(width + 6) * S, joint="curve")
            d.line(pts, fill=(*GOLD, round(255 * a)), width=width * S, joint="curve")

    def partial(pts, p):
        lens = [math.hypot(b[0] - a_[0], b[1] - a_[1]) for a_, b in zip(pts, pts[1:])]
        left, out = sum(lens) * p, [pts[0]]
        for (ax, ay), (bx, by), L in zip(pts, pts[1:], lens):
            if left >= L:
                out.append((bx, by))
                left -= L
            else:
                out.append((ax + (bx - ax) * left / max(L, 1e-6), ay + (by - ay) * left / max(L, 1e-6)))
                break
        return out

    for c, age, a in live:
        kind = c.get("type", "circle")
        anchor = None
        if kind == "circle":
            cx, cy = P(c["at"])
            r = float(c.get("r", 0.05)) * sc * S
            p = ease_out(age / 0.8)
            n = max(2, int(72 * p))
            a0 = -2.2
            stroke([(cx + r * math.cos(a0 + 2 * math.pi * 1.04 * p * k / n), cy + r * 0.92 * math.sin(a0 + 2 * math.pi * 1.04 * p * k / n))
                    for k in range(n + 1)], 6, a)
            anchor = (cx / S, cy / S, r / S)
        elif kind == "box":
            x0, y0 = P(c["box"][:2])
            x1, y1 = P(c["box"][2:])
            p = ease_out(age / 0.9)
            d.rectangle((x0, y0, x1, y1), fill=(*GOLD, round(28 * a * p)))
            stroke(partial([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], p), 5, a)
            anchor = ((x0 + x1) / 2 / S, (y0 + y1) / 2 / S, max(x1 - x0, y1 - y0) / 2 / S)
        elif kind in ("arrow", "route"):
            pts = [P(x) for x in (c.get("points") or [c["from"], c["to"]])]
            out = partial(pts, ease_out(age / (0.7 if kind == "arrow" else 1.6)))
            if kind == "route":
                d.ellipse((pts[0][0] - 9 * S, pts[0][1] - 9 * S, pts[0][0] + 9 * S, pts[0][1] + 9 * S), fill=(*GOLD, round(255 * a)))
            stroke(out, 6, a)
            if len(out) > 1:
                (ax, ay), (bx, by) = out[-2], out[-1]
                ang = math.atan2(by - ay, bx - ax)
                hl = 30 * S
                d.polygon([(bx, by), (bx - hl * math.cos(ang - 0.45), by - hl * math.sin(ang - 0.45)),
                           (bx - hl * math.cos(ang + 0.45), by - hl * math.sin(ang + 0.45))], fill=(*GOLD, round(255 * a)))
            anchor = (out[-1][0] / S, out[-1][1] / S, 20)
        elif kind == "pin":
            cx, cy = P(c["at"])
            p = ease_out(age / 0.45)
            for k in range(2):  # pulse rings
                q = ((age - 0.4 - k * 0.7) % 1.4) / 1.4 if age > 0.4 else 0
                if q > 0:
                    rr = (14 + 60 * q) * S
                    d.ellipse((cx - rr, cy - rr * 0.55, cx + rr, cy + rr * 0.55), outline=(*GOLD, round(200 * (1 - q) * a)), width=3 * S)
            hy = cy - (1 - p) * 70 * S
            d.ellipse((cx - 8 * S, cy - 4 * S, cx + 8 * S, cy + 4 * S), fill=(0, 0, 0, round(120 * a)))
            d.polygon([(cx, hy), (cx - 19 * S, hy - 40 * S), (cx + 19 * S, hy - 40 * S)], fill=(*GOLD, round(255 * a)))
            d.ellipse((cx - 22 * S, hy - 70 * S, cx + 22 * S, hy - 26 * S), fill=(*GOLD, round(255 * a)))
            d.ellipse((cx - 8 * S, hy - 56 * S, cx + 8 * S, hy - 40 * S), fill=(20, 18, 16, round(255 * a)))
            anchor = (cx / S, (cy - 48 * S) / S, 30)
        if c.get("label") and anchor:
            chips.append((c, anchor, age, a))
    frame.alpha_composite(layer.resize((W, H), Image.LANCZOS))
    for c, (ax, ay, r), age, a in chips:
        q = ease_out((age - 0.35) / 0.4)
        if q <= 0:
            continue
        img = chip(c["label"], c.get("sub"))
        side = c.get("side") or ("left" if ax > W * 0.58 else "right")
        sgn = -1 if side == "left" else 1
        cx = ax + sgn * (r + 46 + img.width / 2 - 30)
        cy = ay - (r + 70 if c.get("above") else 0)
        cx = min(max(cx, img.width / 2 + 24), W - img.width / 2 - 24)
        cy = min(max(cy, 420), 1180)
        ex = cx - sgn * (img.width / 2 - 30)
        sx = ax + sgn * (r + 6)
        ImageDraw.Draw(frame).line([(sx, ay), (sx + (ex - sx) * q, ay + (cy - ay) * q)], fill=(*GOLD, round(230 * a * q)), width=3)
        put(frame, img, cx + (1 - q) * 30 * sgn, cy, a * q)


def gradients():
    """Darken the bottom (subtitles) and a little at the top (stamps), so text reads on any picture."""
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    bottom = np.clip((y - 0.52) / 0.48, 0, 1) ** 1.4 * 0.78
    top = np.clip((0.22 - y) / 0.22, 0, 1) ** 1.6 * 0.45
    a = np.repeat((np.maximum(bottom, top) * 255).astype(np.uint8), W, axis=1)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img.putalpha(Image.fromarray(a))
    return img


def vignette():
    y, x = np.ogrid[:H, :W]
    d = np.sqrt(((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2)
    return Image.fromarray((np.clip(1 - (d - 0.55) * 0.6, 0.5, 1) * 255).astype(np.uint8)).convert("RGB")


def grains(n=8, amount=7):
    rng = np.random.default_rng(7)
    return [Image.fromarray(np.clip(rng.normal(128, amount, (H // 2, W // 2)), 0, 255).astype(np.uint8))
            .resize((W, H), Image.BILINEAR).convert("RGB") for _ in range(n)]

BRAND_STORE_LINE = os.environ.get("BRAND_STORE_LINE", "")


def end_card(cta, ad=False):
    y = np.linspace(-1, 1, H)[:, None]
    x = np.linspace(-1, 1, W)[None, :]
    glow = np.clip(1 - np.sqrt(x ** 2 + (y * 0.8) ** 2), 0, 1) ** 2 * 26
    img = Image.fromarray(np.stack([13 + glow, 11 + glow * 0.8, 9 + glow * 0.55], -1).astype(np.uint8)).convert("RGBA")
    put(img, text_layer([BRAND_NAME], SERIF(176), fill=INK, shadow=False), W / 2, H / 2 - 190, 1)
    ImageDraw.Draw(img).line([(W / 2 - 70, H / 2 - 62), (W / 2 + 70, H / 2 - 62)], fill=GOLD, width=3)
    line = cta.replace(f", download {BRAND_NAME}.", ",").rstrip(",")
    put(img, text_layer(wrap(line, SERIF_I(56), 860), SERIF_I(56), fill=(222, 212, 196), shadow=False), W / 2, H / 2 + 40, 1)
    put(img, text_layer([(BRAND_CTA or f"DOWNLOAD {BRAND_NAME}").upper()], SANS_B(40), fill=INK, shadow=False, track=7), W / 2, H / 2 + 230, 1)
    if ad and BRAND_STORE_LINE:
        put(img, text_layer([BRAND_STORE_LINE], SANS(34), fill=(170, 160, 146), shadow=False), W / 2, H / 2 + 292, 1)
    put(img, text_layer(["Archive pictures and film: Wikimedia Commons"], SANS(22), fill=(120, 112, 100), shadow=False), W / 2, H - 300, 1)
    return img


# ---------- sound ----------

def sfx_track(hits, total, path):
    """A few low, warm hits from the kit: a whoosh into dips and the title, a thump under stamps and big lines."""
    try:
        sys.path.insert(0, str(KIT_SOUND))
        from sfx_kit import Bed
    except Exception:
        return None
    b = Bed(total + 1)
    for kind, t in hits:
        if 0 <= t <= total:
            if kind == "whoosh":
                b.add(b.whoosh(0.5, top=1200), max(0, t - 0.35), gain=0.06)
            else:
                b.add(b.thump(70), t, gain=0.10)
    b.write(str(path))
    return path


# ---------- render ----------

def render(story, script, audio, out, music=None, ad=False, until=None):
    story, out = Path(story), Path(out)
    meta = json.loads((story / "beats.json").read_text(encoding="utf-8"))
    paras = paragraphs(Path(script).read_text(encoding="utf-8"))
    beats = meta["beats"]
    if len(beats) != len(paras) - 1:
        raise ValueError(f"beats.json has {len(beats)} beats for {len(paras) - 1} story paragraphs (+1 CTA)")
    vdur = duration(audio)
    words, starts = time_words(paras, audio, vdur)
    words = [dict(x, t0=x["t0"] + LEAD, t1=x["t1"] + LEAD) for x in words]
    starts = [0.0] + [s + LEAD - 0.12 for s in starts[1:]]
    total = vdur + LEAD + TAIL
    if until:
        total = min(total, float(until))
    cta_t = starts[-1]
    gold = {norm(g) for x in meta.get("gold", []) for g in x.split()}
    hits = []

    shots, stamps = [], []
    for i, b in enumerate(beats):
        t0, t1 = starts[i], starts[i + 1]
        specs = [x if isinstance(x, dict) else {"file": x} for x in b["images"]]
        pw = [w for w in words if w["p"] == i]
        wts = [float(s.get("weight", 1)) for s in specs]
        cuts = [t0]
        for k in range(1, len(specs)):
            cuts.append(cuts[-1] + (t1 - t0) * wts[k - 1] / sum(wts))
        for k, s in enumerate(specs):
            if k and s.get("on"):
                w = find_phrase(pw, s["on"])
                if w:
                    cuts[k] = w["t0"] - 0.15
        for k in range(1, len(cuts)):  # keep order, at least 1.2 s a shot
            cuts[k] = min(max(cuts[k], cuts[k - 1] + 1.2), t1 - 1.0 * (len(cuts) - k))
        if b.get("dip"):
            specs[0] = dict(specs[0], cut=specs[0].get("cut", "dip"))
            hits.append(("whoosh", t0))
        for k, s in enumerate(specs):
            s1 = cuts[k + 1] if k + 1 < len(cuts) else t1
            shots.append(Shot(story, s, cuts[k], s1, seed=f"{i}-{k}-{s['file']}"))
            if s.get("stamp"):
                stamps.append((cuts[k] + 0.25, min(cuts[k] + 3.4, s1 - 0.1), s["stamp"], s.get("place")))
        if b.get("stamp"):
            stamps.append((t0 + 0.25, min(t0 + 3.6, t1 - 0.2), b["stamp"], b.get("place")))

    stamp_layers = []
    for s0, s1, txt, place in stamps:
        lay, tw = stamp_layer(txt, place)
        stamp_layers.append((s0, s1, lay, tw))
        hits.append(("thump", s0))

    # the hook: the opening statement, big in the middle, word by word
    hook_paras = set(meta.get("hook", [0] if meta.get("title_card") is False else [1]))
    hook_blocks = []
    for pi in sorted(hook_paras):
        for sent in sentences([w for w in words if w["p"] == pi]):
            n = len(" ".join(w["w"] for w in sent))
            size = 168 if n <= 14 else 136 if n <= 24 else 112 if n <= 44 else 92
            hook_blocks.append(dict(blk=WordBlock(sent, SERIF(size), 960, gold, spacing=4),
                                    t0=sent[0]["t0"] - 0.1, t1=sent[-1]["t1"] + 0.45))
            if size >= 136:
                hits.append(("thump", sent[0]["t0"]))
    for k in range(len(hook_blocks) - 1):
        hook_blocks[k]["t1"] = min(hook_blocks[k]["t1"], hook_blocks[k + 1]["t0"] + 0.05)

    # lower-third subtitles for everything after the hook (not the title or the CTA)
    caps = [g for g in caption_groups(words) if g["p"] not in hook_paras and 0 < g["p"] < len(paras) - 1]
    cap_blocks = [(g, WordBlock(g["words"], SANS(48), 880, gold, spacing=10)) for g in caps]

    emph = []
    for i, b in enumerate(beats):
        for e in b.get("emphasis", []):
            w = find_phrase([x for x in words if x["p"] == i], e["on"])
            if not w:
                print(f"[storydoc] emphasis phrase not found: {e['on']!r}", file=sys.stderr)
                continue
            lay = text_layer(wrap(e["text"], SERIF(118), 940), SERIF(118), fill=GOLD, track=4, spacing=0)
            sub = text_layer([e["sub"]], SANS_B(36), fill=INK, track=6) if e.get("sub") else None
            emph.append((w["t0"] - 0.05, w["t0"] + float(e.get("hold", 2.6)), lay, sub))
            hits.append(("thump", w["t0"]))

    title = text_layer([meta["title"].upper()], SERIF(150), fill=INK, track=14, spacing=0)
    title_sub = text_layer([meta["sub"]], SANS_B(32), fill=GOLD, track=9) if meta.get("sub") else None
    title_t0 = LEAD * 0.4
    title_t1 = max((w["t1"] for w in words if w["p"] == 0), default=2.0) + 0.9
    if meta.get("title_card", True):
        hits.append(("whoosh", title_t0 + 0.2))

    card = end_card(paras[-1], ad)
    vig, grain, grad = vignette(), grains(), gradients()

    music = music or meta.get("music")
    mpath = MUSIC / "ads" / music if music else None
    out.parent.mkdir(parents=True, exist_ok=True)
    sfx = sfx_track(hits, total, out.with_suffix(".sfx.wav"))
    cmd = [FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-itsoffset", str(LEAD), "-i", str(audio)]
    fc = f"[1:a]aresample=48000,apad,atrim=0:{total:.2f},asplit=2[v][key];"
    mix, n_in = ["[v]"], 2
    if mpath and mpath.exists():
        cmd += ["-stream_loop", "-1", "-i", str(mpath)]
        fc += (f"[{n_in}:a]aresample=48000,atrim=0:{total:.2f},volume=0.22,afade=t=in:d=1.5,"
               f"afade=t=out:st={total - 2.4:.2f}:d=2.4[m];[m][key]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=600[duck];")
        mix.append("[duck]")
        n_in += 1
    else:
        fc += "[key]anullsink;"
    if sfx:
        cmd += ["-i", str(sfx)]
        fc += f"[{n_in}:a]aresample=48000,atrim=0:{total:.2f}[fx];"
        mix.append("[fx]")
    fc += f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    cmd += ["-filter_complex", fc, "-map", "0:v", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{total:.2f}", "-movflags", "+faststart", str(out)]
    out.parent.mkdir(parents=True, exist_ok=True)
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    black = Image.new("RGB", (W, H))
    for fi in range(math.ceil(total * FPS)):
        t = fi / FPS
        if t >= cta_t:
            fr = card.copy()
            a = min(1, (t - cta_t) / 0.8)
            if a < 1 and shots:
                fr = Image.blend(shots[-1].frame(t, fi).convert("RGBA"), fr, a)
            ff.stdin.write(fr.convert("RGB").tobytes())
            continue
        k = max((j for j, s in enumerate(shots) if s.s0 <= t), default=0)
        cur = shots[k]
        fr = cur.frame(t, fi)
        if k and t < cur.s0 + XFADE and cur.cut == "fade":
            fr = Image.blend(shots[k - 1].frame(t, fi), fr, ease((t - cur.s0) / XFADE))
        elif k and cur.cut == "dip" and t < cur.s0 + 0.45:
            fr = Image.blend(black, fr, ease((t - cur.s0) / 0.45))
        if k + 1 < len(shots) and shots[k + 1].cut == "dip" and t > shots[k + 1].s0 - 0.4:
            fr = Image.blend(fr, black, ease((t - (shots[k + 1].s0 - 0.4)) / 0.4))
        for s in shots[:max(0, k - 1)]:  # free decoders of shots that are done
            s.close()
        fr = ImageChops.add(ImageChops.multiply(fr, vig), grain[fi % len(grain)], 1.0, -128).convert("RGBA")
        fr.alpha_composite(grad)
        draw_callouts(fr, cur, t, words)

        ta = fade(t, title_t0, title_t1, 0.6) if meta.get("title_card", True) else 0
        if ta:
            put(fr, title, W / 2, H * 0.43, ta, 1.0 + 0.04 * (1 - ease((t - title_t0) / 2.5)))
            if title_sub:
                put(fr, title_sub, W / 2, H * 0.43 + 120, fade(t, title_t0 + 0.5, title_t1, 0.5))
                q = ease((t - title_t0 - 0.3) / 0.8) * ta
                ImageDraw.Draw(fr).line([(W / 2 - 160 * q, H * 0.43 + 78), (W / 2 + 160 * q, H * 0.43 + 78)],
                                        fill=(*GOLD, round(255 * ta)), width=3)
        for hb in hook_blocks:
            if hb["t0"] <= t <= hb["t1"]:
                hb["blk"].draw(fr, W / 2, HOOK_Y, t, fade(t, hb["t0"], hb["t1"], 0.18))
        for s0, s1, lay, tw in stamp_layers:  # typewriter stamp with rules growing out to the sides
            a = fade(t, s0, s1, 0.35)
            if not a:
                continue
            q = ease((t - s0) / 0.6)
            shown = with_alpha(lay, a)
            vis = max(1, round(lay.width / 2 - tw / 2 + tw * q))
            x0 = W / 2 - lay.width / 2
            comp(fr, shown.crop((0, 0, vis, min(96, lay.height))), x0, STAMP_Y)
            if lay.height > 96:
                comp(fr, with_alpha(lay.crop((0, 96, lay.width, lay.height)), a * ease((t - s0 - 0.4) / 0.4)), x0, STAMP_Y + 96)
            L = 120 * ease((t - s0 - 0.2) / 0.6)
            d = ImageDraw.Draw(fr)
            d.line([(W / 2 - tw / 2 - 30 - L, STAMP_Y + 42), (W / 2 - tw / 2 - 30, STAMP_Y + 42)], fill=(*GOLD, round(255 * a)), width=3)
            d.line([(W / 2 + tw / 2 + 30, STAMP_Y + 42), (W / 2 + tw / 2 + 30 + L, STAMP_Y + 42)], fill=(*GOLD, round(255 * a)), width=3)
        for e0, e1, lay, sub in emph:
            a = fade(t, e0, e1, 0.3)
            if a:
                put(fr, lay, W / 2, EMPH_Y, a, 1.0 + 0.06 * (1 - ease_out((t - e0) / 0.5)))
                if sub:
                    put(fr, sub, W / 2, EMPH_Y + lay.height / 2 + 20, fade(t, e0 + 0.35, e1, 0.3))
        for g, blk in cap_blocks:
            if g["t0"] <= t < g["t1"]:
                blk.draw(fr, W / 2, CAP_Y, t, fade(t, g["t0"], g["t1"], 0.1), reveal=False)
        ff.stdin.write(fr.convert("RGB").tobytes())
    for s in shots:
        s.close()
    ff.stdin.close()
    if ff.wait():
        raise RuntimeError("ffmpeg failed")
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", "2.0", "-i", str(out), "-frames:v", "1", str(out.with_suffix(".jpg"))])
    out.with_suffix(".timing.json").write_text(json.dumps(dict(
        starts=starts, shots=[dict(file=s.spec["file"], s0=round(s.s0, 2), s1=round(s.s1, 2)) for s in shots],
        captions=[dict(text=g["text"], t0=g["t0"], t1=g["t1"]) for g in caps]), indent=1), encoding="utf-8")
    if sfx:
        Path(sfx).unlink(missing_ok=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--music")
    ap.add_argument("--ad", action="store_true", help="the paid-ad cut: adds the BRAND_STORE_LINE text (if set) to the end card")
    ap.add_argument("--until", type=float, help="render only the first N seconds (for checking)")
    a = ap.parse_args()
    print(render(a.story, a.script, a.audio, a.out, a.music, a.ad, a.until))


if __name__ == "__main__":
    main()
