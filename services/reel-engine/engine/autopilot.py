"""Autopilot: a folder of footage -> as many good test batches as fit a time budget (e.g. overnight).

  python -m engine autopilot config.json --root reel-data        (or POST /autopilot on the worker)

config.json
{
  "folder": "C:/Users/me/Pictures/iphone",       # scanned recursively for .mov/.mp4/.m4v
  "budget_minutes": 480, "max_videos": 60,       # stops at whichever comes first
  "hooks": [{"id": "h12", "text": "...", "framework": "F13"}],     # best first (evidence-ranked)
  "styles": [{"format": "montage", "pacing": "fast", "look": "film", "label": "..."}],
  "hooks_per_story": 3, "min_clips": 3, "music": ["assets/music/...mp3", "synth:cinematic"],
  "hashtags": ["travel"], "endcard": "<brand>|<tagline>", "cta": "<call to action>",
  "places": "auto"                                 # name stories from GPS (built-in table) when possible
}

Loop: scan (real video only, Apple capture date + GPS) -> stories (same place, trip days within 4 days;
no GPS -> same day) -> rank (engine analysis, cached; near-duplicate shots dropped) -> plan one hook test
per story (one edit, several hooks, style from references) -> render -> next story, then a second pass
with the next style while budget remains. Resumable: <root>/autopilot/<run>/state.json. Never posts.
"""
import json
import math
import os
import re
import subprocess
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .batch import analyze_all
from .common import BRAND_NAME, BRAND_TAGLINE, BRAND_NICHE, BRAND_CTA, FFMPEG, ROOT, ensure_dir, jdump, jload

VIDEO_EXT = (".mov", ".mp4", ".m4v")

# Places footage may come from (name, lat, lon, radius km). Nearest match within radius wins. A generic starter list of
# big cities; add your own regions in knowledge/places.json as [["Name", lat, lon, radius_km], ...].
PLACES = [
    ("New York", 40.71, -74.01, 30), ("Los Angeles", 34.05, -118.24, 40), ("San Francisco", 37.77, -122.42, 30),
    ("Chicago", 41.88, -87.63, 30), ("Miami", 25.76, -80.19, 30), ("Toronto", 43.65, -79.38, 30),
    ("Mexico City", 19.43, -99.13, 35), ("London", 51.51, -0.13, 35), ("Paris", 48.86, 2.35, 30),
    ("Berlin", 52.52, 13.40, 30), ("Madrid", 40.42, -3.70, 30), ("Rome", 41.90, 12.50, 30),
    ("Amsterdam", 52.37, 4.90, 25), ("Istanbul", 41.01, 28.98, 40), ("Dubai", 25.20, 55.27, 40),
    ("Cairo", 30.04, 31.24, 35), ("Cape Town", -33.92, 18.42, 35), ("Mumbai", 19.08, 72.88, 40),
    ("Bangkok", 13.75, 100.50, 40), ("Singapore", 1.35, 103.82, 30), ("Tokyo", 35.68, 139.69, 60),
    ("Seoul", 37.57, 126.98, 40), ("Sydney", -33.87, 151.21, 40), ("Sao Paulo", -23.55, -46.63, 40),
]
try:
    _extra = jload(os.path.join(os.path.dirname(__file__), "..", "knowledge", "places.json"))
    PLACES += [tuple(x) for x in (_extra or []) if isinstance(x, (list, tuple)) and len(x) == 4]
except Exception:
    pass
PLACE_NAMES = sorted({p[0] for p in PLACES}, key=len, reverse=True)


def _km(a, b, c, d):
    p = math.pi / 180
    h = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def place_of(lat, lon):
    if lat is None:
        return None
    best = min(PLACES, key=lambda p: _km(lat, lon, p[1], p[2]) / p[3])
    return best[0] if _km(lat, lon, best[1], best[2]) <= best[3] else None


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ------------------------------------------------------------------ scan
def probe_tags(path):
    """Duration, codec, real capture date (Apple tag beats import-stamped creation_time) and GPS."""
    e = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="ignore").stderr
    v = re.search(r"Video: (h264|hevc|prores|vp9|av1)", e)
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", e)
    if not v or not d:
        return None
    wh = re.search(r"Video: .*?, (\d{2,5})x(\d{2,5})", e)
    cd = re.search(r"com\.apple\.quicktime\.creationdate\s*:\s*(\S+)", e) or re.search(r"creation_time\s*:\s*(\S+)", e)
    loc = re.search(r"ISO6709\s*:\s*([+-][\d.]+)([+-][\d.]+)", e) or re.search(r"location\s*:\s*([+-][\d.]+)([+-][\d.]+)", e)
    lat, lon = (float(loc[1]), float(loc[2])) if loc else (None, None)
    return dict(path=str(path), dur=int(d[1]) * 3600 + int(d[2]) * 60 + float(d[3]), date=(cd[1][:10] if cd else ""),
                lat=lat, lon=lon, w=int(wh[1]) if wh else 0, h=int(wh[2]) if wh else 0,
                screen="ScreenRecording" in e or "screen recording" in e.lower())


def scan(folder, log=print):
    files = [p for p in Path(folder).rglob("*") if p.suffix.lower() in VIDEO_EXT and p.is_file()]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as ex:
        rows = [r for r in ex.map(probe_tags, files) if r]
    keep = [r for r in rows if 2.0 <= r["dur"] <= 600 and not r["screen"] and min(r["w"], r["h"]) >= 480]
    log(f"scan: {len(files)} files, {len(rows)} videos, {len(keep)} usable")
    return keep


# ------------------------------------------------------------------ stories
def stories(clips):
    """Same place and trip (dates within 4 days) -> one story; no GPS -> same day."""
    for c in clips:
        c["place"] = place_of(c["lat"], c["lon"])
    key = lambda c: (c["place"] or "~", c["date"])
    out = []
    for c in sorted(clips, key=key):
        last = out[-1] if out else None
        same = last and last["place"] == c["place"] and (
            (c["place"] and _days(last["dates"][-1], c["date"]) <= 4) or (not c["place"] and last["dates"][-1] == c["date"]))
        if same:
            last["clips"].append(c)
            last["dates"].append(c["date"])
        else:
            out.append(dict(place=c["place"], dates=[c["date"]], clips=[c]))
    for s in out:
        s["id"] = f"{_slug(s['place'] or 'trip')}-{s['dates'][0] or 'undated'}"
        s["title"] = f"{s['place'] or 'Untitled trip'} · {s['dates'][0]}" + (f"→{s['dates'][-1]}" if s["dates"][-1] != s["dates"][0] else "")
    return out


def _days(a, b):
    try:
        return abs((time.mktime(time.strptime(b, "%Y-%m-%d")) - time.mktime(time.strptime(a, "%Y-%m-%d"))) / 86400)
    except ValueError:
        return 99


# ------------------------------------------------------------------ ranking
def dhash(path, t):
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1", "-vf", "scale=9:8,format=gray",
                        "-f", "rawvideo", "-"], capture_output=True)
    a = np.frombuffer(r.stdout, np.uint8)
    if a.size != 72:
        return None
    a = a.reshape(8, 9)
    return int("".join("1" if x else "0" for x in (a[:, 1:] > a[:, :-1]).flatten()), 2)


def rank(story, cache_dir, max_clips=12, log=print):
    """Analyse (cached), drop near-duplicates, keep the strongest clips; story score for ordering."""
    cl = [dict(id=f"c{i}", path=c["path"]) for i, c in enumerate(story["clips"])]
    try:
        an = analyze_all(cl, cache_dir)
    except Exception as e:  # one unreadable file shouldn't kill the story
        log(f"  analysis error in {story['id']}: {e}")
        an = {}
        for c in cl:
            try:
                an.update(analyze_all([c], cache_dir))
            except Exception:
                pass
    rows = []
    for c in cl:
        if c["id"] not in an:
            continue
        m = an[c["id"]]["meta"]
        best = max(m["samples"], key=lambda s: s["score"])
        rows.append(dict(path=c["path"], quality=m["quality"], bright=float(np.mean([s["bright"] for s in m["samples"]])),
                         talking=m.get("talking_likely", False), hash=dhash(c["path"], best["t"]), dur=m["duration"]))
    rows.sort(key=lambda r: -r["quality"])
    kept = []
    for r in rows:
        if r["talking"]:
            continue  # talking-to-camera goes to the talking format, not travel montages
        if r["hash"] is not None and any(k["hash"] is not None and bin(r["hash"] ^ k["hash"]).count("1") <= 6 for k in kept):
            continue
        kept.append(r)
    kept = kept[:max_clips]
    top = [k["quality"] for k in kept[:5]]
    story["ranked"] = kept
    story["score"] = round((sum(top) / len(top) if top else 0) * min(len(kept), 6) / 6, 4)
    story["night"] = bool(kept) and float(np.mean([k["bright"] for k in kept[:5]])) < 70
    return story


# ------------------------------------------------------------------ planning
NIGHT_WORDS = re.compile(r"\b(night|11pm|after dark|pm)\b", re.I)


def fill_hook(text, place, night):
    """Swap whatever city a library hook names for this story's place; skip hooks that don't fit."""
    t = text
    for name in PLACE_NAMES:
        t = re.sub(rf"\b{re.escape(name)}\b", "[city]", t)
    t = t.replace("[place]", "[city]")
    if "[city]" in t:
        if not place:
            return None
        t = t.replace("[city]", place)
    if NIGHT_WORDS.search(t) and not night:
        return None
    # A hook naming any other proper noun (a country, a venue: "Croatia's old walls") makes a claim the
    # footage can't back. Only the story's own place, the brand and sentence-initial words may be capitalised.
    allowed = {BRAND_NAME, "I", "POV", *(place or "").split()}
    for m in re.finditer(r"\b[A-Z][\w'’]*", t):
        start_of_sentence = m.start() == 0 or t[:m.start()].rstrip().endswith((".", "!", "?", ":"))
        word = re.split(r"['’]", m.group())[0]
        if not start_of_sentence and word not in allowed and not (place and place.startswith(word)):
            return None
    if len(t.split()) > 10:
        return None
    return t


def plan_job(story, cfg, style, pass_no):
    hooks = []
    for h in cfg.get("hooks", []):
        t = fill_hook(h["text"], story["place"], story["night"])
        if t and t not in [x["text"] for x in hooks]:
            hooks.append(dict(id=h.get("id", f"h{len(hooks)}"), text=t))
        if len(hooks) >= cfg.get("hooks_per_story", 3):
            break
    if not hooks:
        hooks = [dict(id="ap0", text=f"{story['place']}, unplanned." if story["place"] else "Plan less. Experience more.")]
    fmt = style.get("format", "montage")
    dur = {"oneshot": 9, "cinematic": 15, "list": 15}.get(fmt, 13)
    music = [m if m.startswith("synth") or os.path.isabs(m) else str(ROOT / m) for m in (cfg.get("music") or ["synth:cinematic"])]
    tags = list(cfg.get("hashtags", [BRAND_NICHE]))
    if story["place"]:
        tags = [_slug(story["place"]).replace("-", "")] + tags
    clips = [dict(id=f"s{i}", path=r["path"], star=(i == 0)) for i, r in enumerate(story["ranked"])]
    return {
        "job_id": f"auto-{story['id']}-p{pass_no}"[:80],
        "clips": clips,
        "defaults": {"duration": dur, "pacing": style.get("pacing", "fast"), "grade": style.get("look"),
                     "music": music[(pass_no + sum(map(ord, story["id"]))) % len(music)], "endcard": cfg.get("endcard", f"{BRAND_NAME}|{BRAND_TAGLINE}"),
                     "cta": cfg.get("cta", "Free on iPhone"), "hashtags": tags[:5], "hero": "s0",
                     "caption": f"{story['place'] or 'Somewhere'}, unplanned.",
                     "autopilot": {"story": story["id"], "title": story["title"], "style": style.get("label"), "pass": pass_no}},
        "matrix": {"formats": [fmt], "hooks": hooks, "grades": [style["look"]] if style.get("look") else None,
                   "max": len(hooks)},
    }


# ------------------------------------------------------------------ run
class Autopilot:
    def __init__(self, cfg, root, on_job=None, log=print):
        self.cfg, self.root, self.on_job, self.log = cfg, Path(root), on_job or (lambda *_: None), log
        self.run_id = cfg.get("run_id") or time.strftime("ap-%Y%m%d-%H%M%S")
        self.dir = ensure_dir(self.root / "autopilot" / self.run_id)
        self.state_path = self.dir / "state.json"
        self.state = jload(self.state_path) if self.state_path.exists() else dict(
            run_id=self.run_id, cfg=cfg, status="starting", started=time.time(), videos=0, done=[], stories=[], log=[])
        self.stop_flag = threading.Event()

    def _save(self):
        jdump(self.state, self.state_path)

    def _say(self, msg):
        self.log(msg)
        self.state["log"] = (self.state.get("log", []) + [f"{time.strftime('%H:%M:%S')} {msg}"])[-200:]
        self._save()

    def budget_left(self):
        deadline = self.state["started"] + 60 * float(self.cfg.get("budget_minutes", 480))
        return time.time() < deadline and self.state["videos"] < int(self.cfg.get("max_videos", 60)) and not self.stop_flag.is_set()

    def run(self):
        try:
            self.state["status"] = "scanning"
            self._say(f"scanning {self.cfg['folder']}")
            clips = scan(self.cfg["folder"], self._say)
            st = [s for s in stories(clips) if len(s["clips"]) >= int(self.cfg.get("min_clips", 3))]
            # Rank biggest stories first (cheap proxy before analysis); analysis happens lazily per story.
            st.sort(key=lambda s: -len(s["clips"]))
            self.state["stories"] = [dict(id=s["id"], title=s["title"], clips=len(s["clips"]), status="queued") for s in st]
            self.state["status"] = "rendering"
            self._say(f"{len(st)} stories with >={self.cfg.get('min_clips', 3)} clips")
            styles = self.cfg.get("styles") or [dict(format="montage", pacing="fast", look="teal_orange", label="default")]
            cache = ensure_dir(self.root / "cache")
            for pass_no, style in enumerate(styles):
                for s in st:
                    if not self.budget_left():
                        break
                    key = f"{s['id']}#{pass_no}"
                    if key in self.state["done"]:
                        continue
                    row = next(x for x in self.state["stories"] if x["id"] == s["id"])
                    if "ranked" not in s:
                        row["status"] = "analysing"
                        self._save()
                        rank(s, cache, log=self._say)
                        row.update(score=s["score"], kept=len(s["ranked"]), night=s["night"])
                    if len(s["ranked"]) < int(self.cfg.get("min_clips", 3)):
                        row["status"] = "skipped (too few distinct good shots)"
                        self.state["done"].append(key)
                        continue
                    job = plan_job(s, self.cfg, style, pass_no)
                    row["status"] = f"rendering pass {pass_no + 1}"
                    self._say(f"render {job['job_id']}: {len(job['matrix']['hooks'])} hooks, {style.get('label') or style.get('format')}")
                    jp = ensure_dir(self.root / "jobs") / f"{job['job_id']}.json"
                    jdump(job, jp)
                    from .batch import run_job
                    m = run_job(jp, self.root / "output" / job["job_id"])
                    ok = [v for v in m["variants"] if "error" not in v]
                    self.state["videos"] += len(ok)
                    self.state["done"].append(key)
                    row["status"] = f"done ({len(ok)} videos)"
                    row.setdefault("jobs", []).append(job["job_id"])
                    self.on_job(job["job_id"], m)
                    self._say(f"done {job['job_id']}: {len(ok)} ok, {len(m['variants']) - len(ok)} errors")
            self.state["status"] = "stopped" if self.stop_flag.is_set() else "finished"
        except Exception as e:  # report, don't crash the worker
            self.state["status"] = "error"
            self._say(f"error: {e}")
        self.state["finished"] = time.time()
        self._say(f"{self.state['status']}: {self.state['videos']} videos")
        return self.state
