---
name: reel-engine
description: Viral short-form engine for your brand (see BRAND_* env vars). Turns dropped footage (one-shots, many-shot dumps, talking-to-camera, podcast takes) into batches of IG Reels / TikTok variants with different hooks, text, formats, looks and music to A/B test, then learns from posted performance. Use when asked to make reels, TikToks, cut footage, generate hook variants, run the reel queue, or read what's winning.
---

# Reel Engine

Footage in → many test-ready vertical videos out → metrics back → next batch leans into what wins.
Built from two sources: the /brag creative laws (latent-spaces/brag, brag-slim on Opus 5.5) and the
"Claude Code as video editor" workflow (transcribe first, lock the cut, motion text, checks before posting).

`<skill-dir>` is this folder. Engine: `<skill-dir>/engine` (Python 3.10+, ffmpeg, numpy, opencv, pillow;
optional faster-whisper for captions). Run with `PYTHONPATH=<skill-dir> python -m engine ...`.

## The loop

1. **Ingest** — clips land in the input folder (CMO Desk drop zone → `POST /upload`, or a local folder).
   Stars from the user mark heroes; a starred clip gets the hook shot and the final shot.
2. **Read the room** — pull current trends (Reel Radar feed, see `references/trends.md`) and the
   leaderboard (`POST /learn`). Never repeat a losing hook; always keep ~30% of slots for new ideas.
3. **Write the batch** — Claude writes the hooks/copy (`references/hooks.md`) and picks formats
   (`references/formats.md`). Express it as a job (`references/contract.md`): explicit `variants`
   and/or a `matrix` of formats × hooks × looks. Hook tests change ONLY the first 2s text, so the
   result isolates the hook.
4. **Render** — `python -m engine run job.json -o out/` (or `POST /jobs`). Analysis is cached per file.
5. **Check** — run the pre-post checklist below on every variant; fix and re-render the failures.
6. **Deliver** — per variant: `<id>.mp4` (music baked), `<id>_bare.mp4` (no music, for adding the
   trending sound in-app), `<id>.jpg` poster (already baked as frame 0), `<id>.txt` caption + tags.
7. **Learn** — after 48-72h the desk logs views / avg watch / shares / saves per post →
   `/learn` returns the leaderboard and the next matrix.

## Creative laws (non-negotiable, inherited from /brag)

- **The hook is everything.** First 2s decide the video. Hook text is on frame 0, over the best shot.
- **Readable.** Pace comes from cuts, never from yanking text. Any line holds ≥0.3s/word (min 0.8s)
  once fully on screen. The engine warns when a plan breaks this; fix the copy, don't ignore it.
- **Every cut on the beat** of the chosen audio (or of the trending sound used as a timing track).
- **Show the place.** Real footage only — no stock filler, no invented claims, no fake reviews or numbers.
- **Specific, not generic.** Banned: "hidden gems you need to see", "you won't believe", "bucket list".
  Name the place, the thing, the feeling. Follow your brand angle (BRAND_PITCH, knowledge/brand-voice.md).
- **Every frame postable.** Poster = strongest settled frame.
- **Short.** Montage 8-15s, one-shot 6-10s, list 12-18s, talking 15-45s. Loops beat length.

## Audio policy

Trending sounds can't be baked in (licensing, and IG/TikTok only credit sounds added in-app).
So: cut to the trend's beat using a local copy as `timing_track`, ship `<id>_bare.mp4`, and the
poster adds the sound in-app aligned at 0:00. Baked music must be licensed: bundled tracks are
Sascha Ende CC BY 4.0 (credit "Music: Sascha Ende, ende.app"), `synth:cinematic|warm|tense` is generated.

## Pre-post checklist (from the guide's "checks before anything goes out")

- Hook readable on a phone at arm's length in the first second; nothing under the bottom 24%
  (captions/buttons) or the right 14% (like/share rail). Safe zone is enforced in `engine/text.py`.
- No text warnings in the manifest; no flash frames of black; no cut mid-word in talking formats.
- Audio: −14 LUFS integrated, no clipping, music ducks under voice.
- Duration matches the format target; first frame = poster; file ≤ 19 MB.
- Caption: first line restates the hook differently; 3-5 specific hashtags, not 30.
Look at stills (start, each cut, mid-transition, end card) before calling a batch done.

## Formats at a glance (details in references/formats.md)

`oneshot` · `montage` (fast/medium) · `cinematic` (letterbox, serif, slow) · `pov` · `reveal` ·
`list` (numbered spots) · `talking` (jump cuts + karaoke captions) · `podcast` (topic bar + b-roll cutaways)

## When transcription is unavailable

Talking formats fall back to silence-based cuts and spread a provided `script` across the speech for
captions (approximate). Say so in the manifest notes; real word timing needs faster-whisper on the worker.
