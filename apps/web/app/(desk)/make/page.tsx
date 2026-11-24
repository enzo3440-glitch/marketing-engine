import { getRepo } from "@engine/db";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { listIdeas } from "@/lib/ideas";
import { readyVideos } from "@/lib/launch";
import { bragRuns } from "@/lib/brag-ad";
import { creations } from "@/lib/reel-create";
import { Maker, type ClipOption } from "./make";

export default async function MakePage({ searchParams }: { searchParams: { idea?: string } }) {
  await requireArea("content");
  const [ideas, clips, videos] = await Promise.all([listIdeas(), getRepo().list("reel_clips", { order: { col: "added_at", asc: false } }), readyVideos()]);
  const bin: ClipOption[] = clips.filter((c) => !c.read?.skip).map((c) => ({
    id: c.id, file: c.file, kind: c.kind, star: c.star, duration: c.duration, rating: c.read?.rating ?? null, subject: c.read?.subject ?? c.tags.join(", "),
  }));
  return (
    <>
      <PageHeader title="Make" description="Turn an idea into a video: an app ad made by /brag from the latest app code (in our phone, or as floating screens), a template from your reference reels, or raw from your best footage. Finished videos go to Launch.">
        <Link href="/content/engine" className="label hover:text-foreground">Advanced tools →</Link>
      </PageHeader>
      <Maker ideas={ideas.filter((i) => !i.dupOf).map((i) => ({ id: i.id, title: i.title, hook: i.hook, tier: i.tier, channel: i.channel, rank: i.rank, where: i.where }))} clips={bin}
        initialIdea={searchParams.idea ?? null} initialRuns={[...bragRuns(), ...creations()].sort((a, z) => z.at - a.at)} recent={videos.slice(0, 9)} />
    </>
  );
}
