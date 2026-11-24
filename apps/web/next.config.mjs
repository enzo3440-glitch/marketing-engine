import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Settings live in the repo-root .env (SETUP.md step 6). Next.js only reads apps/web/.env*, so load the root file here.
// Variables already set in the environment win; values are never logged.
function loadRootEnv(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^["']/.test(val)) { const q = val[0]; const end = val.indexOf(q, 1); val = end > 0 ? val.slice(1, end) : val.slice(1); }
    else val = val.replace(/(^|\s+)#.*$/, "").trim(); // "KEY=   # comment" means empty
    if (key === "PORT") continue; // the port comes from the shell (`PORT=3100 pnpm desk`), never from .env
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}
loadRootEnv(path.join(here, "../../.env"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // the desk clock, readable in the browser too (lib/tz.ts)
  env: { DESK_TIMEZONE: process.env.DESK_TIMEZONE || "UTC" },
  // Standalone output for Docker (set in apps/web/Dockerfile). Off locally: on Windows it needs symlink rights.
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  transpilePackages: ["@engine/db", "@engine/connectors", "@engine/advisor"],
  experimental: {
    // instrumentation.ts: the ad campaign calendar ticker
    instrumentationHook: true,
    outputFileTracingRoot: path.join(here, "../../"),
    // Migrated CMO data + map seed are read from packages/db/data at runtime.
    outputFileTracingIncludes: { "/**": ["../../packages/db/data/**/*"] },
    // the reel reader drives a local Chrome; keep it out of the bundle
    serverComponentsExternalPackages: ["playwright-core"],
  },
  // the simplified desk: Ideas → Make → Launch → Results (old pages redirect)
  async redirects() {
    return [
      { source: "/content", destination: "/ideas", permanent: false },
      { source: "/content/advisor", destination: "/ideas", permanent: false },
      { source: "/content/cmo", destination: "/results/history", permanent: false },
      { source: "/lab", destination: "/launch", permanent: false },
      { source: "/pulse", destination: "/results", permanent: false },
    ];
  },
  webpack: (config) => {
    // Workspace packages import siblings without extensions; resolve .ts sources.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
