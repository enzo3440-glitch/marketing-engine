# For /brag app ads: start from the kit, don't rebuild it

Everything slow that every ad needs is already made, in `reel-data/ads/_kit` (shared by every run, read-only):

- **`library.md` first.** It lists finished ads and the screens each one already built (the product flows and screens it rebuilt). If one has what you need, copy its `work/` folder and change only the
  lines, footage and timings: that's minutes, not a rebuild. Read the app code only for screens none of them have.

- `<example-ad>/`: a finished ad that already rebuilds your product's screens from the app code, with its
  `overlay.html` + `render.js` + `compose.sh` + `sfx.py`, its plan in `brag-plan.md`, and its stills in `img/`. Copy
  what you need into your own folder and change the lines, footage and place for this ad. Only read the app code for a
  screen this ad needs that isn't in there.
- `sound/sfx_kit.py`: the SFX kit every ad uses for its sound bed (taps, air, a soft landing, a warm tuned reward
  pluck, and `room()` for a clip's own real sound). The example ad's sfx.py shows how. Never synthesize your own sparkles,
  shimmers or noise swells (brand-voice.md, Music).
- `sound/find_drop.py <song> <payoff_s>`: finds a song's real drops and prints the `-ss` that lands the drop on
  the hook's turn (the line or image the hook builds to; brand-voice.md, Music). Never guess where the drop is.
- `tools/`: puppeteer-core and ffmpeg-static, installed. Don't npm install.
- `fonts/`: your brand wordmark font, Inter, the icon font css.
- `footage/`: footage.md says what every clip shows (read it first); one 6-frame strip per clip (`<name>.jpg`) and `durations.json` (path + length). Use
  these to choose shots instead of pulling frames from every clip yourself.

## This run is headless
Nothing will wake you up later: run every render in the foreground and wait for it. If you end your turn while a
render runs in the background, the ad is lost. Only finish once out/ad.mp4 is written.
Write script.txt and caption.txt as plain UTF-8 (the Write tool, or Node/Python), not through PowerShell redirects:
those double-encode punctuation ("â€¦" for "…").

## Render fast (the machine is shared: other ads, the engine, sometimes an emulator)
- Use the kit's the example ad's compose.sh as is for a still background: it decodes the still once and pushes in at 1080p.
  Never `-loop 1` a PNG (it re-decodes every frame; phone stills are 16-bit) and never zoompan at 4K.
- Intermediate files: `-preset ultrafast`. Only the final encode uses `-preset medium -crf 18 -maxrate 14M`.
- Choose shots from footage/<name>.jpg strips; pull a full-size frame only for the shots you've chosen.
- Render the overlay once at full fps; check it with a handful of single frames, not a second full render.

## Footage speed
Real video plays as real video. Check a clip's frame rate first (ffprobe r_frame_rate). Slow motion only on clips shot at 60 fps or
more, and never slower than the frames allow (60 fps: at most 2x slower; 120: 4x; 240: 8x), so every output frame is a real frame.
A 30 fps clip plays at normal speed: no setpts stretch, no minterpolate, no frame-stepping, and no stills pulled from it and zoomed
as a fake shot. If a 30 fps clip is too short for its slot, use a longer part of it or another clip, never a slowed one. A push-in on
video, if any, is slow and smooth over the whole shot (or none); photos (stills) get the pan rule in film/film.md.
