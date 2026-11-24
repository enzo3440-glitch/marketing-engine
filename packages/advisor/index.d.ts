import type { Observation, momentum, readiness, rankIdeas, businessResults } from "./core";
import type { Provider } from "./ideation";

export const TASKS: readonly ["brainstorm", "recommend", "channel_plan"];
export type Task = (typeof TASKS)[number];

export interface Recommendation {
  title: string; action: string; signal: "observed_growth" | "fresh_baseline" | "hypothesis"; evidenceIds: string[]; validationNote?: string;
}
export interface EvidenceRecord { id: string; observations?: Observation[]; [k: string]: unknown }
export interface Ledger { append(event: { id: string; type: string; [k: string]: unknown }, expectedRevision: number): Promise<{ revision: number; events: unknown[] }> }

export interface Advisor {
  status(): { provider: string; evidence: string; ledger: string; canSpend: false; canPublish: false };
  readiness: typeof readiness; momentum: typeof momentum; businessResults: typeof businessResults; rankIdeas: typeof rankIdeas;
  propose(req: { task: Task; context: unknown; evidenceIds?: string[] }): Promise<
    | { status: "unconnected"; recommendations: []; next: string }
    | { status: "proposal_requires_review"; recommendations: Recommendation[]; generatedAt: string; providerModel: string }
  >;
  recordFeedback(event: { id: string; type: string; [k: string]: unknown }, expectedRevision: number): ReturnType<Ledger["append"]>;
}

export function validateProposal(x: unknown): { recommendations: Recommendation[] };
export function createAdvisor(opts?: {
  provider?: Provider | null; evidenceStore?: { getMany(ids: string[]): Promise<EvidenceRecord[]> } | null; ledger?: Ledger | null; clock?: () => string;
}): Advisor;
export function whiteboardAdapter(advisor: Advisor): (req: { version: number; prompt: string; map: unknown }) => Promise<unknown>;
