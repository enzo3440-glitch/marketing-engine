# Trends feed (Reel Radar → engine)

The engine reads one file/endpoint, whatever produces it (Reel Radar today, the CMO Desk later):

```json
{
  "updated": "2026-10-25",
  "audio": [{"id": "a1", "name": "…", "platform": "tiktok|ig", "bpm": 118, "url": "…",
             "use": "fast montage, beat drop at 0:07", "local_file": "trends/a1.mp3", "momentum": 0.8}],
  "hooks": [{"text": "…", "framework": "F4", "seen_on": "…", "why": "…"}],
  "formats": [{"name": "…", "map_to": "list|pov|montage|…", "notes": "…"}],
  "text_styles": [{"name": "…", "map_to": "pill|karaoke|…"}]
}
```

How a batch uses it:
- `audio[].local_file` → `timing_track` (cut to its beat), deliver `_bare.mp4`, add the sound in-app.
  Without a local copy use `bpm` to set the grid (`brief.bpm`).
- `hooks` → rewrite in your brand's voice (references/hooks.md); never copy a creator's line verbatim.
- `formats` → map onto a planner; unknown ones go to the ideas queue in formats.md.
- Freshness: ignore audio older than ~10 days for TikTok, ~3 weeks for IG.
