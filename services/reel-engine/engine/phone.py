"""Our brand phone and labelled placeholders, made as clips a brief can use (job "make" entries, batch.py).

  phone:       an app screen recording (library/screens/*.mp4) in our phone, springing up over a real shot and drifting
  placeholder: a shot still to film, or an app screen still to record, as a clearly labelled card (so a concept can be
               watched before it's shot)
All outputs are 1080x1920, 30 fps, silent.
"""
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .common import FFMPEG, font, run

PW, PH, R, B = 640, 1386, 78, 14            # the phone: screen size, corner radius, bezel
SPRING = "220*exp(-5.5*t)*cos(6.5*t)-7*t"  # rises in with one soft overshoot, then drifts up a few px a second
YELLOW = (255, 204, 0, 255)


def _shell(work, py):
    """The phone's mask and its body + shadow layer, cached per phone height."""
    px = (1080 - PW) // 2
    mask, shell = work / f"_m{PW}x{PH}.png", work / f"_s{PW}x{PH}_{py}.png"
    if not mask.exists():
        m = Image.new("L", (PW, PH), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, PW - 1, PH - 1), R, fill=255)
        m.save(mask)
    if not shell.exists():
        s = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
        d = ImageDraw.Draw(s)
        d.rounded_rectangle((px - B + 8, py - B + 40, px + PW + B + 8, py + PH + B + 40), R + B, fill=(0, 0, 0, 150))
        s = s.filter(ImageFilter.GaussianBlur(40))
        d = ImageDraw.Draw(s)
        d.rounded_rectangle((px - B, py - B, px + PW + B, py + PH + B), R + B, fill=(16, 19, 26, 255), outline=(78, 84, 98, 255), width=3)
        s.save(shell)
    return mask, shell, px


def ride(screen, bg, bg_start, dur, out, screen_start=0.0, phone_y=400):
    """The screen recording in our phone over a blurred, slightly darkened real shot."""
    out = Path(out)
    mask, shell, px = _shell(out.parent, phone_y)
    fc = (f"[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=3,"
          f"eq=brightness=-0.08:saturation=1.05,setsar=1,fps=30[bg];"
          f"[1:v]scale={PW}:{PH}:flags=lanczos,fps=30,setsar=1,tpad=stop_mode=clone:stop_duration={dur}[ph];"
          f"[2:v]format=gray[mk];[ph][mk]alphamerge[phm];"
          f"[bg][3:v]overlay=x=0:y='{SPRING}':eval=frame[bs];[bs][phm]overlay=x={px}:y='{phone_y}+{SPRING}':eval=frame:shortest=0,format=yuv420p[v]")
    run([FFMPEG, "-v", "error", "-y", "-ss", f"{bg_start:.2f}", "-t", f"{dur:.2f}", "-i", str(bg), "-ss", f"{screen_start:.2f}", "-i", str(screen),
         "-loop", "1", "-i", str(mask), "-loop", "1", "-i", str(shell), "-filter_complex", fc, "-map", "[v]", "-t", f"{dur:.2f}",
         "-an", "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-r", "30", str(out)])
    return out


def _card(w, h, tag, body, wrap, scale=1.0):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lines = textwrap.wrap(body, wrap)
    f1 = ImageFont.truetype(font("montserrat-latin-800-normal.woff"), int(40 * scale))
    f2 = ImageFont.truetype(font("montserrat-latin-600-normal.woff"), int(44 * scale))
    lh = int(60 * scale)
    bh = int(90 * scale) + lh * len(lines) + int(40 * scale)
    x0, x1, y0 = int(70 * scale), w - int(70 * scale), (h - bh) // 2
    d.rounded_rectangle((x0, y0, x1, y0 + bh), int(28 * scale), fill=(12, 14, 20, 215), outline=YELLOW, width=int(5 * scale))
    tw = d.textlength(tag, font=f1)
    d.rounded_rectangle(((w - tw) / 2 - 18, y0 + 24 * scale, (w + tw) / 2 + 18, y0 + 80 * scale), 10, fill=YELLOW)
    d.text(((w - tw) / 2, y0 + 30 * scale), tag, font=f1, fill=(0, 0, 0, 255))
    for i, l in enumerate(lines):
        lw = d.textlength(l, font=f2)
        d.text(((w - lw) / 2, y0 + int(100 * scale) + i * lh), l, font=f2, fill=(255, 255, 255, 255))
    return im


def placeholder(text, bg, bg_start, dur, out, screen=False):
    """A labelled card over a dimmed, blurred real shot: what to film (or, screen=True, a phone with the app screen to record)."""
    out = Path(out)
    if not screen:
        png = out.with_name(out.stem + "_card.png")
        _card(1080, 1920, "PLACEHOLDER SHOT", text, 30).save(png)
        fc = ("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,"
              "eq=brightness=-0.12:saturation=0.6,gblur=sigma=6[b];[b][1:v]overlay=0:0,format=yuv420p[v]")
        run([FFMPEG, "-v", "error", "-y", "-ss", f"{bg_start:.2f}", "-t", f"{dur:.2f}", "-i", str(bg), "-loop", "1", "-i", str(png),
             "-filter_complex", fc, "-map", "[v]", "-t", f"{dur:.2f}", "-an", "-c:v", "libx264", "-crf", "16", str(out)])
        return out
    scr = Image.new("RGB", (1140, 2470), (22, 27, 36))
    d = ImageDraw.Draw(scr)
    for y in range(0, 2470, 90):
        d.line((0, y, 1140, y + 300), fill=(30, 36, 47), width=30)
    card = _card(1140, 2470, "APP SCREEN TO RECORD", text, 17, 1.9)
    scr.paste(card, (0, 0), card)
    png = out.with_name(out.stem + "_screen.png")
    scr.save(png)
    vid = out.with_name(out.stem + "_screen.mp4")
    run([FFMPEG, "-v", "error", "-y", "-loop", "1", "-t", f"{dur:.2f}", "-i", str(png), "-vf", "fps=30,format=yuv420p",
         "-c:v", "libx264", "-crf", "16", str(vid)])
    return ride(vid, bg, bg_start, dur, out)


def make(entry, resolve, outdir):
    """One job "make" entry -> a clip file. resolve(id) gives a clip or library item's file path.
    {id, kind: phone|placeholder|placeholder_screen, screen?, bg, bg_start?, dur?, screen_start?, text?}"""
    out = Path(outdir) / f"{entry['id']}.mp4"
    bg, bs, dur = resolve(entry["bg"]), float(entry.get("bg_start") or 0), float(entry.get("dur") or 4)
    if entry["kind"] == "phone":
        return ride(resolve(entry["screen"]), bg, bs, dur, out, float(entry.get("screen_start") or 0))
    return placeholder(entry.get("text") or "Shot to film", bg, bs, dur, out, screen=entry["kind"] == "placeholder_screen")
