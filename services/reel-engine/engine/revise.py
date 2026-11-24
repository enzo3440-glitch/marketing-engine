"""Revisions: one finished video, changed on request and rendered again beside the original.

Every batch keeps spec.json (its clips and each video's brief, written by run_job). A revision is a new brief for one
video. It may only use clips already in the batch and music the engine has, renders as <video>-r<N> into the same
batch folder, and its brief joins spec.json so the revision can be revised again.
"""
import base64
import re
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .analyze import contact_sheet
from .batch import run_job
from .common import FFMPEG, MUSIC, ensure_dir, jdump, jload

# brief keys a revision may set (the rest of the original brief is kept as it was)
EDITABLE = {"hook", "hook_pos", "lines", "sequence", "music", "music_start", "duration", "endcard", "cta", "caption",
            "kicker", "pacing", "grade", "transitions", "transitions_style", "sfx", "sfx_gain", "build_drop", "drop_shot",
            "poster_t", "clips", "hook_style", "hook_anim", "line_style", "line_pos", "line_anim", "endcard_hold"}


def load_spec(root, jid):
    f = Path(root) / "output" / jid / "spec.json"
    return jload(f) if f.is_file() else None


def _brief(spec, vid):
    return next((b for b in spec["briefs"] if b.get("id") == vid), None)


def _kind(cid):
    return "app screen (phone)" if cid.startswith("ph_") else "placeholder" if cid.startswith("PL_") else "footage"


def music_names(root):
    return sorted({p.name for d in (Path(root) / "music", MUSIC) if d.is_dir() for p in d.iterdir()
                   if p.suffix.lower() in (".mp3", ".m4a", ".wav", ".aac", ".ogg")})


def clip_sheet(root, jid, spec, w=180, h=320):
    """Every clip the batch can use, one frame each from its middle, labelled with its id (cached as clips.jpg)."""
    f = Path(root) / "output" / jid / "clips.jpg"
    if f.is_file() and f.stat().st_mtime >= (Path(root) / "output" / jid / "spec.json").stat().st_mtime:
        return f.read_bytes()
    tiles = []
    for c in spec["clips"]:
        dur = subprocess.run([FFMPEG, "-i", c["path"]], stderr=subprocess.PIPE, text=True, errors="ignore").stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", dur)
        t = (int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])) / 2 if m else 0
        b = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", c["path"], "-frames:v", "1", "-vf",
                            f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
                            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE).stdout
        img = np.frombuffer(b[:w * h * 3], np.uint8).reshape(h, w, 3).copy() if len(b) >= w * h * 3 else np.zeros((h, w, 3), np.uint8)
        cv2.rectangle(img, (0, h - 26), (w, h), (0, 0, 0), -1)
        cv2.putText(img, c["id"][:20], (5, h - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(img)
    cols = 8
    while len(tiles) % cols:
        tiles.append(np.zeros((h, w, 3), np.uint8))
    grid = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
    jpg = cv2.imencode(".jpg", grid, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
    f.write_bytes(jpg)
    return jpg


def info(root, jid, vid):
    """What a reviser needs: the brief, the clips it may use, the render's timing and a contact sheet of it."""
    spec = load_spec(root, jid)
    if not spec:
        return None
    b = _brief(spec, vid)
    if b is None:
        return None
    m = jload(Path(root) / "output" / jid / "manifest.json")
    v = next((x for x in m.get("variants", []) if x.get("id") == vid), {})
    clips = [dict(id=c["id"], kind=_kind(c["id"]), duration=round(float((m.get("clips", {}).get(c["id"]) or {}).get("duration") or 0), 2),
                  **({"subject": c["read"].get("subject")} if isinstance(c.get("read"), dict) else {}))
             for c in spec["clips"]]
    sheet = None
    f = Path(root) / "output" / jid / f"{vid}.mp4"
    if f.is_file():
        jpg, times, _ = contact_sheet(str(f), n=12)
        sheet = dict(jpg=base64.b64encode(jpg).decode(), times=times)
    brief = {k: (Path(x).name if k == "music" and x else x) for k, x in b.items() if not k.startswith("_")}
    return dict(brief=brief, clips=clips, music=music_names(root), cuts=v.get("cuts"), duration=v.get("duration"),
                warnings=v.get("warnings", []), sheet=sheet, clip_sheet=base64.b64encode(clip_sheet(root, jid, spec)).decode(),
                editable=sorted(EDITABLE))


def next_id(spec, vid):
    stem = re.sub(r"-r\d+$", "", vid)
    n = [int(x.group(1)) for b in spec["briefs"] if (x := re.fullmatch(re.escape(stem) + r"-r(\d+)", b.get("id", "")))]
    return f"{stem}-r{max(n, default=1) + 1}"


def prepare(root, jid, vid, change):
    """The new brief: the original with the requested edits, checked. Raises ValueError on anything not allowed."""
    spec = load_spec(root, jid)
    if not spec:
        raise ValueError("this batch was made before revisions (no spec.json)")
    b = _brief(spec, vid)
    if b is None:
        raise ValueError(f"no video {vid} in {jid}")
    bad = sorted(set(change) - EDITABLE)
    if bad:
        raise ValueError(f"can't change {', '.join(bad)}")
    have = {c["id"] for c in spec["clips"]}
    seq = change.get("sequence", b.get("sequence")) or []
    used = {(x["clip"] if isinstance(x, dict) else x) for x in seq}
    if used - have:
        raise ValueError(f"clips not in this batch: {', '.join(sorted(used - have))}")
    new = {**b, **change, "id": next_id(spec, vid), "revision_of": vid}
    if "sequence" in change:  # the clips list follows the sequence
        new["clips"] = sorted(used)
    if "music" in change and change["music"]:
        name = Path(str(change["music"])).name
        hit = next((d / name for d in (Path(root) / "music", MUSIC) if (d / name).is_file()), None)
        if not hit:
            raise ValueError(f"no music called {name}")
        new["music"] = str(hit)
        for k in [k for k in new if k.startswith("_")]:  # values worked out from the old song are worked out again
            new.pop(k)
    return new


def render_revision(root, jid, brief):
    """Render one revised brief and add it to the batch (files, manifest.json, spec.json). Returns its manifest row."""
    root = Path(root)
    out = root / "output" / jid
    spec = load_spec(root, jid)
    work = ensure_dir(root / "revisions" / jid)  # analysis cache stays here, so later revisions of the batch start fast
    used = set(brief.get("clips") or []) | {(x["clip"] if isinstance(x, dict) else x) for x in brief.get("sequence") or []}
    job = dict(job_id=jid, clips=[c for c in spec["clips"] if c["id"] in used], defaults={}, variants=[brief])
    jdump(job, work / "job.json")
    m = run_job(work / "job.json", work)
    row = next((v for v in m["variants"] if v.get("id") == brief["id"]), None)
    if not row or "error" in row:
        raise RuntimeError((row or {}).get("error", "render failed"))
    for f in list(work.glob(f"{brief['id']}.*")) + list(work.glob(f"{brief['id']}_bare.*")):
        shutil.move(str(f), str(out / f.name))
    for k in ("file", "bare", "poster", "caption_file"):
        if row.get(k):
            row[k] = str(out / Path(row[k]).name)
    row["tags"] = {**(row.get("tags") or {}), "revision_of": brief["revision_of"]}
    mf = out / "manifest.json"
    bm = jload(mf)
    bm["variants"] = sorted([v for v in bm["variants"] if v.get("id") != row["id"]] + [row], key=lambda v: v.get("id", ""))
    bm.setdefault("clips", {}).update({k: v for k, v in m.get("clips", {}).items() if k not in bm["clips"]})
    jdump(bm, mf)
    spec["briefs"].append(brief)
    jdump(spec, out / "spec.json")
    return row, bm
