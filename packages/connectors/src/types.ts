import type { IntegrationStatus, Repo } from "@engine/db";

export interface Status {
  status: IntegrationStatus;
  detail?: string;
}

export interface Connector {
  id: string;
  label: string;
  requiredEnv: string[];
  /** Real implementation vs a stub with TODOs. */
  implemented: boolean;
  docs?: string;
  test(): Promise<Status>;
  sync(since: Date): Promise<void>;
}

export interface ConnectorContext {
  repo: Repo;
  env: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export const missingEnv = (env: ConnectorContext["env"], keys: string[]) => keys.filter((k) => !env[k]);

export const notConfigured = (missing: string[]): Status => ({ status: "not_configured", detail: `Missing ${missing.join(", ")}` });

export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15000);
  try {
    // never Next's data cache: on a server page it saved the engine's POST /rehydrate reply ({"added": 0}) and
    // replayed it for ten days, so finished ads never reached Launch. Engine and API state is always live.
    const res = await fetch(url, { cache: "no-store", ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(t);
  }
}

export const hstDay = (iso: string) => new Date(Date.parse(iso) - 10 * 3600_000).toISOString().slice(0, 10);
