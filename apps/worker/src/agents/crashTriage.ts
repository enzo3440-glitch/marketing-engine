// On new Sentry incidents (the webhook writes them; this polls every minute): pull the stack + repo files,
// ask Claude for a minimal fix, store it as proposed_fix and queue a fix_pr approval.
import { githubFromEnv } from "@engine/connectors";
import type { Incident } from "@engine/db";
import { z } from "zod";
import { askJson, claudeEnabled } from "../claude";
import { propose, type Agent } from "../run";

const Fix = z.object({
  summary: z.string().describe("One or two sentences: root cause and the change"),
  confidence: z.enum(["low", "medium", "high"]),
  diff: z.string().describe("Unified diff against the files shown"),
  files: z.array(z.object({ path: z.string(), content: z.string().describe("Full new file content") })),
});

/** Repo-relative paths named in a stack trace (src/…, app/…). */
function framesFrom(i: Incident): string[] {
  const text = `${i.body ?? ""}\n${JSON.stringify(i.payload ?? {})}`;
  const paths = new Set<string>();
  for (const m of text.matchAll(/((?:src|app|lib|components|screens)\/[\w./-]+\.(?:tsx?|jsx?))/g)) paths.add(m[1]);
  return [...paths].slice(0, 4);
}

export const crashTriage: Agent = async ({ repo, log }) => {
  const open = (await repo.list("incidents", { eq: { source: "sentry", status: "open" } })).filter((i) => !i.proposed_fix);
  if (!open.length) return log("no new crashes");
  const gh = githubFromEnv(process.env);
  for (const inc of open.slice(0, 3)) {
    if (!claudeEnabled()) {
      await repo.update("incidents", { id: inc.id }, { status: "triaged" });
      log(`${inc.title}: triaged without a fix (ANTHROPIC_API_KEY unset)`);
      continue;
    }
    const files = gh ? (await Promise.all(framesFrom(inc).map(async (p) => ({ path: p, file: await gh.getFile(p) })))).filter((f) => f.file) : [];
    const prompt = [
      `Crash: ${inc.title}`, `Occurrences: ${inc.occurrences}, users affected: ${inc.users_affected}`,
      `Stack / culprit:\n${inc.body ?? "(none)"}`, `Payload:\n${JSON.stringify(inc.payload).slice(0, 6000)}`,
      ...files.map((f) => `--- ${f.path}\n${f.file!.content.slice(0, 20000)}`),
    ].join("\n\n");
    const fix = await askJson({
      system: `You triage production crashes in ${process.env.BRAND_NAME || "our brand"}'s app (React Native / Expo, backed by Supabase). Propose the smallest safe fix touching only the files provided. If the files shown cannot contain the bug, return an empty diff, no files, and say what file you would need.`,
      prompt, schema: Fix, effort: "high",
    });
    await repo.update("incidents", { id: inc.id }, { status: fix.files.length ? "fix_proposed" : "triaged", proposed_fix: { summary: fix.summary, diff: fix.diff, files: fix.files } });
    if (fix.files.length) {
      await propose(repo, {
        type: "fix_pr", agent: "crashTriage", ref_table: "incidents", ref_id: inc.id,
        title: `Fix PR: ${inc.title.slice(0, 80)}`, summary: `${fix.summary} (confidence: ${fix.confidence})`,
        preview: { diff: fix.diff, branch: `fix/${inc.id}`, files: fix.files.map((f) => f.path) },
      });
    }
    log(`${inc.title}: ${fix.files.length ? "fix proposed" : "triaged"}`);
  }
};
