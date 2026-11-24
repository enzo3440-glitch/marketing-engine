import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
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
