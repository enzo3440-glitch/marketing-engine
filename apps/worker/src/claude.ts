import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "./env";

let client: Anthropic | null = null;
export const claudeEnabled = () => Boolean(env.ANTHROPIC_API_KEY);
export const MODEL = env.CLAUDE_MODEL ?? "claude-opus-5-5";

/**
 * One structured call: Claude returns JSON validated against `schema`.
 * Server-side refusal fallbacks are on ("default" routing) so a safety decline is retried on a fallback model.
 */
export async function askJson<T extends z.ZodTypeAny>(opts: {
  system: string; prompt: string; schema: T; effort?: "low" | "medium" | "high" | "xhigh";
}): Promise<z.infer<T>> {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
  });
  if (response.stop_reason === "refusal") throw new Error(`Claude declined: ${response.stop_details?.category ?? "unknown"}`);
  if (response.parsed_output == null) throw new Error(`Unparseable output (stop_reason=${response.stop_reason})`);
  return response.parsed_output as z.infer<T>;
}
