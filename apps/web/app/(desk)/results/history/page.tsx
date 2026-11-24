import Link from "next/link";
import CmoPage from "../../content/cmo/page";

/** Results › History: the saved Reel Radar snapshot and per-post audits from the old CMO desk (read-only). */
export default async function HistoryPage() {
  return (
    <>
      <div className="mb-2 text-xs"><Link href="/results" className="label hover:text-foreground">← Results</Link> · older paid reports are on <Link href="/growth" className="underline">Growth (legacy)</Link></div>
      <CmoPage />
    </>
  );
}
