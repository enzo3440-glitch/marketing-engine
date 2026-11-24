"""Planner: a short creative brief + clip analysis -> a fully timed render plan.

The brief is what the CMO Desk (or Claude) writes. Everything timing-related — which shot,
where it starts, speed, zoom, transition, when each line appears — is decided here.
"""
import re
import zlib

import numpy as np

from . import talk
from .analyze import best_windows, sig_dist
from .beats import analyze_track, beat_times, cut_hits, hit_peaks, cut_lag, drop_time, find_drop, hit_rate, snap_cuts
from .text import read_time
from .common import BRAND_NAME, BRAND_TAGLINE

BPM = {"fast": 124, "medium": 104, "cinematic": 84}
# cut lengths in beats, cycled. Hook shot is handled separately.
PATTERN = {"fast": [2, 1, 1, 2, 1, 1, 2, 2, 1, 1],
           "medium": [2, 2, 1, 1, 2, 2, 2, 1, 1, 2],
           "cinematic": [4, 4, 2, 4, 2, 2, 4]}
TRANS = {"fast": ["flash", "cut", "whip", "cut", "zoom", "cut", "flash", "whip"],
         "medium": ["cut", "whip", "cut", "flash", "cut", "zoom"],
         "cinematic": ["cut", "dip", "cut", "cut", "zoom", "cut"],
         # Delicate, reference-style editing: mostly straight cuts on the beat, an occasional soft dip.
         "clean": ["cut", "cut", "soft", "cut", "cut", "cut", "soft", "cut"],
         # Clean with a few creative reveals (template "fx": "playful"): iris mask, tile squares, soft wipe.
         "playful": ["cut", "mask", "cut", "cut", "squares", "cut", "wipe", "cut"]}
GRADE_BY_PACE = {"fast": "teal_orange", "medium": "tropical", "cinematic": "film"}


def beat_grid(brief, duration):
    """(beats, strong, music_start, bpm). Music start skips intros so the reel opens on energy."""
    src = brief.get("timing_track") or (brief.get("music") if brief.get("music") and
                                         not str(brief.get("music")).startswith("synth") else None)
    pace = brief.get("pacing", "medium")
    if src and brief.get("build_drop"):
        # quiet build-up, then the song's drop lands exactly on beat `drop_beats` (the reveal shot)
        drop = find_drop(src, window=(8, 90))
        tempo = analyze_track(src, max(0.0, drop - 20), 30)["tempo"]
        n = brief.get("drop_beats", 8)
        start = max(0.0, round(drop - n * 60.0 / tempo, 3))

        def grid(st):
            g = analyze_track(src, st, duration + 4)
            bs = [b for b in g["beats"] if b >= 0]
            return ([0.0] + bs if bs and bs[0] > 0.05 else bs), g

        beats, g = grid(start)
        if len(beats) > n:
            # slide the song by whole beats so the beat nearest the drop is the n-th cut
            m = min(range(len(beats)), key=lambda i: abs(beats[i] - (drop - start)))
            if m != n and 0 <= start + beats[m] - beats[n]:
                start = round(start + beats[m] - beats[n], 3)
                beats, g = grid(start)
        brief["_drop_at"] = beats[n] if len(beats) > n else round(drop - start, 3)
        return beats, g["strong"], start, g["tempo"]
    if src:
        start = brief.get("music_start")
        if start in (None, "auto"):
            start = find_drop(src) if brief.get("open_on_drop") else 0.0
        g = analyze_track(src, start, duration + 4)
        beats = [b for b in g["beats"] if b >= 0]
        if beats and beats[0] > 0.05:
            beats = [0.0] + beats
        return beats, g["strong"], start, g["tempo"]
    bpm = brief.get("bpm") or BPM.get(pace, 104)
    step = 60.0 / bpm
    beats = list(np.round(np.arange(0, duration + 4, step), 3))
    return beats, beats[::4], 0.0, bpm


def _snap(beats, t):
    return min(beats, key=lambda b: abs(b - t)) if beats else t


def _shot_number(path):
    """Camera file number (IMG_5263.MOV -> 5263): clips a few numbers apart were shot in the same place."""
    m = re.search(r"(\d{3,})\D*$", str(path).replace("\\", "/").rsplit("/", 1)[-1])
    return int(m.group(1)) if m else None


def _shape(meta):
    w, h = meta.get("width") or 1, meta.get("height") or 1
    return "wide" if w / h > 1.1 else "tall" if w / h < 0.9 else "square"


def _ref_fx(f, k, dur):
    """A reference shot's transition in and camera move, as segment fields. What can't read on screen is noise and
    dropped: a "dissolve" into a flash cut (under 0.6s) is motion blur on a hard cut, and a move on a shot under 0.5s
    or under 3% is the reader's jitter."""
    if not f:
        return {}
    out = {}
    into = f.get("into")
    if into == "dissolve" and (dur < 0.6 or (f.get("into_dur") or 0) < 0.15):
        into = "cut"
    if k and into in ("dissolve", "flash", "whip"):
        out["transition"] = into
        if into == "dissolve":  # as long as the reference's, but never more than half the shot
            out["tr_frames"] = int(round(min(max(f.get("into_dur") or 0.27, 0.13), dur * 0.5) * 30))
    if dur < 0.5:
        return out
    z = float(f.get("zoom") or 1)
    if abs(z - 1) >= 0.03:
        z = min(max(z, 0.85), 1.18)
        out["zoom"] = [1.0, round(z, 3)] if z > 1 else [round(1 / z, 3), 1.0]
    p = float(f.get("pan") or 0)
    if abs(p) >= 0.04:  # sideways drift across the shot, in output pixels at the end
        out["pan"] = round(p, 3)
    return out


def _flex(slots, fxs, drop_k, music, mstart, clips, ids):
    """A template's cut, flexed to the song and the shots. Music: every cut lands on a real hit or on the song's
    eighth-note grid, and nothing shorter than an eighth note survives unless both its cuts are hard hits (a
    deliberate chop), and no lone flash between two holds. Shots: after the drop, neighbouring short shots join into half or whole notes (2-4 beats, cut
    where the music hits weakest) until each epic scene in the footage has a hold to breathe in; and when there are
    fewer quick shots than flashes, flashes join too. Up to the drop the reference's chop stays as it is."""
    total = float(sum(slots))
    bt, period = beat_times(music, mstart, total + 2)
    grid = np.array(sorted(set(bt) | {round((a + b) / 2, 3) for a, b in zip(bt, bt[1:])}))
    cuts = [float(c) for c in np.cumsum(slots)[:-1]]
    hits = cut_hits(music, cuts, mstart)
    drop_t = cuts[drop_k - 1] if drop_k else None
    # 1. on time
    keep = []
    for c, h in zip(cuts, hits):
        g = float(grid[np.argmin(np.abs(grid - c))]) if len(grid) else c
        if h >= 0.5 or c == drop_t:
            keep.append((c, h))
        elif abs(g - c) <= 0.05 and h >= 0.3:
            keep.append((g, h))
    # nothing under an eighth note, unless the music hits hard on both sides
    eighth, out = period / 2 * 0.9, []
    for c, h in keep:
        prev = out[-1] if out else (0.0, 9.0)
        if c - prev[0] < eighth and not (h >= 1.0 and prev[1] >= 1.0) and c != drop_t:
            continue
        out.append((c, h))
    cuts = [c for c, _ in out]
    hit = dict(out)

    # 2. what the footage has: epic scenes that want a hold, and shots that read in a flash
    holdy, quick = set(), set()
    for cid in ids:
        r = clips[cid].get("read") or {}
        if r.get("skip") or r.get("rating") is None:
            continue
        sc = str(r.get("scene") or cid).strip().lower()
        if float(r["rating"]) >= 0.7 and r.get("best_for") in ("hold", "both", None):
            holdy.add(sc)
        if float(r["rating"]) >= 0.35 and r.get("best_for") in ("quick", "both"):
            quick.add(sc)

    def lens(cs):
        b = [0.0] + cs + [total]
        return [b[i + 1] - b[i] for i in range(len(b) - 1)]

    def merge_once(want):
        """Drop the weakest cut after the drop whose two shots join into `want` (a hold or a fewer-flashes merge)."""
        L, best = lens(cuts), None
        for i, c in enumerate(cuts):
            if drop_t is not None and c <= drop_t + 0.01:
                continue
            joined = L[i] + L[i + 1]
            if want == "hold" and not (max(L[i], L[i + 1]) < 2 * period * 0.95 and joined <= 4 * period * 1.1):
                continue
            if want == "flash" and not (min(L[i], L[i + 1]) < period * 0.95 and joined <= 2 * period * 1.1):
                continue
            if best is None or hit.get(c, 0) < hit.get(cuts[best], 0):
                best = i
        if best is None:
            return False
        cuts.pop(best)
        return True

    after = lambda: [x for i, x in enumerate(lens(cuts)) if drop_t is None or sum(lens(cuts)[:i]) >= drop_t - 0.01]
    while sum(1 for x in after() if x >= 2 * period * 0.95) < len(holdy) and merge_once("hold"):
        pass
    while sum(1 for x in after() if x < period * 0.95) > 1.5 * max(len(quick), 1) and merge_once("flash"):
        pass

    # a flash belongs in a run of quick cuts: one lone beat-long shot between two holds reads as a stutter (a spark
    # flicking past between two big views), so it folds into the hold before it
    while True:
        L = lens(cuts)
        lone = [i for i in range(1, len(L) - 1) if L[i] < period * 1.5 and L[i - 1] >= 1.8 * period
                and L[i + 1] >= 1.8 * period and (drop_t is None or abs(cuts[i - 1] - drop_t) > 0.01)]
        if not lone:
            break
        cuts.pop(lone[0] - 1)
    # the shots' entrances follow the cuts they kept
    old = [float(c) for c in np.cumsum(slots)[:-1]]
    starts = [0.0] + cuts
    nfx = [fxs[min(range(len(old) + 1), key=lambda j: abs(([0.0] + old)[j] - s))] if fxs else None for s in starts]
    return [round(x, 3) for x in lens(cuts)], nfx


def _drop_offbeat(slots, fxs, hits):
    """Cuts that land between beats (hit < 0.5), or quick stutters (shot under 0.35s) on a soft hit (< 0.8), are
    removed: the shot before simply holds on. When unsure, fewer cuts look better than a flash off the music."""
    out, ofx = [slots[0]], [fxs[0] if fxs else None]
    for k in range(1, len(slots)):
        h = hits[k - 1] if k - 1 < len(hits) else 1.0
        short = min(slots[k], out[-1]) < 0.35
        if h < 0.5 or (short and h < 0.8):
            out[-1] += slots[k]
        else:
            out.append(slots[k])
            ofx.append(fxs[k] if k < len(fxs) else None)
    return out, ofx


def _auto_adapt(brief, slots, drop_k, beats, mstart, D):
    """Literal or epic, decided per template from its song and its cut: "epic" when, after the drop, the song is a
    relaxed groove (under 7.5 hits a second), the reference still chops faster than the beat (30%+ of its shots there under a beat), and there's room (4s+)
    for big shots to breathe. A busy track made for chop cuts, or a reference already holding its shots, stays as is."""
    music = brief.get("music")
    if not music or D - beats[drop_k] < 4.0:
        return "literal"
    try:
        hits = hit_rate(music, mstart, beats[drop_k], D)
        _, period = beat_times(music, mstart, D + 1)
    except Exception:
        return "literal"
    after = slots[drop_k:]
    # chopping: 30%+ of the shots after the drop are shorter than a beat (a reference that mostly holds stays as is)
    chops = bool(after) and sum(1 for x in after if x < period) >= 0.3 * len(after)
    return "epic" if hits is not None and hits < 7.5 and chops else "literal"


def _epic_section(brief, clips, ids, t0, mstart, ref_end):
    """Slots after the drop for an "epic" template: 4 beats on the drop shot, then 3-4 beat holds on the grid, one per
    great hold shot (rated 0.7+, best for a hold or either, a moment long enough), at least to the reference's end and
    at most 1.6x it, and never past the end of the song's sound. Returns {slots, loop} (loop is None: the song is
    never replayed under the reel)."""
    music = brief.get("music")
    if not music:
        return None
    try:
        bt, period = beat_times(music, mstart, ref_end * 1.7 + 4)
    except Exception:
        return None
    try:
        from .beats import load_audio, SR
        have = len(load_audio(music, mstart, ref_end * 1.7 + 4)) / SR
    except Exception:
        have = ref_end
    # the reel ends with its sound: replaying the song from an earlier point sounds like a restart, so the holds fit
    # what the song has (a longer source track, when there is one, gives them more room)
    grid = [b for b in bt if t0 - 0.06 <= b <= have - 0.15]
    if len(grid) < 6:
        return None
    heroes = 0
    for cid in ids:
        r = clips[cid].get("read") or {}
        if float(r.get("rating") or 0) >= 0.7 and r.get("best_for") in ("hold", "both", None) and not r.get("skip"):
            heroes += 1
    # each hold runs 3-5 beats (the drop shot 4+) and ends on the hardest hit the music actually makes in that
    # window: the note length flexes so every cut lands where the song lands, not where a steady tempo says it should
    try:
        peaks = [(t, s) for t, s in hit_peaks(music, mstart, have) if t <= grid[-1] + 0.05]
    except Exception:
        peaks = []
    cuts, k = [grid[0]], 0
    while True:
        t = cuts[-1]
        lo, hi = t + (3.8 if k == 0 else 2.8) * period, t + 5.2 * period
        opts = [(s - 0.08 * abs((x - t) / period - 4), x) for x, s in peaks if lo <= x <= hi and s >= 0.5]
        if opts:
            nxt = max(opts)[1]
        else:
            on_grid = [b for b in grid if lo <= b <= hi]
            if not on_grid:
                break
            nxt = min(on_grid, key=lambda b: abs(b - t - 4 * period))
        k += 1
        cuts.append(nxt)
        i = len([b for b in grid if b <= nxt]) - 1
        if cuts[-1] >= ref_end - period and k >= min(heroes, 9):
            break
        if cuts[-1] >= ref_end * 1.6:
            break
    if cuts[-1] < grid[-1]:  # end with the song: one more hold if there's room for it, else the last one runs on
        if grid[-1] - cuts[-1] >= 2.5 * period:
            cuts.append(grid[-1])
        else:
            cuts[-1] = grid[-1]
    if len(cuts) < 3:
        return None
    try:  # the grid is the song's average tempo: each hold's cut lands on the hit nearest it
        inner = snap_cuts(music, cuts[1:-1], mstart)
        if len(inner) == len(cuts) - 2:
            cuts = [cuts[0]] + inner + [cuts[-1]]
    except Exception:
        pass
    slots = [round(b - a, 3) for a, b in zip(cuts[:-1], cuts[1:])]
    return dict(slots=slots, loop=None)


def _drop_slot(brief, beats, mstart, D):
    """The template's shot that lands on the song's drop: the cut nearest the biggest energy jump (within 0.4s), as
    the reference's editor cut on it. None when there's no song or no cut near it."""
    music = brief.get("music")
    if not music or str(music).startswith("synth") or len(beats) < 4:
        return None
    try:
        t = drop_time(music, mstart, D)
    except Exception:
        return None
    if t is None:
        return None
    k = min(range(1, len(beats) - 1), key=lambda i: abs(beats[i] - t))
    return k if abs(beats[k] - t) <= 0.4 else None


def _rarity(looks):
    """0..1 per clip: how unlike the rest of the footage it looks (the one bison shot vs the fifth forest trail)."""
    ids = [c for c, s in looks.items() if s]
    if len(ids) < 4:
        return {}
    near = {}
    for a in ids:
        d = sorted(sig_dist(looks[a], looks[b]) for b in ids if b != a)
        near[a] = float(np.mean(d[:3]))
    lo, hi = np.percentile(list(near.values()), [10, 90])
    return {c: float(np.clip((v - lo) / (hi - lo + 1e-9), 0, 1)) for c, v in near.items()}


def _moment_windows(clip, read):
    """The moments the clip read picked out (what to use), as windows the editor can take whole."""
    out = []
    samples = clip["meta"].get("samples") or []
    dur = clip["meta"].get("duration") or 0
    for m in read.get("moments") or []:
        t0, t1 = max(float(m.get("t0", 0)), 0.0), min(float(m.get("t1", 0)), dur - 0.05)
        if t1 - t0 < 0.5:
            continue
        rows = [r for r in samples if t0 <= r["t"] < t1]
        peak = m.get("peak")
        out.append(dict(start=round(t0, 3), dur=round(t1 - t0, 3), moment=True,
                        peak=float(peak) if peak is not None and t0 <= float(peak) <= t1 else None,
                        score=float(np.mean([r["score"] for r in rows])) if rows else 0.4,
                        cx=float(np.median([r["cx"] for r in rows])) if rows else 0.5))
    return out


def _judged(w, read, rare):
    """A window's worth. With a clip read (Claude looked at it): mostly how striking the shot is, a bonus inside
    a moment it picked, and nothing for a clip it said to skip. Without one: the measured score plus rarity."""
    local = min(w["score"] / 0.65, 1.0)
    if read.get("rating") is None:
        return w["score"] + 0.12 * rare
    if read.get("skip") or float(read["rating"]) < 0.3:  # weak clips never win just for being a new scene
        return 0.0
    inside = w.get("moment") or any(
        min(w["start"] + w["dur"], float(m.get("t1", 0))) - max(w["start"], float(m.get("t0", 0))) >= 0.5 * w["dur"]
        for m in read.get("moments") or [])
    return 0.65 * (0.3 * local + 0.7 * float(read["rating"])) + (0.12 if inside else 0.0)


class Pool:
    """Hands out the best unused shot windows, rotating clips so the same clip never runs twice."""

    def __init__(self, clips, ids, hero=None, seed=0, length=3.2, spread=0.08):
        self.rng = np.random.default_rng(seed)
        self.uses, self.recent, self.cast_ids, self.scene_uses = {}, [], set(), {}
        self.look = {cid: clips[cid]["meta"].get("look") for cid in ids}
        self.num = {cid: _shot_number(clips[cid].get("path", "")) for cid in ids}
        self.read = {cid: clips[cid].get("read") or {} for cid in ids}
        self.scene = {cid: str(self.read[cid].get("scene") or "").strip().lower() for cid in ids}
        rare = _rarity(self.look)
        self.w = {}
        for cid in ids:
            ws = best_windows(clips[cid]["meta"], length=length, n=10) + _moment_windows(clips[cid], self.read[cid])
            for w in ws:
                w["clip"] = cid
                w["score"] = _judged(w, self.read[cid], rare.get(cid, 0.0))
                if cid == hero:
                    w["score"] += 0.25
            self.w[cid] = ws
        self.used, self.last = set(), None
        for cid in self.w:
            for w in self.w[cid]:
                w["base"] = w["score"]
                if seed:  # alternate variants explore different, still-good shots
                    w["score"] += self.rng.uniform(0, spread)

    def take_from(self, cid, need):
        """Best unused window of one specific clip (for scripted shot order)."""
        ws = self.w.get(cid) or []
        free = [(w["score"] * (1.0 if w["dur"] >= need else w["dur"] / need), i) for i, w in enumerate(ws) if (cid, i) not in self.used]
        if not free:
            self.used -= {(cid, i) for i in range(len(ws))}
            free = [(w["score"], i) for i, w in enumerate(ws)]
        if not free:
            raise ValueError(f"sequence clip {cid} has no usable window")
        _, i = max(free)
        self.used.add((cid, i))
        self.last = cid
        return dict(ws[i])

    def take(self, need, prefer=None, avoid_last=True, rank=None, like=None, quick=False):
        """rank (0..) takes the rank-th best scene instead of the best window, e.g. so a batch's templates open differently."""
        cands = []
        for cid, ws in self.w.items():
            for i, w in enumerate(ws):
                if (cid, i) in self.used:
                    continue
                if avoid_last and cid == self.last and len(self.w) > 1:
                    continue
                fit = 1.0 if w["dur"] >= need else w["dur"] / need
                bonus = 0.3 if cid == prefer else 0
                if like and (cid == like or self._same_scene(cid, like)):
                    bonus += 0.45  # the loop cut: end where it began, so the replay flows on
                # another moment of a clip already shown only wins when it clearly beats every fresh clip,
                # and a take of the scene just shown (same burst of files, or the same look) waits a few cuts
                near = sum(1 for r in self.recent if self._same_scene(cid, r))
                kind = self.read[cid].get("best_for")
                if quick:  # a fast cut wants a shot that hits in a split second; the majestic ones stay for the holds
                    rating = float(self.read[cid].get("rating") or 0)
                    hero = kind == "hold" if kind else rating >= 0.8
                    # an epic shot is never spent as a flash: it needs time to be taken in
                    bonus += (0.1 if kind == "quick" else 0) - (1.0 if hero and rating >= 0.8 else 0.35 * hero) - 0.3 * (cid in self.cast_ids)
                elif need >= 0.7 and self.read[cid].get("best_for") == "quick":
                    bonus -= 0.6  # a flash shot (a spark, a quick gesture) lives in the chop, never in a slot meant to be held
                # one take per scene: the second bridge walk only plays when nothing new is left
                sc = self.scene.get(cid)
                spent = 0.3 * self.scene_uses.get(sc, 0) if sc and cid != like else 0
                cands.append((w["score"] * fit + bonus - 0.25 * self.uses.get(cid, 0) - 0.2 * near - spent, cid, i))
        if not cands:  # everything used: recycle
            self.used.clear()
            return self.take(need, prefer, avoid_last=False, like=like, quick=quick)
        _, cid, i = max(cands)
        if rank is not None:
            best = {}
            # ranked on the unjittered worth, so templates given ranks 0..4 open on five different scenes
            for c in sorted(cands, key=lambda c: self.w[c[1]][c[2]]["base"], reverse=True):  # one entry per scene
                best.setdefault(self.scene.get(c[1]) or c[1], c)
            _, cid, i = list(best.values())[min(rank, len(best) - 1)]
        self.used.add((cid, i))
        self.uses[cid] = self.uses.get(cid, 0) + 1
        self._scene_used(cid)
        self.recent = (self.recent + [cid])[-3:]
        self.last = cid
        return dict(self.w[cid][i])

    def cast_heroes(self, slots, D, taken=None, drop=None):
        """{slot index: window} for the template's key shots, chosen right after the opener and before the fast cuts
        can use anything up. In order: the shot on the drop (the most epic thing in the footage: a majestic hold if the
        slot is long, the hardest-hitting quick shot if it's a flash), then the first long hold, then the other holds
        longest first. A hold is 0.9s+, or in the slowest fifth of the reel's shots (and at least 0.6s). Holds go to
        shots that reward a long look (best_for hold); each key shot is its own scene and is never stretched to fit."""
        if len(slots) < 4:
            return {}
        bar = max(0.6, min(0.9, float(np.percentile(slots, 80))))
        holds = [k for k in range(1, len(slots) - 1) if slots[k] >= bar]
        order = [drop] if drop and 0 < drop < len(slots) - 1 else []
        after = [k for k in holds if k > (drop or 0)] or holds
        if after and after[0] not in order:
            order.append(after[0])
        order += [k for k in sorted(holds, key=lambda i: -slots[i]) if k not in order]
        out, scenes = {}, {self.scene.get(taken) or taken} if taken else set()
        for k in order:
            need, hold = slots[k] + 0.1, slots[k] >= bar
            cands = []
            for cid, ws in self.w.items():
                sc = self.scene.get(cid) or cid
                kind = self.read[cid].get("best_for")
                fit = (0.15 if kind in ("hold", "both") else -0.2 if kind == "quick" else 0) if hold else                       (0.15 if kind in ("quick", "both") else -0.1 if kind == "hold" else 0)
                for i, w in enumerate(ws):
                    if (cid, i) in self.used or w["dur"] < need * 0.9:
                        continue  # a key shot is never stretched or frozen to fill its slot
                    cands.append((w["score"] + fit - 0.25 * self.uses.get(cid, 0) - (0.3 if sc in scenes else 0), cid, i))
            if not cands:
                continue
            _, cid, i = max(cands)
            self.used.add((cid, i))
            self.uses[cid] = self.uses.get(cid, 0) + 1
            self._scene_used(cid)
            scenes.add(self.scene.get(cid) or cid)
            self.cast_ids.add(cid)
            out[k] = dict(self.w[cid][i])
        return out

    def _scene_used(self, cid):
        sc = self.scene.get(cid)
        if sc:
            self.scene_uses[sc] = self.scene_uses.get(sc, 0) + 1

    def mark(self, cid):
        """A cast shot reaching its place in the timeline (its window was reserved by cast_heroes)."""
        self.recent = (self.recent + [cid])[-3:]
        self.last = cid

    def _same_scene(self, a, b):
        if self.scene.get(a) and self.scene.get(b):  # both looked at: their scene names decide
            return self.scene[a] == self.scene[b]
        na, nb = self.num.get(a), self.num.get(b)
        if na is not None and nb is not None and abs(na - nb) <= 3:
            return True
        return sig_dist(self.look.get(a), self.look.get(b)) < 15


def _speed_for(w, clips, pace, k):
    fps = clips[w["clip"]]["meta"].get("fps", 30)
    if pace == "cinematic" and fps >= 48:
        return 0.5
    if pace == "fast" and k % 5 == 3:
        return [1.8, 0.7] if fps >= 48 else [1.6, 0.9]  # speed ramp into the cut
    if pace == "cinematic":
        return 0.85 if fps >= 48 else 1.0
    return 1.0


def _zoom(k, pace):
    amp = {"fast": 0.14, "medium": 0.09, "cinematic": 0.06}[pace]
    return [1.0, 1.0 + amp] if k % 2 == 0 else [1.0 + amp, 1.0]


# ------------------------------------------------------------------ text timing
def text_events(brief, cuts, total, beats):
    ev, style = [], brief.get("hook_style", "hook")
    hook = brief.get("hook")
    end_len = float(brief.get("endcard_hold") or 1.9) if brief.get("endcard") else 0  # how long the end card stays up
    t_after = 0.0
    if hook:
        need = read_time(hook) + 0.5
        t1 = next((c for c in cuts if c >= max(need, 2.0)), max(need, 2.0))
        t1 = min(t1, total - end_len - 0.1)
        ev.append(dict(t0=0.0, t1=t1, text=hook, style=style, pos=brief.get("hook_pos", "upper"),
                       anim=brief.get("hook_anim", "pop")))
        if brief.get("kicker"):
            ev.append(dict(t0=0.15, t1=t1, text=brief["kicker"], style="kicker", pos="top", anim="fade"))
        t_after = t1
    lines = list(brief.get("lines", []))
    if brief.get("cta") and not brief.get("endcard"):
        lines.append(brief["cta"])
    # Shot-pinned lines {"text", "shot", "to"?, "pos"?}: the line covers shots shot..to, so copy about a screen
    # recording never spills onto the next place. Still held for its read time (the readability law wins).
    pinned = [x for x in lines if isinstance(x, dict) and "shot" in x]
    lines = [x if isinstance(x, str) else x["text"] for x in lines if not (isinstance(x, dict) and "shot" in x)]
    bounds = list(cuts) + [total]
    for x in pinned:
        a, z = int(x["shot"]), int(x.get("to", x["shot"]))
        if a >= len(cuts):
            continue
        start = max(bounds[a], t_after)
        end = min(bounds[min(z, len(cuts) - 1) + 1], total - end_len)
        if x.get("at") is not None:
            # a template line keeps the reference's own seconds (shot numbers drift when flash cuts fold), moved with
            # the cuts if they were slid onto the beat; the reel already showed it for that long, so no read-time pad
            lag = brief.get("_lag", 0.0)
            start = max(float(x["at"]) + lag, t_after)
            end = min(max(float(x.get("until") or x["at"]) + lag, start + 0.4), total - end_len)
        elif end - start < read_time(x["text"]):
            end = min(start + read_time(x["text"]) + 0.3, total - end_len)
        ev.append(dict(t0=round(start, 3), t1=round(end, 3), text=x["text"], style=x.get("style", brief.get("line_style", "pill")),
                       pos=x.get("pos", brief.get("line_pos", "lower")), anim=x.get("anim", brief.get("line_anim", "slide"))))
    if lines:
        avail = total - end_len - t_after
        slot = avail / len(lines)
        t = t_after
        for i, line in enumerate(lines):
            start = next((c for c in cuts if c >= t - 0.05), t)
            end = min(start + max(slot, read_time(line) + 0.4), total - end_len)
            if end - start < read_time(line):
                end = min(start + read_time(line) + 0.3, total)
            ev.append(dict(t0=round(start, 3), t1=round(end, 3), text=line,
                           style=brief.get("line_style", "pill"), pos=brief.get("line_pos", "lower"),
                           anim=brief.get("line_anim", "slide")))
            t = end
    if brief.get("endcard"):
        name, tag = (BRAND_NAME, BRAND_TAGLINE) if brief["endcard"] is True else (brief["endcard"].split("|") + [""])[:2]
        t0 = total - end_len
        ev.append(dict(t0=t0, t1=total, text=name, style=brief.get("endcard_style") or "endcard", pos="center", anim="pop"))
        if tag:
            ev.append(dict(t0=t0 + 0.25, t1=total, text=tag, style="kicker", pos=(500, 1060), anim="fade"))
        if brief.get("cta"):
            ev.append(dict(t0=t0 + 0.4, t1=total, text=brief["cta"], style="pill", pos="lower", anim="slide"))
    return ev


# ------------------------------------------------------------------ formats
def plan_montage(brief, clips):
    D = brief.get("duration", 15)
    pace = brief.get("pacing", "fast")
    ids = brief.get("clips") or list(clips)
    # footage keeps the shape it was shot in, never cropped to fit: a sideways ("turn your phone") reel uses only
    # landscape clips, an upright reel only vertical ones (square clips fit either)
    want = "wide" if brief.get("sideways") else "tall"
    fits = [c for c in ids if _shape(clips[c]["meta"]) in (want, "square")]
    if len(fits) < min(3, len(ids)):
        raise ValueError(f"needs {'landscape' if want == 'wide' else 'vertical'} footage: only {len(fits)} of {len(ids)} "
                         f"clips were shot {'wide' if want == 'wide' else 'vertically'}, and clips aren't cropped to fit")
    ids = fits
    hero = brief.get("hero") if brief.get("hero") in ids else None
    if brief.get("build_drop") and not brief.get("drop_beats"):
        # the drop lands on the reveal: after the scripted build-up shots (default: after the first shot)
        seq0 = [x if isinstance(x, dict) else {"clip": x} for x in brief.get("sequence") or []]
        k_drop = brief.get("drop_shot", 1)
        held = [int(x.get("beats") or 0) for x in seq0[:k_drop]]
        brief["drop_beats"] = sum(held) if held and all(held) else 8
    beats, strong, mstart, bpm = beat_grid(brief, D)
    slots, fxs = [], []
    fx_in = brief.get("shot_fx") or []
    for i, x in enumerate(brief.get("slots") or []):  # a reel's flash cuts under 0.2s fold into the next shot (timing kept)
        x, f = float(x), (fx_in[i] if i < len(fx_in) else None)
        if slots and slots[-1] < 0.2:
            slots[-1] += x
            if f and fxs[-1]:  # the merged shot keeps how it came in, and takes the longer shot's camera move
                fxs[-1] = {**fxs[-1], "zoom": f.get("zoom", 1), "pan": f.get("pan", 0)}
        elif x > 0:
            slots.append(x)
            fxs.append(f)
    if len(slots) > 1 and slots[-1] < 0.2:
        tail = slots.pop()  # pop first: `slots[-2] += slots.pop()` writes the sum one slot too early
        fxs.pop()
        slots[-1] += tail
    # literal template: cut exactly where the reference cut (its song is timed to these slots), at real speed, and
    # each shot comes in and moves the way the reference's shot did (hard cut, dissolve, flash, whip; push in/out).
    # Nothing the reference didn't do: no added zooms, ramps or effects.
    literal = bool(slots)
    if slots:
        mstart = float(brief.get("music_start") or 0.0)
        music = brief.get("music")
        if music and not str(music).startswith("synth") and len(slots) > 3:
            # the reel's cuts as read can sit a few frames off its pulled sound: slide them onto the beat (the first
            # shot gives or takes the difference, the last makes it up, so the length and song stay the same)
            try:
                lag = cut_lag(music, list(np.cumsum(slots)[:-1]), mstart)
            except Exception:
                lag = 0.0
            if lag and slots[0] + lag > 0.15 and slots[-1] - lag > 0.15:
                slots[0] += lag
                slots[-1] -= lag
                brief["_lag"] = lag
            try:  # then each cut onto its own beat hit
                total0 = sum(slots)
                cuts = snap_cuts(music, list(np.cumsum(slots)[:-1]), mstart)
                if cuts and cuts[-1] < total0 - 0.2:
                    slots = list(np.diff([0.0] + cuts + [total0]))
            except Exception:
                pass
            try:  # fewer cuts beat stutters: a cut the music doesn't hit is dropped, its shot runs on in the one before
                slots, fxs = _drop_offbeat(slots, fxs, cut_hits(music, list(np.cumsum(slots)[:-1]), mstart))
            except Exception:
                pass
        beats = [round(float(x), 3) for x in np.cumsum([0.0] + slots)]
        strong, D = beats, beats[-1]
    # the drop: the shot it lands on is the reel's big reveal, so it gets time to breathe. If the reference fires quick
    # cuts there, they fold into that one shot until it holds ~1.3s (the cut after it still lands where the reel's did)
    drop_k = _drop_slot(brief, beats, mstart, D) if literal else None
    epic = None
    if drop_k and brief.get("adapt", "auto") == "auto":
        brief["adapt"] = _auto_adapt(brief, slots, drop_k, beats, mstart, D)
    if drop_k and brief.get("adapt") == "epic":
        # adaptive "epic" template: the reference's chop up to the drop (the rumble before "go."), then the editor's own
        # cut: shots on the beat, 3-4 beats each, as many as there are great hold shots (the reel runs longer, the song
        # loops a bar-aligned section underneath, rather than rushing them)
        epic = _epic_section(brief, clips, ids, beats[drop_k], mstart, D)
        if epic:
            slots, fxs = slots[:drop_k] + epic["slots"], fxs[:drop_k] + [None] * len(epic["slots"])
            beats = [round(float(x), 3) for x in np.cumsum([0.0] + slots)]
            strong, D = beats, beats[-1]
    if drop_k and not epic:
        while slots[drop_k] < 1.3 and drop_k + 1 < len(slots) - 1:
            slots[drop_k] += slots.pop(drop_k + 1)
            fxs.pop(drop_k + 1)
        beats = [round(float(x), 3) for x in np.cumsum([0.0] + slots)]
        strong = beats
    if literal and not epic and brief.get("music") and not str(brief["music"]).startswith("synth") and len(slots) > 3:
        try:  # the template flexes to the footage: note lengths the shots need, every cut on the music
            slots, fxs = _flex(slots, fxs, drop_k, brief["music"], mstart, clips, ids)
            if drop_k:
                drop_k = min(range(len(slots)), key=lambda i: abs(sum(slots[:i]) - beats[drop_k]))
            beats = [round(float(x), 3) for x in np.cumsum([0.0] + slots)]
            strong = beats
        except Exception:
            pass
    seed, spread, opener = brief.get("seed", 0), 0.08, 0
    if brief.get("template") and not seed:
        # each reference template gets its own pick of the footage, so a batch doesn't open five times on one shot:
        # its opener is one of the top few clips, chosen by the template
        seed, spread = zlib.crc32(brief["template"].encode()) % 10_000 + 1, 0.15
        opener = 0 if hero else brief.get("opener", seed) % 5
    pool = Pool(clips, ids, hero, seed, spread=spread)
    pat = PATTERN[pace]
    clean = brief.get("transitions_style", "clean") == "clean"
    trs = (TRANS["playful"] if brief.get("fx") == "playful" else TRANS["clean"]) if clean else TRANS[pace]
    if brief.get("transitions") and brief["transitions"] != "auto":
        trs = [brief["transitions"]]
    # casting: a template's long holds are where the eye rests, so right after the opener is picked they get the best
    # shots in the footage (each with a moment long enough to fill it), before the fast cuts can use them up
    cast = {}
    segs, bi, k = [], 0, 0
    # hook shot: hero, held to cover the hook read
    hook_beats = max(2, int(np.ceil((read_time(brief.get("hook", "")) + 0.5) / (60 / bpm)))) if brief.get("hook") else 2
    while True:
        if bi >= len(beats) - 1 or beats[bi] >= D - 0.2:
            break
        nb = hook_beats if k == 0 else pat[(k - 1) % len(pat)]
        seq = [x if isinstance(x, dict) else {"clip": x} for x in brief.get("sequence") or []]
        if seq and k < len(seq) and seq[k].get("beats"):
            nb = int(seq[k]["beats"])  # scripted hold, e.g. let a screen recording finish its reveal
        elif slots:
            nb = 1
        elif k == 0 and brief.get("_drop_at") is not None:
            # quiet start: the hook shot holds right up to the drop, so the drop hits on the second shot
            nb = max(1, min(range(len(beats)), key=lambda i: abs(beats[i] - brief["_drop_at"])))
        if seq and k >= len(seq) - 1 and k:
            nb = max(1, len([b for b in beats if beats[bi] <= b < D]))  # last scripted shot runs to the end
        if brief.get("endcard") and beats[min(bi + nb, len(beats) - 1)] > D - float(brief.get("endcard_hold") or 1.9) and k:
            nb = len([b for b in beats if beats[bi] <= b < D]) or nb  # final shot runs under the end card
        end = beats[min(bi + nb, len(beats) - 1)]
        end = min(end, D)
        dur = round(end - beats[bi], 3)
        if dur < 0.2:
            break
        speed = 1.0 if k == 0 else _speed_for({"clip": ids[0]}, clips, pace, k)
        need = dur * (speed if not isinstance(speed, list) else sum(speed) / 2) + 0.1
        # `sequence`: scripted shot order (e.g. app-in-hand: place -> screen proof -> payoff). Entries are clip
        # ids or {"clip", "beats"}; the last entry runs to the end so it can sit under the end card.
        if literal and k == 1:
            cast = pool.cast_heroes(slots, D, taken=segs[0]["clip"], drop=drop_k)
        if seq:
            entry = seq[min(k, len(seq) - 1)]
            w = pool.take_from(entry["clip"], need)
            if "start" in entry and k < len(seq):  # editor picked the moment; keep the analysed framing
                w.update(start=float(entry["start"]), dur=need)
            if entry.get("sync") and k < len(seq):  # the score's source: picture in sync with the soundtrack
                w.update(start=round(mstart + beats[bi], 3), dur=need)
        elif k in cast:
            w = cast[k]
            pool.mark(w["clip"])
        else:
            last = end >= D - 0.01
            w = pool.take(need, prefer=hero if k == 0 or last else None, rank=opener if k == 0 and brief.get("template") and not hero else None,
                          like=segs[0]["clip"] if literal and last and segs else None,
                          quick=bool(cast) and 0 < k and not last and dur < 0.5)  # all-flash reels use the best
        if k:
            speed = _speed_for(w, clips, pace, k)
        if (seq and seq[min(k, len(seq) - 1)].get("sync")) or literal:
            speed = 1.0
        tr = "cut" if k == 0 or literal else trs[(k - 1) % len(trs)]
        if beats[bi] in strong and tr == "cut" and pace != "cinematic" and not clean and not literal:
            tr = "flash"
        start = w["start"]
        avail = w["dur"]
        if w.get("peak") is not None and avail > dur:
            # a moment longer than the slot: land on its peak (a reveal's full view), arriving just before it, never
            # the first seconds of a pan that hasn't got there yet
            start = min(max(w["peak"] - 0.65 * dur, w["start"]), w["start"] + avail - dur)
            avail = w["start"] + w["dur"] - start
        consumed = dur * (speed if not isinstance(speed, list) else sum(speed) / 2)
        if consumed > avail:  # short window: centre what we have, renderer holds last frame
            start = max(w["start"] - (consumed - avail) / 2, 0)
        seg = dict(clip=w["clip"], start=round(start, 3), dur=dur, speed=speed, cx=w["cx"],
                   zoom=[1.0, 1.0] if literal else _zoom(k, pace), transition=tr, hit=beats[bi] in strong)
        if literal:
            seg.update(_ref_fx(fxs[k] if k < len(fxs) else None, k, dur))
        segs.append(seg)
        bi += nb
        k += 1
    total = sum(s["dur"] for s in segs)
    cuts = list(np.cumsum([0] + [s["dur"] for s in segs])[:-1])
    plan = dict(id=brief["id"], format=brief.get("format", "montage"), segments=segs,
                grade=brief.get("grade") or GRADE_BY_PACE[pace], grain=brief.get("grain", pace != "fast"),
                vignette=True, letterbox=brief.get("letterbox", False), seed=brief.get("seed", 0),
                sideways=brief.get("sideways"),
                text=text_events(brief, cuts, total, beats), poster_t=0.75, hook=brief.get("hook"),
                caption=brief.get("caption", ""), hashtags=brief.get("hashtags", []),
                timing_track=brief.get("timing_track"),
                transitions_style="clean" if clean else "punchy",
                audio=dict(mode="music" if brief.get("music") else "none", music=brief.get("music"), natural=brief.get("natural", "auto"),
                           music_start=mstart, bpm=bpm, sfx=brief.get("sfx", True), drop_at=brief.get("_drop_at"),
                           loop=epic["loop"] if epic else None),
                test_tags=dict(format=brief.get("format", "montage"), pacing=pace, hook_id=brief.get("hook_id")))
    if brief.get("drop_hit", not clean) and len(segs) > 2:
        plan["hits"] = [cuts[1]]
    return plan


def plan_oneshot(brief, clips):
    D = brief.get("duration", 9)
    ids = brief.get("clips") or list(clips)
    hero = brief.get("hero") or max(ids, key=lambda c: clips[c]["meta"].get("quality", 0))
    m = clips[hero]["meta"]
    ws = best_windows(m, length=min(D, m["duration"] - 0.2), n=1)
    w = ws[0] if ws else dict(start=0, dur=m["duration"], cx=0.5)
    slow = m.get("fps", 30) >= 48 and brief.get("slowmo", True)
    speed = 0.6 if slow else 1.0
    dur = round(min(D, w["dur"] / speed), 3)
    segs = [dict(clip=hero, start=w["start"], dur=dur, speed=speed, cx=w["cx"],
                 zoom=[1.0, brief.get("push", 1.12)], transition="cut")]
    beats, strong, mstart, bpm = beat_grid(brief, dur)
    cuts = [round(b, 3) for b in beats if 0 < b < dur][::4] or [0.0]
    plan = dict(id=brief["id"], format="oneshot", segments=segs, grade=brief.get("grade", "film"),
                grain=brief.get("grain", True), vignette=True, letterbox=brief.get("letterbox", False),
                text=text_events(brief, [0.0] + cuts, dur, beats), poster_t=0.75, hook=brief.get("hook"),
                caption=brief.get("caption", ""), hashtags=brief.get("hashtags", []),
                timing_track=brief.get("timing_track"),
                audio=dict(mode=("mix" if brief.get("nat_sound") and m["has_audio"] else "music") if brief.get("music")
                           else ("original" if m["has_audio"] and brief.get("nat_sound", True) else "none"),
                           music=brief.get("music"), music_start=mstart, bpm=bpm, original_gain=0.5),
                test_tags=dict(format="oneshot", hook_id=brief.get("hook_id")))
    return plan


def plan_list(brief, clips):
    """'3 spots…' countdown: hook, then one shot per item with a numbered label."""
    items = brief.get("items") or brief.get("lines", [])
    D = brief.get("duration", 4 + 3 * len(items))
    beats, strong, mstart, bpm = beat_grid(brief, D)
    step = 60 / bpm
    pool = Pool(clips, brief.get("clips") or list(clips), brief.get("hero"), brief.get("seed", 0))
    hook_d = _snap(beats, max(read_time(brief.get("hook", "")) + 0.4, 2.0))
    per = max(round((D - hook_d - (1.9 if brief.get("endcard") else 0)) / max(len(items), 1) / step) * step, 2 * step)
    segs = [dict(**_seg(pool.take(hook_d + 0.1, brief.get("hero")), hook_d, [1.0, 1.1], "cut"))]
    text = [dict(t0=0, t1=hook_d, text=brief["hook"], style=brief.get("hook_style", "hook"), pos="upper", anim="pop")]
    t = hook_d
    for i, it in enumerate(items):
        segs.append(_seg(pool.take(per + 0.1), per, _zoom(i, "medium"), "whip" if i else "zoom"))
        label = it if brief.get("no_numbers") else f"{len(items) - i if brief.get('countdown') else i + 1}. {it}"
        text.append(dict(t0=t + 0.1, t1=t + per, text=label, style=brief.get("line_style", "list"),
                         pos="upper", anim="slide"))
        t += per
    if brief.get("endcard"):
        segs.append(_seg(pool.take(2.0, brief.get("hero")), 1.9, [1.05, 1.0], "dip"))
        text += [e for e in text_events(dict(endcard=brief["endcard"], endcard_style=brief.get("endcard_style"), cta=brief.get("cta")), [], t + 1.9, beats)]
    return dict(id=brief["id"], format="list", segments=segs, grade=brief.get("grade", "tropical"),
                grain=False, vignette=True, text=text, poster_t=0.75, hook=brief.get("hook"),
                caption=brief.get("caption", ""), hashtags=brief.get("hashtags", []),
                timing_track=brief.get("timing_track"),
                audio=dict(mode="music" if brief.get("music") else "none", music=brief.get("music"),
                           music_start=mstart, bpm=bpm), test_tags=dict(format="list", hook_id=brief.get("hook_id")))


def _seg(w, dur, zoom, tr):
    return dict(clip=w["clip"], start=w["start"], dur=round(dur, 3), speed=1.0, cx=w["cx"], zoom=zoom, transition=tr)


def plan_talking(brief, clips):
    """Talking head / podcast: dead air removed, punch-in alternation, karaoke captions, b-roll cutaways."""
    main = brief.get("hero") or next(c for c in (brief.get("clips") or clips) if clips[c]["meta"].get("has_audio"))
    m = clips[main]["meta"]
    words = brief.get("words") or talk.transcribe(clips[main]["path"])
    ranges = talk.speech_ranges(clips[main]["path"], m["duration"], words)
    if brief.get("max_duration"):
        keep, acc = [], 0
        for a, b in ranges:
            if acc >= brief["max_duration"]:
                break
            b = min(b, a + brief["max_duration"] - acc)
            keep.append([a, b])
            acc += b - a
        ranges = keep
    # split long ranges so the punch-in alternates every ~2.5-4s
    pieces = []
    for a, b in ranges:
        n = max(1, int((b - a) // 3.2))
        step = (b - a) / n
        pieces += [[a + i * step, a + (i + 1) * step] for i in range(n)]
    broll = [c for c in (brief.get("broll") or []) if c != main]
    pool = Pool(clips, broll, None, brief.get("seed", 0)) if broll else None
    segs = []
    for i, (a, b) in enumerate(pieces):
        z = 1.0 if i % 2 == 0 else brief.get("punch", 1.16)
        seg = dict(clip=main, start=round(a, 3), dur=round(b - a, 3), speed=1.0,
                   cx=m.get("samples") and float(np.median([s["cx"] for s in m["samples"]])) or 0.5,
                   zoom=[z, z + 0.015], transition="cut", audio_clip=main, audio_start=round(a, 3))
        if pool and i % 3 == 2 and b - a > 1.2:  # cutaway: b-roll picture, keep the voice
            w = pool.take(b - a)
            seg.update(clip=w["clip"], start=w["start"], cx=w["cx"], zoom=[1.0, 1.08])
        segs.append(seg)
    total = sum(s["dur"] for s in segs)
    cap_words = talk.remap_words(words, pieces) if words else talk.script_words(brief.get("script", ""), pieces)
    text = talk.caption_groups(cap_words) if brief.get("captions", True) else []
    cuts = list(np.cumsum([0] + [s["dur"] for s in segs])[:-1])
    if brief.get("hook"):
        h_end = next((c for c in cuts if c >= read_time(brief["hook"]) + 0.6), 3.0)
        text.append(dict(t0=0, t1=h_end, text=brief["hook"], style=brief.get("hook_style", "pill"),
                         pos="top", anim="pop"))
    if brief.get("format") == "podcast" and brief.get("topic"):
        text.append(dict(t0=0, t1=total, text=brief["topic"], style="kicker", pos=(500, 290), anim="fade"))
    plan = dict(id=brief["id"], format=brief.get("format", "talking"), segments=segs,
                grade=brief.get("grade", "clean"), grain=False, vignette=brief.get("format") == "podcast",
                text=text, poster_t=0.9, hook=brief.get("hook"), caption=brief.get("caption", ""),
                hashtags=brief.get("hashtags", []), words_source="transcript" if words else "script",
                audio=dict(mode="mix" if brief.get("music") else "original", music=brief.get("music"),
                           music_gain=0.18, duck=True, sfx=False),
                test_tags=dict(format=brief.get("format", "talking"), hook_id=brief.get("hook_id")))
    if not words and not brief.get("script"):
        plan["text"] = [e for e in plan["text"] if e["style"] != "karaoke"]
        plan["warnings"] = ["no transcript and no script: captions skipped"]
    return plan


FORMATS = {"montage": plan_montage, "cinematic": plan_montage, "pov": plan_montage, "reveal": plan_montage,
           "oneshot": plan_oneshot, "list": plan_list, "talking": plan_talking, "podcast": plan_talking}


def plan(brief, clips):
    fmt = brief.get("format", "montage")
    b = dict(brief)
    if fmt == "cinematic":
        b.setdefault("pacing", "cinematic")
        b.setdefault("letterbox", True)
        b.setdefault("hook_style", "hook_serif")
    if fmt == "pov":
        b.setdefault("hook_style", "pill")
        b.setdefault("pacing", "medium")
        if b.get("hook") and not b["hook"].lower().startswith("pov"):
            b["hook"] = "POV: " + b["hook"]
    if fmt == "reveal":
        b.setdefault("pacing", "fast")
        b.setdefault("transitions", "auto")
    return FORMATS[fmt](b, clips)
