"""Learning loop: posted-video metrics -> which hooks / formats / looks win -> next batch's matrix.

perf.json rows (one per posted variant per platform), filled by the CMO Desk:
  {"variant_id": "montage-h2-1", "platform": "ig"|"tiktok", "views": 1234, "avg_watch_s": 4.1,
   "duration_s": 12, "likes": 50, "shares": 9, "saves": 14, "comments": 3, "follows": 2,
   "tags": {"format": "montage", "hook_id": "h2", "pacing": "fast", "grade": "teal_orange", "music": "..."}}

Score = what the algorithms reward: retention first, then shares/saves (send-to-friend signals),
normalised per platform so IG and TikTok numbers can be pooled.
"""
import math
from collections import defaultdict


def variant_score(r):
    v = max(r.get("views", 0), 1)
    ret = min(r.get("avg_watch_s", 0) / max(r.get("duration_s", 1), 1), 1.5)       # watch-through
    send = (r.get("shares", 0) * 2 + r.get("saves", 0) * 1.5) / v * 100               # per 100 views
    eng = (r.get("likes", 0) + 2 * r.get("comments", 0) + 3 * r.get("follows", 0)) / v * 100
    reach = math.log10(v)
    return round(0.45 * ret * 10 + 0.25 * send + 0.15 * eng + 0.15 * reach, 3)


def leaderboard(rows, dims=("template", "vibe", "opening", "hook", "hook_id", "format", "pacing", "grade", "music")):
    """Per-dimension ranking with shrinkage toward the mean so one lucky post can't dominate."""
    if not rows:
        return {}
    by_pf = defaultdict(list)
    for r in rows:
        by_pf[r.get("platform", "ig")].append(r)
    z = []
    for pf, rs in by_pf.items():  # z-score inside each platform
        s = [variant_score(r) for r in rs]
        mu = sum(s) / len(s)
        sd = (sum((x - mu) ** 2 for x in s) / max(len(s) - 1, 1)) ** 0.5 or 1
        z += [(r, (x - mu) / sd) for r, x in zip(rs, s)]
    out = {}
    k = 3.0  # prior strength in "posts"
    for d in dims:
        acc = defaultdict(list)
        for r, zz in z:
            val = (r.get("tags") or {}).get(d)
            if val:
                acc[val].append(zz)
        out[d] = sorted(
            [dict(value=val, n=len(xs), mean_z=round(sum(xs) / len(xs), 3),
                  shrunk=round(sum(xs) / (len(xs) + k), 3)) for val, xs in acc.items()],
            key=lambda x: -x["shrunk"])
    return out


def next_matrix(rows, hooks_pool, formats_pool, explore=0.3, size=12):
    """Exploit the top hooks/formats, keep `explore` share of slots for untested ideas."""
    lb = leaderboard(rows)
    tested_h = {x["value"] for x in lb.get("hook_id", [])}
    top_h = [x["value"] for x in lb.get("hook_id", []) if x["shrunk"] > 0][:3]
    top_f = [x["value"] for x in lb.get("format", []) if x["shrunk"] > 0][:2] or formats_pool[:2]
    new_h = [h["id"] for h in hooks_pool if h["id"] not in tested_h]
    n_explore = max(1, int(size * explore))
    pick_h = top_h + new_h[:n_explore]
    pick_f = top_f + [f for f in formats_pool if f not in top_f][:1]
    return dict(formats=pick_f, hooks=[h for h in hooks_pool if h["id"] in pick_h],
                rationale=dict(winning_hooks=top_h, winning_formats=top_f, exploring=new_h[:n_explore]),
                max=size)
