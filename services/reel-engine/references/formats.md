# Formats

Each format is a planner in `engine/plan.py`. Brief fields shared by all: `id, format, clips, hero,
duration, hook, hook_style, kicker, lines, line_style, cta, endcard, grade, music, timing_track,
caption, hashtags, seed, sequence`.

| Format | Input | Shape | Default look | Use it to test |
|---|---|---|---|---|
| `oneshot` | 1 great clip (starred or best-scored) | slow push-in 1.0→1.12, slow-mo if ≥48fps, hook → 1-2 lines | `film` + grain | does the place alone stop the scroll |
| `montage` | 3-30 clips | hook shot (hero) held for the read, then beat cuts; flash/whip/zoom transitions, speed ramps | `teal_orange` fast / `tropical` medium | energy + hook |
| `cinematic` | 3+ clips | 2.39 letterbox bars, serif italic hook, 2-4 beat holds, dips, slow-mo | `film` | premium / brand feel |
| `pov` | 1-10 clips | "POV: …" native pill text held long, medium cuts | `tropical` | relatability |
| `reveal` | 3+ clips | tease shots then hard cut to the hero on a strong beat with impact hit | `teal_orange` | payoff curiosity |
| `list` | 3-6 clips | hook, then one numbered spot per shot (whip between), end card | `tropical` | saves (people save lists) |
| `talking` | talking-to-camera clip (+ optional b-roll) | dead air removed, punch-in alternates every cut, karaoke captions, hook pill on top | `clean` | your own voice / opinions |
| `podcast` | same + `topic` | as talking + persistent topic bar, b-roll cutaway every 3rd cut, vignette | `clean` | hot takes, debate bait |

## Pacing
`fast` 124 BPM grid, 1-2 beat cuts · `medium` 104, 1-2 beats · `cinematic` 84, 2-4 beats.
With a music/timing track the track's own beat grid wins. `open_on_drop: true` starts the track at its biggest energy jump.

## Looks (`grade`)
`clean · teal_orange · film · golden · moody · tropical · mono` (+ `grain`, `vignette`, `letterbox`).

## Text styles
`hook` (Anton caps) · `hook_serif` (DM Serif italic) · `pill` (TikTok-native white box) · `kicker`
(small tracked caps) · `caption` · `karaoke` (word-by-word, active word yellow) · `serif` · `list`
(Archivo Black) · `stamp` (yellow box) · `pin` (location pin + place) · `endcard` (brand wordmark, Pacifico).
Animations: `pop · slide · fade · type · words · none`.

## Ideas queue (not yet their own planner — express via montage/oneshot + copy)
- **Expectation vs reality** — tourist-trap shot (top) vs your pick: two-beat structure, `stamp` labels.
- **"Locals sent me to…"** — deadpan bad recommendation, then the real spot.
- **App-in-hand** — screen recording of the app surfacing a place, cut to arriving there. Clip tag `screen`.
  Express it as a `montage` with `sequence: [place, screen, place, …]` (scripted shot order; entries are clip ids or
  `{"clip", "beats"}` to hold a shot, the last runs under the end card; each shot still gets its clip's
  best window and the beat grid; `"start"` pins the source moment). Pin copy to shots with
  `lines: [{"text", "shot", "to", "pos"}]` so screen-recording copy never spills onto the next place.
- **Challenge reveal** — riddle text → photo at the landmark → place reveal.
- **Map pin drop** — `pin` style with place name over each shot; good for saves.
- **Duet/stitch bait** — "Tell me you're a tourist without telling me…" open question, no answer.
