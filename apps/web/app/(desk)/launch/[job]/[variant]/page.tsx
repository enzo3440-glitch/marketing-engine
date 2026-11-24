import { notFound } from "next/navigation";
import { requireArea } from "@/lib/auth";
import { videoWithVersions } from "@/lib/launch";
import { VideoStudio } from "./studio";

export const dynamic = "force-dynamic";

/** One video, big: watch it, read its script, ask for changes, and compare the versions that come back. */
export default async function VideoPage({ params }: { params: { job: string; variant: string } }) {
  await requireArea("content");
  const found = await videoWithVersions(decodeURIComponent(params.job), decodeURIComponent(params.variant));
  if (!found) notFound();
  return <VideoStudio video={found.video} versions={found.versions} />;
}
