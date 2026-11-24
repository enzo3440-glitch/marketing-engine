# CMO Desk ↔ Reel Engine contract

The desk owns UI and records; the engine owns analysis, planning and rendering. They meet over the
worker API (`engine/server.py`) or by writing `job.json` and calling `python -m engine run`.

## Desk data model (suggested tables)

| table | key fields |
|---|---|
| `reel_clips` | id, file (path under worker `input/`), source (`upload`/`link`/`folder`), kind (`oneshot`/`broll`/`talking`/`podcast`/`screen`/`reference`), star (bool), tags[], thumb, quality, duration, talking_likely, added_at |
| `reel_refs` | id, format, url or file, notes — style references per format (what "good" looks like) |
| `reel_hooks` | id (`h12`), text, framework (F1-F10), source (`claude`/`radar`/`owner`), status (`new`/`testing`/`winner`/`retired`) |
| `reel_jobs` | job_id, status, created_at, matrix/variants JSON, manifest JSON |
| `reel_variants` | id, job_id, format, hook_id, grade, music, file, bare, poster, caption, duration, picked (bool) |
| `reel_posts` | variant_id, platform (`ig`/`tiktok`), url, posted_at, views, avg_watch_s, likes, comments, shares, saves, follows, updated_at |

## Flow

1. **Drop** → `POST /upload?name=` per file (links: desk downloads first only for owned media; references stay links).
2. **Analyze/plan preview** → submit job with `plans_only` via CLI or just submit; manifest returns per-clip `quality`, `thumb`, `talking_likely`, best windows — use these to auto-tag `kind` and pre-select heroes.
3. **Batch builder** → user picks formats, hooks (from `reel_hooks`, + "generate 6 more" via Claude), looks, music/timing track, count. Desk posts:
   ```json
   {"job_id": "weekend-2026-01-15", "clips": [{"id":"c1","path":"beach.mp4","star":true}],
    "defaults": {"duration": 12, "music": "synth:cinematic", "endcard": true, "hashtags": ["weekend"]},
    "matrix": {"formats": ["montage","oneshot","pov"], "hooks": [{"id":"h1","text":"…"}], "grades": ["teal_orange","film"], "max": 12}}
   ```
4. **Poll** `GET /jobs/<id>` → `status` queued/rendering/done/error; `manifest.variants[]` has file/poster/caption paths → serve via `GET /files/<job>/<name>`.
5. **Gallery** → play, star the keepers, copy caption, download (single or zip of picked), mark posted (platform + URL).
6. **Metrics** → after 48-72h log numbers into `reel_posts` (manual entry or a platform connector later) → `POST /learn {rows, hooks, formats}` → show leaderboard; "Next batch" pre-fills the builder from `next`.

7. **References** → links (IG/TikTok/YouTube) are stored as links only. A dropped reference file goes to
   `POST /upload?name=ref_<name>` then `POST /refs/analyze {"path"}` → `{duration, shots, shot_lengths, avg_shot,
   cuts_per_10s, opening_hold, pacing, format}`. "Use as style" copies format, pacing and length into the builder.
   Uploads may be chunked (streamed); the worker accepts both chunked and Content-Length bodies.

## Rules the desk should enforce
- A hook test = one edit, many hooks. Don't change format and hook in the same comparison.
- Post `_bare.mp4` when using a trending sound; record which sound in `reel_posts`.
- Retire a hook after 3 posts below the platform median; promote to `winner` after 2 above.
- Keep thumbnails/captions in the desk; the engine is stateless apart from its analysis cache.

## Deploy
Any box with ffmpeg + Python 3.10: `pip install -r requirements.txt`, then
`REEL_TOKEN=… python -m engine.server --root /data/reels --host 0.0.0.0 --port 8787`.
Render time scales with cores (~20-40s per 12s variant on 4 cores). Railway works if the volume holds `input/` and `output/`.
