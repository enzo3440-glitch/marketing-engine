import { guardApi } from "@/lib/auth";
import { deskStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

/** The status strip's feed: engine, Meta, Instagram, queue counts. Polled every 15 s by the shell. */
export async function GET() {
  const s = await guardApi("command", "content", "growth", "calendar", "ops", "build", "settings", "finance", "capital");
  if (s instanceof Response) return s;
  return Response.json(await deskStatus());
}
