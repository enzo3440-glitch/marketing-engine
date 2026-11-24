import { getRepo } from "@engine/db";
import { FinanceModel } from "./client";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";

export default async function FinancePage() {
  await requireArea("finance");
  const repo = getRepo();
  const [actuals, scenarios] = await Promise.all([repo.list("fin_actuals", { order: { col: "month" } }), repo.list("fin_scenarios")]);
  const goal = Number(process.env.FIN_GOAL_MRR ?? 25000);
  return (
    <>
      <PageHeader title="Finance" description="Live model fed by ops actuals. The data-room model stays canonical; this is the operating view." />
      <FinanceModel actuals={actuals} scenarios={scenarios} goalMrr={goal} />
    </>
  );
}
