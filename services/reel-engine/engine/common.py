"""Shared constants and helpers for the Reel Engine."""
import json
import os
import shutil
import subprocess
from pathlib import Path

# Brand settings (override with environment variables)
BRAND_NAME = os.environ.get("BRAND_NAME", "our brand")
BRAND_TAGLINE = os.environ.get("BRAND_TAGLINE", "Look closer.")
BRAND_PITCH = os.environ.get("BRAND_PITCH", "")
BRAND_NICHE = os.environ.get("BRAND_NICHE", "lifestyle")
BRAND_GOAL = os.environ.get("BRAND_GOAL", "")
BRAND_IG_HANDLE = os.environ.get("BRAND_IG_HANDLE", "")
BRAND_CTA = os.environ.get("BRAND_CTA", "")

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONTS = ASSETS / "fonts"
MUSIC = ASSETS / "music"

W, H, FPS = 1080, 1920, 30
# Platform UI safe zone for IG Reels + TikTok (captions, buttons, username)
SAFE = dict(left=70, right=930, top=230, bottom=1460)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


def run(cmd, quiet=True, check=True):
    r = subprocess.run(cmd, stdout=subprocess.PIPE if quiet else None,
                       stderr=subprocess.PIPE if quiet else None)
    if check and r.returncode != 0:
        err = (r.stderr or b"").decode(errors="ignore")[-2000:]
        raise RuntimeError(f"command failed: {' '.join(map(str, cmd[:6]))}...\n{err}")
    return r


def probe(path):
    r = run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams",
             "-show_format", str(path)])
    d = json.loads(r.stdout)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    out = {"path": str(path), "duration": float(d["format"].get("duration", 0) or 0),
           "has_audio": a is not None, "has_video": v is not None}
    if v:
        w, h = int(v["width"]), int(v["height"])
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(float(sd["rotation"]))
        if "tags" in v and "rotate" in v["tags"]:
            rot = int(v["tags"]["rotate"])
        if abs(rot) % 180 == 90:
            w, h = h, w
        num, den = (v.get("avg_frame_rate") or "30/1").split("/")
        fps = float(num) / float(den) if float(den) else 30.0
        out.update(width=w, height=h, fps=round(fps, 3), rotation=rot)
        if not out["duration"]:
            out["duration"] = float(v.get("duration", 0) or 0)
    return out


def font(name):
    p = FONTS / name
    if not p.exists():
        raise FileNotFoundError(p)
    return str(p)


FONT = {
    "anton": "anton-latin-400-normal.woff",
    "bebas": "bebas-neue-latin-400-normal.woff",
    "archivo": "archivo-black-latin-400-normal.woff",
    "mont900": "montserrat-latin-900-normal.woff",
    "mont800": "montserrat-latin-800-normal.woff",
    "mont700": "montserrat-latin-700-normal.woff",
    "mont600": "montserrat-latin-600-normal.woff",
    "serif_it": "dm-serif-display-latin-400-italic.woff",
    "serif": "dm-serif-display-latin-400-normal.woff",
    "playfair_it": "playfair-display-latin-700-italic.woff",
    "pacifico": "pacifico-latin-400-normal.woff",
    # caption faces matched against reference reels (Instagram / TikTok text tools look like these)
    "inter": "inter-latin-400-normal.woff",
    "inter600": "inter-latin-600-normal.woff",
    "inter700": "inter-latin-700-normal.woff",
    "garamond": "eb-garamond-latin-400-normal.woff",
    "garamond_it": "eb-garamond-latin-400-italic.woff",
    "baskerville": "libre-baskerville-latin-400-normal.woff",
    "baskerville_it": "libre-baskerville-latin-400-italic.woff",
    "typewriter": "courier-prime-latin-400-normal.woff",
    "hand": "caveat-latin-500-normal.woff",
}


def jdump(obj, path):
    Path(path).write_text(json.dumps(obj, indent=2), encoding="utf-8")


def jload(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)
    return Path(p)
