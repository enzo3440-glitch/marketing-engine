// Anthropic Usage & Cost Admin API → ops.api_spend (one row per day per model).
// Needs an Admin API key (sk-ant-admin…, Console → Settings → Admin keys; org admin required).
import { httpJson, missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

const BASE = "https://api.anthropic.com/v1/organizations";

interface Bucket<R> { starting_at: string; ending_at: string; results: R[] }
interface Page<R> { data: Bucket<R>[]; has_more: boolean; next_page: string | null }
interface CostResult { amount: string; currency: string; description?: string; model?: string | null; cost_type?: string; token_type?: string }
interface UsageResult {
  model?: string | null; uncached_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export function anthropicConnector(ctx: ConnectorContext): Connector {
  const req = ["ANTHROPIC_ADMIN_KEY"];
  const headers = () => ({ "x-api-key": ctx.env.ANTHROPIC_ADMIN_KEY!, "anthropic-version": "2023-06-01" });

  async function pages<R>(path: string, params: Record<string, string | string[]>): Promise<Bucket<R>[]> {
    const out: Bucket<R>[] = [];
    let page: string | null = null;
    do {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) qs.append(k, x);
      if (page) qs.set("page", page);
      const res: Page<R> = await httpJson<Page<R>>(`${BASE}/${path}?${qs}`, { headers: headers() });
      out.push(...res.data);
      page = res.has_more ? res.next_page : null;
    } while (page);
    return out;
  }

  return {
    id: "anthropic", label: "Anthropic", requiredEnv: req, implemented: true,
    docs: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api",
    async test() {
      const miss = missingEnv(ctx.env, req);
      if (miss.length) return notConfigured(miss);
      const start = new Date(Date.now() - 86400_000).toISOString();
      await httpJson(`${BASE}/cost_report?starting_at=${encodeURIComponent(start)}&limit=1`, { headers: headers() });
      return { status: "connected" };
    },
    async sync(since) {
      const starting_at = since.toISOString();
      const [cost, usage] = await Promise.all([
        pages<CostResult>("cost_report", { starting_at, "group_by[]": "description", limit: "31" }),
        pages<UsageResult>("usage_report/messages", { starting_at, bucket_width: "1d", "group_by[]": "model", limit: "31" }),
      ]);
      const rows = new Map<string, { date: string; provider: string; model: string; tokens_in: number; tokens_out: number; cost_usd: number }>();
      const row = (date: string, model: string) => {
        const k = `${date}|${model}`;
        if (!rows.has(k)) rows.set(k, { date, provider: "anthropic", model, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
        return rows.get(k)!;
      };
      for (const b of cost) {
        const date = b.starting_at.slice(0, 10);
        // Amounts are USD decimal strings in cents.
        for (const r of b.results) row(date, r.model ?? r.description ?? "other").cost_usd += Number(r.amount) / 100;
      }
      for (const b of usage) {
        const date = b.starting_at.slice(0, 10);
        for (const r of b.results) {
          const x = row(date, r.model ?? "other");
          x.tokens_in += (r.uncached_input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) +
            (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);
          x.tokens_out += r.output_tokens ?? 0;
        }
      }
      if (rows.size) await ctx.repo.upsert("api_spend", [...rows.values()].map((r) => ({ ...r, cost_usd: +r.cost_usd.toFixed(4) })), "date,provider,model");
      ctx.log?.(`anthropic: ${rows.size} day×model rows`);
    },
  };
}
