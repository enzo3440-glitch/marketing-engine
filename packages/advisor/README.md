# Marketing Advisor · portable starter

A model-neutral marketing strategist/creative director and evaluation toolkit for your company CMO desk. It is NOT a deployed autonomous agent, a trained model, or a live connection to Claude/Meta/TikTok. Use it inside the operations app being built by your other bot.

## What works now
- Portable `skill/marketing-advisor/SKILL.md` plus evaluation/channel references.
- Original campaign ideation prompt and structured draft validation, including emotional drivers, app proof, community/belonging, channel variants and success metrics.
- Transparent idea/readiness rubric, observed view momentum with abstention, attributed cost metrics and descriptive holdout evaluation.
- Provider-neutral proposal engine with evidence-ID validation; unconnected mode by default.
- Revision-checked append-only local feedback ledger; replace with your database adapter in production.
- Host-driven trend collector contract preserving last-good results on failure. No background job installed.
- Small embeddable `<marketing-advisor>` UI with connected/unconnected states. It never publishes or spends.

## Run
Node22+; no dependencies or installation required. From this folder: `npm test`, then `npm run demo`. Tests are local and make no network requests. The demo intentionally shows unconnected/insufficient-evidence states.

## Give this to Claude or another coding bot
“Integrate this package into our authenticated operations app. Preserve its missing-data, evidence, score separation and review/apply safeguards. Implement server-side provider, tenant-scoped database and video-inspection adapters using our existing infrastructure. Keep secrets server-side. Do not enable ad publishing, spending, new credentials or external access without my approval. Use README and docs/integration.md; run tests before changing rubric behavior.”

The assistant identity/runtime from ChatGPT is not exported. These are portable instructions and code that your chosen model can use. You do not need a specific model provider. No proprietary marketing-book corpus or fine-tuning is included.

## Real integration still required
Your operations repo/stack, DB schema, authenticated API routes, chosen model/provider, authorized analytics sources and video asset access were not supplied. The included contracts and sample payloads let your builder wire these without guessing. This package does not inspect video bytes or fetch live social data on its own. The host must attest actual inspection depth; a JSON flag alone is not independent proof.

Existing Radar schedules remain separate and unchanged by this package. The owner has an outside-signals check configured elsewhere every4hours; do not duplicate it. To run here, attach `collectSignals` to the host scheduler and allowed source adapters, respecting rate limits/terms. A scheduler process/service must remain running for background work; the browser panel alone is not an always-on agent.

## Production security
No public HTTP server is bundled. Authenticate and authorize every host route, enforce tenant boundaries/CSRF/rate limits/request sizes, validate supplied URLs and schemas, and keep model credentials on the server. Treat captions/transcripts/LLM output as untrusted text. Never let it select arbitrary tools, network destinations or executable code. Use read-only evidence tools. Enforce review/apply for map changes; spending/publishing are not in the tool set.

FileLedger is single-host reference storage with an exclusive lock and atomic rename. Production use should use DB transactions with expectedRevision, backups and access controls. A crashed process can leave a lock; investigate the writer before manually removing it. Do not use this local store as a distributed database.

## Honest scoring
Scores are editorial checklist numbers, not viral probability. Momentum is views/hour, not future acquisition. Business results require exact attribution. Feedback evaluation is descriptive and does not automatically retrain or change weights. The schema and tests enforce important abstentions, but cannot prove that a supplied review/source is truthful. See skill references for the human/host responsibilities.
