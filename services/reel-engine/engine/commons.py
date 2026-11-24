"""Find and fetch freely licensed archive pictures and film for story docs.

Wikimedia Commons only: public-domain, CC0, CC BY and CC BY-SA files (never NC or ND, because ads are commercial and
every shot is cropped and panned). Each download is logged in the story's credits.json with its author and licence, so
the caption can credit the CC BY / BY-SA ones.

    python -m engine.commons search "Barcelona 1908" --kind video
    python -m engine.commons fetch reel-data/story-docs/barcelona "File:Barcelona 1908.webm" --as 01-film-1908.webm
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia's policy wants automated clients to carry a contact. Set your own contact address; it lives
# in a git-ignored file (reel-data/story-docs/_cache/.contact) or WIKIMEDIA_CONTACT so it never lands in the repo.
def _contact():
    import os
    c = os.environ.get("WIKIMEDIA_CONTACT", "").strip()
    if not c:
        try:
            c = (Path(__file__).resolve().parent.parent / "reel-data" / "story-docs" / "_cache" / ".contact").read_text("utf-8").strip()
        except OSError:
            c = ""
    return c or "contact via commons talk"


UA = {"User-Agent": f"StoryDocs/1.0 (archive research; {_contact()}) python-urllib"}
OK = re.compile(r"^(public domain|pd\b|cc0|cc by(-sa)? ?[\d.]*|cc-by(-sa)?-[\d.]+|attribution|no restrictions)", re.I)
BAD = re.compile(r"\b(nc|nd)\b|noncommercial|noderiv|fair use|non-free", re.I)
MAX_VIDEO = 400 * 1024 * 1024


def _get(params, tries=6):
    import time
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "maxlag": 5})
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:  # Wikimedia asks bots to back off on 429 / 503
            if e.code not in (429, 503) or i == tries - 1:
                raise
            time.sleep(float(e.headers.get("Retry-After") or 5 * (i + 1)))


def _clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def _row(page):
    ii = (page.get("imageinfo") or [{}])[0]
    md = ii.get("extmetadata") or {}
    lic = _clean(md.get("LicenseShortName", {}).get("value"))
    return dict(title=page["title"], url=ii.get("url"), thumb=ii.get("thumburl"), width=ii.get("width"),
                height=ii.get("height"), size=ii.get("size"), mime=ii.get("mime"), duration=ii.get("duration"),
                author=_clean(md.get("Artist", {}).get("value"))[:160] or "Unknown", license=lic,
                license_url=_clean(md.get("LicenseUrl", {}).get("value")),
                date=_clean(md.get("DateTimeOriginal", {}).get("value"))[:40],
                desc=_clean(md.get("ImageDescription", {}).get("value"))[:240],
                commons_url="https://commons.wikimedia.org/wiki/" + urllib.parse.quote(page["title"].replace(" ", "_")),
                usable=bool(OK.search(lic)) and not BAD.search(lic))


def search(query, kind="image", n=20):
    ft = {"image": "filetype:bitmap", "video": "filetype:video"}[kind]
    d = _get(dict(action="query", generator="search", gsrsearch=f"{query} {ft}", gsrnamespace=6, gsrlimit=n,
                  prop="imageinfo", iiprop="url|size|mime|extmetadata", iiurlwidth=640))
    rows = [_row(p) for p in sorted(d.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))]
    if kind == "image":
        rows = [r for r in rows if (r["width"] or 0) >= 1000 and (r["mime"] or "").startswith("image/")]
    return [r for r in rows if r["usable"]]


def info(title):
    d = _get(dict(action="query", titles=title, prop="imageinfo", iiprop="url|size|mime|extmetadata", iiurlwidth=640))
    return _row(next(iter(d["query"]["pages"].values())))


def sources(title):
    """The original and Commons' transcodes of a video, smallest first: [(height or 0, url)]."""
    d = _get(dict(action="query", titles=title, prop="videoinfo", viprop="url|derivatives"))
    vi = (next(iter(d["query"]["pages"].values())).get("videoinfo") or [{}])[0]
    out = [(int(x.get("height") or 0), x["src"]) for x in vi.get("derivatives", []) if x.get("src")]
    return sorted(out) or [(0, vi.get("url"))]


def stream(title, height=1080):
    """The best transcode at or under this height (falls back to the smallest one above it)."""
    src = sources(title)
    under = [s for s in src if 0 < s[0] <= height]
    return (under[-1] if under else src[0])[1]


def download(url, dest, tries=6):
    """One polite GET (Wikimedia rate-limits bursts: wait as long as Retry-After says)."""
    import time
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=900) as src, open(dest, "wb") as f:
                while chunk := src.read(1 << 20):
                    f.write(chunk)
            return dest
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or i == tries - 1:
                raise
            time.sleep(float(e.headers.get("Retry-After") or 30) + 2)


CACHE = Path(__file__).resolve().parent.parent / "reel-data" / "story-docs" / "_cache"


def preview(title):
    """The smallest transcode, downloaded once into the cache (for contact sheets and picking moments)."""
    src = sources(title)
    url = src[0][1]
    return download(url, CACHE / (re.sub(r"[^\w.-]+", "_", title.removeprefix("File:"))[:90] + Path(urllib.parse.urlparse(url).path).suffix))


def sheet(title, out, every=20.0, start=0.0, end=None, cols=6):
    """A contact sheet of a Commons video: one frame every N seconds, timecode on each."""
    from PIL import Image, ImageDraw
    from .common import FFMPEG
    import subprocess, io
    local = preview(title)
    end = end or float(info(title).get("duration") or 60)
    frames, t = [], start
    while t < end:
        p = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{t:.1f}", "-i", str(local), "-frames:v", "1", "-vf", "scale=320:-2",
                            "-f", "image2", "-c:v", "mjpeg", "-"], capture_output=True, timeout=120)
        if p.stdout:
            im = Image.open(io.BytesIO(p.stdout)).convert("RGB")
            ImageDraw.Draw(im).text((6, 4), f"{int(t // 60)}:{int(t % 60):02d}", fill=(255, 230, 0))
            frames.append(im)
        t += every
    if not frames:
        raise SystemExit("no frames")
    w, h = frames[0].size
    rows = (len(frames) + cols - 1) // cols
    img = Image.new("RGB", (w * cols, h * rows))
    for i, f in enumerate(frames):
        img.paste(f.resize((w, h)), ((i % cols) * w, (i // cols) * h))
    img.save(out, quality=85)
    return out


def clip(story, title, name, t0, t1, beat=None, height=1080):
    """Cut [t0, t1] of a Commons video into the story folder (an h264 mp4), by remote seek; logged in credits.json."""
    from .common import FFMPEG
    import subprocess
    r = info(title)
    if not r["usable"]:
        raise SystemExit(f"{title}: licence '{r['license']}' isn't usable")
    dest = Path(story) / name
    url = stream(title, height)
    local = download(url, CACHE / (re.sub(r"[^\w.-]+", "_", title.removeprefix("File:"))[:80] + f"-{height}" + Path(urllib.parse.urlparse(url).path).suffix))
    subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t0:.2f}", "-i", str(local), "-t", f"{t1 - t0:.2f}",
                    "-an", "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", str(dest)], check=True)
    _credit(story, name, title, r, beat)
    return dest


def _credit(story, name, title, r, beat):
    cp = Path(story) / "credits.json"
    credits = json.loads(cp.read_text(encoding="utf-8")) if cp.exists() else []
    credits = [c for c in credits if c.get("file") != name] + [dict(
        file=name, beat=beat, title=title.removeprefix("File:"), commons_url=r["commons_url"], author=r["author"],
        license=r["license"], license_url=r["license_url"])]
    cp.write_text(json.dumps(credits, indent=1, ensure_ascii=False), encoding="utf-8")


def fetch(story, title, name, beat=None):
    story = Path(story)
    r = info(title)
    if not r["usable"]:
        raise SystemExit(f"{title}: licence '{r['license']}' isn't usable (public domain, CC0, CC BY, CC BY-SA only)")
    if (r["size"] or 0) > MAX_VIDEO:
        raise SystemExit(f"{title}: {r['size'] / 1e6:.0f} MB is too big")
    dest = story / name
    download(r["url"], dest)
    _credit(story, name, title, r, beat)
    return dest


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--kind", default="image", choices=["image", "video"])
    s.add_argument("-n", type=int, default=20)
    f = sub.add_parser("fetch")
    f.add_argument("story")
    f.add_argument("title")
    f.add_argument("--as", dest="name", required=True)
    f.add_argument("--beat", type=int)
    sh = sub.add_parser("sheet")
    sh.add_argument("title")
    sh.add_argument("out")
    sh.add_argument("--every", type=float, default=20)
    sh.add_argument("--start", type=float, default=0)
    sh.add_argument("--end", type=float)
    c = sub.add_parser("clip")
    c.add_argument("story")
    c.add_argument("title")
    c.add_argument("t0", type=float)
    c.add_argument("t1", type=float)
    c.add_argument("--as", dest="name", required=True)
    c.add_argument("--beat", type=int)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if a.cmd == "search":
        for r in search(a.query, a.kind, a.n):
            extra = f"{r['duration']:.0f}s" if r.get("duration") else f"{r['width']}x{r['height']}"
            print(f"{r['title']} | {extra} | {r['license']} | {r['date']} | {r['desc'][:110]}")
    elif a.cmd == "sheet":
        print(sheet(a.title, a.out, a.every, a.start, a.end))
    elif a.cmd == "clip":
        print(clip(a.story, a.title, a.name, a.t0, a.t1, a.beat))
    else:
        print(fetch(a.story, a.title, a.name, a.beat))


if __name__ == "__main__":
    main()
