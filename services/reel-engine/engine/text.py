"""Kinetic text: styles, layout inside the platform safe zone, per-frame animation.

An event: {t0, t1, text, style, pos, anim, words?}
  style: hook | hook_serif | kicker | pill | caption | karaoke | serif | list | stamp | pin | endcard
         or a dict copied from a reference reel's caption: {font, size: (big, small), upper, fill, box?, shadow, stroke}
  pos:   top | upper | center | lower | (x, y) centre in px
  anim:  pop | slide | fade | type | words | none
  words: karaoke only, [{w, t0, t1}] in video time
"""
import math
from functools import lru_cache
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .common import FONT, SAFE, W, font

BRAND = (255, 214, 10)        # caption highlight (yellow reads on everything)
WHITE = (255, 255, 255)
INK = (12, 12, 14)

STYLES = {
    "hook":     dict(font="anton", size=(150, 92), upper=True, fill=WHITE, stroke=0, shadow=18, lh=0.98),
    "hook_serif": dict(font="serif_it", size=(132, 84), upper=False, fill=WHITE, shadow=20, lh=1.0),
    "kicker":   dict(font="mont700", size=(46, 38), upper=True, fill=WHITE, shadow=10, track=6, lh=1.2),
    "pill":     dict(font="mont800", size=(78, 58), upper=False, fill=INK, box=WHITE, lh=1.18),
    "caption":  dict(font="mont800", size=(66, 50), upper=False, fill=WHITE, stroke=7, shadow=8, lh=1.12),
    "karaoke":  dict(font="mont900", size=(84, 64), upper=True, fill=WHITE, stroke=8, shadow=10, lh=1.05),
    "serif":    dict(font="playfair_it", size=(96, 64), upper=False, fill=WHITE, shadow=16, lh=1.08),
    "list":     dict(font="archivo", size=(96, 64), upper=True, fill=WHITE, shadow=14, lh=1.0),
    "stamp":    dict(font="anton", size=(120, 80), upper=True, fill=INK, box=BRAND, lh=1.0),
    "pin":      dict(font="mont800", size=(48, 40), upper=False, fill=WHITE, shadow=10, lh=1.1, pin=True),
    "endcard":  dict(font="pacifico", size=(170, 120), upper=False, fill=WHITE, shadow=20, lh=1.1),
}

POS = {"top": 400, "upper": 560, "center": 880, "lower": 1260}


@lru_cache(64)
def _font(key, size):
    return ImageFont.truetype(font(FONT[key]), size)


def _wrap(text, f, maxw, track=0):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if _tw(trial, f, track) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _tw(s, f, track=0):
    return f.getlength(s) + track * max(len(s) - 1, 0)


def _style(style):
    """A named style, or a look measured from a reference (lists from JSON become tuples)."""
    if isinstance(style, dict):
        return {k: tuple(v) if isinstance(v, list) else v for k, v in style.items()}
    return STYLES[style]


def fit(text, style, maxw=None, max_lines=3):
    st = _style(style)
    maxw = maxw or (SAFE["right"] - SAFE["left"])
    big, small = st["size"]
    for size in range(big, small - 1, -4):
        f = _font(st["font"], size)
        lines = _wrap(text, f, maxw, st.get("track", 0))
        if len(lines) <= max_lines:
            return f, lines, size
    f = _font(st["font"], small)
    return f, _wrap(text, f, maxw, st.get("track", 0)), small


def _draw_line(d, xy, s, f, fill, stroke=0, track=0, stroke_fill=INK):
    x, y = xy
    if not track:
        d.text((x, y), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        return
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        x += f.getlength(ch) + track


def render_sprite(text, style, color=None, maxw=None):
    """RGBA sprite for a text block, centred; returns (Image, (w, h))."""
    st = _style(style)
    if st.get("upper"):
        text = text.upper()
    f, lines, size = fit(text, style, maxw)
    track = st.get("track", 0)
    lh = int(size * st.get("lh", 1.1))
    asc, desc = f.getmetrics()
    pad = 40 + st.get("shadow", 0) * 2 + (int(size * 1.6) if st.get("scrim") else 0)  # room for the glow to fade out
    widths = [_tw(l, f, track) for l in lines]
    bw = int(max(widths)) + 2 * pad + (60 if st.get("pin") else 0)
    bh = lh * (len(lines) - 1) + asc + desc + 2 * pad
    img = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    fill = color or st["fill"]
    # boxes (pill / stamp) drawn per line, TikTok-native
    if st.get("box"):
        d = ImageDraw.Draw(img)
        for i, (l, w) in enumerate(zip(lines, widths)):
            x0 = (bw - w) / 2 - size * 0.32
            y0 = pad + i * lh - size * 0.12
            d.rounded_rectangle([x0, y0, x0 + w + size * 0.64, y0 + asc + desc * 0.6 + size * 0.16],
                                radius=int(size * 0.28), fill=st["box"] + (255,))
    if st.get("scrim"):  # a soft dark glow behind just the words, so light text reads over a bright shot
        # feathered well past the letters so it reads as shade in the picture, never as a box or badge
        sc = Image.new("RGBA", img.size, (0, 0, 0, 0))
        dsc = ImageDraw.Draw(sc)
        for i, w in enumerate(widths):
            x0, y0 = (bw - w) / 2 - size * 0.3, pad + i * lh
            dsc.rounded_rectangle([x0, y0, x0 + w + size * 0.6, y0 + asc + desc * 0.5], radius=int(size * 0.5),
                                  fill=(0, 0, 0, int(255 * min(1.0, st["scrim"] * 1.25))))
        img = Image.alpha_composite(sc.filter(ImageFilter.GaussianBlur(size * 0.85)), img)
    if st.get("shadow"):
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ds = ImageDraw.Draw(sh)
        # crisp: a tight shadow just under the letters keeps thin faces sharp (a wide blur reads as fuzzy text)
        crisp = st.get("crisp")
        off, alpha = (max(2, size * 0.035), 150) if crisp else (size * 0.04, 170)
        for i, (l, w) in enumerate(zip(lines, widths)):
            _draw_line(ds, ((bw - w) / 2 + (off * 0.4 if crisp else 0), pad + i * lh + off), l, f, (0, 0, 0, alpha),
                       st.get("stroke", 0), track, (0, 0, 0, alpha))
        sh = sh.filter(ImageFilter.GaussianBlur(1.2 if crisp else st["shadow"] / 2))
        img = Image.alpha_composite(img, sh)
    d = ImageDraw.Draw(img)
    for i, (l, w) in enumerate(zip(lines, widths)):
        x = (bw - w) / 2 + (30 if st.get("pin") else 0)
        _draw_line(d, (x, pad + i * lh), l, f, fill, st.get("stroke", 0), track, tuple(st.get("stroke_fill", INK)))
    if st.get("pin"):
        x = (bw - widths[0]) / 2 - 18
        y = pad + asc * 0.15
        r = size * 0.32
        d.ellipse([x - r, y, x + r, y + 2 * r], fill=(255, 64, 64, 255))
        d.polygon([(x - r * 0.8, y + r * 1.5), (x + r * 0.8, y + r * 1.5), (x, y + r * 2.9)], fill=(255, 64, 64, 255))
        d.ellipse([x - r * 0.38, y + r * 0.62, x + r * 0.38, y + r * 1.38], fill=(255, 255, 255, 255))
    return img


def _ease_out_back(x):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2


def _ease_out(x):
    return 1 - (1 - x) ** 3


def read_time(text):
    """Seconds a line needs once fully on screen (brag law: ~0.3s/word, min 0.8s)."""
    return max(0.8, 0.3 * len(text.split()) + 0.25)


# ---------------------------------------------------------------- legibility
POP_YELLOW = (255, 214, 10)  # the brand's pop colour: the last resort when a caption won't read over its shot
MIN_SIZE = {"garamond": 58, "garamond_it": 58, "baskerville": 54, "baskerville_it": 54}  # thin faces need more size
MIN_DEFAULT = 50


def _rel_lum(rgb):
    c = np.asarray(rgb, float) / 255
    c = np.where(c <= 0.03928, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return float(c @ np.array([0.2126, 0.7152, 0.0722]))


def _contrast(a, b):
    la, lb = _rel_lum(a), _rel_lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def legible(frame, e):
    """Make a caption copied from a reference read over *this* shot, changing as little of its look as possible:
    a minimum readable size and crisp edges always; then, only if it doesn't read, (1) slide it a little up or down
    to a calmer, better-contrasted spot near its place, (2) a soft dark backing behind the words, (3) pop yellow
    with a crisp dark edge. Decided once, on the caption's first frame, so the text never jumps."""
    st = dict(_style(e["style"]))
    floor = MIN_SIZE.get(st.get("font"), MIN_DEFAULT)
    if st["size"][0] < floor:
        k = floor / st["size"][0]
        st["size"] = (floor, max(int(st["size"][1] * k), 24))
    st.update(crisp=True, shadow=max(st.get("shadow", 0), 6) if not st.get("box") else 0)
    fill = tuple(st.get("fill", WHITE))
    sp = np.asarray(render_sprite(e["text"], st))
    ys, xs = np.nonzero(sp[..., 3] > 60)
    if not len(ys):
        return dict(e, style=st)
    tw, th = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    pos = e.get("pos", "upper")
    cx = (SAFE["left"] + SAFE["right"]) // 2 if isinstance(pos, str) else int(pos[0])
    cy = POS.get(pos, 560) if isinstance(pos, str) else int(pos[1])
    Hh, Ww = frame.shape[:2]
    cx = int(min(max(cx, tw // 2 + 40), Ww - tw // 2 - 40))  # off-centre captions stay fully on screen
    best = None
    for dy in (0, -50, 50, -100, 100, -160, 160, -220, 220):
        y = min(max(cy + dy, SAFE["top"] + th // 2), SAFE["bottom"] - th // 2)
        x0, y0 = max(cx - tw // 2, 0), max(y - th // 2, 0)
        region = frame[y0:min(y0 + th, Hh), x0:min(x0 + tw, Ww)]
        if not region.size:
            continue
        px = region.reshape(-1, 3)[:, ::-1].astype(np.float32)  # BGR -> RGB
        lum = px @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        # light text is lost on the brightest bits behind it, dark text on the darkest: judge against those
        pick = lum >= np.percentile(lum, 85) if _rel_lum(fill) > 0.18 else lum <= np.percentile(lum, 15)
        bg = tuple(float(c) for c in px[pick].mean(axis=0))
        busy = float(lum.std())
        c = _contrast(fill, bg) if not st.get("box") else 7.0
        score = min(c, 6) - busy / 22 - abs(dy) / 260  # readable first, then calm (not over faces / detail), then close to its place
        if not best or score > best[0]:
            best = (score, y, c, bg, busy)
    if not best:
        return dict(e, style=st)
    _, y, c, bg, busy = best
    out = dict(e, pos=[cx, y])
    thin = st.get("font") in MIN_SIZE  # hairline serifs need more contrast than a bold sans to read
    need = 4.5 if thin else 3.0
    if st.get("box") or (c >= need and busy < 40):
        return dict(out, style=st)
    if _rel_lum(fill) > _rel_lum(bg) or _rel_lum(fill) > 0.35:
        # light text on a bright or busy patch: back it softly; the reference's colour stays.
        # Busy detail (ornament, crowds, foliage) gets a firmer backing: contrast alone doesn't make it read there.
        floor = 0.5 if busy >= 45 else 0.0
        for a in (0.35, 0.5, 0.62, 0.72):
            if a < floor:
                continue
            dark = tuple(v * (1 - a) for v in bg)
            if _contrast(fill, dark) >= need + 0.5:
                st["scrim"] = a
                return dict(out, style=st)
    else:
        # dark text on a dark patch: lift it toward white, keeping its hue
        for t in (0.35, 0.6, 0.85):
            lifted = tuple(int(v + (255 - v) * t) for v in fill)
            if _contrast(lifted, bg) >= 3.0:
                st["fill"] = lifted
                return dict(out, style=st)
    # still not reading: the brand's pop colour with a crisp dark edge
    st.update(fill=POP_YELLOW, stroke=max(3, st["size"][0] // 18), stroke_fill=INK, scrim=0.35)
    return dict(out, style=st)


class TextTrack:
    def __init__(self, events):
        self.events = sorted(events, key=lambda e: e["t0"])
        self._cache = {}
        self._fit = {}  # caption -> its legibility-adjusted version, decided on its first frame

    def warnings(self):
        out = []
        for e in self.events:
            if e.get("style") == "karaoke":
                continue
            need = read_time(e["text"]) + (0.25 if e.get("anim", "pop") != "none" else 0)
            if e["t1"] - e["t0"] < need:
                out.append(f"'{e['text'][:40]}' on screen {e['t1'] - e['t0']:.2f}s < {need:.2f}s readable hold")
        return out

    def _sprite(self, key, text, style, color=None):
        k = (key, text, style if isinstance(style, str) else repr(sorted(style.items())), color)
        if k not in self._cache:
            self._cache[k] = np.asarray(render_sprite(text, style, color), dtype=np.uint8)
        return self._cache[k]

    def _anchor(self, e, sp):
        pos = e.get("pos", "upper")
        cx = (SAFE["left"] + SAFE["right"]) // 2
        cy = POS.get(pos, 560) if isinstance(pos, str) else pos[1]
        if not isinstance(pos, str):
            cx = pos[0]
        return cx - sp.shape[1] // 2, cy - sp.shape[0] // 2

    def draw(self, frame, t):
        for i, e in enumerate(self.events):
            if not (e["t0"] <= t < e["t1"]):
                continue
            if isinstance(e.get("style"), dict):  # a look copied from a reference: make it read over this shot
                sig = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (16, 28), interpolation=cv2.INTER_AREA).astype(np.int16)
                if i not in self._fit or np.abs(sig - self._fit[i][0]).mean() > 35:  # first frame, or a cut under the line (not a camera move)
                    self._fit[i] = (sig, legible(frame, e))
                e = self._fit[i][1]
            if e.get("style") == "karaoke":
                self._karaoke(frame, e, t)
                continue
            anim = e.get("anim", "pop")
            local, out_t = t - e["t0"], e["t1"] - t
            a, s, dy = 1.0, 1.0, 0
            text = e["text"]
            if anim == "pop":
                x = min(local / 0.24, 1)
                s = 0.78 + 0.22 * _ease_out_back(x)
                a = min(local / 0.1, 1)
            elif anim == "slide":
                x = min(local / 0.32, 1)
                dy = int(70 * (1 - _ease_out(x)))
                a = min(local / 0.18, 1)
            elif anim == "fade":
                a = min(local / 0.35, 1)
            elif anim == "type":
                n = len(text)
                k = int(min(1, local / min(0.7, 0.035 * n + 0.05)) * n)
                text = text[:max(k, 1)]
            elif anim == "words":
                ws = text.split()
                k = min(len(ws), int(local / 0.11) + 1)
                text = " ".join(ws[:k])
            if anim != "none" and out_t < 0.14:
                a *= max(out_t / 0.14, 0)
            sp = self._sprite(i, text, e["style"], tuple(e["color"]) if e.get("color") else None)
            if anim == "type" or anim == "words":  # keep block position stable while text grows
                full = self._sprite(i, e["text"], e["style"])
                x0, y0 = self._anchor(e, full)
            else:
                x0, y0 = self._anchor(e, sp)
            if s != 1.0:
                h, w = sp.shape[:2]
                nw, nh = max(int(w * s), 2), max(int(h * s), 2)
                sp = np.asarray(Image.fromarray(sp).resize((nw, nh), Image.BILINEAR))
                x0 += (w - nw) // 2
                y0 += (h - nh) // 2
            blend(frame, sp, x0, y0 + dy, a)

    def _karaoke(self, frame, e, t):
        """Caption groups of words; active word in brand colour, scaled up slightly."""
        words = e["words"]
        active = next((j for j, w in enumerate(words) if w["t0"] <= t < w["t1"]), None)
        if active is None:
            active = max([j for j, w in enumerate(words) if w["t0"] <= t] or [0])
        st = STYLES["karaoke"]
        f, _, size = fit(" ".join(w["w"] for w in words), "karaoke", max_lines=2)
        sprites = []
        for j, w in enumerate(words):
            col = BRAND if j == active else WHITE
            key = ("k", w["w"], j == active, size)
            if key not in self._cache:
                self._cache[key] = np.asarray(_word_sprite(w["w"].upper(), st, f, col), dtype=np.uint8)
            sprites.append(self._cache[key])
        # flow into lines
        maxw = SAFE["right"] - SAFE["left"]
        lines, cur, cw = [], [], 0
        space = int(size * 0.18)
        for sp in sprites:
            sw = sp.shape[1] - 2 * PADK
            if cur and cw + space + sw > maxw:
                lines.append(cur)
                cur, cw = [], 0
            cur.append(sp)
            cw += sw + (space if len(cur) > 1 else 0)
        if cur:
            lines.append(cur)
        cy = POS.get(e.get("pos", "lower"), 1260)
        lh = int(size * 1.08)
        y = cy - lh * len(lines) // 2
        local = t - e["t0"]
        a = min(local / 0.08, 1)
        for line in lines:
            tw = sum(sp.shape[1] - 2 * PADK for sp in line) + space * (len(line) - 1)
            x = (SAFE["left"] + SAFE["right"]) // 2 - tw // 2
            for sp in line:
                blend(frame, sp, x - PADK, y - PADK, a)
                x += sp.shape[1] - 2 * PADK + space
            y += lh


PADK = 24


def _word_sprite(word, st, f, col):
    asc, desc = f.getmetrics()
    w = int(f.getlength(word)) + 2 * PADK
    h = asc + desc + 2 * PADK
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((PADK, PADK + 4), word, font=f, fill=(0, 0, 0, 160),
                            stroke_width=st["stroke"], stroke_fill=(0, 0, 0, 160))
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(6)))
    ImageDraw.Draw(img).text((PADK, PADK), word, font=f, fill=col, stroke_width=st["stroke"], stroke_fill=INK)
    return img


def blend(frame, sp, x0, y0, alpha=1.0):
    """Alpha-blend RGBA sprite (RGB order) onto BGR uint8 frame in place."""
    if alpha <= 0:
        return
    H_, W_ = frame.shape[:2]
    h, w = sp.shape[:2]
    x1, y1 = max(x0, 0), max(y0, 0)
    x2, y2 = min(x0 + w, W_), min(y0 + h, H_)
    if x2 <= x1 or y2 <= y1:
        return
    s = sp[y1 - y0:y2 - y0, x1 - x0:x2 - x0]
    a = (s[..., 3:4].astype(np.float32) / 255.0) * alpha
    rgb = s[..., 2::-1].astype(np.float32)  # RGB -> BGR
    roi = frame[y1:y2, x1:x2].astype(np.float32)
    frame[y1:y2, x1:x2] = (roi * (1 - a) + rgb * a).astype(np.uint8)
