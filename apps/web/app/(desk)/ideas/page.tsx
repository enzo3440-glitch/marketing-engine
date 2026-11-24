import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { listIdeas, rankedAt } from "@/lib/ideas";
import { IdeasBoard } from "./ideas";

export default async function IdeasPage() {
  await requireArea("content");
  return (
    <>
      <PageHeader title="Ideas" description="Every idea worth making, ranked best to worst, with where it should run (Ads, IG, TikTok). Pick one and make it into a video." />
      <IdeasBoard initial={await listIdeas()} rankedAt={rankedAt()} />
    </>
  );
}
