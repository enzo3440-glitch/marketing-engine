// Supabase: Management API for project health; daily signups from the app's auth.users.
// The app project can differ from the ops warehouse (APP_SUPABASE_* falls back to SUPABASE_*).
import { createClient } from "@supabase/supabase-js";
import { hstDay, httpJson, missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

export function supabaseConnector(ctx: ConnectorContext): Connector {
  const req = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF"];
  const mgmt = <T>(path: string) =>
    httpJson<T>(`https://api.supabase.com/v1/projects/${ctx.env.SUPABASE_PROJECT_REF}${path}`, {
      headers: { Authorization: `Bearer ${ctx.env.SUPABASE_ACCESS_TOKEN}` },
    });

  return {
    id: "supabase", label: "Supabase", requiredEnv: req, implemented: true, docs: "https://supabase.com/docs/reference/api",
    async test() {
      const miss = missingEnv(ctx.env, req);
      if (miss.length) return notConfigured(miss);
      const health = await mgmt<{ name: string; healthy: boolean; status: string }[]>("/health?services=auth&services=db&services=rest&services=storage");
      const bad = health.filter((h) => !h.healthy);
      return bad.length ? { status: "error", detail: `Unhealthy: ${bad.map((b) => `${b.name} (${b.status})`).join(", ")}` } : { status: "connected" };
    },
    async sync(since) {
      const url = ctx.env.APP_SUPABASE_URL ?? ctx.env.SUPABASE_URL;
      const key = ctx.env.APP_SUPABASE_SERVICE_ROLE_KEY ?? ctx.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return;
      const app = createClient(url, key, { auth: { persistSession: false } });
      const counts = new Map<string, number>();
      for (let page = 1; ; page++) {
        const { data, error } = await app.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        for (const u of data.users) {
          if (Date.parse(u.created_at) < since.getTime()) continue;
          const d = hstDay(u.created_at);
          counts.set(d, (counts.get(d) ?? 0) + 1);
        }
        if (data.users.length < 1000) break;
      }
      await ctx.repo.upsert("metrics_daily", [...counts].map(([date, value]) => ({ date, metric: "signups", value, source: "supabase" })), "date,metric,source");
      ctx.log?.(`supabase: signups for ${counts.size} days`);
    },
  };
}
