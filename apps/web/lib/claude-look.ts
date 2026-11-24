import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCli } from "./clip-reader";

/**
 * Ask Claude about a few images, on the Claude subscription login (headless Claude Code, no API key): the images (or
 * named files: images and text) go to a fresh temp folder, Claude may only Read files there, and must answer one JSON
 * object. The folder is deleted afterwards. Null if Claude Code isn't available or the answer isn't JSON.
 */
export async function claudeLook<T = Record<string, unknown>>(question: string, jpgs: Buffer[] | Record<string, Buffer | string>, timeoutMs = 4 * 60_000): Promise<T | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-look-"));
  try {
    const named = Array.isArray(jpgs) ? Object.fromEntries(jpgs.map((b, i) => [`frame${i + 1}.jpg`, b])) : jpgs;
    const files = Object.entries(named).map(([n, b]) => {
      const f = path.join(dir, n);
      fs.writeFileSync(f, b);
      return f;
    });
    let prompt = `${question}\n\nLook at these files with the Read tool: ${files.join(", ")}.\nReply with a single JSON object and nothing else.`;
    // Windows caps a command line near 32,000 characters: a long prompt (the lab's playbook rewrite) goes in a file instead,
    // or the spawn fails at once and the caller silently keeps its old answer
    if (prompt.length > 12_000) {
      const task = path.join(dir, "task.md");
      fs.writeFileSync(task, prompt);
      prompt = `Read ${task} with the Read tool and do exactly what it asks. Reply with a single JSON object and nothing else.`;
    }
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // the subscription login, never a key
    const out = await new Promise<string>((resolve) => {
      const p = spawn(claudeCli(), ["-p", prompt, "--allowedTools", "Read", "--strict-mcp-config", "--output-format", "text"],
        { cwd: dir, env, windowsHide: true });
      let s = "";
      p.stdout.on("data", (d) => { s += d; });
      const kill = setTimeout(() => p.kill(), timeoutMs);
      p.on("error", () => { clearTimeout(kill); resolve(""); });
      p.on("close", () => { clearTimeout(kill); resolve(s); });
    });
    const a = out.indexOf("{"), z = out.lastIndexOf("}");
    return a >= 0 && z > a ? (JSON.parse(out.slice(a, z + 1)) as T) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Is a reel a "turn your phone" edit (wide footage and text rotated 90 degrees inside the vertical frame)? "cw" when
 * the picture's top is at the frame's right side, "ccw" when it's at the left, null when upright or unsure.
 */
export async function reelTurn(frames: { jpg: string }[]): Promise<"cw" | "ccw" | null> {
  const pick = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 4)) === 0).slice(0, 4);
  if (!pick.length) return null;
  const r = await claudeLook<{ turn?: string }>(
    `These are frames from one Instagram reel. Some reels are "turn your phone" edits: the footage (and any text) is rotated
90 degrees inside the vertical frame, so the viewer turns the phone sideways to watch. Is this reel's picture rotated?
Answer {"turn": "none"} if people, horizons and text are the normal way up; {"turn": "cw"} if the picture's top (sky, heads,
the top of letters) points to the RIGHT side of the frame; {"turn": "ccw"} if it points to the LEFT side.`,
    pick.map((f) => Buffer.from(f.jpg.split(",").pop() ?? "", "base64")),
  );
  return r?.turn === "cw" || r?.turn === "ccw" ? r.turn : null;
}
