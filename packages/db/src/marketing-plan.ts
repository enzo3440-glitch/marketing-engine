// Example marketing plan for the neutral "Acme" brand: content pillars, the weekly slot plan, the launch rounds,
// a few starter posts and story templates. This is placeholder data so the desk renders on a fresh install:
// during setup your AI rewrites this file (and knowledge/brand-voice.md) with your real plan.
// Client-safe data. Every post and idea enters the pipeline as an untested idea: reviewed, tested, then approved.

export type PlanChannel = "ig_organic" | "ig_paid" | "tiktok";
export type PillarId = "anti_checklist" | "food_culture" | "useful" | "comedy" | "challenge" | "rules";

export type Tier = "entertain" | "educate" | "sell";
/** grid = main profile, trial = Instagram trial reel (non-followers only), ad = ad-only, tiktok = TikTok. */
export type Placement = "grid" | "trial" | "ad" | "tiktok";

export interface Pillar { id: PillarId; name: string; line: string; job: string; color: string }
/** day: 0 = Monday … 6 = Sunday. channel "review" is the weekly results review, not a post. */
export interface WeekSlot { day: number; channel: PlanChannel | "review"; pillar: PillarId | null; label: string }
export interface LaunchPhase { id: string; name: string; weeks: [number, number]; question: string; paid: string[]; organic: string; decide: string }
export interface PlanPost {
  ref: string; title: string; hook: string; channel: PlanChannel; pillar: PillarId; format: string; duration: string;
  audience: string; beats: string[]; cta?: string; hypothesis: string; measure: string;
  /** Launch round (paid tests) and a fixed slot; organic posts are placed into matching weekly slots. */
  round?: 1 | 2 | 3; slot?: { week: number; day: number };
  template?: string; source: "marketing-guide" | "template-ideas" | "idea-slate";
  /** Entertain the masses, educate the interested, sell to the committed. */
  tier?: Tier; placement?: Placement[]; feature?: string; kind?: "reel" | "post";
  /** Why it can't run yet (e.g. the feature isn't shipped). */
  blocked?: string;
}
export interface StoryTemplate {
  id: string; name: string; from: string; pillar: PillarId; channels: PlanChannel[]; duration: string;
  beats: string[]; guardrails: string[]; measure: string;
}

export const PILLARS: Pillar[] = [
  { id: "anti_checklist", name: "Point of view", line: "The usual way isn't the only way.", job: "Identity and independence: a clear opinion about how your audience does things today.", color: "#e11d48" },
  { id: "food_culture", name: "Stories", line: "Every product has a story.", job: "Follow real people and real moments that show why the brand exists.", color: "#d97706" },
  { id: "useful", name: "Product proof", line: "Show it working.", job: "Show exactly what the product does with a real screen recording and one next step.", color: "#2563eb" },
  { id: "comedy", name: "Light humor", line: "Say what everyone is thinking.", job: "Poke fun at the problem, not the customer. Affectionate, then a real solution.", color: "#7c3aed" },
  { id: "challenge", name: "Challenge & discovery", line: "Can you solve it?", job: "Quizzes and riddles. Participation, not just viewing.", color: "#059669" },
  { id: "rules", name: "Weekly series", line: "One idea a week.", job: "A recurring editorial series that earns follows and saves.", color: "#0f766e" },
];

export const WEEK: WeekSlot[] = [
  { day: 0, channel: "ig_paid", pillar: null, label: "Launch-round ads go live / refresh" },
  { day: 0, channel: "ig_organic", pillar: "rules", label: "Weekly series episode" },
  { day: 1, channel: "tiktok", pillar: "comedy", label: "Light humor" },
  { day: 2, channel: "ig_organic", pillar: "food_culture", label: "Story post" },
  { day: 3, channel: "ig_paid", pillar: null, label: "Matched variant or follow-up goes live" },
  { day: 3, channel: "ig_organic", pillar: "useful", label: "Product in real use" },
  { day: 3, channel: "tiktok", pillar: "challenge", label: "Quiz / riddle" },
  { day: 5, channel: "tiktok", pillar: "useful", label: "Prove it: to-camera demo" },
  { day: 6, channel: "review", pillar: null, label: "Weekly results review" },
];

export const LAUNCH: LaunchPhase[] = [
  { id: "prep", name: "Week 0 · Prep", weeks: [0, 0], question: "Can every test be measured and shipped honestly?",
    paid: [], organic: "Shoot the first round of content.",
    decide: "Every ad has: creative ID, hypothesis, audience, destination, one CTA, spend cap, window, winner rule." },
  { id: "r1", name: "Round 1 · What makes it useful?", weeks: [1, 2], question: "Plain problem vs proof vs humor.",
    paid: ["01"], organic: "Weekly series and TikTok humor.",
    decide: "Split the pilot budget evenly across concepts. Judge cost per activated user, not cost per install. Small samples are directional." },
  { id: "scale", name: "Scale what activates", weeks: [3, 4], question: "Is the winner durable?",
    paid: [], organic: "Second execution of each winner before treating it as a finding.",
    decide: "Scale only after downstream behavior confirms it." },
];

const P = (ref: string, title: string, hook: string, channel: PlanChannel, pillar: PillarId, format: string, duration: string,
  audience: string, beats: string[], hypothesis: string, measure: string, extra: Partial<PlanPost> = {}): PlanPost =>
  ({ ref, title, hook, channel, pillar, format, duration, audience, beats, hypothesis, measure, source: "marketing-guide", ...extra });

/** Example starter posts. Replace with your own plan during setup. */
export const GUIDE_POSTS: PlanPost[] = [
  P("01", "Show it working", "Here's the whole thing in ten seconds.", "ig_paid", "useful", "Paid reel", "15–25s", "People with the problem Acme solves",
    ["The problem", "Open Acme", "Real screen recording of the key step", "The result"],
    "A clear demonstration of the product beats a vague promise.", "Activated users per spend", { cta: "Try Acme", round: 1, slot: { week: 1, day: 0 } }),
  P("R01", "Weekly series: episode 1", "One idea worth stealing this week.", "ig_organic", "rules", "Organic reel", "15–25s", "Existing followers",
    ["Series title card", "One real moment that shows the idea", "How the product helps", "Series end card"],
    "A serialized format earns follows and saves.", "Follows per reach, saves", { template: "rules_episode" }),
];

/** Example story templates. */
export const TEMPLATES: StoryTemplate[] = [
  { id: "rules_episode", name: "Weekly series episode", from: "Example template", pillar: "rules", channels: ["ig_organic"], duration: "15–25s",
    beats: ["Title card with one original line", "One real moment that shows it", "The product moment that made it possible", "Series end card"],
    guardrails: ["Original lines only", "Consent from anyone on camera"], measure: "Follows per reach, saves, series completion" },
  { id: "better_question", name: "Better question", from: "Example template", pillar: "anti_checklist", channels: ["ig_organic", "tiktok"], duration: "Carousel or 10–20s",
    beats: ["The usual question on screen", "Cross it out: the better question", "One real answer found with the product", "Ask the viewer theirs"],
    guardrails: ["Critique habits, not people"], measure: "Saves, shares, comments with answers" },
];

const I = (ref: string, template: string, title: string, hook: string, channel: PlanChannel, beats: string[], hypothesis: string): PlanPost => {
  const t = TEMPLATES.find((x) => x.id === template)!;
  return { ref, title, hook, channel, pillar: t.pillar, format: t.name, duration: t.duration, audience: "Curious customers", beats, hypothesis, measure: t.measure, template, source: "template-ideas" };
};

/** Original ideas for each template. Untested: each needs review, a low-cost test, then approval. */
export const TEMPLATE_IDEAS: PlanPost[] = [
  I("B01", "better_question", "The better question", "Stop asking what's popular. Ask what fits you.", "ig_organic",
    ["The usual question", "Cross it out", "The better question", "One real answer"], "A better-question opener drives saves."),
];

/** Example idea slate, tiered entertain / educate / sell. */
export const SLATE_IDEAS: PlanPost[] = [
  { ref: "S01", title: "Behind the scenes", hook: "How we actually build this.", channel: "tiktok", pillar: "food_culture", format: "To-camera", duration: "20–30s",
    audience: "Curious customers", beats: ["Hook", "One real behind-the-scenes moment", "What we learned"], hypothesis: "Honest process content builds trust.",
    measure: "Completion, follows", source: "idea-slate", tier: "entertain", placement: ["tiktok"], kind: "reel" },
  { ref: "S02", title: "Quick how-to", hook: "Do this in three taps.", channel: "ig_organic", pillar: "useful", format: "Carousel", duration: "5 slides",
    audience: "New users", beats: ["The task", "Step 1", "Step 2", "Step 3"], hypothesis: "Saveable how-tos drive activation.",
    measure: "Saves", source: "idea-slate", tier: "educate", placement: ["grid"], kind: "post" },
];

export const ALL_PLAN_POSTS: PlanPost[] = [...GUIDE_POSTS, ...TEMPLATE_IDEAS, ...SLATE_IDEAS];

const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/**
 * Dates for the plan, from the launch Monday (week 0 = prep). Paid tests keep their round slot; organic and TikTok
 * posts fill the weekly pillar slots in order from week 1. Blocked posts and anything that doesn't fit stay unscheduled.
 */
export function schedulePlan(launchMonday: string, posts: PlanPost[] = ALL_PLAN_POSTS, weeks = 8): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  // the weekly series runs in order, one episode a week, ahead of other posts in its slot
  const free = posts.filter((p) => !p.slot && !p.blocked).sort((a, b) => Number(/^R\d/.test(b.ref)) - Number(/^R\d/.test(a.ref)));
  for (const p of posts) out[p.ref] = p.slot && !p.blocked ? addDays(launchMonday, p.slot.week * 7 + p.slot.day) : null;
  const taken = new Set<string>();
  for (let w = 1; w <= weeks; w++) {
    for (const s of WEEK) {
      if (s.channel === "review" || s.channel === "ig_paid" || !s.pillar) continue;
      const day = addDays(launchMonday, w * 7 + s.day);
      if (posts.some((p) => out[p.ref] === day && p.channel === s.channel)) continue; // a fixed post already holds this slot
      const p = free.find((x) => !taken.has(x.ref) && x.channel === s.channel && x.pillar === s.pillar);
      if (!p) continue;
      taken.add(p.ref);
      out[p.ref] = day;
    }
  }
  return out;
}

/** The Monday on or after a date. */
export function nextMonday(day: string): string {
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, dow === 1 ? 0 : (8 - dow) % 7);
}
