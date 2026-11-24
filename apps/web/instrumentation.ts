// Server start hook. The Node-only part lives in instrumentation-node.ts so the edge build never bundles it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
