// Sentry integration webhooks (internal integration → webhook URL /api/webhooks/sentry).
// Signature: HMAC-SHA256(raw body, client secret) hex in `sentry-hook-signature`.
import crypto from "node:crypto";
import type { Incident, Repo, Severity } from "@engine/db";
import { missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

export function verifySentrySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const LEVEL: Record<string, Severity> = { fatal: "critical", error: "error", warning: "warn", info: "info", debug: "info" };

interface SentryIssue {
  id: string; title: string; culprit?: string; shortId?: string; level?: string; count?: string | number;
  userCount?: number; firstSeen?: string; lastSeen?: string; permalink?: string; web_url?: string;
}

/** Upsert an incident from an issue / event_alert / error webhook. Returns the incident and whether it is new. */
export async function upsertSentryIncident(repo: Repo, resource: string | null, payload: { action?: string; data?: Record<string, unknown> }): Promise<{ incident: Incident; isNew: boolean } | null> {
  const data = payload.data ?? {};
  const ev = data.event as (Partial<SentryIssue> & { issue_id?: string | number }) | undefined;
  const issue: SentryIssue | null = (data.issue as SentryIssue | undefined)
    ?? (ev?.issue_id ? { id: String(ev.issue_id), title: ev.title ?? "Sentry event", culprit: ev.culprit, level: ev.level, web_url: ev.web_url } : null);
  if (!issue?.id) return null;
  const fingerprint = `sentry:${issue.id}`;
  const [existing] = await repo.list("incidents", { eq: { fingerprint } });
  const now = new Date().toISOString();
  const resolved = resource === "issue" && payload.action === "resolved";
  const patch: Partial<Incident> = {
    source: "sentry", severity: LEVEL[issue.level ?? "error"] ?? "error", title: issue.title,
    body: issue.culprit ?? null,
    payload: { resource, action: payload.action, shortId: issue.shortId, culprit: issue.culprit, url: issue.web_url ?? issue.permalink, raw: data },
    occurrences: Number(issue.count ?? (existing ? existing.occurrences + 1 : 1)),
    users_affected: issue.userCount ?? existing?.users_affected ?? 0,
    last_seen: issue.lastSeen ?? now,
    ...(resolved ? { status: "resolved", resolved_at: now } : {}),
  };
  if (existing) {
    await repo.update("incidents", { fingerprint }, patch);
    return { incident: { ...existing, ...patch } as Incident, isNew: false };
  }
  const [incident] = await repo.insert("incidents", [{
    id: crypto.randomUUID(), fingerprint, status: "open", proposed_fix: null, first_seen: issue.firstSeen ?? now, resolved_at: null, ...patch,
  }]);
  return { incident, isNew: true };
}

export function sentryConnector(ctx: ConnectorContext): Connector {
  const req = ["SENTRY_CLIENT_SECRET"];
  return {
    id: "sentry", label: "Sentry", requiredEnv: req, implemented: true, docs: "https://docs.sentry.io/organization/integrations/integration-platform/webhooks/",
    async test() {
      const miss = missingEnv(ctx.env, req);
      if (miss.length) return notConfigured(miss);
      return { status: "connected", detail: "Webhook secret set; events arrive at /api/webhooks/sentry" };
    },
    async sync() {
      // Push-based: nothing to pull.
    },
  };
}
