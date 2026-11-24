import { getRepo, saveMockState, type Dataset } from "@engine/db";
import { guardApi } from "@/lib/auth";

// Mock mode only: write the in-memory desk data to data/private/mock-state.json right now.
// (MockRepo also saves after every write; this exists for instances started before persistence.)
export async function POST() {
  const s = await guardApi("settings");
  if (s instanceof Response) return s;
  const repo = getRepo() as unknown as { mode: string; ds?: Dataset };
  if (repo.mode !== "mock" || !repo.ds) return Response.json({ error: "only in mock mode" }, { status: 400 });
  saveMockState(repo.ds);
  return Response.json({ ok: true, refs: repo.ds.reel_refs.length });
}
