"""Carousel posts: 1080x1350 slides from real frames, our phone and the brand's text styles.

A carousel brief: {id, format: "carousel", caption, hashtags,
  slides: [{clip, t?, text?, sub?, style?: hook|hook_serif|caption|pill|stamp, pos?: top|center|lower,
            screen?: library screen id, screen_t?}],
  endcard?: "Brand|tagline", cta?}
A slide with a screen shows that app screen in our phone over the slide's shot. The end card is its own last slide.
Output: <id>_1.jpg ... (the post), <id>.jpg (cover), <id>.mp4 (a silent preview, 2.5s a slide), <id>.txt (caption).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

from .common import BRAND_NAME, FFMPEG, run
from .text import read_time, render_sprite

W, H = 1080, 1350
POS = {"top": 150, "upper": 260, "center": 560, "lower": 960}
SAFE_W = 920


def _frame(path, t, work, name):
    png = work / f"{name}.png"
    run([FFMPEG, "-v", "error", "-y", "-ss", f"{max(t, 0):.2f}", "-i", str(path), "-frames:v", "1",
         "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}", str(png)])
    return Image.open(png).convert("RGBA")


def _screen(path, t, work, name, h):
    png = work / f"{name}_scr.png"
    run([FFMPEG, "-v", "error", "-y", "-ss", f"{max(t, 0):.2f}", "-i", str(path), "-frames:v", "1", str(png)])
    scr = Image.open(png).convert("RGBA")
    w = int(h * scr.width / scr.height)
    scr = scr.resize((w, h), Image.LANCZOS)
    r, b = int(h * 0.056), int(h * 0.01)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    body = Image.new("RGBA", (w + 2 * b + 80, h + 2 * b + 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle((40 + 6, 40 + 30, 40 + w + 2 * b + 6, 40 + h + 2 * b + 30), r + b, fill=(0, 0, 0, 150))
    body = body.filter(ImageFilter.GaussianBlur(30))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle((40, 40, 40 + w + 2 * b, 40 + h + 2 * b), r + b, fill=(16, 19, 26, 255), outline=(78, 84, 98, 255), width=3)
    body.paste(scr, (40 + b, 40 + b), mask)
    return body


def _shade(img, y0, y1):
    """A soft dark band behind text so white type reads over any shot."""
    band = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle((0, max(0, y0), W, min(H, y1)), fill=(0, 0, 0, 105))
    return Image.alpha_composite(img, band.filter(ImageFilter.GaussianBlur(70)))


def _text(img, text, style, y):
    sp = render_sprite(text, style, maxw=SAFE_W)
    img = _shade(img, y - 40, y + sp.height + 40) if style not in ("pill", "stamp") else img
    img.alpha_composite(sp, (max(0, (W - sp.width) // 2), max(0, y - 40)))
    return img, y + sp.height - 60


def render_carousel(brief, resolve, outdir):
    """resolve(clip id) -> file path (a batch clip or a library item)."""
    out = Path(outdir)
    vid = brief["id"]
    work = out / "work" / vid
    work.mkdir(parents=True, exist_ok=True)
    slides, warns = [], []
    for i, s in enumerate(brief.get("slides") or []):
        img = _frame(resolve(s["clip"]), float(s.get("t") or 0), work, f"s{i}")
        if s.get("screen"):
            img = img.filter(ImageFilter.GaussianBlur(2))
            ph = _screen(resolve(s["screen"]), float(s.get("screen_t") or 1.2), work, f"s{i}", 780)
            img.alpha_composite(ph, ((W - ph.width) // 2, H - ph.height + 190))  # low, so the text above stays clear
        style = s.get("style") or ("hook" if i == 0 else "pill")
        if s.get("screen") and style in ("hook", "hook_serif", "stamp"):
            style = "pill"  # big type would run into the phone; a pill sits above it and reads over anything
        pos = s.get("pos") or ("top" if s.get("screen") else "center" if i == 0 else "lower")
        y = POS.get(pos, 560)
        if s.get("text"):
            img, y = _text(img, s["text"], style, y)
        if s.get("sub"):
            img, _ = _text(img, s["sub"], "caption", y + 20)
        if len((s.get("text") or "").split()) > 14:
            warns.append(f"slide {i + 1}: {len(s['text'].split())} words is a lot for one slide")
        slides.append(img)
    if brief.get("endcard"):
        base = slides[-1] if slides else Image.new("RGBA", (W, H), (12, 12, 14, 255))
        last = (brief.get("slides") or [{}])[-1]
        img = _frame(resolve(last["clip"]), float(last.get("t") or 0) + 0.8, work, "end") if last.get("clip") else base
        img = Image.alpha_composite(img.filter(ImageFilter.GaussianBlur(6)), Image.new("RGBA", (W, H), (0, 0, 0, 120)))
        name, tag = (brief["endcard"].split("|") + [""])[:2]
        img, y = _text(img, name or BRAND_NAME, "endcard", 420)
        if tag:
            img, y = _text(img, tag, "kicker", y + 30)
        if brief.get("cta"):
            img, _ = _text(img, brief["cta"], "pill", y + 60)
        slides.append(img)
    names = []
    for i, img in enumerate(slides):
        p = out / f"{vid}_{i + 1}.jpg"
        img.convert("RGB").save(p, quality=92)
        names.append(p.name)
    if not names:
        raise ValueError("a carousel needs at least one slide")
    poster = out / f"{vid}.jpg"
    slides[0].convert("RGB").save(poster, quality=90)
    hold = 2.5
    lst = work / "slides.txt"
    lst.write_text("".join(f"file '{(out / n).as_posix()}'\nduration {hold}\n" for n in names) + f"file '{(out / names[-1]).as_posix()}'\n")
    mp4 = out / f"{vid}.mp4"
    run([FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", "fps=30,format=yuv420p",
         "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", str(mp4)])
    tags = " ".join("#" + t.lstrip("#") for t in brief.get("hashtags", []))
    (out / f"{vid}.txt").write_text((brief.get("caption", "") + ("\n\n" + tags if tags else "")).strip() + "\n", encoding="utf-8")
    return dict(id=vid, format="carousel", file=str(mp4), bare=None, poster=str(poster), caption_file=str(out / f"{vid}.txt"),
                duration=round(hold * len(names), 2), size_mb=round(mp4.stat().st_size / 2 ** 20, 2), cuts=[], warnings=warns,
                hook=(brief.get("slides") or [{}])[0].get("text"), grade=None, music=None,
                tags={**(brief.get("test_tags") or {}), "slides": ",".join(names)})
