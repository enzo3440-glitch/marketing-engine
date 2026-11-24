"""Director: judge every clip, then cast clips into trend templates so each edit is genuinely different.

Each clip gets role scores (score / hero / establish / detail / people / motion) from its analysis and its
sound. Templates (edit_rules.TEMPLATES) are sequences of role slots measured in beats; the director fills them
with the best-fitting clips, never repeating a clip back to back, and picks the soundtrack by the rules:
one soundtrack per reel; a clip's own music can carry the whole edit; trending sounds drive the templates.

Variance is enforced, not hoped for: slow templates go half-time on fast songs, edits that run out of music lose
middle shots (never the ending), clips are spread across the batch, B/C versions recast the order, and a version
too close to one already made is recast or dropped (RULES["variance"]).
"""
import re

import numpy as np

from .common import BRAND_NAME
from .beats import SR, analyze_track, load_audio
from .edit_rules import RULES, TEMPLATE_BY_ID, TEMPLATES

_audio_cache = {}


def audio_profile(path, dur):
    """How musical a clip's own sound is: loud enough, tonal (low spectral flatness), sustained."""
    if path in _audio_cache:
        return _audio_cache[path]
    out = dict(musical=0.0, start=0.0)
    try:
        y = load_audio(path, 0, min(dur, 60))
    except Exception:
        y = np.zeros(0)
    if len(y) >= SR * 6:
        hop = SR  # 1s frames
        frames = [y[i:i + hop] for i in range(0, len(y) - hop, hop)]
        rms = np.array([np.sqrt((f ** 2).mean()) + 1e-9 for f in frames])
        flat = []
        for f in frames:
            X = np.abs(np.fft.rfft(f * np.hanning(len(f)))) + 1e-9
            flat.append(np.exp(np.mean(np.log(X))) / np.mean(X))
        flat = np.array(flat)
        db = 20 * np.log10(rms)
        good = (db > -36) & (flat < 0.2)  # loud + tonal = music (a quartet ~0.16); crowds, wind, clubs sit at 0.25-0.45
        out["musical"] = float(good.mean()) * min(1.0, len(y) / SR / 12)
        # start of the longest musical run: where the soundtrack should begin
        best, run, s0, start = 0, 0, 0, 0
        for i, g in enumerate(good):
            run = run + 1 if g else 0
            if run == 1:
                s0 = i
            if run > best:
                best, start = run, s0
        out["start"] = float(start)
    _audio_cache[path] = out
    return out


def judge(clips):
    """Role scores per clip, 0..1. Uses the analysed samples (sharpness, motion, shake, faces) + sound."""
    roles = {}
    for cid, c in clips.items():
        m = c["meta"]
        s = m.get("samples") or []
        mot = float(np.mean([x["motion"] for x in s])) if s else 0.0
        shk = float(np.mean([x["shake"] for x in s])) if s else 0.0
        q = float(m.get("quality", 0.4))
        dur = float(m.get("duration", 0))
        faces = float(m.get("face_ratio", 0))
        steady = 1 - min(shk / 6.0, 1)
        moving = min(mot / 12.0, 1)
        prof = audio_profile(c["path"], dur) if m.get("has_audio") else dict(musical=0.0, start=0.0)
        roles[cid] = dict(
            score=prof["musical"] if dur >= 10 else 0.0, score_start=prof["start"],
            hero=q * 0.6 + steady * 0.3 + min(dur / 10, 1) * 0.1,
            establish=q * 0.5 + steady * 0.3 + (1 - moving) * 0.2,
            detail=q * 0.5 + (1 - moving) * 0.3 + steady * 0.2,
            people=faces * 0.6 + q * 0.4,
            motion=moving * 0.5 + q * 0.3 + steady * 0.2,
            any=q, quality=q, steady=steady, duration=dur,
        )
    return roles


def cast(slots, roles, rng, score_clip=None, open_rank=0, avoid=None, batch_used=None):
    """Fill role slots with clips: best fit, small random spread, no clip twice in a row, prefer unused.
    Long clips can give several different shots (the planner takes a fresh window each time).
    open_rank picks the 1st/2nd/3rd best opening (hook) shot, for A/B tests of the first image.
    avoid: {slot index: clip} from the baseline, so test versions don't repeat it shot for shot.
    batch_used: clip -> times used by earlier versions in this batch, so a batch spreads across all clips."""
    seq, used, last = [], {}, None
    avoid, batch_used = avoid or {}, batch_used or {}
    for si, (role, beats) in enumerate(slots):
        if role == "score" and score_clip:
            seq.append(dict(clip=score_clip, beats=beats, sync=True))
            last = score_clip
            continue
        cands = []
        for cid, r in roles.items():
            if cid == last and len(roles) > 1:
                continue
            if cid == score_clip:  # the score's source appears only as the motif, in sync
                continue
            shots_in_clip = max(1.0, r["duration"] / 6.0)  # a 18s clip holds ~3 distinct shots
            fit = r.get(role, r["any"]) + rng.uniform(0, 0.06) - used.get(cid, 0) * (0.15 + 0.3 / shots_in_clip)
            fit -= 0.06 * batch_used.get(cid, 0)
            if avoid.get(si) == cid:
                fit -= 0.3
            if beats >= 4 and r["steady"] < 0.5:  # shaky footage never gets a long hold
                fit -= 0.3
            elif beats <= 2 and r["steady"] < 0.5:  # ...but it makes a good quick cut
                fit += 0.08
            cands.append((fit, cid))
        cands.sort(reverse=True)
        cid = cands[min(open_rank, len(cands) - 1)][1] if si == 0 else cands[0][1]
        used[cid] = used.get(cid, 0) + 1
        seq.append(dict(clip=cid, beats=max(1, beats)))
        last = cid
    return seq


def fit_slots(slots, tempo, max_len, pacing):
    """Half-time for slow templates on fast songs, then drop middle shots (never the ending) to fit the music."""
    def fitted(mult):
        out = [(r, b * mult) for r, b in slots]
        spb = 60.0 / tempo
        while len(out) > 3 and sum(b for _, b in out) * spb > max_len:
            mid = [i for i in range(1, len(out) - 1) if out[i][0] != "score"] or list(range(1, len(out) - 1))
            del out[mid[len(mid) // 2]]
        return out
    if (pacing == "cinematic" and tempo >= 96) or (pacing == "medium" and tempo >= 140):
        half = fitted(2)
        if len(half) >= min(5, len(slots)):
            return half, True
    return fitted(1), False


def similarity(a, b):
    """0..1: how alike two versions look and sound (the same shots in the same places weighs most)."""
    sa = [s["clip"] for s in a.get("sequence") or []] or [a.get("hero")]
    sb = [s["clip"] for s in b.get("sequence") or []] or [b.get("hero")]
    pos = sum(x == y for x, y in zip(sa, sb)) / max(len(sa), len(sb))
    shots = len(set(sa) & set(sb)) / max(len(set(sa) | set(sb)), 1)
    look = ((a.get("grade") == b.get("grade")) + (a.get("hook_style") == b.get("hook_style"))
            + (a.get("music") == b.get("music"))) / 3
    return round(0.55 * pos + 0.15 * shots + 0.3 * look, 3)


TOO_CLOSE = 0.72

VARIES = {"A": "baseline", "B": "opening shot + order", "C": "hook + text style + order (+ learned look)",
          "D": "opening shot + order", "E": "hook + text style + order (+ learned look)", "F": "order"}


def _fits_footage(h, place):
    """Saved hooks are only reused when true of any footage: no numbers or prices, no other place's name."""
    if re.search(r"[0-9€£$]", h):
        return False
    words = re.findall(r"(?<![.?!]\s)(?<!^)\b[A-Z][a-z]+", h)
    return all(w in ("I", BRAND_NAME) or (place and w in place) for w in words)


def _hook(t, i, place, pool):
    forms = [h for h in t.get("hooks", []) if "{place}" not in h or place]
    if pool:
        forms = forms + [h for h in pool if _fits_footage(h, place)]
    h = forms[i % len(forms)] if forms else ""
    return h.replace("{place}", place) if place else h


def _tempo(path, start):
    try:
        return float(analyze_track(path, float(start or 0), 30)["tempo"]) or 100.0
    except Exception:
        return 100.0


def direct(spec, clips, sounds):
    """spec: {templates: [ids] | None, per_template: n, hook: str|None, place: str|None, hooks: [pool], seed}.
    sounds: [{path, vibe?}] trending audio. Returns engine briefs (plan inputs)."""
    rng = np.random.default_rng(spec.get("seed", 7))
    roles = judge(clips)
    ids = spec.get("templates") or [t["id"] for t in TEMPLATES]
    per = max(1, min(int(spec.get("per_template", 1)), 6))
    place, pool = spec.get("place"), spec.get("hooks") or []
    score_clip = max(roles, key=lambda c: roles[c]["score"]) if roles else None
    if score_clip and roles[score_clip]["score"] < 0.35:
        score_clip = None
    heroes = sorted(roles, key=lambda c: roles[c]["hero"], reverse=True)
    briefs, notes, batch_used = [], [], {}

    def score_music(b):
        sdur = roles[score_clip]["duration"]
        st = roles[score_clip]["score_start"]
        if sdur - st < 14:  # keep enough of the music to carry the edit
            st = max(0.0, sdur - 16.0)
        b.update(music=clips[score_clip]["path"], music_start=round(st, 2), sfx=False, _max_len=round(sdur - st - 0.3, 2))

    for ti, spec_t in enumerate(ids):
        if isinstance(spec_t, dict):  # {"id": base template, "as": "style-<ref>", "name", "grade", "hooks"}
            base = TEMPLATE_BY_ID.get(spec_t.get("id"))
            if not base:
                continue
            t = dict(base, **{k: v for k, v in spec_t.items() if k in ("name", "grade", "hooks", "vibe") and v})
            tid = spec_t.get("as") or base["id"]
        else:
            t, tid = TEMPLATE_BY_ID.get(spec_t), spec_t
            if not t:
                continue
        made = []
        for n in range(per):
            # trial-reel test set: A = best opening + best hook; B = next-best opening shot + new order;
            # C = another hook in the template's alternate text style + new order
            test = "ABCDEF"[n]
            open_rank = {"B": 1, "D": 2}.get(test, 0)
            alt_text = test in ("C", "E")
            vid = f"{tid}-{test}"
            hook = spec.get("hook") if spec.get("hook") and not alt_text else _hook(t, {"C": 1, "E": 2}.get(test, 0), place, pool)
            hook_style = t["text"][0]["style"] if t["text"] else "caption"
            if alt_text and t.get("alt_style"):
                hook_style = t["alt_style"]
            learned = [g for g in spec.get("looks") or [] if g != t["grade"]]
            grade = learned[(ti + n) % len(learned)] if alt_text and learned else t["grade"]  # C tries a look your references taught
            b = dict(id=vid, template=tid, vibe=t["vibe"], format=t.get("format", "montage"), pacing=t["pacing"],
                     grade=grade, grain=t.get("grain", False), fx=t.get("fx", "clean"), transitions_style="clean",
                     hook=hook, hook_style=hook_style, hook_pos=t.get("hook_pos", "upper"),
                     seed=int(rng.integers(1, 9999)), letterbox=t.get("letterbox", False),
                     build_drop=t.get("build_drop", False), natural="off")
            if t.get("endcard"):
                b.update(endcard=t["endcard"], endcard_style=t.get("endcard_style", "endcard"))
            sound_note, live_score = None, False
            # soundtrack, by the rules
            if t["audio"] == "clip_music":
                if not score_clip:
                    notes.append(f"{t['name']}: none of these clips has music strong enough to carry an edit")
                    break
                score_music(b)
                live_score = True
            elif t["audio"] == "own_or_trending":
                # one-shots: B and C each try a different single shot (a one-shot is its shot)
                long = [c for c in heroes if roles[c]["duration"] >= 6.5] or heroes  # a one-shot needs a 6s+ shot
                h = long[min({"B": 1, "C": 2, "D": 3, "E": 4}.get(test, 0), len(long) - 1)]
                hc = clips[h]
                if hc["meta"].get("has_audio") and audio_profile(hc["path"], hc["meta"].get("duration", 0))["musical"] >= 0.2:
                    b.update(music=hc["path"], music_start=0.0)
                elif sounds:
                    b.update(music=sounds[(n + len(briefs)) % len(sounds)]["path"])
                else:
                    b.update(natural="on")  # its own ambience, no song
                b.update(clips=[h], hero=h, duration=min(12.0, max(6.0, roles[h]["duration"] - 0.5)))
            else:
                if sounds:
                    b["music"] = sounds[(n + len(briefs)) % len(sounds)]["path"]
                elif score_clip and t["vibe"] in ("cinematic", "nostalgic", "calm"):
                    score_music(b)  # until there's a trending sound, the live music in your clips carries it
                    sound_note = "live music from your clips (no trending sound yet)"
                else:
                    notes.append(f"{t['name']}: needs a trending sound (drop the song or a reel that uses it)")
                    break
            if b.get("format") != "oneshot":
                tempo = _tempo(b["music"], b.get("music_start"))
                slots, half = fit_slots(list(t["slots"]), tempo, b.get("_max_len", 45.0), t["pacing"])
                if open_rank and slots[0][0] == "score":  # B test of a score edit: open on a place, then the musicians
                    slots[0], slots[1] = slots[1], slots[0]
                base_seq = made[0].get("sequence") if made else None
                avoid = {i: s["clip"] for i, s in enumerate(base_seq)} if base_seq else None
                for attempt in range(4):
                    b["sequence"] = cast(slots, roles, np.random.default_rng(spec.get("seed", 7) + ti * 31 + n * 7 + attempt * 101),
                                         score_clip if live_score else None, open_rank, avoid,
                                         {c: k * (1 + attempt) for c, k in batch_used.items()})
                    if all(similarity(b, o) < TOO_CLOSE for o in briefs):
                        break
                total_beats = sum(s["beats"] for s in b["sequence"])
                b["duration"] = round(min(45.0, b.get("_max_len", 45.0), total_beats * 60.0 / tempo + 0.3), 2)
                b["half_time"] = half
                lines = []
                for tx in t["text"][1:]:
                    line = _hook(t, n + 1, place, pool)
                    if line and line != hook and tx["slot"] < len(b["sequence"]):
                        lines.append(dict(text=line, shot=tx["slot"], pos=tx["pos"], style=tx["style"], anim="fade"))
                if lines:
                    b["lines"] = lines
            b.pop("_max_len", None)
            close = max(((similarity(b, o), o["id"]) for o in briefs), default=(0, None))
            if close[0] >= TOO_CLOSE:
                notes.append(f"{vid}: skipped, too close to {close[1]} ({close[0]:.0%} alike)")
                continue
            opening = b.get("hero") if b.get("format") == "oneshot" else b["sequence"][0]["clip"]
            b["test_tags"] = dict(template=tid, vibe=t["vibe"], test=test, varies=VARIES[test], opening=opening, hook=hook,
                                  hook_style=b["hook_style"], grade=b["grade"], **({"sound": sound_note} if sound_note else {}))
            for c in ([s["clip"] for s in b.get("sequence") or []] or [b.get("hero")]):
                batch_used[c] = batch_used.get(c, 0) + 1
            briefs.append(b)
            made.append(b)
    pairs = [similarity(a, z) for i, a in enumerate(briefs) for z in briefs[i + 1:]]
    return briefs, dict(notes=notes, score_clip=score_clip, hero=heroes[0] if heroes else None, rules=RULES,
                        variance=dict(max=max(pairs, default=0), mean=round(float(np.mean(pairs)), 3) if pairs else 0),
                        roles={c: {k: round(v, 2) for k, v in r.items()} for c, r in roles.items()})
