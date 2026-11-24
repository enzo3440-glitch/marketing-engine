// Railway public GraphQL v2: deployments + service status. Failed deploys become incidents.
import { httpJson, missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

interface DeployNode {
  id: string; status: string; createdAt: string;
  meta?: { commitMessage?: string } | null; service?: { name: string } | null;
}

export function railwayConnector(ctx: ConnectorContext): Connector {
  const req = ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID"];
  const gql = <T>(query: string, variables: Record<string, unknown> = {}) =>
    httpJson<{ data: T; errors?: { message: string }[] }>(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.env.RAILWAY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }).then((r) => {
      if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join("; "));
      return r.data;
    });

  return {
    id: "railway", label: "Railway", requiredEnv: req, implemented: true, docs: "https://docs.railway.com/reference/public-api",
    async test() {
      const miss = missingEnv(ctx.env, req);
      if (miss.length) return notConfigured(miss);
      await gql(`query($id: String!) { project(id: $id) { id name } }`, { id: ctx.env.RAILWAY_PROJECT_ID });
      return { status: "connected" };
    },
    async sync() {
      const data = await gql<{ deployments: { edges: { node: DeployNode }[] } }>(
        `query($id: String!) { deployments(first: 30, input: { projectId: $id }) { edges { node { id status createdAt meta service { name } } } } }`,
        { id: ctx.env.RAILWAY_PROJECT_ID },
      );
      const nodes = data.deployments.edges.map((e) => e.node);
      const map = (s: string) => (s === "SUCCESS" ? "success" : s === "FAILED" ? "failed" : s === "CRASHED" ? "crashed" : "building");
      await ctx.repo.upsert("deploys", nodes.map((n) => ({
        id: n.id, service: n.service?.name ?? "unknown", status: map(n.status) as "success",
        commit_message: n.meta?.commitMessage ?? null, created_at: n.createdAt,
      })), "id");
      const failed = nodes.filter((n) => n.status === "FAILED" || n.status === "CRASHED");
      for (const n of failed) {
        const fingerprint = `railway:deploy:${n.id}`;
        if ((await ctx.repo.list("incidents", { eq: { fingerprint } })).length) continue;
        await ctx.repo.insert("incidents", [{
          id: crypto.randomUUID(), source: "railway", severity: "error", status: "open",
          title: `Deploy ${n.status.toLowerCase()}: ${n.service?.name ?? "service"}`, body: n.meta?.commitMessage ?? null,
          payload: { deploymentId: n.id }, fingerprint, occurrences: 1, users_affected: 0, proposed_fix: null,
          first_seen: n.createdAt, last_seen: n.createdAt, resolved_at: null,
        }]);
      }
      ctx.log?.(`railway: ${nodes.length} deployments, ${failed.length} failed`);
    },
  };
}
