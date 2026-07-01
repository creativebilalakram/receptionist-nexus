import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Trash2, RefreshCw, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { getClient } from "@/lib/clients.functions";
import { listMeetingTypes } from "@/lib/booking.functions";
import {
  debugListAppointments,
  debugHardDeleteAppointment,
  debugWipeAllAppointments,
  debugConfigSnapshot,
  debugGenerateSlots,
  debugRecentLogs,
  debugRecentJobs,
} from "@/lib/booking-debug.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/StatusPill";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const clientOpts = (id: string) => queryOptions({ queryKey: ["client", id], queryFn: () => getClient({ data: { id } }) });

export const Route = createFileRoute("/_authenticated/clients/$id/booking-debug")({
  head: () => ({ meta: [{ title: "Booking Debug — Receptionist Engine" }] }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(clientOpts(params.id)),
  component: BookingDebugPage,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Client not found.</div>,
});

function shortId(id: string) { return id.slice(0, 8); }
function fmtInTz(iso: string | null | undefined, tz: string) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso));
  } catch { return iso; }
}
function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function BookingDebugPage() {
  const { id } = Route.useParams();
  const { data: client } = useSuspenseQuery(clientOpts(id));
  const tz = client.timezone || "UTC";

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <div>
        <Link to="/clients/$id" params={{ id }} className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Back to client
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">Booking Debug · {client.business_name}</h1>
        <p className="text-sm text-muted-foreground font-mono">tz: {tz} · id: {client.id}</p>
      </div>

      <ConfigSection clientId={id} tz={tz} />
      <AppointmentsSection clientId={id} tz={tz} />
      <SlotTester clientId={id} tz={tz} />
      <NukeZone clientId={id} businessName={client.business_name} />
      <LogsSection clientId={id} />
      <JobsSection clientId={id} />
    </div>
  );
}

// ============ Sections 2/3/4 ============
function ConfigSection({ clientId, tz }: { clientId: string; tz: string }) {
  const fn = useServerFn(debugConfigSnapshot);
  const { data } = useQuery({ queryKey: ["debug", clientId, "config"], queryFn: () => fn({ data: { clientId } }) });
  if (!data) return <Skeleton title="Config snapshot" />;

  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return (
    <>
      <Card>
        <CardHeader><CardTitle className="text-base">Availability Rules</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-2 text-xs">
            {days.map((d, idx) => {
              const rule = data.rules.find((r: any) => r.day_of_week === idx);
              return (
                <div key={d} className={`rounded border p-2 ${rule?.is_enabled ? "border-primary/40 bg-primary/5" : "border-muted opacity-60"}`}>
                  <div className="font-mono font-medium">{d}</div>
                  {rule ? (
                    <div className="mt-1 font-mono">{rule.is_enabled ? `${rule.start_time.slice(0,5)}–${rule.end_time.slice(0,5)}` : "off"}</div>
                  ) : <div className="mt-1 text-muted-foreground">no rule</div>}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Booking Settings</CardTitle></CardHeader>
        <CardContent>
          {data.settings ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
              <dt className="text-muted-foreground">min_notice_minutes</dt><dd className="font-mono">{data.settings.min_notice_minutes}</dd>
              <dt className="text-muted-foreground">max_advance_days</dt><dd className="font-mono">{data.settings.max_advance_days}</dd>
              <dt className="text-muted-foreground">auto_buffer_after</dt><dd className="font-mono">{data.settings.auto_buffer_after_minutes}m</dd>
              <dt className="text-muted-foreground">timezone</dt><dd className="font-mono">{tz}</dd>
            </dl>
          ) : <p className="text-sm text-muted-foreground">No booking_settings row.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Blocked Dates ({data.blocks.length})</CardTitle></CardHeader>
        <CardContent>
          {data.blocks.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <Table><TableHeader><TableRow><TableHead>Start</TableHead><TableHead>End</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody>{data.blocks.map((b: any) => (
                <TableRow key={b.id}><TableCell>{fmtInTz(b.start_at, tz)}</TableCell><TableCell>{fmtInTz(b.end_at, tz)}</TableCell><TableCell>{b.reason ?? "—"}</TableCell></TableRow>
              ))}</TableBody></Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// ============ Section 1: Appointments ============
function AppointmentsSection({ clientId, tz }: { clientId: string; tz: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(debugListAppointments);
  const delFn = useServerFn(debugHardDeleteAppointment);
  const [onlyOccupying, setOnlyOccupying] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["debug", clientId, "appts"],
    queryFn: () => listFn({ data: { clientId } }),
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    if (!onlyOccupying) return all;
    const cutoff = Date.now() - 86_400_000;
    const now = Date.now();
    return all.filter((a: any) =>
      ["scheduled","confirmed"].includes(a.status)
      && new Date(a.scheduled_at).getTime() > cutoff
      && (a.effective_end_at ? new Date(a.effective_end_at).getTime() > now : true)
    );
  }, [data, onlyOccupying]);

  async function onDelete(id: string) {
    if (!confirm(`Hard-delete appointment ${shortId(id)}?`)) return;
    try {
      await delFn({ data: { id, clientId } });
      toast.success("Appointment deleted");
      qc.invalidateQueries({ queryKey: ["debug", clientId] });
    } catch (e: any) { toast.error(e.message ?? "Delete failed"); }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Raw Appointments ({rows.length}{data ? ` of ${data.length}` : ""})</CardTitle>
          <CardDescription>Sorted by scheduled_at desc.</CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={onlyOccupying} onCheckedChange={(v) => setOnlyOccupying(!!v)} />
            Only occupying
          </label>
          <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw className="h-3 w-3" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No appointments{onlyOccupying ? " (with current filter)" : ""}.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>ID</TableHead><TableHead>Start</TableHead><TableHead>End</TableHead>
                <TableHead>Dur</TableHead><TableHead>Status</TableHead>
                <TableHead>Contact</TableHead><TableHead>Via</TableHead><TableHead>Parent</TableHead>
                <TableHead>Created</TableHead><TableHead className="text-right">Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((a: any) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs" title={a.id}>{shortId(a.id)}</TableCell>
                    <TableCell title={a.scheduled_at}>{fmtInTz(a.scheduled_at, tz)}</TableCell>
                    <TableCell>{fmtInTz(a.effective_end_at, tz)}</TableCell>
                    <TableCell className="font-mono text-xs">{a.duration_minutes ?? "—"}m</TableCell>
                    <TableCell><StatusPill status={a.status as any} /></TableCell>
                    <TableCell className="text-xs">
                      <div>{a.contact_name ?? "—"}</div>
                      <div className="font-mono text-muted-foreground">{a.contact_phone ?? ""}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.booked_via ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{a.parent_appointment_id ? shortId(a.parent_appointment_id) : "—"}</TableCell>
                    <TableCell className="text-xs">{fmtInTz(a.created_at, tz)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => onDelete(a.id)}><Trash2 className="h-3 w-3" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Section 5: Slot Tester ============
function SlotTester({ clientId, tz }: { clientId: string; tz: string }) {
  const mtFn = useServerFn(listMeetingTypes);
  const runFn = useServerFn(debugGenerateSlots);
  const { data: mts } = useQuery({ queryKey: ["debug", clientId, "mts"], queryFn: () => mtFn({ data: { clientId } }) });
  const [meetingTypeId, setMeetingTypeId] = useState<string>("");
  const [start, setStart] = useState<string>(() => toLocalInputValue(new Date()));
  const [end, setEnd] = useState<string>(() => toLocalInputValue(new Date(Date.now() + 7 * 86_400_000)));
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const r = await runFn({ data: {
        clientId,
        meetingTypeId: meetingTypeId || null,
        rangeStart: new Date(start).toISOString(),
        rangeEnd: new Date(end).toISOString(),
      }});
      setResult(r);
    } catch (e: any) { toast.error(e.message ?? "Failed"); }
    finally { setRunning(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live Slot Generator</CardTitle>
        <CardDescription>Invokes the real <code className="font-mono text-xs">generateSlots()</code> and audits every 15-min candidate.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Meeting Type</Label>
            <Select value={meetingTypeId} onValueChange={setMeetingTypeId}>
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                {(mts ?? []).map((m: any) => (
                  <SelectItem key={m.id} value={m.id}>{m.name} · {m.duration_minutes}m {m.is_default ? "(default)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Start (local)</Label>
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">End (local)</Label>
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={run} disabled={running} className="w-full">{running ? "Running…" : "Run generateSlots"}</Button>
          </div>
        </div>

        {result && (
          <div className="space-y-4">
            {result.error && (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                Error: {result.error}
              </div>
            )}
            <div className="text-xs text-muted-foreground font-mono">
              {result.slots?.length ?? 0} slots · step {result.step_minutes}m · footprint {result.footprint_minutes}m · tz {result.timezone}
            </div>
            {result.slots?.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-1">Included slots</h3>
                <div className="rounded border p-2 max-h-64 overflow-auto text-xs font-mono grid grid-cols-2 md:grid-cols-3 gap-1">
                  {result.slots.map((s: any) => <div key={s.start} className="rounded bg-primary/10 px-2 py-1">{s.label}</div>)}
                </div>
              </div>
            )}
            {result.audit?.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-1">Rejection audit (first 200 candidates)</h3>
                <div className="rounded border max-h-80 overflow-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Candidate</TableHead><TableHead>Decision</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {result.audit.map((a: any, i: number) => (
                        <TableRow key={i} className={a.included ? "bg-emerald-500/5" : ""}>
                          <TableCell className="text-xs font-mono">{a.time_label}</TableCell>
                          <TableCell className="text-xs">{a.included ? "✓ Included" : "✗ Rejected"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{a.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
            {result.busy_snapshot?.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Busy snapshot ({result.busy_snapshot.length})</summary>
                <pre className="mt-2 rounded bg-muted p-2 overflow-auto">{JSON.stringify(result.busy_snapshot, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Section 6: Nuke ============
function NukeZone({ clientId, businessName }: { clientId: string; businessName: string }) {
  const qc = useQueryClient();
  const fn = useServerFn(debugWipeAllAppointments);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const r = await fn({ data: { clientId, confirmBusinessName: confirm } });
      toast.success(`Deleted ${r.deleted} appointments`);
      qc.invalidateQueries({ queryKey: ["debug", clientId] });
      setOpen(false); setConfirm("");
    } catch (e: any) { toast.error(e.message ?? "Wipe failed"); }
    finally { setRunning(false); }
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" /> Nuke Test Data</CardTitle>
        <CardDescription>Hard-deletes every appointment for this client. Logged to webhook_logs (marker: manual_test_data_wipe). Use before running new booking flows if the test data is polluting availability.</CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive"><Trash2 className="h-4 w-4" /> Delete ALL appointments</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm wipe</DialogTitle>
              <DialogDescription>
                Type the business name exactly to confirm: <span className="font-mono font-semibold">{businessName}</span>
              </DialogDescription>
            </DialogHeader>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={businessName} />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="destructive" onClick={run} disabled={running || confirm.trim().toLowerCase() !== businessName.trim().toLowerCase()}>
                {running ? "Wiping…" : "Delete everything"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ============ Section 7: Logs ============
function LogsSection({ clientId }: { clientId: string }) {
  const fn = useServerFn(debugRecentLogs);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["debug", clientId, "logs", onlyFailures],
    queryFn: () => fn({ data: { clientId, onlyFailures } }),
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Recent Webhook Activity</CardTitle>
          <CardDescription>Latest 40 log entries.</CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={onlyFailures} onCheckedChange={(v) => setOnlyFailures(!!v)} /> Failures only
          </label>
          <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw className="h-3 w-3" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {!data || data.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : (
          <div className="rounded border max-h-96 overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead></TableHead><TableHead>Time</TableHead><TableHead>Dir</TableHead>
                <TableHead>Status</TableHead><TableHead>Error</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.map((l: any) => (
                  <>
                    <TableRow key={l.id} onClick={() => setExpanded(expanded === l.id ? null : l.id)} className="cursor-pointer">
                      <TableCell>{expanded === l.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</TableCell>
                      <TableCell className="text-xs font-mono">{new Date(l.created_at).toLocaleString()}</TableCell>
                      <TableCell className="text-xs">{l.direction}</TableCell>
                      <TableCell className={`text-xs font-mono ${l.status_code >= 400 ? "text-destructive" : ""}`}>{l.status_code ?? "—"}</TableCell>
                      <TableCell className="text-xs text-destructive truncate max-w-xs">{l.error ?? ""}</TableCell>
                    </TableRow>
                    {expanded === l.id && (
                      <TableRow key={l.id + "-exp"}>
                        <TableCell colSpan={5}>
                          <pre className="text-xs bg-muted rounded p-2 overflow-auto max-h-64">{JSON.stringify({ payload: l.payload, response: l.response }, null, 2)}</pre>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Section 8: Outbound Jobs ============
function JobsSection({ clientId }: { clientId: string }) {
  const fn = useServerFn(debugRecentJobs);
  const { data, refetch } = useQuery({ queryKey: ["debug", clientId, "jobs"], queryFn: () => fn({ data: { clientId } }) });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Async Job State (outbound_jobs)</CardTitle>
          <CardDescription>Which background jobs are running, retrying, or dying silently.</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw className="h-3 w-3" /></Button>
      </CardHeader>
      <CardContent>
        {!data || data.length === 0 ? <p className="text-sm text-muted-foreground">No jobs yet (queue not populated — Part B pending).</p> : (
          <div className="rounded border max-h-96 overflow-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>ID</TableHead><TableHead>Type</TableHead><TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead><TableHead>Next run</TableHead><TableHead>Last error</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.map((j: any) => (
                  <TableRow key={j.id}>
                    <TableCell className="text-xs font-mono">{shortId(j.id)}</TableCell>
                    <TableCell className="text-xs">{j.job_type}</TableCell>
                    <TableCell className="text-xs font-mono">{j.status}</TableCell>
                    <TableCell className="text-xs">{j.attempts}/{j.max_attempts}</TableCell>
                    <TableCell className="text-xs">{j.next_run_at ? new Date(j.next_run_at).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-xs text-destructive truncate max-w-md">{j.last_error ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Skeleton({ title }: { title: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Loading…</p></CardContent></Card>;
}
