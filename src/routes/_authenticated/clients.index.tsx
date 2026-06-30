import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { Plus, ArrowUpRight } from "lucide-react";
import { listClients } from "@/lib/clients.functions";
import { StatusPill } from "@/components/StatusPill";
import { relativeTime } from "@/lib/format";

const opts = queryOptions({ queryKey: ["clients"], queryFn: () => listClients() });

export const Route = createFileRoute("/_authenticated/clients/")({
  head: () => ({ meta: [{ title: "Clients — Receptionist Engine" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(opts),
  component: ClientsList,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Not found.</div>,
});

function ClientsList() {
  const { data } = useSuspenseQuery(opts);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
          <h1 className="mt-2 text-display">Clients.</h1>
        </div>
        <Link to="/clients/new" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">
          <Plus className="h-4 w-4" /> New client
        </Link>
      </div>

      <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
        {data.length === 0 ? (
          <div className="px-6 py-20 text-center">
            <p className="text-sm font-medium">No clients yet.</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
              Each client gets its own AI receptionist, webhook secret, and conversation history. Start with one.
            </p>
            <Link to="/clients/new" className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">
              <Plus className="h-4 w-4" /> Add your first client
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Business</th>
                <th className="px-3 py-3 font-medium">Niche</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium text-right">Convos</th>
                <th className="px-3 py-3 font-medium">Last activity</th>
                <th className="px-6 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((c) => (
                <tr key={c.id} className="transition hover:bg-muted/20">
                  <td className="px-6 py-3">
                    <Link to="/clients/$id" params={{ id: c.id }} className="font-medium hover:text-primary">
                      {c.business_name}
                    </Link>
                    <div className="font-mono text-[10px] text-muted-foreground">{c.slug}</div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{c.niche || "—"}</td>
                  <td className="px-3 py-3"><StatusPill status={c.is_active ? "active" : "idle"} /></td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.conversation_count}</td>
                  <td className="px-3 py-3 text-muted-foreground">{relativeTime(c.last_activity)}</td>
                  <td className="px-6 py-3 text-right">
                    <Link to="/clients/$id" params={{ id: c.id }} className="inline-flex rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
