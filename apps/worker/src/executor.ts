// Polls approved approvals and dispatches by type. The only code path that acts outside the desk.
import { githubFromEnv } from "@engine/connectors";
import type { Approval, Incident } from "@engine/db";
import type { Agent } from "./run";

type Handler = (a: Approval, ctx: Parameters<Agent>[0]) => Promise<Record<string, unknown>>;

// ad_launch and optimize run in the desk itself the moment they are approved (apps/web/lib/ad-campaigns.ts, lib/improve.ts).
const handlers: Record<Exclude<Approval["type"], "ad_launch" | "optimize">, Handler> = {
  async fix_pr(a, { repo }) {
    const gh = githubFromEnv(process.env);
    if (!gh) throw new Error("GITHUB_TOKEN / APP_REPO not set");
    const [inc] = await repo.list("incidents", { eq: { id: a.ref_id ?? "" } }) as Incident[];
    const files = inc?.proposed_fix?.files ?? [];
    if (!files.length) throw new Error("incident has no proposed file changes");
    const base = await gh.defaultBranch();
    const branch = `fix/${inc.id}`;
    await gh.createBranch(branch, base);
    for (const f of files) await gh.putFile(f.path, f.content, branch, `fix: ${inc.title.slice(0, 60)}`);
    const pr = await gh.openPr(branch, base, `fix: ${inc.title.slice(0, 70)}`, `${inc.proposed_fix!.summary}\n\nSentry: ${(inc.payload as { url?: string }).url ?? inc.fingerprint}\n\nProposed by Marketing Engine Desk crash triage; approved in the desk.`);
    return { pr: pr.html_url, number: pr.number, branch };
  },
  async post(a) {
    // TODO: Meta instagram_content_publish (container → publish) / TikTok Content Posting API (needs app review).
    return { stub: true, note: "Publishing not connected; post manually", caption: a.preview.caption };
  },
  async outreach_email(a) {
    // TODO: gmail.users.drafts.create + send with the Workspace OAuth client.
    return { stub: true, note: "Email sending not connected", to: a.preview.to };
  },
  async ad_change(a) {
    // TODO: Meta/TikTok campaign status updates.
    return { stub: true, note: "Ad changes not connected", change: a.preview };
  },
  async other() {
    return { acknowledged: true };
  },
};

export const executor: Agent = async (ctx) => {
  const { repo, log } = ctx;
  for (const a of await repo.list("approvals", { eq: { status: "approved" } })) {
    if (a.type === "ad_launch" || a.type === "optimize") continue;
    try {
      const result = await handlers[a.type](a, ctx);
      await repo.update("approvals", { id: a.id }, { status: "executed", result });
      log(`${a.type} ${a.id}: executed`);
    } catch (e) {
      await repo.update("approvals", { id: a.id }, { status: "failed", result: { error: e instanceof Error ? e.message : String(e) } });
      log(`${a.type} ${a.id}: failed`);
    }
  }
};
