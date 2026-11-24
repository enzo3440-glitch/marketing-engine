import { upsertSentryIncident, verifySentrySignature } from "@engine/connectors";
import { getRepo } from "@engine/db";

// Sentry internal integration webhook. Signature is checked against SENTRY_CLIENT_SECRET;
// with no secret configured the endpoint refuses everything (mock mode has no live feed).
export async function POST(req: Request) {
  const secret = process.env.SENTRY_CLIENT_SECRET;
  if (!secret) return Response.json({ error: "SENTRY_CLIENT_SECRET not configured" }, { status: 503 });
  const raw = await req.text();
  if (!verifySentrySignature(raw, req.headers.get("sentry-hook-signature"), secret)) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const resource = req.headers.get("sentry-hook-resource");
  if (resource === "installation") return Response.json({ ok: true });
  const result = await upsertSentryIncident(getRepo(), resource, JSON.parse(raw));
  return Response.json({ ok: true, incident: result?.incident.id ?? null, new: result?.isNew ?? false });
}
