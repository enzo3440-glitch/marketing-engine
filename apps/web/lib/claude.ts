import "server-only";
import { claudeLook } from "./claude-look";

/**
 * Claude for the desk's writing tasks (advisor, idea generation, map brainstorm) runs on the Claude subscription login
 * (headless Claude Code, `claude -p`), never an API key. Trend refresh with web search is the one exception (below).
 */
export const claudeConfigured = () => true;
export const claudeModel = () => process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
/** Only the trend refresh (Messages API web search) still needs a key; everything else uses the Max login. */
export const apiKeyConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** One JSON-returning Claude call. Callers validate the shape themselves (the advisor and the map reviewer both have strict validators). */
export async function claudeJson(system: string, prompt: string, _effort: "low" | "medium" | "high" = "medium"): Promise<unknown> {
  const out = await claudeLook(`${system}\n\n${prompt}`, {}, 10 * 60_000);
  if (!out) throw new Error("Claude didn't answer. Is Claude Code signed in on this machine?");
  return out;
}
