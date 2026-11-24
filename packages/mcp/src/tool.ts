// One registration helper so every tool gets the same role check, error shape and output limit.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z, ZodRawShape } from "zod";
import { requireArea, ToolError, type Area } from "./context";

const MAX_CHARS = 60_000;

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Return this from a tool to send MCP content blocks as they are (e.g. an image the model should look at). */
export class McpContent {
  constructor(readonly content: Block[]) {}
}

export interface ToolDef<S extends ZodRawShape> {
  title: string;
  description: string;
  /** Desk areas that may call this (any one of them), mirroring the desk's guardApi/requireArea. */
  areas: Area[];
  input: S;
  /** Reads are annotated readOnly; writes change desk/engine state. */
  kind: "read" | "write";
  /** Removes or irreversibly decides something; such tools also take a confirm flag. */
  destructive?: boolean;
}

export function define<S extends ZodRawShape>(server: McpServer, name: string, def: ToolDef<S>, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
  server.registerTool(name, {
    title: def.title,
    description: `${def.kind === "read" ? "[read-only] " : def.destructive ? "[write, destructive: needs confirm=true] " : "[write] "}${def.description}`,
    inputSchema: def.input,
    annotations: {
      title: def.title, readOnlyHint: def.kind === "read", destructiveHint: def.kind === "write" ? Boolean(def.destructive) : false,
      idempotentHint: def.kind === "read", openWorldHint: false,
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, (async (args: any) => {
    try {
      requireArea(...def.areas);
      if (def.destructive && args?.confirm !== true) throw new ToolError(`${name} changes data irreversibly: call again with confirm=true once the user has agreed.`);
      const out = await run(args);
      if (out instanceof McpContent) return { content: out.content };
      let text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
      if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated; narrow the query with limit/filters)`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `${name} failed: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}
