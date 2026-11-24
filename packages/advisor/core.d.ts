// Type declarations for src/core.mjs (the source is kept verbatim from the advisor handoff).
export const RUBRIC_VERSION: string;
export const CRITERIA: readonly ["hook", "clarity", "discoveryPayoff", "brandFit", "actionBridge"];
export type Criterion = (typeof CRITERIA)[number];

export interface Observation {
  id: string; creativeId: string; sourceUrl: string; metric: string;
  scope: "post_lifetime" | "post_interval" | "campaign_interval" | "account_interval";
  paidStatus: "organic" | "paid" | "mixed" | "unknown";
  observedAt: string; publishedAt: string; value: number | null; display: string | null;
  approximate: boolean; precision?: number;
}

export interface Momentum {
  kind: "observed_momentum"; score: null; probability: null; label: string; reason: string;
  rate: number | null; delta?: number; hours?: number; approximate?: boolean; from?: string; to?: string; paidStatus?: string;
}

export interface Review {
  id?: string; stage: "idea" | "video";
  inspection?: { depth: string; completed: boolean };
  criteria?: Partial<Record<Criterion, { value: number; rationale: string }>>;
}
export interface Readiness {
  kind: "idea_priority" | "creative_readiness"; rubricVersion: string; score: number | null;
  confidence: "unscored" | "editorial"; probability: null; reasons: string[];
}

export function requireObject<T>(x: T, label?: string): T;
export function iso(x: unknown): boolean;
export function assertObservation(o: Observation): Observation;
export function momentum(observations: Observation[], opts?: { now?: string; maxAgeHours?: number; minIntervalHours?: number }): Momentum;
export function readiness(review: Review): Readiness;
export function rankIdeas(reviews: Review[]): (Readiness & { id?: string })[];
export function businessResults(row: Record<string, unknown>): {
  kind: string; costPerFollow: number | null; costPerInstall: number | null; costPerActivation: number | null; reason: string | null; currency?: string;
};
export function calibrate(pairs: Record<string, unknown>[], opts?: { minimum?: number }): unknown[];
