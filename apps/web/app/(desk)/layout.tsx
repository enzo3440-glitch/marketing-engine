import { getRepo } from "@engine/db";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CommandPalette, Sidebar, Topbar } from "@/components/shell";
import { ACCESS, getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The shell renders immediately; live counts (approvals, alerts, engine, Meta, Instagram) stream in from /api/status.
export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const mock = getRepo().mode === "mock";
  return (
    <div className="flex min-h-screen">
      <Sidebar areas={ACCESS[session.role]} email={session.email} role={session.role} mock={mock} />
      <div className="min-w-0 flex-1">
        <Suspense>
          <Topbar mock={mock} />
        </Suspense>
        <main className="ops-grid min-h-[calc(100vh-2.75rem)]">
          <div className="mx-auto max-w-[1600px] p-4">{children}</div>
        </main>
      </div>
      <CommandPalette areas={ACCESS[session.role]} />
    </div>
  );
}
