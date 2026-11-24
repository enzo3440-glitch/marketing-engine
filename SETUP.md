# SETUP.md: instructions for your AI

> **To the AI reading this (Claude Code or similar):** you are setting up Marketing Engine for a person who may not be
> technical. Go one step at a time. At each step, say in plain words what you're about to do and why, do it (or tell
> them exactly what to click when it happens in a browser), then run the **Check** before moving on. If a check fails,
> fix it before continuing. Never skip ahead.
>
> **Ground rules for the whole setup:**
> - Never print, echo, paste or commit the contents of `.env`, an access token or a password. To confirm a value is set,
>   check that it's non-empty (e.g. `grep -c '^META_ACCESS_TOKEN=.\+' .env`), never show it.
> - The person types tokens and passwords into `.env` or a browser themselves. Don't ask them to paste a token into chat.
> - No Anthropic API key. The desk runs Claude Code headless (`claude -p`) on the person's signed-in subscription.
>   `ANTHROPIC_API_KEY` must be unset in their shell and absent from `.env`.
> - Nothing is posted publicly until step 10, and only after the person clicks Approve on Launch.
> - Commands below are written for macOS/Linux shells. On Windows, use the PowerShell equivalents.

---

## Step 1. Install the prerequisites

Install whatever is missing:

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 20 or newer | runs the desk (Next.js) |
| pnpm | 9.15 | installs the desk's packages (`npx pnpm@9.15.0` works with no install) |
| Python | 3.11 or newer | runs the reel engine |
| ffmpeg + ffprobe | any recent | renders video |
| Git | any | to get updates |
| Claude Code | latest | the desk's editor, taste maker and marketing advisor |

On macOS: `brew install node python ffmpeg git`. On Windows: `winget install OpenJS.NodeJS.LTS Python.Python.3.12 Gyan.FFmpeg Git.Git`.
Claude Code: see https://docs.claude.com/claude-code (the desktop app or `npm install -g @anthropic-ai/claude-code`).

Then, from the repo root:

```bash
npx -y pnpm@9.15.0 install
python -m pip install -r services/reel-engine/requirements.txt
cp .env.example .env
```

**Check:** `node -v` ≥ 20, `python --version` ≥ 3.11, `ffmpeg -version` and `ffprobe -version` both print a version,
`pnpm install` finished without errors, and `.env` exists. `.env` must appear in `git status --ignored` as ignored, never as new.

## Step 2. Sign in to Claude (subscription login, no API key)

1. The person runs `claude` once in a terminal and signs in with their Claude account (Pro or Max; Max is recommended,
   the desk reads every clip and writes every script with it).
2. Make sure no API key is set: `echo ${ANTHROPIC_API_KEY:+set}` should print nothing. If it prints `set`, remove the
   key from their shell profile. The desk also strips it before every run.
3. If `claude` isn't on PATH for the desk, put the full path in `.env` as `CLAUDE_CLI=`.

**Check:** `claude -p "Reply with the single word: ready"` prints `ready` without asking for a key.

## Step 3. Get Instagram and a Facebook Page ready

The Instagram API only works for **professional** accounts linked to a **Facebook Page**.

1. In the Instagram app: Settings → Account type and tools → Switch to professional account (Creator or Business).
2. Create a Facebook Page for the brand if there isn't one (facebook.com/pages/create).
3. Link them: Instagram → Settings → Accounts Center, or on the Page: Settings → Linked accounts → Instagram.
4. Make sure the person has a Meta Business portfolio (business.facebook.com) that owns the Page, and an ad account
   (Business settings → Accounts → Ad accounts) with a payment method, if they want ads.

**Check:** in Meta Business Suite, the Page and the Instagram account both show under the same business, and the ad account is listed.

## Step 4. Create a Meta app and get a token

1. Go to developers.facebook.com → My Apps → Create app. Pick **Other** → **Business** type. Connect it to their business portfolio.
2. Add the products **Instagram** (Instagram API with Facebook login) and **Marketing API**.
3. Create a **system user** token (most durable): business.facebook.com → Business settings → Users → System users →
   Add (Admin) → Assign assets: the Page (full control), the Instagram account, the ad account (manage) and the app.
   Then **Generate new token** for the app, expiry **Never**, with these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `instagram_manage_insights`
   - `instagram_manage_contents`
   - `ads_management`
   - `ads_read`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`

   (Alternative for testing only: Graph API Explorer → pick the app → add the same permissions → Generate Access Token,
   then exchange it for a long-lived token. It expires in ~60 days.)
4. The person pastes the token into `.env` as `META_ACCESS_TOKEN=` themselves, in their editor. Not in chat.

**Check:** paste the token into the Access Token Debugger (developers.facebook.com/tools/debug/accesstoken) in the
browser. It shows **Valid**, the nine scopes above, and the expiry they chose. Then confirm `.env` has a non-empty
`META_ACCESS_TOKEN` without printing it.

## Step 5. Find the three ids

Run these with the token read from `.env` (so it never appears on screen). Example in bash:

```bash
set -a; . ./.env; set +a
curl -s "https://graph.facebook.com/v24.0/me/accounts?fields=id,name,instagram_business_account&access_token=$META_ACCESS_TOKEN"
curl -s "https://graph.facebook.com/v24.0/me/adaccounts?fields=id,name,account_status&access_token=$META_ACCESS_TOKEN"
```

- `META_PAGE_ID` = the Page's `id` from the first call.
- `META_IG_USER_ID` = `instagram_business_account.id` on that same Page.
- `META_AD_ACCOUNT_ID` = the ad account's `id` (starts with `act_`; keep the prefix or not, both work). `account_status` 1 means active.

The person (or you, since these ids aren't secrets) writes them into `.env`. Also set `META_DEFAULT_LINK` (where ad
buttons go), `META_COUNTRIES` (e.g. `US,CA`) and a safe `META_MAX_DAILY_BUDGET` (the desk refuses anything above it).

**Check:** `curl -s "https://graph.facebook.com/v24.0/$META_IG_USER_ID?fields=username,followers_count&access_token=$META_ACCESS_TOKEN"`
returns their Instagram username. If it says "Unsupported get request", the IG id or the Page link is wrong: go back to step 3.

## Step 6. Fill in the rest of `.env`

Walk through `.env.example` line by line with the person:

- **Brand:** `BRAND_NAME`, `BRAND_PITCH`, `BRAND_NICHE`, `BRAND_GOAL`, `BRAND_IG_HANDLE` (and optionally `BRAND_TAGLINE`, `BRAND_CTA`).
- **Engine:** `VIDEO_ENGINE_URL=http://127.0.0.1:8787`; `REEL_TOKEN` = a long random string you generate
  (`openssl rand -hex 24` or `python -c "import secrets;print(secrets.token_hex(24))"`), written straight into `.env`
  without printing it; `AUTOPILOT_ROOTS` = the folder(s) where they keep their own footage.
- **Trends (optional):** `DESK_TREND_ACCOUNTS` = 5-15 big Instagram accounts in their niche, comma-separated, no @.
- **Posting switches:** leave `DESK_TRIAL_POSTING=off` for now. It's switched on in step 10.
- Leave the Supabase block empty unless they want a hosted database (without it, data stays on this machine).

**Check:** every Brand, Meta and Engine line is non-empty (count them, don't print them), and `ANTHROPIC_API_KEY` isn't in `.env`.

## Step 7. Seed the brand voice and the first ideas

This is the most important step: every idea, script, edit and re-cut reads these files.

1. Interview the person for 10-15 minutes: what the product is, who it's for, the one-line promise, how it should feel,
   lines that sound like them, words they hate, what footage they have, which features are real. Ask for 3-5 accounts
   or posts they admire and why.
2. Fill in `services/reel-engine/knowledge/brand-voice.md` (keep the section headings; the desk looks up
   `## The cinematic look` and `## Founder notes` by name) and `services/reel-engine/knowledge/brand-content.md`.
   Write it in their words. Read it back to them and fix what they say is off.
3. Leave `what-works.md` and `niche-trends.md` as they are: the lab and the trend reader write those from real results.
4. Optionally, read `packages/advisor/skill/marketing-advisor/SKILL.md` and its references for the marketing advisor's
   method, and adapt `references/marketing-plan.md` to their goals.

**Check:** no `[bracket]` placeholders remain in brand-voice.md or brand-content.md (`grep -n '\[' ...` shows only real
text), and the person has said "yes, that sounds like us".

## Step 8. First build and run

Open two terminals.

```bash
# Terminal 1: the reel engine
cd services/reel-engine
python -m engine.server --root reel-data --host 127.0.0.1 --port 8787
# (Windows: services\reel-engine\run-local.cmd)
```

```bash
# Terminal 2: the desk (build once, then serve)
npx -y pnpm@9.15.0 desk          # = build apps/web, then start on http://localhost:3000
# For development with hot reload instead: npx -y pnpm@9.15.0 dev
```

**Check:** http://localhost:3000 opens. Settings → Integrations shows Meta and the reel engine as connected (green).
`curl -s http://127.0.0.1:8787/health` (with the bearer token if set) answers. If Meta shows `not_configured`, a
`META_*` line is empty; if it shows an error, re-run the step 5 check.

## Step 9. First ideas and first video

The desk's flow is **Ideas → Make → Launch → Results**, with one approval before anything goes public.

1. **Ideas:** click **Generate ideas**. Claude writes ideas from brand-voice.md, the trends and (later) what has won or
   been killed. Pick one with the person, or add their own.
2. **Make:** upload 5-20 of their best clips (or point `AUTOPILOT_ROOTS` at a footage folder). The desk reads each clip
   with Claude, then **Make video** cuts a reel from the idea. You can also **Upload a finished video** they made elsewhere.
3. Watch the result with them. Use **Tweak it** (e.g. "Make the opening line land faster") until they like it, then
   **Add to Launch**.

**Check:** the video plays on Launch with a sensible script and caption, and there's no editing note, file name or
placeholder text on screen.

## Step 10. First post from Launch

1. Explain what posting does: a **trial reel** goes to non-followers first (no risk to the grid); **Post** shares to the
   grid and followers. Ads create a paused campaign in their ad account, then switch on with the dates and budget they approve.
2. Switch posting on: set `DESK_TRIAL_POSTING=on` (and `DESK_TRIAL_BATCH=on` for the daily trial reels) in `.env`, then restart the desk.
3. The person clicks **Approve** on Launch themselves. Nothing posts without it.

**Check:** the reel appears on their Instagram (trial reels show under Professional dashboard → Trial reels), and Launch
shows it as live. After 48-72 h, **Results** shows reach, skip rate and saves+shares.

---

## What happens next (explain this to the person)

- **Results** reads Instagram and Meta numbers. **Reach comes first**; saves and shares only count past 500 reach
  (`DESK_ACT_REACH`).
- The **optimizer** (`apps/web/lib/optimize.ts`) spots weak videos and proposes a re-cut or a pause. Each proposal waits
  for one click.
- The **lab** (`apps/web/lib/lab.ts`) treats every re-cut as a scored experiment: a hypothesis that must cite something
  learned, a verdict that must beat chance, and a playbook (`what-works.md`) rewritten from the results at least daily.
- **Idea lessons** (`apps/web/lib/idea-feedback.ts`) learn from killed and winning videos (weighted above the owner's own
  deletes), so ideas get better over time.
- A new version of a video retires the old one automatically (its ads paused, the old trial reel deleted).
- Add standing asks under `## Founder notes` in brand-voice.md whenever something bugs them. Those notes always win.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Claude didn't answer" | Claude Code isn't signed in, or `CLAUDE_CLI` points to the wrong file. Re-run step 2's check. |
| Meta error 190 | The token expired or was revoked. Generate a new one (step 4). |
| Meta error 10 / 200 | A permission is missing from the token. Check the nine scopes in the debugger. |
| "Unsupported get request" on the IG id | The Instagram account isn't professional or isn't linked to the Page (step 3). |
| Renders fail with ffprobe errors | ffmpeg/ffprobe aren't on PATH for the engine's terminal. |
| Narration step fails | `NARRATION_VOICE` isn't set. It needs a Piper `.onnx` voice you have the right to use (optional feature). |
