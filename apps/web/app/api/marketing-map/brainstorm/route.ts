import { getRepo } from "@engine/db";
import { BRAND } from "@/lib/brand";
import { guardApi } from "@/lib/auth";
import { claudeJson } from "@/lib/claude";
import { brainstormPrompt } from "@/lib/marketing-map";

// Server-side brainstorm adapter (the whiteboard's brainstorm adapter). Returns proposals only;
// the client reviews and the user applies. Runs on the Claude Max login (lib/claude.ts).
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { focus } = (await req.json().catch(() => ({}))) as { focus?: string };
  const map = (await getRepo().getMap()).doc;
  try {
    return Response.json(await claudeJson(
      `You are ${BRAND.name}'s creative strategist. ${BRAND.name} is ${BRAND.pitch}, in the ${BRAND.niche} niche.`,
      `${brainstormPrompt(map)}${focus ? `\n\nFocus: ${focus}` : ""}`,
    ));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
