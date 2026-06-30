import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, X, CircleDashed, CalendarPlus, AlertTriangle, PlayCircle } from "lucide-react";
import { getConversation, updateConversationStatus, createAppointment, resumeAI } from "@/lib/data.functions";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";

type Msg = { role: "user" | "assistant"; content: string; timestamp: string };
type Qualification = { budget?: boolean | null; authority?: boolean | null; need?: boolean | null; timing?: boolean | null };

const convOpts = (id: string) => queryOptions({ queryKey: ["conversation", id], queryFn: () => getConversation({ data: { id } }) });

export const Route = createFileRoute("/_authenticated/conversations/$id")({
  head: () => ({ meta: [{ title: "Conversation — Receptionist Engine" }] }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(convOpts(params.id)),
  component: ConversationDetail,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Not found.</div>,
});

function ConversationDetail() {
  const { id } = Route.useParams();
  const { data: conv } = useSuspenseQuery(convOpts(id));
  const queryClient = useQueryClient();
  const updateStatus = useServerFn(updateConversationStatus);

  const messages: Msg[] = Array.isArray(conv.messages) ? (conv.messages as unknown as Msg[]) : [];
  const qual = (conv.qualification ?? {}) as Qualification;
  const client = conv.clients as { id: string; business_name: string } | null;

  async function setStatus(status: "qualified" | "lost") {
    await updateStatus({ data: { id, status } });
    queryClient.invalidateQueries({ queryKey: ["conversation", id] });
    toast.success(`Marked ${status}`);
  }

  async function toggleTakeover(v: boolean) {
    await updateStatus({ data: { id, manual_takeover: v } });
    queryClient.invalidateQueries({ queryKey: ["conversation", id] });
    toast.success(v ? "Manual takeover ON — AI paused" : "AI re-engaged");
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link to="/clients/$id" params={{ id: client?.id ?? "" }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> {client?.business_name ?? "Client"}
      </Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Chat */}
        <div className="space-y-4">
          <StageTracker current={(conv.current_stage as string | null) ?? "open"} reasoning={conv.last_reasoning ?? null} />
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h1 className="text-base font-semibold">{conv.first_name ?? conv.phone ?? conv.subscriber_id}</h1>
                <p className="font-mono text-[10px] text-muted-foreground">{conv.phone ?? "no phone"} · {conv.subscriber_id}</p>
              </div>
              <StatusPill status={conv.status} />
            </div>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-6 py-6">
            {messages.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No messages yet.</p>
            ) : messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                  m.role === "user"
                    ? "rounded-bl-sm bg-muted text-foreground"
                    : "rounded-br-sm bg-primary text-primary-foreground"
                }`}>
                  <div>{m.content}</div>
                  <div className={`mt-1 font-mono text-[10px] ${m.role === "user" ? "text-muted-foreground" : "text-primary-foreground/70"}`}>
                    {formatDateTime(m.timestamp)}
                  </div>
                </div>
              </div>
            ))}
          </div>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Lead score</h2>
            <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{conv.lead_score}<span className="text-base text-muted-foreground">/100</span></div>
            <div className="mt-4 space-y-2">
              <BantRow label="Budget" value={qual.budget} />
              <BantRow label="Authority" value={qual.authority} />
              <BantRow label="Need" value={qual.need} />
              <BantRow label="Timing" value={qual.timing} />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Manual takeover</h2>
                <p className="text-xs text-muted-foreground">Pauses AI replies for this thread.</p>
              </div>
              <Switch checked={conv.manual_takeover} onCheckedChange={toggleTakeover} />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-2">
            <h2 className="text-sm font-semibold">Actions</h2>
            <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => setStatus("qualified")}>
              <Check className="mr-1.5 h-3.5 w-3.5" /> Mark qualified
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => setStatus("lost")}>
              <X className="mr-1.5 h-3.5 w-3.5" /> Mark lost
            </Button>
            <ScheduleAppointmentButton clientId={client?.id ?? ""} conversationId={id} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function BantRow({ label, value }: { label: string; value: boolean | null | undefined }) {
  const icon = value === true ? <Check className="h-3.5 w-3.5 text-success" />
    : value === false ? <X className="h-3.5 w-3.5 text-destructive" />
    : <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      {icon}
    </div>
  );
}

function ScheduleAppointmentButton({ clientId, conversationId }: { clientId: string; conversationId: string }) {
  const queryClient = useQueryClient();
  const create = useServerFn(createAppointment);
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!when) { toast.error("Pick a time"); return; }
    setLoading(true);
    try {
      await create({ data: { client_id: clientId, conversation_id: conversationId, scheduled_at: new Date(when).toISOString(), notes: notes || null } });
      toast.success("Appointment scheduled");
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["client", clientId, "appts"] });
      setOpen(false); setWhen(""); setNotes("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setLoading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <CalendarPlus className="mr-1.5 h-3.5 w-3.5" /> Schedule appointment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Schedule appointment</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="when">When</Label>
            <Input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1.5" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={loading}>{loading ? "Scheduling…" : "Schedule"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STAGES: { key: string; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "discover", label: "Discover" },
  { key: "qualify", label: "Qualify" },
  { key: "position", label: "Position" },
  { key: "invite", label: "Invite" },
  { key: "close", label: "Close" },
];

function StageTracker({ current, reasoning }: { current: string; reasoning: string | null }) {
  const [open, setOpen] = useState(false);
  const activeIdx = STAGES.findIndex((s) => s.key === current);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {STAGES.map((s, i) => {
            const isActive = s.key === current;
            const isPast = activeIdx > -1 && i < activeIdx;
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isPast
                        ? "bg-muted text-foreground"
                        : "bg-muted/40 text-muted-foreground"
                  }`}
                >
                  {s.label}
                </span>
                {i < STAGES.length - 1 && <span className="text-[10px] text-muted-foreground">→</span>}
              </div>
            );
          })}
        </div>
        {(current === "objection" || current === "park") && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-amber-500">
            {current}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {open ? "▼" : "▶"} AI reasoning
      </button>
      {open && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-[11px] text-muted-foreground">
          {reasoning ?? "(no reasoning recorded yet)"}
        </pre>
      )}
    </div>
  );
}

