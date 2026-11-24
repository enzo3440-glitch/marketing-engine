import { anthropicConnector } from "./anthropic";
import { githubConnector } from "./github";
import { railwayConnector } from "./railway";
import { reelEngineConnector } from "./reel-engine";
import { sentryConnector } from "./sentry";
import { appStoreConnector, googleCloudConnector, googleWorkspaceConnector, metaConnector, tiktokConnector } from "./stubs";
import { supabaseConnector } from "./supabase";
import type { Connector, ConnectorContext, Status } from "./types";

export * from "./types";
export { verifySentrySignature, upsertSentryIncident } from "./sentry";
export { GitHub, githubFromEnv } from "./github";
export { MetaAds, MetaApiError, type MetaAccount } from "./meta-ads";
export { ReelEngine, stubManifest, type EngineJob, type EngineManifest, type EngineVariant, type Library, type LibraryItem, type ReviseInfo } from "./reel-engine";

export function createConnectors(ctx: ConnectorContext): Connector[] {
  return [
    anthropicConnector(ctx), railwayConnector(ctx), supabaseConnector(ctx), sentryConnector(ctx),
    googleCloudConnector(ctx), appStoreConnector(ctx), metaConnector(ctx), tiktokConnector(ctx),
    googleWorkspaceConnector(ctx), githubConnector(ctx), reelEngineConnector(ctx),
  ];
}

/** Run test() and persist the result to ops.integrations. */
export async function testAndRecord(c: Connector, ctx: ConnectorContext): Promise<Status> {
  let s: Status;
  try {
    s = await c.test();
  } catch (e) {
    s = { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  await ctx.repo.upsert("integrations", [{
    provider: c.id, status: s.status, last_error: s.status === "error" ? s.detail ?? null : null,
    last_sync_at: s.status === "connected" ? new Date().toISOString() : null, config: { detail: s.detail ?? null },
  }], "provider");
  return s;
}
