# Marketing Engine

An AI marketing desk for one brand's Instagram and Meta ads. It turns your own footage into reels and video ads,
posts them from one place with one approval, reads the results, re-cuts what's weak as scored experiments, and writes
down what it learns in a playbook that every later video follows.

It runs on your own computer, with your own Claude subscription (Claude Code, no API key) and your own Meta account.

## What's inside

- **The desk** (`apps/web`, Next.js): **Ideas → Make → Launch → Results**.
  - *Ideas* come from your brand voice, today's top reels in your niche, and lessons from videos that won or were killed.
  - *Make* reads your clips with Claude and cuts reels and ads (editor + taste maker), or takes a finished video.
  - *Launch* posts trial reels, grid posts and ads after one **Approve**. A new version retires the old one.
  - *Results* shows reach first; saves and shares only count past 500 reach.
- **Optimizer** (`apps/web/lib/optimize.ts`): finds weak videos and proposes re-cuts or pauses, each waiting for one click.
- **Lab** (`apps/web/lib/lab.ts`): every re-cut is a hypothesis that must cite learned evidence; verdicts must beat
  chance; the playbook `services/reel-engine/knowledge/what-works.md` is rewritten from real results.
- **Reel engine** (`services/reel-engine`, Python + ffmpeg): plans, cuts, grades, captions and renders.
- **Marketing advisor** (`packages/advisor`): a model-neutral rubric for momentum, ideation and an evidence ledger.
- **Connectors** (`packages/connectors`): Instagram Graph and Meta Marketing APIs.
- **MCP server** (`packages/mcp`): drive the desk from Claude Code.

## Get started

Open this folder in Claude Code (or another coding AI) and say:

> Read SETUP.md and set this up for me, one step at a time.

It walks you through installing the tools, signing in, creating a Meta app and token, filling `.env`, writing your brand
voice, and posting your first video. Reading it yourself works too.

Quick look with no accounts at all (example data): `npx -y pnpm@9.15.0 install && npx -y pnpm@9.15.0 dev`, then open
http://localhost:3000.

## Your data stays yours

`.env`, `services/reel-engine/reel-data/` (your clips, renders and learning state) and `packages/db/data/private/` are
gitignored. Don't commit them if you fork this repo publicly.

## Notes

- One `.env` in the repo root configures everything (desk, engine, MCP server). Set `DESK_TIMEZONE` to your timezone.
- The bundled Happy Beats tracks are by Sascha Ende (ende.app), CC BY 4.0, not covered by this repo's license. Add your
  own cleared tracks for ads (`services/reel-engine/assets/music/ads/README.md`).
- Fonts in `services/reel-engine/assets/fonts` are from Google Fonts (SIL Open Font License).

## License

See [LICENSE](LICENSE).
