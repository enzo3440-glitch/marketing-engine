export const env = process.env as Record<string, string | undefined>;

export const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);

export { apiBudgets as budgets } from "@engine/db";

export const TZ = "Pacific/Honolulu";
