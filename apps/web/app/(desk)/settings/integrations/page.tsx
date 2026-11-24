import { createConnectors } from "@engine/connectors";
import { getRepo } from "@engine/db";
import { IntegrationsList } from "./client";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";

export default async function IntegrationsPage() {
  await requireArea("settings");
  const repo = getRepo();
  const rows = await repo.list("integrations");
  const connectors = createConnectors({ repo, env: process.env }).map((c) => {
    const r = rows.find((x) => x.provider === c.id);
    return {
      id: c.id, label: c.label, implemented: c.implemented, docs: c.docs ?? null,
      env: c.requiredEnv.map((k) => ({ key: k, set: Boolean(process.env[k]) })),
      status: r?.status ?? "not_configured", lastSync: r?.last_sync_at ?? null, error: r?.last_error ?? null,
      detail: (r?.config as { detail?: string } | undefined)?.detail ?? null,
    };
  });
  return (
    <>
      <PageHeader title="Integrations" description={`Each provider falls back to seeded mock data until its env vars exist. Data mode: ${repo.mode}.`} />
      <IntegrationsList items={connectors} />
    </>
  );
}
