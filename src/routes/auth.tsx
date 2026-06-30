import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — Receptionist Engine" }] }),
  component: AuthPage,
});

const signUpSchema = z.object({
  full_name: z.string().trim().min(1, "Required").max(80),
  agency_name: z.string().trim().min(1, "Required").max(80),
  email: z.string().trim().email().max(255),
  password: z.string().min(8, "8+ characters").max(72),
});
const signInSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(72),
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", full_name: "", agency_name: "" });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const parsed = signUpSchema.safeParse(form);
        if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
        const { error } = await supabase.auth.signUp({
          email: parsed.data.email,
          password: parsed.data.password,
          options: {
            emailRedirectTo: `${window.location.origin}/dashboard`,
            data: { full_name: parsed.data.full_name, agency_name: parsed.data.agency_name },
          },
        });
        if (error) throw error;
        toast.success("Account created. Welcome aboard.");
        navigate({ to: "/dashboard", replace: true });
      } else {
        const parsed = signInSchema.safeParse(form);
        if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
        const { error } = await supabase.auth.signInWithPassword(parsed.data);
        if (error) throw error;
        toast.success("Signed in.");
        navigate({ to: "/dashboard", replace: true });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
      if (result.error) { toast.error(result.error.message ?? "Google sign-in failed"); return; }
      if (result.redirected) return;
      navigate({ to: "/dashboard", replace: true });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-sidebar p-12 md:flex">
        <Link to="/" className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-mono text-sm font-bold">RE</div>
          <span className="font-semibold tracking-tight">Receptionist Engine</span>
        </Link>
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Operator console</p>
          <h2 className="mt-3 text-display max-w-sm">Run every client's WhatsApp on autopilot.</h2>
          <p className="mt-4 max-w-md text-sm text-muted-foreground">
            Each business gets a webhook, a brain, and a booking funnel — managed from one workspace.
          </p>
        </div>
        <div className="font-mono text-xs text-muted-foreground">v1.0 · Multi-tenant SaaS</div>
      </aside>

      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 md:hidden">
            <Link to="/" className="flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-mono text-sm font-bold">RE</div>
              <span className="font-semibold tracking-tight">Receptionist Engine</span>
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your workspace"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to manage your receptionists." : "One workspace, unlimited client receptionists."}
          </p>

          <Button onClick={handleGoogle} disabled={loading} variant="outline" className="mt-6 w-full">
            Continue with Google
          </Button>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> OR <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleEmail} className="space-y-4">
            {mode === "signup" && (
              <>
                <div>
                  <Label htmlFor="full_name">Your name</Label>
                  <Input id="full_name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="mt-1.5" required />
                </div>
                <div>
                  <Label htmlFor="agency_name">Agency name</Label>
                  <Input id="agency_name" value={form.agency_name} onChange={(e) => setForm({ ...form, agency_name: e.target.value })} className="mt-1.5" required />
                </div>
              </>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1.5" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="mt-1.5" required />
            </div>
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Working…" : mode === "signin" ? "Sign in" : "Create workspace"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "Don't have an account yet? " : "Already have one? "}
            <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="text-primary underline-offset-4 hover:underline">
              {mode === "signin" ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>
      </section>
    </div>
  );
}
