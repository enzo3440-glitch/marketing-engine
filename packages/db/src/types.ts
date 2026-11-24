// Row types for schema `ops`. Keep in sync with migrations/*.sql
// (`pnpm db:types` regenerates Supabase's own types into src/supabase.gen.ts when a project is linked).

export type Role = "ceo" | "marketing" | "eng";
export type IntegrationStatus = "connected" | "error" | "not_configured";
export type Severity = "info" | "warn" | "error" | "critical";
export type IncidentStatus = "open" | "triaged" | "fix_proposed" | "resolved" | "ignored";
export type ApprovalType = "fix_pr" | "post" | "outreach_email" | "ad_change" | "ad_launch" | "optimize" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface Integration {
  provider: string;
  status: IntegrationStatus;
  last_sync_at: string | null;
  last_error: string | null;
  config: Record<string, unknown>;
}

export interface MetricDaily { date: string; metric: string; value: number; source: string }

export interface ApiSpend {
  date: string; provider: string; model: string;
  tokens_in: number; tokens_out: number; cost_usd: number;
}

export interface ProposedFix {
  summary: string;
  diff: string;
  files?: { path: string; content: string }[];
}

export interface Incident {
  id: string; source: string; severity: Severity; title: string; body: string | null;
  payload: Record<string, unknown>; fingerprint: string | null; occurrences: number; users_affected: number;
  status: IncidentStatus; proposed_fix: ProposedFix | null;
  first_seen: string; last_seen: string; resolved_at: string | null;
}

export interface Approval {
  id: string; type: ApprovalType; ref_table: string | null; ref_id: string | null;
  title: string; summary: string | null; preview: Record<string, unknown>;
  status: ApprovalStatus; created_by_agent: string | null;
  decided_by: string | null; decided_at: string | null; result: Record<string, unknown> | null;
  created_at: string;
}

export interface Campaign {
  id: string; platform: "meta" | "tiktok"; external_id: string | null; name: string;
  status: string | null; objective: string | null; meta: Record<string, unknown>;
}

export interface CampaignDaily {
  campaign_id: string; date: string; spend: number; impressions: number; clicks: number; installs: number;
}

export type ContentStatus = "idea" | "draft" | "approved" | "scheduled" | "posted";
export interface ContentItem {
  id: string; platform: "instagram" | "tiktok"; kind: "reel" | "trial_reel" | "post";
  status: ContentStatus; title: string | null; caption: string | null; media_url: string | null;
  scheduled_at: string | null; posted_at: string | null;
  views: number | null; likes: number | null; saves: number | null; shares: number | null;
  attributed_signups: number | null; source: string; meta: Record<string, unknown>;
}

export interface BuildItem {
  id: string; kind: "feature" | "bug" | "test"; title: string;
  status: "backlog" | "active" | "done"; priority: number; notes: string | null;
}

export type Segment = "hit" | "warm" | "partnership" | "investor" | "mentor";
export interface CapitalContact {
  id: string; name: string; org: string | null; segment: Segment; stage: string;
  last_touch: string | null; notes: string | null;
}

export interface FinActual {
  month: string; revenue: number; paid_subs: number; mau: number; ad_spend: number; api_spend: number;
  infra_spend: number; payroll: number; other_opex: number; cash_end: number;
}

export interface ScenarioAssumptions {
  growth_rate: number;   // monthly MAU growth, 0.08 = 8%
  conversion: number;    // share of MAU that is paid
  arpu: number;          // USD per paid sub per month
  cac: number;           // USD per new paid sub
  churn: number;         // monthly paid churn
  opex_growth: number;   // monthly growth of non-ad opex
}
export interface FinScenario { id: string; name: string; assumptions: ScenarioAssumptions }

export interface CalendarEvent {
  id: string; external_id: string | null; title: string; starts_at: string; ends_at: string;
  attendees: string[]; is_own: boolean;
}

export interface InboxItem {
  id: string; thread_id: string | null; sender: string; subject: string; snippet: string;
  importance: number; received_at: string;
}

export interface AgentRun {
  id: string; agent: string; started_at: string; finished_at: string | null;
  status: "running" | "ok" | "failed"; log: string | null;
}

export interface Deploy {
  id: string; service: string; status: "success" | "failed" | "building" | "crashed";
  commit_message: string | null; created_at: string;
}

// Content / Reel Engine -------------------------------------------------------

export type ReelFormat = "oneshot" | "montage" | "cinematic" | "pov" | "reveal" | "list" | "talking" | "podcast";
export const REEL_FORMATS: ReelFormat[] = ["oneshot", "montage", "cinematic", "pov", "reveal", "list", "talking", "podcast"];
/** Reference types: every render format, plus ads (paid creative we want to learn from). */
export const REF_FORMATS: string[] = [...REEL_FORMATS, "ad"];
export const REEL_GRADES = ["clean", "teal_orange", "film", "golden", "moody", "tropical", "mono"] as const;
/**
 * Stock tracks are retired: every reel uses trending audio from the sound library instead
 * (songs you drop in, or the audio of reference reels you dropped). See lib/reels.ts soundLibrary().
 */
export const REEL_MUSIC: readonly string[] = [];

export interface ReelClip {
  id: string; file: string; source: "upload" | "link" | "folder";
  kind: "oneshot" | "broll" | "talking" | "podcast" | "screen" | "reference" | null;
  star: boolean; tags: string[]; thumb: string | null; quality: number | null; duration: number | null;
  talking_likely: boolean | null; added_at: string;
  /** Claude's look at the clip: how striking it is, what's in it, which parts to use (lib/clip-reader.ts) */
  read?: ClipRead; read_error?: string;
}

export interface ClipRead {
  /** 0..1: how much it would stop a scroll in a reel (subject, light, composition, motion) */
  rating: number;
  /** what's in it, e.g. "bison grazing on a golden plain" */
  subject: string;
  /** the place/scene, shared by takes of the same thing, e.g. "suspension bridge"; the editor spaces these out */
  scene: string;
  /** the parts worth using, in seconds */
  moments: { t0: number; t1: number; why: string; /** the most epic instant (e.g. where a pan's full reveal is in frame) */ peak?: number }[];
  /** where it plays best: "hold" = majestic or intricate, rewards a long look (vistas, waterfalls, the goat over the
   * lake); "quick" = big impact that reads in a split second (a spark, a jump, a bold silhouette); "both" */
  best_for?: "hold" | "quick" | "both";
  /** nothing usable (black, blurry, pocket shot) */
  skip?: boolean;
  /** what's wrong with the rest, e.g. "shaky first 2s" */
  flaws?: string;
  read_at: string;
}

export interface RefMetrics {
  duration?: number; shots?: number; shot_lengths?: number[]; avg_shot?: number; cuts_per_10s?: number;
  /** a "turn your phone" reel: picture and text rotated 90 degrees in the frame (cw = its top points right) */
  turn?: "cw" | "ccw" | null;
  /** per shot (same order as shot_lengths): how it comes in and how the camera moves in it, read from the reel */
  shot_fx?: { into: "cut" | "dissolve" | "flash" | "whip"; into_dur?: number; zoom: number; pan: number }[];
  opening_hold?: number; pacing?: "fast" | "medium" | "cinematic"; format?: string; talking_likely?: boolean;
  likes?: number | null; views?: number | null; observed_at?: string | null; account?: string | null;
  /** color grade to apply when used as style (clean, teal_orange, film, golden, moody, tropical, mono) */
  look?: string;
  /** the hook the reference opens with (what its first text says); joins the hook pool */
  hook?: string;
  /** on-screen text per shot (read by OCR from a dropped reference video, or typed in) */
  lines?: { shot: number; t?: number; t1?: number; text: string; pos?: "top" | "center" | "bottom"; size?: number; look?: RefTextLook }[];
  /** the song it uses, e.g. "Someone New · Hozier" (add it in-app on the _bare cut) */
  song?: string;
  /** its sound, pulled from the reel for a template's render (engine input/ file; local only, never committed) */
  audio?: string; audio_error?: string;
  /** which song its sound is: references sharing a song share a key (one template per song), and song_at is where its
   * sound starts in that song in seconds (null when the same song was recognised by name only, e.g. another version) */
  song_key?: string; song_at?: number | null;
  /** the reel's own caption (from its page) and what it's for, e.g. "Fast montage · inspirational" */
  caption?: string; purpose?: string;
  /** your correction of the measured caption look (typeface / colour); wins over every read */
  text_override?: { font?: string; fill?: [number, number, number] };
  /** what you want from it: a fixed template, or only learn some of its parts */
  intent?: "template" | "learn";
  learn?: RefAspect[];
  /** read from its link: when, the frame size, the measured color, or why it couldn't be read */
  read_at?: string; read_error?: string; width?: number; height?: number;
  color?: { sat: number; warm: number; bright: number; contrast: number; mono: boolean };
}
/** How a reference's caption looks, measured from its frames: the face that matched, size at 1080x1920, colours. */
export interface RefTextLook {
  font: string; size: [number, number]; upper: boolean; fill: [number, number, number]; box: [number, number, number] | null;
  stroke: number; shadow: number; lh?: number; x?: number; y?: number; match?: number; votes?: string;
}
export const REF_ASPECTS = ["color", "cuts", "text", "music"] as const;
export type RefAspect = (typeof REF_ASPECTS)[number];
export interface ReelRef {
  id: string; format: string; url: string | null; file: string | null; notes: string | null; title: string | null;
  source: "instagram" | "tiktok" | "youtube" | "link" | "file" | "watchlist"; metrics: RefMetrics; added_at: string;
}

export type HookStatus = "new" | "testing" | "winner" | "retired";
export interface ReelHook {
  id: string; text: string; framework: string | null;
  source: "claude" | "radar" | "owner" | "map"; status: HookStatus; created_at: string;
}

export interface ReelJobRequest {
  job_id: string;
  clips: { id: string; path: string; star?: boolean; tags?: string[]; read?: ClipRead }[];
  defaults: Record<string, unknown>;
  matrix?: { formats: string[]; hooks: { id: string; text: string }[]; grades?: string[]; music?: string[]; per_combo?: number; max?: number };
  variants?: Record<string, unknown>[];
  /** clips the engine makes first: our phone over a clip, or a labelled placeholder (engine/phone.py) */
  make?: Record<string, unknown>[];
  /** director: judge the clips and cast them into trend templates (engine/director.py) */
  direct?: Record<string, unknown>;
}

export interface ReelJob {
  job_id: string; status: "queued" | "rendering" | "done" | "error"; created_at: string;
  request: ReelJobRequest; manifest: Record<string, unknown> | null; error: string | null; stub: boolean;
}

export interface ReelVariant {
  id: string; job_id: string; format: string | null; hook_id: string | null; hook: string | null;
  grade: string | null; music: string | null; file: string | null; bare: string | null; poster: string | null;
  caption: string | null; duration: number | null; warnings: string[]; tags: Record<string, string>;
  picked: boolean;
}

export interface ReelPost {
  id: number; job_id: string; variant_id: string; platform: "ig" | "tiktok"; url: string | null;
  sound: string | null; posted_at: string | null;
  views: number | null; avg_watch_s: number | null; likes: number | null; comments: number | null;
  shares: number | null; saves: number | null; follows: number | null; updated_at: string;
}

export interface CmoRecommendation {
  id: string; kind: "trend" | "watchlist" | "paid_decision" | "creative_test" | "agent";
  title: string; hook: string | null; body: string | null; evidence: string | null;
  confidence: string | null; signal: string | null; sources: { title: string; url: string }[];
  status: "new" | "accepted" | "dismissed"; created_at: string;
}

// Marketing Map (ported from Marketing Whiteboard; same JSON as its Export).
export interface MapChannel {
  id: string; title: string; subtitle?: string; color?: string; objective?: string; metric?: string;
  tone?: string; x?: number; y?: number;
}
export interface MapNode {
  id: string; channel: string; title: string; hook?: string; visual?: string; audio?: string;
  overlay?: string; cta?: string; hypothesis?: string; note?: string; x?: number; y?: number;
}
export interface MarketingMapDoc {
  version: number; title: string; updatedAt: string | null;
  channels: MapChannel[]; nodes: MapNode[]; edges?: { from: string; to: string }[];
  taglines?: string[]; strategy?: string[];
}
export interface AdvisorEvent {
  id: string; revision: number; type: string; payload: Record<string, unknown>; recorded_at: string;
}

export interface MarketingMap { id: string; revision: number; doc: MarketingMapDoc; updated_at: string }

// Ad campaign calendar: a Marketing Map ad concept scheduled with a reel from the gallery, approved in the desk, then
// built in Meta paused and switched on on its start date (apps/web/lib/ad-campaigns.ts).
export type AdObjective = "app_installs" | "traffic" | "awareness";
export type AdCampaignStatus =
  | "planned" | "pending_approval" | "rejected" | "building" | "ready" | "live" | "paused" | "ended" | "failed";
/** One ad in a campaign: a desk video (job_id/variant_id/file/poster) or an Instagram post (ig_media_id). */
export interface AdCreativePick {
  /** "<job_id>|<variant_id>" for desk videos, "ig:<media id>" for Instagram posts. */
  key: string; job_id?: string; variant_id?: string; file?: string; poster?: string | null; ig_media_id?: string;
  label?: string; thumb?: string | null; permalink?: string | null;
}
export interface AdTrialPick { key: string; job_id: string; variant_id: string; label?: string; poster?: string | null }
export interface AdMetaIds { video_id?: string; image_hash?: string; creative_id?: string; ad_id?: string; /** Set when rotation paused this ad for a better one. */ paused_at?: string;
  /** The feature ad set this ad runs in (campaigns split by feature), and why the live optimizer paused it. */ adset_id?: string; feature?: string; killed?: string;
  /** Waves: built paused, waiting for a live slot in its feature ad set; when it went live; when it moved to the winners campaign. */
  bench?: boolean; live_at?: string; graduated_at?: string }
/** A launch's waves (apps/web/lib/waves.ts): the feature test campaign runs a few ads per feature at a time with the rest
 * waiting their turn, and proven ads move to a winners campaign whose budget Meta spreads itself. */
export interface AdWaves {
  live_per_set: number;
  /** Winners campaign in Meta (holds its own budget) and its one ad set. */
  winners_campaign_id?: string; winners_adset_id?: string;
  /** Proven ads, by creative key: the winners-campaign ad, when it moved, its test read, and when it was dropped. */
  winners?: Record<string, { ad_id: string; at: string; ctr: number; hook: number; dropped_at?: string; why?: string }>;
  /** Features whose ad set ran out of ads (feature → when). */
  retired?: Record<string, string>;
  /** The current split of the daily budget. */
  split?: { winners: number; per_set: number; at: string };
  log?: { at: string; text: string }[];
}
export interface AdCampaign {
  id: string; title: string; concept_id: string | null; objective: AdObjective;
  /** Honolulu dates, inclusive. */
  starts_on: string; ends_on: string;
  /** In the ad account's currency (whole units, e.g. dollars). */
  daily_budget: number; countries: string[]; age_min: number; age_max: number;
  primary_text: string; headline: string; cta: string; link: string;
  /** Legacy single creative (older rows and Test Lab campaigns): a gallery reel (job_id/variant_id), or an existing
   * Instagram post promoted as-is (ig_media_id). Read it through creativesOf() in apps/web/lib/ad-campaigns.ts. */
  creative: { job_id: string; variant_id: string; file: string; poster: string | null; ig_media_id?: string } | null;
  /** The ads in the campaign: one creative + ad each, all in the campaign's one ad set. Written going forward. */
  creatives?: AdCreativePick[];
  /** Desk videos the owner sent to trial alongside the campaign (posted through Launch's trial flow, not ads). */
  trials?: AdTrialPick[];
  status: AdCampaignStatus; approval_id: string | null;
  meta: { video_id?: string; image_hash?: string; campaign_id?: string; adset_id?: string; creative_id?: string; ad_id?: string;
    /** Per-ad Meta ids, by AdCreativePick.key (resumable per ad). */
    ads?: Record<string, AdMetaIds>;
    /** One ad set per feature (lib/features.ts), each an even share of the daily budget; absent = the single adset_id. */
    adsets?: Record<string, string>;
    waves?: AdWaves;
    built_at?: string; activated_at?: string; error?: string | null };
  created_at: string; updated_at: string;
}

// Growth tests (Test Lab): trial reels first (free, non-followers only, off the grid), the best ones screened as
// ads-only campaigns on a small budget, the winners scaled. Every step that posts or spends is an approval.
export type TestStage = "trial" | "screen" | "scale" | "done";
export interface CandidateMetrics {
  reach?: number; saves?: number; shares?: number; views?: number; avg_watch_ms?: number | null;
  spend?: number; impressions?: number; clicks?: number; video_views?: number; landing_views?: number; installs?: number;
  measured_at?: string;
}
export interface TestCandidate {
  id: string; label: string; hook: string; caption: string; pillar: string | null; content_id: string | null;
  creative: { job_id: string; variant_id: string; file: string; poster: string | null };
  status: "active" | "advanced" | "dropped";
  trial: { media_id?: string; permalink?: string | null; posted_at?: string; metrics?: CandidateMetrics; score?: number | null; error?: string | null } | null;
  screen: { ad_campaign_id?: string; metrics?: CandidateMetrics; score?: number | null } | null;
  scale: { ad_campaign_id?: string; metrics?: CandidateMetrics } | null;
}
export interface GrowthTest {
  id: string; name: string; stage: TestStage;
  plan: { usable: number | null; currency: string; screen_daily: number; screen_days: number; scale_total: number; scale_days: number; reserve: number; advance_trial: number; advance_screen: number };
  candidates: TestCandidate[]; log: { at: string; text: string }[];
  created_at: string; updated_at: string;
}
