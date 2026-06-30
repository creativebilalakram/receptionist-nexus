import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, CalendarCheck, Users } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Receptionist Engine — AI WhatsApp receptionists that convert" },
      { name: "description", content: "Multi-tenant AI receptionist platform for agencies. Connect ManyChat, qualify leads on WhatsApp, auto-book appointments." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-mono text-sm font-bold">RE</div>
          <span className="font-semibold tracking-tight">Receptionist Engine</span>
        </div>
        <Link
          to="/auth"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium transition hover:border-primary/40"
        >
          Sign in <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pt-20 pb-32">
        <div className="max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Multi-tenant · WhatsApp · ManyChat</p>
          <h1 className="mt-5 text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
            AI receptionists that <span className="text-primary">actually convert</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Stop losing leads in your clients' WhatsApp inbox. Spin up a receptionist per business in minutes — natural conversations, real qualification, automatic booking.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#features"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-5 py-3 text-sm font-medium transition hover:border-primary/40"
            >
              How it works
            </a>
          </div>
        </div>

        <section id="features" className="mt-32 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
          <Feature
            icon={<Users className="h-5 w-5" />}
            title="Multi-client by design"
            body="Onboard unlimited businesses under one workspace. Each gets its own brain, tone, and webhook secret."
          />
          <Feature
            icon={<Bot className="h-5 w-5" />}
            title="Sounds like a human"
            body="Short replies, one question at a time, mirrors the user's language, never sounds like a form."
          />
          <Feature
            icon={<CalendarCheck className="h-5 w-5" />}
            title="Qualifies + books"
            body="BANT scoring runs quietly in the background. When the lead is hot, the booking link drops naturally."
          />
        </section>

        <footer className="mt-24 flex items-center justify-between border-t border-border pt-8 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Receptionist Engine</span>
          <span className="font-mono">v1.0</span>
        </footer>
      </main>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-card p-8">
      <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">{icon}</div>
      <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
