"""Job runner: the contract between the CMO Desk and the engine.

job.json
{
  "job_id": "2026-10-25-oahu-01",
  "clips": [{"id": "c1", "path": "input/drone_lanikai.mp4", "star": true, "tags": ["drone"]}, ...],
  "defaults": {"duration": 15, "music": "assets/music/x.mp3", "caption": "...", "hashtags": [...]},
  "variants": [ {brief}, ... ],                 # explicit briefs (see plan.py), and/or
  "matrix": {"formats": ["montage", "oneshot"], "hooks": [{"id": "h1", "text": "..."}],
             "grades": ["teal_orange", "film"], "per_combo": 1, "max": 12},
  "make": [{"id": "ph1", "kind": "phone", "screen": "screen_t_food", "bg": "c1", "dur": 4}, ...],   # clips made first (phone.py)
  "library_root": "<reel-data>"                # where library ids (library.py) resolve
}
A variant with "format": "carousel" is a carousel post (carousel.py), not a video.
Outputs <out>/manifest.json + <id>.mp4, <id>_bare.mp4, <id>.jpg, <id>.txt per variant.
"""
import hashlib
import itertools
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from .analyze import analyze_clip, best_windows, look_sig, strip
from .common import FFMPEG, ROOT, ensure_dir, jdump, jload, run
from .plan import plan as make_plan
from .render import render
from . import library


def _key(path):
    st = os.stat(path)
    return hashlib.sha1(f"{Path(path).resolve()}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]


def analyze_all(clips, cache_dir):
    cache = ensure_dir(cache_dir)
    out = {}
    for c in clips:
        p = cache / f"{_key(c['path'])}.json"
        meta = jload(p) if p.exists() else None
        if meta is None:
            meta = analyze_clip(c["path"])
            jdump(meta, p)
        if "look" not in meta:  # older caches: add the look fingerprint the editor uses to spread scenes out
            w = best_windows(meta, 3.2, 1)
            meta["look"] = look_sig(c["path"], w[0]["start"] + w[0]["dur"] / 2 if w else 0.5)
            jdump(meta, p)
        out[c["id"]] = dict(path=c["path"], meta=meta, star=c.get("star", False), tags=c.get("tags", []),
                            read=c.get("read"))  # the desk's read of the clip: rating, scene, best moments
    return out


def thumbnails(clips, outdir):
    """Best-moment thumbnail per clip (for the desk's clip bin)."""
    d = ensure_dir(Path(outdir) / "thumbs")
    res = {}
    for cid, c in clips.items():
        w = best_windows(c["meta"], 1.0, 1)
        t = w[0]["start"] + 0.4 if w else 0
        f = d / f"{cid}.jpg"
        run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", c["path"], "-frames:v", "1",
             "-vf", "scale=360:-2", "-q:v", "4", str(f)])
        res[cid] = str(f)
    return res


def expand(job, clips):
    base = dict(job.get("defaults", {}))
    stars = [cid for cid, c in clips.items() if c["star"]]
    if stars and "hero" not in base:
        base["hero"] = stars[0]
    briefs = []
    for i, v in enumerate(job.get("variants", [])):
        b = {**base, **v}
        b.setdefault("id", f"v{i + 1:02d}")
        if b.get("template"):
            b.setdefault("opener", sum(1 for x in briefs if x.get("template")))  # templates in a batch open differently
        briefs.append(b)
    mx = job.get("matrix")
    if mx:
        hooks = mx.get("hooks") or [{"id": "h0", "text": base.get("hook", "")}]
        grades = mx.get("grades") or [None]
        musics = mx.get("music") or [base.get("music")]
        n = len(briefs)
        combos = list(itertools.product(mx.get("formats", ["montage"]), hooks))
        styles = base.pop("styles", None) or {}
        for k, (fmt, h) in enumerate(combos):
            # per-format style from the best-matching reference: pacing, look, which ref it came from
            st = {key: val for key, val in (styles.get(fmt) or {}).items() if val}
            for r in range(mx.get("per_combo", 1)):
                # a hook may carry per-format wording: {"text": "...", "by_format": {"pov": "..."}}
                text = (h.get("by_format") or {}).get(fmt, h.get("text"))
                b = {**base, **st, "format": fmt, "hook": text, "hook_id": h.get("id"),
                     "kicker": h.get("kicker", base.get("kicker")),
                     "grade": grades[(k + r) % len(grades)] or st.get("grade") or base.get("grade"),
                     "music": musics[(k + r) % len(musics)], "seed": k * 7 + r,
                     "id": f"{fmt}-{h.get('id', 'h')}-{r + 1}"}
                if h.get("lines"):
                    b["lines"] = h["lines"]
                briefs.append(b)
                n += 1
        if mx.get("max"):
            briefs = briefs[:mx["max"]]
    return briefs


def _render_one(plan, clips, outdir):
    try:
        return render(plan, clips, outdir)
    except Exception as e:  # one bad variant never sinks the batch
        return dict(id=plan["id"], error=f"{e.__class__.__name__}: {str(e)[:400]}")


def run_job(job_path, outdir, workers=None, plans_only=False):
    job = jload(job_path)
    base = Path(job_path).resolve().parent
    for c in job["clips"]:
        if not os.path.isabs(c["path"]):
            c["path"] = str(base / c["path"])
    def track(v):
        """Relative song paths: next to the job file if it's there, else the engine's own (assets/music/...)."""
        if not v or str(v).startswith("synth") or os.path.isabs(v):
            return v
        return str(base / v) if (base / v).exists() else str(ROOT / v)

    for k in ("music", "timing_track"):
        if job.get("defaults", {}).get(k):
            job["defaults"][k] = track(job["defaults"][k])
    if job.get("matrix", {}).get("music"):
        job["matrix"]["music"] = [track(m) for m in job["matrix"]["music"]]
    for v in job.get("variants", []):
        for k in ("music", "timing_track"):
            if v.get(k):
                v[k] = track(v[k])
    out = ensure_dir(outdir)
    lib_root = job.get("library_root")
    known = {c["id"]: c["path"] for c in job["clips"]}

    def resolve(cid):
        p = known.get(cid) or (library.resolve(lib_root, cid) if lib_root else None)
        if not p:
            raise ValueError(f"unknown clip {cid}")
        return p

    if job.get("make"):  # our phone over a clip, or a labelled placeholder: made first, then used like any clip
        from .phone import make as make_clip
        made = ensure_dir(out / "made")
        for m in job["make"]:
            p = make_clip(m, resolve, made)
            job["clips"].append(dict(id=m["id"], path=str(p), tags=["made", m["kind"]]))
            known[m["id"]] = str(p)
    for b in job.get("variants", []):  # library clips a brief names are added to the batch's clips
        for cid in [x["clip"] if isinstance(x, dict) else x for x in (b.get("sequence") or [])] + list(b.get("clips") or []):
            if cid not in known and lib_root and library.resolve(lib_root, cid):
                known[cid] = library.resolve(lib_root, cid)
                job["clips"].append(dict(id=cid, path=known[cid]))
    clips = analyze_all(job["clips"], out / "cache")
    thumbs = thumbnails(clips, out)
    plans = []
    briefs = expand(job, clips)
    if job.get("direct"):  # director: judge the clips, cast them into trend templates (see director.py)
        from .director import direct
        d = dict(job["direct"])
        sounds = [dict(s, path=track(s["path"])) for s in d.pop("sounds", [])]
        directed, report = direct({**d, "seed": d.get("seed", 7)}, clips, sounds)
        for b in directed:
            briefs.append({**job.get("defaults", {}), **b})
        jdump(report, out / "director.json")
    # each video's brief and the clips it can use, so one video can be changed and rendered again (revise.py)
    jdump(dict(clips=job["clips"], briefs=briefs), out / "spec.json")
    carousels = []
    for b in briefs:
        if b.get("format") == "carousel":
            from .carousel import render_carousel
            try:
                carousels.append(render_carousel(b, resolve, out))
            except Exception as e:
                carousels.append(dict(id=b.get("id"), error=f"carousel failed: {e.__class__.__name__}: {str(e)[:300]}"))
            continue
        try:
            p = make_plan(b, clips)
            p.setdefault("test_tags", {}).update({k: v for k, v in (b.get("test_tags") or {}).items()})
            plans.append(p)
        except Exception as e:
            plans.append(dict(id=b.get("id"), error=f"plan failed: {e}"))
    jdump(plans, out / "plans.json")
    manifest = dict(job_id=job.get("job_id"), clips={cid: dict(strip(c["meta"]), star=c["star"], tags=c["tags"],
                                                             thumb=thumbs.get(cid)) for cid, c in clips.items()},
                    variants=[])
    if plans_only:
        jdump(manifest, out / "manifest.json")
        return manifest
    good = [p for p in plans if "error" not in p]
    manifest["variants"] = [p for p in plans if "error" in p] + carousels
    workers = workers or max(1, min(len(good), (os.cpu_count() or 2) // 2))
    with ProcessPoolExecutor(max(1, workers)) as ex:
        futs = [ex.submit(_render_one, p, clips, str(out)) for p in good]
        for f in as_completed(futs):
            r = f.result()
            manifest["variants"].append(r)
            print(f"[render] {r.get('id')}: {'ERROR ' + r['error'] if 'error' in r else str(r['size_mb']) + ' MB'}")
    manifest["variants"].sort(key=lambda r: r.get("id", ""))
    jdump(manifest, out / "manifest.json")
    return manifest
