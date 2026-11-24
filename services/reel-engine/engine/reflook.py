"""The look of a reference reel's caption: font, size, colour, case, box, outline, measured from one frame.

The font is found by rendering the caption's own words in each candidate face and comparing letter shapes
and width with the reel's pixels, so a template's text looks like the reel's text, not a house style.
"""
import math

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .common import FONT, H, font

# faces that cover what Instagram / TikTok text tools and CapCut templates use
# (the heavy display serifs, DM Serif and Playfair, stay house styles: caption tools set thinner book serifs)
CANDIDATES = ["inter", "inter600", "inter700", "mont600", "mont800", "mont900", "anton", "bebas", "archivo",
              "garamond", "garamond_it", "baskerville", "baskerville_it", "typewriter", "hand", "pacifico"]
_PROBE = 100  # px size the candidates are rendered at
# script faces fit noisy letter outlines too easily: they have to win clearly
PRIOR = {"hand": -0.12, "pacifico": -0.12}


def _tight(mask):
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return None
    return mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def _render(text, key):
    f = ImageFont.truetype(font(FONT[key]), _PROBE)
    x0, y0, x1, y1 = f.getbbox(text)
    img = Image.new("L", (max(x1 - x0, 1) + 4, max(y1 - y0, 1) + 4), 0)
    ImageDraw.Draw(img).text((2 - x0, 2 - y0), text, font=f, fill=255)
    return np.asarray(img)


def _ink(crop):
    """Text pixels of a caption crop. Colours split three ways (Lab k-means); the text is the group drawn in thin
    strokes (most of it vanishes under a small erosion), not a solid patch of photo behind it."""
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    k = 3 if len(lab) > 60 else 2
    _, labels, centers = cv2.kmeans(lab, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0), 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.reshape(crop.shape[:2])
    ker = np.ones((3, 3), np.uint8)
    best, best_score = None, -1.0
    for c in range(k):
        m = (labels == c).astype(np.uint8)
        cover = m.mean()
        if not 0.03 <= cover <= 0.55:
            continue
        survive = cv2.erode(m, ker, iterations=max(1, crop.shape[0] // 14)).sum() / max(m.sum(), 1)
        contrast = abs(float(centers[c][0]) - float(np.delete(centers[:, 0], c).mean())) / 255
        light = float(centers[c][0]) / 255  # Lab L: captions are nearly always near-white or near-black
        extreme = max(light, 1 - light)
        score = (1 - survive) * 0.45 + contrast * 0.3 + extreme * 0.25
        if score > best_score:
            best, best_score = m, score
    if best is None:
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return 255 - th if (th > 0).mean() > 0.5 else th
    # drop specks: keep components of letter size
    n, lab_cc, stats, _ = cv2.connectedComponentsWithStats(best, 8)
    keep = np.zeros_like(best)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= max(3, crop.shape[0] // 8) and stats[i, cv2.CC_STAT_HEIGHT] <= crop.shape[0]:
            keep[lab_cc == i] = 1
    return keep * 255


def _band(mask):
    """The text line inside a noisy mask: rows and columns where ink is dense (stray photo pixels drop out)."""
    m = mask > 127
    rows, cols = m.sum(axis=1), m.sum(axis=0)
    if not rows.any():
        return None
    r = np.nonzero(rows >= rows.max() * 0.2)[0]
    c = np.nonzero(cols >= max(cols.max() * 0.05, 1))[0]
    return m[r.min():r.max() + 1, c.min():c.max() + 1]


def match_font(mask, text, box_ar=None):
    """(font key, score, ink height at the probe size) for the face whose rendering best matches the mask."""
    ref = _band(mask)
    if ref is None or ref.shape[0] < 6:
        return None
    hh = 40
    ar = ref.shape[1] / ref.shape[0]
    dens = (ref > 0).mean()
    a = cv2.resize(ref.astype(np.uint8) * 255, (max(8, int(hh * ar)), hh)) > 127
    best = None
    for key in CANDIDATES:
        r = _band(_render(text, key))  # same crop as the reel's mask, so both are compared like for like
        if r is None:
            continue
        ar2 = r.shape[1] / r.shape[0]
        b = cv2.resize(r.astype(np.uint8) * 255, (a.shape[1], hh)) > 127
        iou = (a & b).sum() / max((a | b).sum(), 1)
        width = abs(math.log(ar2 / ar))
        weight = abs((r > 0).mean() - dens)  # stroke weight: light serif vs heavy display face
        score = iou - 0.8 * width - 1.2 * weight + PRIOR.get(key, 0)  # letter shapes, width the face sets the words at, weight
        if not best or score > best[1]:
            best = (key, score, r.shape[0])
    return best


def measure(img, box, text):
    """Look of one caption: img = BGR frame, box = EasyOCR quad of its biggest word run, text = what it says."""
    h, w = img.shape[:2]
    xs, ys = [int(p[0]) for p in box], [int(p[1]) for p in box]
    x0, x1, y0, y1 = max(min(xs), 0), min(max(xs), w), max(min(ys), 0), min(max(ys), h)
    if x1 - x0 < 8 or y1 - y0 < 6:
        return None
    crop = img[y0:y1, x0:x1]
    ink = _ink(crop)
    on = ink > 127
    if on.mean() < 0.03:
        return None
    # letter cores, not their anti-aliased edges (which blend into the photo and darken a light colour)
    px = crop[on].astype(np.float32)
    lum = px @ np.array([0.11, 0.59, 0.3], np.float32)
    lighter = lum.mean() > float(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)[~on].mean() if (~on).any() else 128)
    core = px[lum >= np.percentile(lum, 60)] if lighter else px[lum <= np.percentile(lum, 40)]
    fill = tuple(int(c) for c in (core if len(core) else px).mean(axis=0)[::-1])  # BGR -> RGB
    bg = crop[~on]
    if len(bg):  # a "colour" that's really the photo behind (light text over sea or sky): the text is white / black
        bgc = bg.mean(axis=0)[::-1]
        if np.linalg.norm(np.array(fill, float) - bgc) < 70 and max(fill) - min(fill) > 40:
            fill = (255, 255, 255) if np.mean(fill) > 110 else (15, 15, 15)
    # a solid box behind the text (Instagram's "background" text): around the letters, inside the caption, is one
    # flat colour (a photo, even a clear sky, varies more than this)
    ker = np.ones((3, 3), np.uint8)
    around = ~(cv2.dilate(on.astype(np.uint8), ker, iterations=2) > 0)
    behind = crop[around]
    box_rgb = None
    if len(behind) > 30 and behind.std(axis=0).mean() < 6 and abs(float(behind.mean()) - float(np.mean(fill))) > 60:
        rgb = tuple(int(c) for c in behind.mean(axis=0)[::-1])
        lum, sat = sum(rgb) / 3, max(rgb) - min(rgb)
        if lum > 220 or lum < 40 or sat > 90:  # text-tool boxes are white, black or a bold colour, not sky grey
            box_rgb = rgb
    # an outline: right around the letters it's much darker than the text and than the background further out
    edge = (cv2.dilate(on.astype(np.uint8), ker, iterations=2) > 0) & ~on
    stroke = 0
    if edge.any() and np.mean(fill) > 150 and crop[edge].mean() < 60 and crop[~edge & ~on].mean() > 90:
        stroke = 6
    words = text.strip()
    m = match_font(ink, words)
    if not m:
        return None
    key, score, probe_ink = m
    # font size so the rendered letters stand as tall as the reel's, at our 1080x1920 frame
    band = _band(ink)
    ink_px = (band.shape[0] if band is not None else y1 - y0) * (H / h)
    size = int(round(_PROBE * ink_px / max(probe_ink, 1)))
    return dict(font=key, size=[size, max(int(size * 0.8), 20)], upper=words.isupper() and len(words) > 3,
                fill=list(fill), box=list(box_rgb) if box_rgb else None, stroke=stroke,
                shadow=0 if box_rgb else 10, lh=1.1, y=round(((y0 + y1) / 2) / h, 3), match=round(float(score), 3))
