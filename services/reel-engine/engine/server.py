"""Render worker HTTP API (stdlib only) — what the CMO Desk talks to.

  python -m engine.server --root /data/reels --port 8787   (env REEL_TOKEN enables bearer auth)

  GET  /health
  POST /upload?name=clip.mp4        raw body -> <root>/input/<name>          (drag & drop from the desk)
  POST /upload?name=x.mp3&kind=music raw body -> <root>/music/<name>         (your own songs)
  GET  /music                       bundled tracks + your songs, with where each one's drop is
  GET  /library                     footage, phone shots and app screens a request can build from (library.py)
  POST /jobs                        job JSON (see batch.py); clip paths relative to <root>/input
  GET  /jobs                        recent jobs
  GET  /jobs/<id>                   {status, progress, manifest}
  GET  /files/<id>/<file>           rendered mp4 / jpg / txt / thumbs/<clip>.jpg
  DELETE /jobs/<id>[/<variant>]     delete a finished batch, or one video of it, from disk
  GET  /jobs/<id>/<variant>/revise  what a revision can change: the video's brief, its batch's clips, music, a contact sheet
  POST /jobs/<id>/<variant>/revise  {"change": {...brief edits}} -> renders <variant>-r<N> into the batch (see revise.py)
  GET  /revisions/<rev>             {status, variant, error} of a revision
  POST /learn                       {"rows": [...perf], "hooks": [...], "formats": [...]} -> leaderboard + next matrix
  POST /autopilot                   {folder, budget_minutes, max_videos, hooks, styles, ...} -> overnight run (see autopilot.py)
  GET  /autopilot                   run status · POST /autopilot/stop
  POST /refs/analyze                {"path": "<file under input/>"} -> style reference rhythm (shots, cut rate, pacing)
  POST /clips/sheet                 {"path": "<file under input/>"} -> {jpg (base64), times, duration}: 8 numbered moments
"""
import argparse
import base64
import json
import mimetypes
import os
import queue
import re
import shutil
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .analyze import analyze_clip
from .autopilot import Autopilot
from .batch import run_job
from .common import MUSIC, ensure_dir, jdump
from .learn import leaderboard, next_matrix
from . import library, revise

SAFE = re.compile(r"^[\w.\- ]+$")
JOBS, Q = {}, queue.Queue()
REVS = {}  # revision id -> {status, job_id, of, variant | error}
PILOT = {"run": None, "thread": None}


def abs_music(m, root):
    """Sound library paths -> files: music/<name> (your songs), input/ref_<name> (a reference reel's audio)."""
    for pre, sub in (("music/", "music"), ("input/", "input")):
        if isinstance(m, str) and m.startswith(pre) and SAFE.match(m[len(pre):]):
            return str(Path(root) / sub / m[len(pre):])
    return m


def resolve_music(job, root):
    """'music/<name>' (a song you uploaded) -> absolute path inside <root>/music."""
    def fix(m):
        if isinstance(m, str) and m.startswith("music/") and SAFE.match(m[6:]):
            return str(Path(root) / "music" / m[6:])
        return m
    d = job.get("defaults", {})
    if "music" in d:
        d["music"] = fix(d["music"])
    for snd in job.get("direct", {}).get("sounds", []):
        snd["path"] = abs_music(snd.get("path"), root)
    for v in job.get("variants", []):  # a reference's own audio as the template song: input/<file>
        m = v.get("music")
        if isinstance(m, str) and m.startswith("input/") and SAFE.match(m[6:]):
            v["music"] = str(Path(root) / "input" / m[6:])
    if job.get("matrix", {}).get("music"):
        job["matrix"]["music"] = [fix(m) for m in job["matrix"]["music"]]
    for v in job.get("variants", []):
        if "music" in v:
            v["music"] = fix(v["music"])
        # one template per song: the sounds pulled from its reels, placed where each sits in the song, make one longer
        # stretch of it (the reel can run on instead of replaying); music_at is where this template's own reel starts
        parts = [(abs_music(p.get("audio"), root), p.get("at")) for p in v.pop("music_parts", None) or []]
        parts = [(f, float(a)) for f, a in parts if a is not None and f and Path(f).is_file()]
        if len(parts) > 1:
            try:
                from .songs import stitch
                song = stitch(parts, Path(root) / "input")
                base = min(a for _, a in parts)
                v["music"], v["music_start"] = song, round(float(v.pop("music_at", base)) - base, 3)
            except Exception as e:
                v.setdefault("warnings", []).append(f"song stitch failed: {e}")


def list_music(root):
    out = []
    for src, d in (("yours", Path(root) / "music"), ("bundled", MUSIC)):
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in (".mp3", ".m4a", ".wav", ".aac", ".ogg"):
                path = f"music/{f.name}" if src == "yours" else f"assets/music/{f.name}"
                out.append(dict(name=f.name, path=path, source=src))
    return out


def allowed_folder(folder):
    """Autopilot reads local folders: only those under AUTOPILOT_ROOTS (';'-separated) are allowed."""
    roots = [r for r in (os.environ.get("AUTOPILOT_ROOTS") or "").split(";") if r.strip()]
    try:
        f = Path(folder).resolve()
    except OSError:
        return False
    return f.is_dir() and any(str(f).lower().startswith(str(Path(r).resolve()).lower()) for r in roots)


def worker(root):
    while True:
        jid = Q.get()
        if jid in REVS:  # one revised video, rendered into its batch
            r = REVS[jid]
            r["status"] = "rendering"
            try:
                row, bm = revise.render_revision(root, r["job_id"], r.pop("brief"))
                r.update(status="done", variant=row)
                if r["job_id"] in JOBS:
                    JOBS[r["job_id"]]["manifest"] = bm
            except Exception as e:
                r.update(status="error", error=f"{e}"[:600])
            continue
        j = JOBS[jid]
        j.update(status="rendering", started=time.time())
        try:
            jp = Path(root) / "jobs" / f"{jid}.json"
            m = run_job(jp, Path(root) / "output" / jid)
            j.update(status="done", manifest=m)
        except Exception as e:
            j.update(status="error", error=f"{e}", trace=traceback.format_exc()[-1500:])
        j["finished"] = time.time()


class H(BaseHTTPRequestHandler):
    root = "."
    token = None

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, b"")

    def _auth(self):
        if self.token and self.headers.get("Authorization") != f"Bearer {self.token}":
            self._send(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        # Streamed uploads (e.g. Node fetch with a ReadableStream body) arrive chunked, without Content-Length.
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            parts = []
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline().strip():  # skip trailers up to the blank line
                        pass
                    break
                parts.append(self.rfile.read(size))
                self.rfile.readline()  # CRLF after each chunk
            return b"".join(parts)
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if not self._auth():
            return
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["health"]:
            return self._send(200, {"ok": True, "queued": Q.qsize()})
        if parts == ["music"]:
            return self._send(200, list_music(self.root))
        if len(parts) == 2 and parts[0] == "music" and SAFE.match(parts[1]) and parts[1].lower().endswith((".mp3", ".m4a", ".wav", ".aac", ".ogg")):
            for d in (Path(self.root) / "music", MUSIC):  # your songs first, then bundled tracks
                f = d / parts[1]
                if f.is_file():
                    return self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "audio/mpeg")
        if len(parts) == 2 and parts[0] == "input" and SAFE.match(parts[1]) and parts[1].startswith("ref_"):
            f = Path(self.root) / "input" / parts[1]  # reference videos only (template previews in the desk)
            if f.is_file():
                return self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "video/mp4")
        if parts == ["library"]:  # what a request can build from: footage, phone shots, app screens (+ a labelled sheet)
            its = [{k: v for k, v in it.items() if k != "path"} for it in library.items(self.root)]
            return self._send(200, dict(items=its, sheet=library.sheet(self.root) if its else None, knowledge=library.knowledge()))
        if parts == ["templates"]:
            from .edit_rules import RULES, public_templates
            return self._send(200, dict(templates=public_templates(), rules=RULES))
        if parts == ["autopilot"]:
            run = PILOT["run"]
            return self._send(200, run.state if run else {"status": "idle"})
        if parts == ["jobs"]:
            return self._send(200, [{k: v for k, v in j.items() if k != "manifest"} for j in JOBS.values()])
        if len(parts) == 2 and parts[0] == "jobs" and parts[1] in JOBS:
            return self._send(200, JOBS[parts[1]])
        if len(parts) == 4 and parts[0] == "jobs" and parts[3] == "revise" and all(SAFE.match(p) for p in parts[1:3]):
            i = revise.info(self.root, parts[1], parts[2])
            return self._send(200, i) if i else self._send(404, {"error": "no spec for this video (made before revisions)"})
        if len(parts) == 2 and parts[0] == "revisions" and parts[1] in REVS:
            return self._send(200, {k: v for k, v in REVS[parts[1]].items() if k != "brief"})
        if len(parts) >= 3 and parts[0] == "files" and parts[1] in JOBS:
            rel = "/".join(parts[2:])
            if ".." in rel:
                return self._send(400, {"error": "bad path"})
            f = Path(self.root) / "output" / parts[1] / rel
            if f.is_file():
                return self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        """DELETE /jobs/<id> removes a finished batch's folder; DELETE /jobs/<id>/<variant> removes one video's files."""
        if not self._auth():
            return
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) not in (2, 3) or parts[0] != "jobs" or not all(SAFE.match(p) and p not in (".", "..") for p in parts[1:]):
            return self._send(400, {"error": "DELETE /jobs/<id>[/<variant>]"})
        jid = parts[1]
        out = (Path(self.root) / "output").resolve()
        d = (out / jid).resolve()
        if d.parent != out:
            return self._send(400, {"error": "bad job id"})
        if JOBS.get(jid, {}).get("status") in ("queued", "rendering"):
            return self._send(409, {"error": "still rendering"})
        if len(parts) == 2:
            if d.is_dir():
                shutil.rmtree(d)
            JOBS.pop(jid, None)
            return self._send(200, {"ok": True, "deleted": jid})
        vid = parts[2]
        gone = []
        for f in (d.glob(f"{vid}.*") if d.is_dir() else []):
            f.unlink()
            gone.append(f.name)
        for f in (d.glob(f"{vid}_bare.*") if d.is_dir() else []):
            f.unlink()
            gone.append(f.name)
        mf = d / "manifest.json"
        if mf.is_file():  # keep the manifest in step so a restart doesn't bring the video back
            m = json.loads(mf.read_text(encoding="utf-8"))
            m["variants"] = [v for v in m.get("variants", []) if v.get("id") != vid]
            if m["variants"]:
                mf.write_text(json.dumps(m, indent=1))
                if jid in JOBS:
                    JOBS[jid]["manifest"] = m
            else:  # last video gone: the batch goes too
                shutil.rmtree(d)
                JOBS.pop(jid, None)
        return self._send(200, {"ok": True, "deleted": gone})

    def do_POST(self):
        if not self._auth():
            return
        u = urlparse(self.path)
        if u.path == "/upload":
            name = (parse_qs(u.query).get("name") or [""])[0]
            if not SAFE.match(name or ""):
                return self._send(400, {"error": "bad name"})
            kind = (parse_qs(u.query).get("kind") or ["clip"])[0]
            if kind == "music" and not name.lower().endswith((".mp3", ".m4a", ".wav", ".aac", ".ogg")):
                return self._send(400, {"error": "music must be mp3, m4a, wav, aac or ogg"})
            p = ensure_dir(Path(self.root) / ("music" if kind == "music" else "input")) / name
            p.write_bytes(self._body())
            return self._send(200, {"path": name, "bytes": p.stat().st_size})
        if u.path == "/jobs":
            job = json.loads(self._body() or b"{}")
            jid = job.get("job_id") or time.strftime("job-%Y%m%d-%H%M%S")
            if not SAFE.match(jid):
                return self._send(400, {"error": "bad job_id"})
            job["job_id"] = jid
            for c in job.get("clips", []):  # clips resolve inside <root>/input only
                if ".." in c["path"] or os.path.isabs(c["path"]):
                    return self._send(400, {"error": f"clip path must be relative: {c['path']}"})
                c["path"] = str(Path(self.root) / "input" / c["path"])
            resolve_music(job, self.root)
            job["library_root"] = str(self.root)  # library ids (footage, phone shots, app screens) resolve here
            jdump(job, ensure_dir(Path(self.root) / "jobs") / f"{jid}.json")
            JOBS[jid] = dict(job_id=jid, status="queued", queued=time.time())
            Q.put(jid)
            return self._send(202, JOBS[jid])
        if u.path == "/rehydrate":  # pick up batches written straight into output/ (the desk's /brag app ads)
            n = len(JOBS)
            rehydrate(self.root)
            return self._send(200, {"added": len(JOBS) - n})
        parts = [p for p in u.path.split("/") if p]
        if len(parts) == 4 and parts[0] == "jobs" and parts[3] == "revise" and all(SAFE.match(p) and p not in (".", "..") for p in parts[1:3]):
            if JOBS.get(parts[1], {}).get("status") != "done":
                return self._send(409, {"error": "batch isn't finished"})
            try:
                brief = revise.prepare(self.root, parts[1], parts[2], json.loads(self._body() or b"{}").get("change") or {})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            rid = f"{parts[1]}~{brief['id']}"
            if REVS.get(rid, {}).get("status") in ("queued", "rendering"):
                return self._send(409, {"error": "already rendering"})
            REVS[rid] = dict(status="queued", job_id=parts[1], of=parts[2], id=brief["id"], brief=brief)
            Q.put(rid)
            return self._send(202, {"rev": rid, "id": brief["id"], "status": "queued"})
        if u.path == "/autopilot":
            cfg = json.loads(self._body() or b"{}")
            if PILOT["thread"] and PILOT["thread"].is_alive():
                return self._send(409, {"error": "autopilot already running", "run_id": PILOT["run"].run_id})
            cfg["music"] = [abs_music(m, self.root) for m in cfg.get("music") or []]
            if not cfg["music"]:
                return self._send(400, {"error": "no trending sounds yet: drop a song or a reference reel first"})
            if not allowed_folder(cfg.get("folder", "")):
                return self._send(403, {"error": "folder not allowed; add its parent to AUTOPILOT_ROOTS"})

            def on_job(jid, manifest):  # finished stories appear in the desk right away
                t = time.time()
                JOBS[jid] = dict(job_id=jid, status="done", queued=t, finished=t, manifest=manifest)

            run = Autopilot(cfg, self.root, on_job=on_job)
            PILOT.update(run=run, thread=threading.Thread(target=run.run, daemon=True))
            PILOT["thread"].start()
            return self._send(202, {"run_id": run.run_id, "status": "starting"})
        if u.path == "/autopilot/stop":
            if PILOT["run"]:
                PILOT["run"].stop_flag.set()
            return self._send(200, {"ok": True})
        if u.path == "/refs/analyze":
            # Style reference: measure rhythm (shots, cut rate, opening hold) to match pacing in a batch.
            b = json.loads(self._body() or b"{}")
            rel = b.get("path", "")
            if not rel or ".." in rel or os.path.isabs(rel):
                return self._send(400, {"error": "path must be relative to input/"})
            f = Path(self.root) / "input" / rel
            if not f.is_file():
                return self._send(404, {"error": "not found"})
            meta = analyze_clip(str(f))
            prof = reference_profile(meta)
            if b.get("text"):  # references only: read the on-screen text of every shot (slow-ish, CPU OCR)
                from .reftext import shot_text
                prof["lines"] = shot_text(str(f), meta.get("shots") or [[0.0, meta.get("duration", 0)]])
            return self._send(200, prof)
        if u.path == "/refs/ocr":
            # A reel read from its link: on-screen text from frames sampled in memory (never stored)
            b = json.loads(self._body() or b"{}")
            frames = []
            for f in b.get("frames", [])[:60]:
                data = str(f.get("jpg", "")).split(",", 1)[-1]
                try:
                    frames.append((float(f.get("t", 0)), base64.b64decode(data)))
                except Exception:
                    continue
            from .reftext import frames_text
            return self._send(200, {"lines": frames_text(frames, b.get("shots") or [], turn=b.get("turn"))})
        if u.path == "/refs/song":
            # Is a reference's pulled sound a song another reference already uses? {match: {id, score, at} | null}
            b = json.loads(self._body() or b"{}")
            paths = [b.get("audio", "")] + [o.get("audio", "") for o in b.get("others", [])]
            if any(not p.startswith("input/") or not SAFE.match(p[6:]) for p in paths):
                return self._send(400, {"error": "audio paths must be input/<file>"})
            f = Path(self.root) / b["audio"]
            if not f.is_file():
                return self._send(404, {"error": "not found"})
            others = [dict(id=o.get("id"), path=str(Path(self.root) / o["audio"])) for o in b.get("others", [])
                      if (Path(self.root) / o["audio"]).is_file()]
            from .songs import song_match
            return self._send(200, {"match": song_match(str(f), others)})
        if u.path == "/clips/sheet":
            # A clip as 8 numbered moments on one image, for the desk to show Claude (what it is, which parts to use)
            b = json.loads(self._body() or b"{}")
            rel = b.get("path", "")
            if not rel or ".." in rel or os.path.isabs(rel):
                return self._send(400, {"error": "path must be relative to input/"})
            f = Path(self.root) / "input" / rel
            if not f.is_file():
                return self._send(404, {"error": "not found"})
            from .analyze import contact_sheet
            jpg, times, dur = contact_sheet(str(f))
            return self._send(200, {"jpg": base64.b64encode(jpg).decode(), "times": times, "duration": dur})
        if u.path == "/learn":
            b = json.loads(self._body() or b"{}")
            rows = b.get("rows", [])
            return self._send(200, dict(leaderboard=leaderboard(rows),
                                        next=next_matrix(rows, b.get("hooks", []), b.get("formats", ["montage"]))))
        self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


def reference_profile(meta):
    shots = meta.get("shots") or [[0.0, meta.get("duration", 0)]]
    lens = [round(b - a, 3) for a, b in shots]
    dur = meta.get("duration", 0) or sum(lens)
    avg = sum(lens) / len(lens) if lens else 0
    pacing = "fast" if avg < 1.2 else "medium" if avg < 2.4 else "cinematic"
    fmt = "oneshot" if len(lens) == 1 else "cinematic" if pacing == "cinematic" else "montage"
    return dict(duration=round(dur, 2), shots=len(lens), shot_lengths=lens, avg_shot=round(avg, 2),
                cuts_per_10s=round(10 * max(len(lens) - 1, 0) / dur, 2) if dur else 0,
                opening_hold=lens[0] if lens else 0, pacing=pacing, format=fmt,
                talking_likely=meta.get("talking_likely", False))


def rehydrate(root):
    """Finished jobs survive restarts: load <root>/output/<job>/manifest.json back into JOBS as done.
    Also picks up batches rendered with the CLI (`python -m engine run`) and copied into output/."""
    for mf in sorted((Path(root) / "output").glob("*/manifest.json")):
        jid = mf.parent.name
        if jid in JOBS or not SAFE.match(jid):
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        t = mf.stat().st_mtime
        JOBS[jid] = dict(job_id=jid, status="done", queued=t, finished=t, manifest=m)


def _yield_cpu():
    """Renders take every core they're given; run below normal priority so the desk (and the rest of the machine)
    stays responsive. Child processes (render workers, ffmpeg) inherit it."""
    try:
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL
        else:
            os.nice(5)
    except Exception:
        pass


def main():
    _yield_cpu()
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="reel-data")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    ensure_dir(a.root)
    # Absolute root: job clip paths are built from it, and the renderer resolves relative paths against
    # the job file's folder (root/jobs), which turned "reel-data/input/x.mov" into "reel-data/jobs/reel-data/...".
    a.root = str(Path(a.root).resolve())
    H.root, H.token = a.root, os.environ.get("REEL_TOKEN")
    rehydrate(a.root)
    threading.Thread(target=worker, args=(a.root,), daemon=True).start()
    print(f"reel engine on http://{a.host}:{a.port}  root={Path(a.root).resolve()}")
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
