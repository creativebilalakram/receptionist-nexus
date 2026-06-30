import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { listAppointments } from "@/lib/data.functions";
import { StatusPill } from "@/components/StatusPill";
import { formatDateTime } from "@/lib/format";

const opts = queryOptions({ queryKey: ["appointments"], queryFn: () => listAppointments() });

export const Route = createFileRoute("/_authenticated/appointments")({
  head: () => ({ meta: [{ title: "Appointments — Receptionist Engine" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(opts),
  component: AppointmentsPage,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Not found.</div>,
});

function AppointmentsPage() {
  const { data } = useSuspenseQuery(opts);

  const grouped = new Map<string, typeof data>();
  for (const a of data) {
    const key = a.client_name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Schedule</p>
      <h1 className="mt-2 text-display">Appointments.</h1>

      {data.length === 0 ? (
        <div className="mt-10 rounded-xl border border-border bg-card px-6 py-20 text-center">
          <p className="text-sm font-medium">No appointments scheduled.</p>
          <p className="mt-1 text-sm text-muted-foreground">As leads qualify and book, they'll line up here, grouped by client.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {Array.from(grouped.entries()).map(([clientName, appts]) => (
            <section key={clientName}>
              <h2 className="mb-3 text-sm font-semibold tracking-tight">{clientName}</h2>
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <ul className="divide-y divide-border">
                  {appts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-4 px-6 py-3 text-sm">
                      <div>
                        <div className="font-medium">{formatDateTime(a.scheduled_at)}</div>
                        {a.notes && <div className="mt-0.5 text-xs text-muted-foreground">{a.notes}</div>}
                      </div>
                      <StatusPill status={a.status} />
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
