/**
 * Who the desk is making content for. Set these in .env during setup (SETUP.md, step 6).
 * Everything brand-specific beyond these few words lives in services/reel-engine/knowledge/brand-voice.md,
 * which every prompt reads, so the voice, the product and the rules are yours to write.
 */
export const BRAND = {
  /** The brand or product name, as it should appear in captions and end cards. */
  name: process.env.BRAND_NAME || "our brand",
  /** One line: what it is and who it's for, e.g. "a recipe app for busy parents". */
  pitch: process.env.BRAND_PITCH || "a product people love",
  /** The niche the content lives in, e.g. "travel", "cooking", "fitness", "skincare". */
  niche: process.env.BRAND_NICHE || "lifestyle",
  /** What the ads should drive, e.g. "App Store downloads", "website sign-ups", "store visits". */
  goal: process.env.BRAND_GOAL || "clicks to the link",
  /** The Instagram handle, without @. */
  handle: process.env.BRAND_IG_HANDLE || "",
};
