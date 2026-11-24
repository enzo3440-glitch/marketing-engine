import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { describeAll, nameSounds, queueAudio, queueRead, readingNow } from "@/lib/ref-intake";

export const dynamic = "force-dynamic";

/** Which references are being read from their links right now. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json({ reading: readingNow() });
}

/** Read references from their links: {ids}, {unread: true} for links not read yet, {all: true} to redo all, {sounds: true} for song names. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json().catch(() => ({}))) as { ids?: string[]; unread?: boolean; all?: boolean; sounds?: boolean; audio?: boolean; describe?: boolean };
  // {sounds: true}: just name each reel's sound (quick; no playback), for references read before songs were looked up
  // {audio: true}: pull the sound of every template that doesn't have it yet (queued after any reads)
  // {describe: true}: titles from each reel's caption + what it's for (a page load each, no playback)
  if (b.describe) return Response.json({ described: await describeAll(await getRepo().list("reel_refs")) });
  if (b.audio) return Response.json({ queued: queueAudio(await getRepo().list("reel_refs")) });
  if (b.sounds) return Response.json({ named: await nameSounds(await getRepo().list("reel_refs")) });
  const refs = (await getRepo().list("reel_refs")).filter((r) => r.url
    && (b.all || (b.ids?.includes(r.id) ?? false) || (b.unread && !r.metrics.read_at)));
  return Response.json({ queued: queueRead(refs) });
}
