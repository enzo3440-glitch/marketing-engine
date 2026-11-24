"use client";
import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";
import { Button, Card, CardBody, Input } from "@/components/ui";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!url || !anon) return;
    setState("sending");
    const sb = createBrowserClient(url, anon);
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/auth/callback`, shouldCreateUser: false } });
    if (error) {
      setState("error");
      setMsg(error.message);
    } else setState("sent");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold">Marketing Engine</h1>
            <p className="text-sm text-muted-foreground">Sign in with a magic link.</p>
          </div>
          {!url || !anon ? (
            <p className="text-sm text-muted-foreground">
              Supabase Auth is not configured, so the desk runs open in mock mode. <a className="text-primary underline" href="/">Continue</a>
            </p>
          ) : state === "sent" ? (
            <p className="text-sm">Check {email} for the sign-in link.</p>
          ) : (
            <form onSubmit={send} className="space-y-3">
              <Input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button className="w-full" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send magic link"}</Button>
              {state === "error" && <p className="text-xs text-destructive">{msg}</p>}
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
