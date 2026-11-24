import { getRepo } from "@engine/db";
import { CapitalDesk } from "./client";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";

export default async function CapitalPage() {
  await requireArea("capital");
  const repo = getRepo();
  const [contacts, approvals] = await Promise.all([repo.list("capital_contacts"), repo.list("approvals", { eq: { type: "outreach_email" }, order: { col: "created_at", asc: false } })]);
  return (
    <>
      <PageHeader title="Capital" description="Investors, partners, mentors and hit-list contacts. Outreach drafts go through the approval gate before anything is sent." />
      <CapitalDesk contacts={contacts} drafts={approvals} />
    </>
  );
}
