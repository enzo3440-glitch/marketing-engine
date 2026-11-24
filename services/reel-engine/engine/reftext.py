"""On-screen text of a reference reel, shot by shot (EasyOCR, local models; optional).

Returns [{"shot": i, "t": seconds, "text": "...", "pos": "top|center|bottom"}] so a reference can become a
literal template: same cuts, same words in the same place.
"""
import re
import subprocess

import cv2
import numpy as np

from .common import FFMPEG

_reader = None


def _ocr():
    global _reader
    if _reader is None:
        import easyocr  # heavy import; only when a reference is analysed
        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _reader


def _clean(t):
    """Common OCR slips on caption fonts: 'II'/'Il' for 'll', ':' or '_' for a full stop, '=' for '?'."""
    t = re.sub(r"'\s*[Il]{2}\b", "'ll", t)
    t = re.sub(r"\b(You|you|We|we|They|they|I|It|it|She|she|He|he) ?[Il1]{2}\b", lambda m: m.group(1) + "'ll", t)  # "You II" -> "You'll"
    t = re.sub(r"\s*'\s*([sS])\b", r"'\1", t)
    t = re.sub(r"(\w) ?\$ (?=\w)", lambda m: m.group(1) + "'s ", t)  # "there $ a" -> "there's a" (an apostrophe-s read as $)
    t = re.sub(r"=(?=\s|$)", "?", t)
    t = re.sub(r"[:_]+(?=\s|$)", ".", t)
    return _spellfix(re.sub(r"\s+", " ", t).strip())


# characters OCR mixes up on caption fonts; a misread word is only corrected through these swaps, so names stay
_CONF = {frozenset(p) for p in ["vy", "lt", "lh", "ce", "rt", "nh", "0o", "1l", "1i", "il", "uv", "ao", "eo", "mn", "hb", "ft", "s5", "gq", "ij"]}
_spell = None


def _speller():
    global _spell
    if _spell is None:
        try:
            from spellchecker import SpellChecker  # optional: pyspellchecker
            _spell = SpellChecker()
        except Exception:
            _spell = False
    return _spell


def _ocr_swap(a, b):
    return len(a) == len(b) and all(x == y or frozenset((x, y)) in _CONF for x, y in zip(a, b))


def _fix_word(w):
    core = re.sub(r"[^\w']", "", w)
    if not core or not core.isalpha() or len(core) < 2:
        return w
    sp = _speller()
    low = core.lower()
    # odd casing ("yOu", "VOU") is an OCR artefact; a capital first letter is kept
    cased = (lambda x: x[0].upper() + x[1:]) if core[0].isupper() and not core.isupper() else (lambda x: x)
    if not sp or low in sp:
        fixed = low if core != low and not core.istitle() and not core.isupper() else core
        return w.replace(core, cased(fixed) if fixed == low else fixed)
    cand = sp.correction(low)
    if cand and _ocr_swap(low, cand):
        return w.replace(core, cased(cand))
    # two words read as one ("Giveme", "alife", "oflife"): split where both halves are real words
    for i in range(1, len(low)):
        a, b = low[:i], low[i:]
        if (len(a) > 1 or a in ("a", "i")) and len(b) > 1 and a in sp and b in sp and sp.word_usage_frequency(a) > 1e-6 and sp.word_usage_frequency(b) > 1e-6:
            return w.replace(core, f"{cased(a)} {b}")
    return w.replace(core, cased(low) if not core.isupper() else core)


def _spellfix(t):
    # a digit inside a word is a misread letter ("S0" -> "So", "1ife" -> "life")
    t = re.sub(r"(?<=[A-Za-z])0|0(?=[a-z])", "o", t)
    t = re.sub(r"(?<=[a-z])1|1(?=[a-z]{2})", "l", t)
    return " ".join(_fix_word(w) for w in t.split())


def _caption_like(t):
    """Real captions are a phrase (3+ words) or end like a sentence; map labels and app titles are not."""
    return len(t.split()) >= 3 or bool(re.search(r"[.!?]$", t))


def _same(a, b):
    wa, wb = set(re.findall(r"\w+", a.lower())), set(re.findall(r"\w+", b.lower()))
    return bool(wa and wb) and len(wa & wb) / max(len(wa), len(wb)) >= 0.6


def _frame(path, t, w=540):
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", f"scale={w}:-2", "-f", "image2pipe", "-vcodec", "png", "-"], stdout=subprocess.PIPE)
    if not r.stdout:
        return None
    return cv2.imdecode(np.frombuffer(r.stdout, np.uint8), cv2.IMREAD_COLOR)


def _reading_order(found, hmax):
    """Words into lines (centres within half a word-height share a line), lines top to bottom, words left to right.
    Sorting on the top edge alone scrambles a line whose words sit a few pixels apart ("day He said one")."""
    cy = lambda f: (min(p[1] for p in f[0]) + max(p[1] for p in f[0])) / 2
    lines = []
    for f in sorted(found, key=cy):
        if lines and abs(cy(f) - np.mean([cy(g) for g in lines[-1]])) <= hmax * 0.5:
            lines[-1].append(f)
        else:
            lines.append([f])
    return [f for line in lines for f in sorted(line, key=lambda f: min(p[0] for p in f[0]))]


def _read(reader, img, min_conf=0.45, min_h=0.028, with_look=False, short_ok=False):
    """The caption on one frame: (text, pos, size as a share of frame height) or None."""
    h = img.shape[0]
    # captions only: big overlay text, not the small UI text inside a phone or app recording
    found = [(box, txt, conf) for box, txt, conf in reader.readtext(img)
             if conf >= min_conf and len(txt.strip()) > 1 and (max(p[1] for p in box) - min(p[1] for p in box)) >= min_h * h]
    if not found:
        return None
    hmax = max(max(p[1] for p in b) - min(p[1] for p in b) for b, _, _ in found)
    found = [f for f in found if (max(p[1] for p in f[0]) - min(p[1] for p in f[0])) >= 0.75 * hmax]  # the caption is the biggest text
    found = _reading_order(found, hmax)
    text = _clean(" ".join(t.strip() for _, t, _ in found))
    y = float(np.mean([np.mean([p[1] for p in box]) / h for box, _, _ in found]))
    pos = "top" if y < 0.38 else "bottom" if y > 0.68 else "center"
    if not _caption_like(text):
        # a reel's own one- or two-word beats ("You will", "Remember", "GO") are captions too when they sit centred
        # across the frame and read cleanly; screen recordings (short_ok False) keep the phrase-only rule
        xs = [p[0] for f in found for p in f[0]]
        centred = abs((min(xs) + max(xs)) / 2 / img.shape[1] - 0.5) < 0.15
        if not (short_ok and centred and min(c for _, _, c in found) >= 0.5 and re.search(r"[A-Za-z]{2}", text)):
            return None
    look = None
    if with_look:  # the reel's own typeface, colour, box: measured on its widest word run
        from .reflook import measure
        wbox, wtxt, _ = max(found, key=lambda f: max(p[0] for p in f[0]) - min(p[0] for p in f[0]))
        try:
            look = measure(img, wbox, wtxt)
        except Exception as e:
            print(f"[reftext] look: {e}", flush=True)
        if look:
            look["y"] = round(y, 3)
            w_ = img.shape[1]  # where it sits across: left / right placements and staggered layouts carry over
            look["x"] = round(((min(p[0] for f in found for p in f[0]) + max(p[0] for f in found for p in f[0])) / 2) / w_, 3)
    return (text, pos, round(hmax / h, 3), look)


def shot_text(path, shots, min_conf=0.45):
    """OCR the middle of each shot. Consecutive shots with the same text keep it once (on the first shot)."""
    try:
        reader = _ocr()
    except Exception as e:  # OCR is optional: no easyocr / models -> no text, cuts still measured
        print(f"[reftext] OCR unavailable: {e}", flush=True)
        return []
    out, last = [], None
    for i, (a, b) in enumerate(shots):
        img = _frame(path, (a + b) / 2)
        r = _read(reader, img, min_conf, with_look=True) if img is not None else None
        if not r:
            last = None
            continue
        if not last or not _same(r[0], last):
            out.append(dict(shot=i, t=round(a, 2), text=r[0], pos=r[1], size=r[2], **({"look": r[3]} if r[3] else {})))
        last = r[0]
    return unify_faces(out)  # a dropped reference video gets the same look reading as a link


def frames_text(frames, shot_lengths, min_conf=0.45, turn=None):
    """Text over time from sampled frames [(t, jpeg bytes)] of a reel read from its link.
    Returns [{shot, t, t1, text, pos, size}]: each caption once, with when it appears and leaves."""
    try:
        reader = _ocr()
    except Exception as e:
        print(f"[reftext] OCR unavailable: {e}", flush=True)
        return []
    bounds = np.cumsum([0.0] + list(shot_lengths or []))
    shot_at = lambda t: int(max(0, np.searchsorted(bounds, t, side="right") - 1)) if len(bounds) > 1 else 0
    out = []
    for t, data in sorted(frames, key=lambda f: f[0]):
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is not None and turn in ("cw", "ccw"):  # a "turn your phone" reel: read it the right way up
            img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE if turn == "cw" else cv2.ROTATE_90_CLOCKWISE)
        # reels read from a link are clean frames (no phone UI), so small trend captions count too
        r = _read(reader, img, min(min_conf, 0.3), min_h=0.01, with_look=True, short_ok=True) if img is not None else None
        if not r:
            continue
        if out and _same(r[0], out[-1]["text"]) and t - out[-1]["t1"] < 1.2:
            out[-1]["t1"] = round(t, 2)
            if len(r[0]) > len(out[-1]["text"]):  # words appearing one by one: keep the fullest read
                out[-1]["text"] = r[0]
            if r[3]:
                out[-1]["_looks"].append(r[3])
            continue
        out.append(dict(shot=shot_at(t), t=round(t, 2), t1=round(t, 2), text=r[0], pos=r[1], size=r[2], _looks=[r[3]] if r[3] else []))
    # a short beat seen on a single frame is more likely a sign in the shot than a caption
    out = [l for l in out if _caption_like(l["text"]) or l["t1"] > l["t"]]
    for line in out:  # a caption seen on several frames votes: the most-matched face, typical size and colour
        looks = line.pop("_looks", [])
        if looks:
            line["look"] = _vote(looks)
    # each sample stands for the half-gap around it: a caption seen on one frame is on screen ~one gap, not 0s
    ts = sorted(f[0] for f in frames)
    half = float(np.median(np.diff(ts))) / 2 if len(ts) > 1 else 0.3
    for i, line in enumerate(out):
        nxt = out[i + 1]["t"] if i + 1 < len(out) else ts[-1] + half if ts else line["t1"] + half
        line["t"] = round(max(0.0, line["t"] - half), 2)
        line["t1"] = round(min(line["t1"] + half, nxt), 2)
    return tidy(out)


_SMALL = set("the a an and or but to of in on at for with is are was be it its you your we our i my me he she they this that so".split())


def _overlap(a, b):
    """Share of meaningful words two reads have in common (small words like 'the' / 'you' don't count)."""
    wa = {w for w in re.findall(r"\w+", a.lower()) if w not in _SMALL and len(w) > 2}
    wb = {w for w in re.findall(r"\w+", b.lower()) if w not in _SMALL and len(w) > 2}
    common = wa & wb
    return len(common) / max(min(len(wa), len(wb)), 1) if len(common) >= 2 else 0.0


def tidy(lines):
    """Clean a reel's captions as a set: one read per caption (a near-repeat of the line before folds into it),
    one typeface, and one colour unless a line really differs (an outlier read off a patch of photo is put back)."""
    out = []
    for line in lines:
        line = dict(line, text=_clean(line["text"]))
        close = out and line.get("t", 0) - out[-1].get("t1", out[-1].get("t", 0)) < 1.5  # repeats sit right after each other
        if close and _overlap(line["text"], out[-1]["text"]) >= 0.6:
            prev = out[-1]
            prev["t1"] = max(prev.get("t1", prev.get("t", 0)), line.get("t1", line.get("t", 0)))
            if len(line["text"]) > len(prev["text"]) and _caption_like(line["text"]):
                prev["text"] = line["text"]
            continue
        out.append(line)
    out = unify_faces(out)
    fills = [l["look"]["fill"] for l in out if l.get("look")]
    if len(fills) >= 3:
        mid = np.median(np.array(fills, float), axis=0)
        for l in out:
            if l.get("look") and np.linalg.norm(np.array(l["look"]["fill"], float) - mid) > 80:
                l["look"] = dict(l["look"], fill=[int(c) for c in mid])
    return out


FAMILY ={"inter": "sans", "inter600": "sans", "inter700": "sans", "mont600": "sans", "mont800": "sans", "mont900": "sans",
          "anton": "display", "bebas": "display", "archivo": "display",
          "serif": "serif", "baskerville": "serif", "garamond": "serif",
          "serif_it": "serif_it", "playfair_it": "serif_it", "garamond_it": "serif_it", "baskerville_it": "serif_it",
          "typewriter": "mono", "hand": "script", "pacifico": "script"}


def unify_faces(lines):
    """A reel sets its captions in one typeface: vote the family across every line (weighted by how many frames
    agreed), then the face within it, and give it to all lines. Each line keeps its own size, colour and box."""
    from collections import Counter
    looks = [l["look"] for l in lines if l.get("look")]
    if len(looks) < 2:
        return lines
    weight = lambda lk: int(str(lk.get("votes", "1/1")).split("/")[0] or 1)
    fam = Counter()
    for lk in looks:
        fam[FAMILY.get(lk["font"], lk["font"])] += weight(lk)
    top = fam.most_common(1)[0][0]
    faces = Counter()
    for lk in looks:
        if FAMILY.get(lk["font"], lk["font"]) == top:
            faces[lk["font"]] += weight(lk)
    face = faces.most_common(1)[0][0]
    sizes = [lk["size"][0] for lk in looks]
    mid = float(np.median(sizes))
    for l in lines:
        lk = l.get("look")
        if not lk:
            continue
        # some reels mix faces on purpose (a big bold headline over a small serif line): a line keeps its own face
        # when several frames agreed on it and it's set at a clearly different size; a weak one-frame read falls in
        votes, seen = (int(x) for x in str(lk.get("votes", "1/1")).split("/"))
        own = FAMILY.get(lk["font"], lk["font"]) != top and votes >= 2 and votes / max(seen, 1) >= 0.6 and abs(lk["size"][0] - mid) / mid > 0.25
        if not own:
            l["look"] = dict(lk, font=face, upper=lk.get("upper") or (top == "display"))
    return lines


def _vote(looks):
    from collections import Counter
    face = Counter(l["font"] for l in looks).most_common(1)[0][0]
    same = [l for l in looks if l["font"] == face]
    pick = dict(same[0])
    pick["size"] = [int(np.median([l["size"][0] for l in same])), int(np.median([l["size"][1] for l in same]))]
    pick["fill"] = [int(np.median([l["fill"][i] for l in same])) for i in range(3)]
    boxes = [l["box"] for l in same if l.get("box")]
    # a box is only real when it's seen on 2+ frames: on one frame, dark rock or sky behind small letters reads as one
    pick["box"] = boxes[0] if len(boxes) >= 2 and len(boxes) * 2 > len(same) else None
    pick["shadow"] = 0 if pick["box"] else 10
    pick["votes"] = f"{len(same)}/{len(looks)}"
    return pick
