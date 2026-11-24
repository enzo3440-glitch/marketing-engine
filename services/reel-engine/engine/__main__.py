"""CLI:
  python -m engine analyze clip1.mp4 clip2.mp4 [-o analysis.json]
  python -m engine run job.json -o out/ [--workers 4] [--plans-only]
  python -m engine beats track.mp3
  python -m engine autopilot config.json [--root reel-data]
"""
import argparse
import json

from .analyze import analyze_clip, best_windows, strip
from .batch import run_job
from .beats import analyze_track, find_drop
from .common import jdump


def main():
    ap = argparse.ArgumentParser(prog="engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("clips", nargs="+")
    a.add_argument("-o", "--out")
    r = sub.add_parser("run")
    r.add_argument("job")
    r.add_argument("-o", "--out", required=True)
    r.add_argument("--workers", type=int)
    r.add_argument("--plans-only", action="store_true")
    b = sub.add_parser("beats")
    b.add_argument("track")
    ap_ = sub.add_parser("autopilot")
    ap_.add_argument("config")
    ap_.add_argument("--root", default="reel-data")
    args = ap.parse_args()

    if args.cmd == "analyze":
        res = {}
        for c in args.clips:
            m = analyze_clip(c)
            res[c] = dict(strip(m), best=best_windows(m, 2.0, 4))
        print(json.dumps({k: dict(quality=v["quality"], duration=v["duration"], best=v["best"][:2],
                                  talking_likely=v["talking_likely"]) for k, v in res.items()}, indent=1))
        if args.out:
            jdump(res, args.out)
    elif args.cmd == "run":
        m = run_job(args.job, args.out, args.workers, args.plans_only)
        ok = [v for v in m["variants"] if "error" not in v]
        print(f"done: {len(ok)}/{len(m['variants'])} variants -> {args.out}/manifest.json")
    elif args.cmd == "autopilot":
        from .autopilot import Autopilot
        st = Autopilot(json.load(open(args.config)), args.root).run()
        print(f"{st['status']}: {st['videos']} videos, state in {args.root}/autopilot/{st['run_id']}/state.json")
    elif args.cmd == "beats":
        g = analyze_track(args.track, 0, 60)
        print(json.dumps(dict(tempo=g["tempo"], first_beats=g["beats"][:16], drop=find_drop(args.track)), indent=1))


if __name__ == "__main__":
    main()
