import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { dashboardStats } from "@/lib/data.functions";
import { StatusPill } from "@/components/StatusPill";
import { relativeTime } from "@/lib/format";

const statsOpts = queryOptions({
  queryKey: ["dashboard-stats"],
  queryFn: () => dashboardStats(),
});

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Receptionist Engine" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(statsOpts),
  component: Dashboard,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Not found.</div>,
});

function Dashboard() {
  const { data } = useSuspenseQuery(statsOpts);
  const stats = [
    { label: "Active clients", value: data.activeClients },
    { label: "Conversations today", value: data.conversationsToday },
    { label: "Qualified this week", value: data.qualifiedThisWeek },
    { label: "Booked this week", value: data.appointmentsThisWeek },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Overview</p>
          <h1 className="mt-2 text-display">Workspace pulse.</h1>
        </div>
        <Link
          to="/clients/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Add client
        </Link>
      </div>

      <div className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-card p-6">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{s.label}</div>
            <div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      <section className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recent activity</h2>
          <Link to="/clients" className="text-xs text-muted-foreground hover:text-foreground">All clients →</Link>
        </div>
        <div className="mt-4 rounded-xl border border-border bg-card">
          {data.recent.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium">No conversations yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Add your first client and wire up its ManyChat webhook to start receiving messages.</p>
              <Link to="/clients/new" className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:border-primary/40">
                <Plus className="h-3 w-3" /> Add a client
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-6 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{r.first_name ?? r.phone ?? "Unknown"}</span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-muted-foreground">{r.client_name}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{relativeTime(r.last_message_at)}</div>
                  </div>
                  <StatusPill status={r.status} />
                  <Link to="/conversations/$id" params={{ id: r.id }} className="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground">
                    <ArrowUpRight className="h-4 w-4" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
