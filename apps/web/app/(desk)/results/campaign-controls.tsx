"use client";
import { ExternalLink, Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/providers";
import { Button } from "@/components/ui";

/** Pause / Resume (the campaign route's setPaused) and the Ads Manager link for one desk campaign on Results. */
export function CampaignControls({ id, status, built, canApprove, adsManager }: { id: string; status: string; built: boolean; canApprove: boolean; adsManager: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: "pause" | "resume") => async () => {
    setBusy(true); setError(null);
    try { await api(`/api/ads/campaigns/${id}`, { method: "POST", json: { action } }); router.refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {built && ["ready", "live"].includes(status) && <Button size="sm" variant="outline" disabled={busy} onClick={act("pause")}><Pause className="h-3.5 w-3.5" />Pause</Button>}
      {built && status === "paused" && canApprove && <Button size="sm" disabled={busy} onClick={act("resume")}><Play className="h-3.5 w-3.5" />Resume</Button>}
      {adsManager && <a className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs" href={adsManager} target="_blank" rel="noreferrer" title="Open in Ads Manager"><ExternalLink className="h-3.5 w-3.5" /></a>}
      {error && <span className="w-full text-right text-[10.5px] text-destructive">{error}</span>}
    </div>
  );
}
