// Data access. One generic surface over two backends:
//  - MockRepo: in-memory copy of the seeded dataset (zero credentials; writes last until restart)
//  - SupabaseRepo: schema `ops` via the service-role client (server-side only)
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildMockDataset, type Dataset } from "./mock";
import { loadMockState, saveMockState } from "./mock-state";
import type { MarketingMap, MarketingMapDoc } from "./types";

export type TableName = Exclude<keyof Dataset, "cmo_snapshot" | "marketing_map">;
export type Row<K extends TableName> = Dataset[K][number];

export interface ListOpts {
  /** Inclusive lower bound on `dateCol` (YYYY-MM-DD or ISO). */
  since?: string;
  dateCol?: string;
  eq?: Record<string, string | number | boolean>;
  order?: { col: string; asc?: boolean };
  limit?: number;
}

export class ConflictError extends Error {
  readonly name = "ConflictError";
  constructor(public current: MarketingMap) {
    super("revision conflict");
  }
}

/** Duck-typed: Next can bundle this module more than once, so `instanceof` is unreliable across routes. */
export const isConflict = (e: unknown): e is ConflictError => (e as { name?: string } | null)?.name === "ConflictError";

export interface Repo {
  mode: "mock" | "supabase";
  list<K extends TableName>(table: K, opts?: ListOpts): Promise<Row<K>[]>;
  insert<K extends TableName>(table: K, rows: Partial<Row<K>>[]): Promise<Row<K>[]>;
  update<K extends TableName>(table: K, match: Record<string, string | number>, patch: Partial<Row<K>>): Promise<number>;
  upsert<K extends TableName>(table: K, rows: Partial<Row<K>>[], onConflict: string): Promise<void>;
  remove<K extends TableName>(table: K, match: Record<string, string | number>): Promise<void>;
  cmoSnapshot(): Promise<Dataset["cmo_snapshot"]>;
  getMap(): Promise<MarketingMap>;
  saveMap(doc: MarketingMapDoc, expectedRevision: number): Promise<MarketingMap>;
}

const matches = (row: Record<string, unknown>, m: Record<string, unknown>) => Object.entries(m).every(([k, v]) => row[k] === v);

function applyList<T extends Record<string, unknown>>(rows: T[], o: ListOpts = {}): T[] {
  let out = rows;
  if (o.eq) out = out.filter((r) => matches(r, o.eq!));
  if (o.since) {
    const col = o.dateCol ?? "date";
    out = out.filter((r) => String(r[col] ?? "") >= o.since!);
  }
  if (o.order) {
    const { col, asc = true } = o.order;
    out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1));
  }
  if (o.limit) out = out.slice(0, o.limit);
  return out;
}

export class MockRepo implements Repo {
  mode = "mock" as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** persist: save user-editable tables to disk after writes (off for tests / seeding). */
  constructor(private ds: Dataset, private persist = false) {
    if (persist) loadMockState(ds);
  }
  private touch() {
    if (!this.persist) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => saveMockState(this.ds), 300);
  }
  async list<K extends TableName>(table: K, opts?: ListOpts) {
    return applyList(this.ds[table] as unknown as Record<string, unknown>[], opts) as unknown as Row<K>[];
  }
  async insert<K extends TableName>(table: K, rows: Partial<Row<K>>[]) {
    const arr = this.ds[table] as unknown as Row<K>[];
    const full = rows.map((r) => ({ ...r }) as Row<K>);
    arr.unshift(...full);
    this.touch();
    return full;
  }
  async update<K extends TableName>(table: K, match: Record<string, string | number>, patch: Partial<Row<K>>) {
    let n = 0;
    for (const row of this.ds[table] as unknown as Record<string, unknown>[]) {
      if (matches(row, match)) {
        Object.assign(row, patch);
        n++;
      }
    }
    if (n) this.touch();
    return n;
  }
  async upsert<K extends TableName>(table: K, rows: Partial<Row<K>>[], onConflict: string) {
    const keys = onConflict.split(",").map((s) => s.trim());
    const arr = this.ds[table] as unknown as Record<string, unknown>[];
    for (const r of rows as Record<string, unknown>[]) {
      const hit = arr.find((x) => keys.every((k) => x[k] === r[k]));
      if (hit) Object.assign(hit, r);
      else arr.unshift({ ...r });
    }
    this.touch();
  }
  async remove<K extends TableName>(table: K, match: Record<string, string | number>) {
    const arr = this.ds[table] as unknown as Record<string, unknown>[];
    for (let i = arr.length - 1; i >= 0; i--) if (matches(arr[i], match)) arr.splice(i, 1);
    this.touch();
  }
  async cmoSnapshot() {
    return this.ds.cmo_snapshot;
  }
  async getMap() {
    return this.ds.marketing_map;
  }
  async saveMap(doc: MarketingMapDoc, expectedRevision: number) {
    const cur = this.ds.marketing_map;
    if (cur.revision !== expectedRevision) throw new ConflictError(cur);
    const updated_at = new Date().toISOString();
    this.ds.marketing_map = { id: "main", revision: cur.revision + 1, doc: { ...doc, updatedAt: updated_at }, updated_at };
    this.touch();
    return this.ds.marketing_map;
  }
}

export class SupabaseRepo implements Repo {
  mode = "supabase" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: SupabaseClient<any, any, any>;
  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false }, db: { schema: "ops" } });
  }
  private t(table: string) {
    return this.db.schema("ops").from(table);
  }
  async list<K extends TableName>(table: K, o: ListOpts = {}) {
    let q = this.t(table).select("*");
    for (const [k, v] of Object.entries(o.eq ?? {})) q = q.eq(k, v);
    if (o.since) q = q.gte(o.dateCol ?? "date", o.since);
    if (o.order) q = q.order(o.order.col, { ascending: o.order.asc ?? true });
    q = q.limit(o.limit ?? 10000);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as Row<K>[];
  }
  async insert<K extends TableName>(table: K, rows: Partial<Row<K>>[]) {
    const { data, error } = await this.t(table).insert(rows as object[]).select("*");
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as Row<K>[];
  }
  async update<K extends TableName>(table: K, match: Record<string, string | number>, patch: Partial<Row<K>>) {
    let q = this.t(table).update(patch as object);
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { data, error } = await q.select("*");
    if (error) throw new Error(`${table}: ${error.message}`);
    return data?.length ?? 0;
  }
  async upsert<K extends TableName>(table: K, rows: Partial<Row<K>>[], onConflict: string) {
    const { error } = await this.t(table).upsert(rows as object[], { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  async remove<K extends TableName>(table: K, match: Record<string, string | number>) {
    let q = this.t(table).delete();
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  async cmoSnapshot() {
    const { data } = await this.t("cmo_snapshots").select("*").order("imported_at", { ascending: false }).limit(1).maybeSingle();
    return data ? { observed_at: data.observed_at, exported_at: data.exported_at, snapshot: data.snapshot } : null;
  }
  async getMap() {
    const { data, error } = await this.t("marketing_maps").select("*").eq("id", "main").maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data as MarketingMap;
    const { loadMarketingMapSeed } = await import("./cmo");
    return { id: "main", revision: 0, doc: loadMarketingMapSeed(), updated_at: new Date().toISOString() };
  }
  async saveMap(doc: MarketingMapDoc, expectedRevision: number) {
    const updated_at = new Date().toISOString();
    const next = { id: "main", revision: expectedRevision + 1, doc: { ...doc, updatedAt: updated_at }, updated_at };
    if (expectedRevision === 0) {
      const { error } = await this.t("marketing_maps").insert(next);
      if (error) throw new ConflictError(await this.getMap());
      return next;
    }
    // Conditional write: only succeeds if nobody saved since the caller's read.
    const { data, error } = await this.t("marketing_maps").update(next).eq("id", "main").eq("revision", expectedRevision).select("*");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new ConflictError(await this.getMap());
    return data[0] as MarketingMap;
  }
}

const g = globalThis as unknown as { __opsRepo?: Repo };

/**
 * Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY exist, otherwise the seeded mock. In mock mode only one
 * process may own mock-state.json (the desk); others set OPS_MOCK_PERSIST=0 and read it without writing back.
 */
export function getRepo(): Repo {
  if (g.__opsRepo) return g.__opsRepo;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  g.__opsRepo = url && key ? new SupabaseRepo(url, key) : new MockRepo(buildMockDataset(), process.env.OPS_MOCK_PERSIST !== "0");
  return g.__opsRepo;
}

export const isMockMode = () => getRepo().mode === "mock";
