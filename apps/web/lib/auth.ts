import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { getRepo, type Role } from "@engine/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

type CookieList = { name: string; value: string; options: CookieOptions }[];

export type Area = "command" | "build" | "ops" | "growth" | "content" | "capital" | "finance" | "calendar" | "settings";

/** Spec: ceo sees all; marketing sees growth/content/calendar; eng sees build/ops (+ integrations). */
export const ACCESS: Record<Role, Area[]> = {
  ceo: ["command", "build", "ops", "growth", "content", "capital", "finance", "calendar", "settings"],
  marketing: ["growth", "content", "calendar"],
  eng: ["build", "ops", "settings"],
};

export interface Session { userId: string | null; email: string; role: Role; mock: boolean }

export const authConfigured = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export function supabaseServer() {
  const store = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: CookieList) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a Server Component; middleware refreshes the session instead.
        }
      },
    },
  });
}

export async function getSession(): Promise<Session | null> {
  if (!authConfigured()) {
    const role = (process.env.MOCK_ROLE as Role) ?? "ceo";
    return { userId: null, email: "owner@example.com", role: ACCESS[role] ? role : "ceo", mock: true };
  }
  const { data } = await supabaseServer().auth.getUser();
  if (!data.user) return null;
  const repo = getRepo();
  let role: Role = "eng";
  if (repo.mode === "supabase") {
    // profiles is not in the generic Dataset; query it directly through the service client.
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: p } = await admin.schema("ops").from("profiles").select("role").eq("user_id", data.user.id).maybeSingle();
    role = (p?.role as Role) ?? "eng";
  }
  return { userId: data.user.id, email: data.user.email ?? "", role, mock: false };
}

export const homeFor = (role: Role) => `/${ACCESS[role][0]}`;

/** Page guard. */
export async function requireArea(area: Area): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!ACCESS[s.role].includes(area)) redirect(homeFor(s.role));
  return s;
}

/** Route-handler guard: returns the session or a Response to send. */
export async function guardApi(...areas: Area[]): Promise<Session | Response> {
  const s = await getSession();
  if (!s) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!areas.some((a) => ACCESS[s.role].includes(a))) return Response.json({ error: "forbidden" }, { status: 403 });
  return s;
}
