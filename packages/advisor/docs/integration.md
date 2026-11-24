# Integration contract

## Host components
1. Authenticated operations backend exposes POST `/marketing/propose`, `/marketing/ideate`, `/marketing/feedback` and read-only evidence routes. These are suggested host routes, NOT installed endpoints.
2. Provider adapter implements `generate(request) -> structured JSON`. It chooses any model server-side and validates responses. Return no secrets or arbitrary HTML. Configure model name/version and token/time/cost limits; allow cancellation.
3. Evidence adapter implements `getMany(ids)` scoped to the authenticated tenant. Normalize authorized social metrics into observation records. Save raw display and exact metric names, timestamps, source links, scope, paid status and precision. Reject future timestamps and contradictory IDs in host ingestion.
4. Editor adapter emits creative IDs/versions and artifact references after generation. These refs are not permission to fetch arbitrary URLs. Host resolves allowlisted tenant-owned assets; reviewer inspects actual video/audio and submits attested review with evidence spans. No automatic full-review claim from a transcript.
5. Feedback adapter appends immutable scoring, publication and outcome events. Use transactional expectedRevision, dedupe event IDs, freeze score before outcomes. Never retroactively label a forecast.
6. Scheduler invokes `collectSignals` using authorized source adapters. Preserve lastSuccessfulAt and lastAttemptedAt. Use backoff for rate limits and stop on mandatory access restrictions. Do not silently enable new recurring jobs; integrate with existing owner-approved schedule.

## Whiteboard handoff
The separately delivered whiteboard supports `window.BrainstormAdapter = async ({version,prompt,map}) => ({nodes,edges})` and `window.MarketingMap.requestBrainstorm(prompt)`. Its proposals require review then Apply. `whiteboardAdapter` in this starter returns advisor recommendations and empty graph changes intentionally: the host must map campaign drafts into valid graph nodes/edges and keep the existing review/apply step. It is not a complete drop-in graph generator.

A node should retain title, channel, hook, visual, audio, overlay, CTA, hypothesis, note, plus `advisor` metadata (rubricVersion, evaluatedAt, evidenceIds, kind, score, confidence). Do not overwrite hand-edited concepts with a new score. Keep scores in a sidecar keyed by node ID and creative version. Link ideas→planned creatives→published media/ad IDs→outcomes explicitly.

## Embed panel
Serve `ui/advisor-panel.js` from your app and import it as a module. Add `<marketing-advisor></marketing-advisor>`. Set `panel.adapter = request => yourAuthenticatedBackend(request)` and `panel.context` to selected node/creative and permitted evidence IDs; call `panel.render()` after adapter assignment. The panel uses textContent for model output. It only displays proposals, never mutates the graph or publishes.

## Model-neutral tool catalog (host must implement)
- get_product_facts, get_brand_brief: verified features and claim boundaries.
- get_evidence, get_creative, get_outcomes: tenant-scoped read-only records.
- inspect_video: authorized asset review with actual modalities/time spans; host verifies depth.
- propose_campaigns, evaluate_creative: draft outputs only.
- append_feedback: validated immutable event, expectedRevision.
- propose_whiteboard_changes: reviewable node/edge draft, not direct apply.
There is deliberately no spend, publish, credential or permission-changing tool.

## Rollout
A: use skill+manual evidence and copyable prompts now. B: connect model and product/DB records, compare outputs against human review. C: connect permitted collectors/video inspection and fixed-horizon outcomes. D: hold out future campaigns, assess calibration and only then version rubric changes. Avoid claims of predictive learning until evidence beats simple baselines out of sample.
