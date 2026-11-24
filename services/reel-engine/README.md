# Reel Engine

Footage in -> batches of IG Reels / TikTok test variants out -> metrics back -> next batch.
See SKILL.md (workflow + creative laws), references/contract.md (CMO Desk integration),
references/formats.md, hooks.md, trends.md.

Quick start:
    pip install -r requirements.txt          # + ffmpeg on PATH
    PYTHONPATH=. python -m engine run job.json -o out/
    PYTHONPATH=. python -m engine.server --root reel-data --port 8787

Credits: creative laws adapted from /brag (latent-spaces/brag, MIT). Bundled music: "Happy Beats /
Business Moves" by Sascha Ende, ende.app, CC BY 4.0. Fonts: Anton, Bebas Neue, Archivo Black,
Montserrat, DM Serif Display, Playfair Display, Pacifico (SIL OFL, via Fontsource).
