export const EMOTIONS: readonly ["desire", "hunger", "beauty", "awe", "humor", "cringe", "insight", "agency", "belonging"];
export type Emotion = (typeof EMOTIONS)[number];

export interface IdeationContext {
  audience?: string; objective?: string; channel?: string; emotion?: Emotion; tension?: string; proof?: string;
}
export interface CampaignDraft {
  title: string; audienceTension: string; differentiatedPromise: string; emotionalHook: string; hook: string;
  appProof: string; belongingCue: string; CTA: string; hypothesis: string; primaryMetric: string; lowCostTest: string;
  disconfirmingResult: string; shotBeats: string[]; evidenceIds: string[]; guardrails: string[]; channelVariants: string[];
}
export interface Provider { model?: string; generate(request: Record<string, unknown>): Promise<unknown> }

export function ideationPrompt(ctx?: IdeationContext & { evidence?: unknown[]; outcomes?: unknown[] }): string;
export function validateCampaigns(result: unknown): { campaigns: CampaignDraft[]; status: "drafts_require_review" };
export function ideate(opts?: { provider?: Provider | null; context?: IdeationContext; evidence?: { id: string }[]; outcomes?: unknown[] }):
  Promise<{ status: "unconnected"; campaigns: []; prompt: string } | { campaigns: CampaignDraft[]; status: "drafts_require_review" }>;
