import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, RefreshCw, Trash2, ArrowUpRight } from "lucide-react";
import {
  getClient,
  updateClient,
  toggleClientActive,
  regenerateWebhookSecret,
  deleteClient,
} from "@/lib/clients.functions";
import {
  listConversationsForClient,
  listClientLogs,
  listClientAppointments,
} from "@/lib/data.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPill } from "@/components/StatusPill";
import { relativeTime, formatDateTime } from "@/lib/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const clientOpts = (id: string) => queryOptions({ queryKey: ["client", id], queryFn: () => getClient({ data: { id } }) });
const convsOpts = (id: string) => queryOptions({ queryKey: ["client", id, "convs"], queryFn: () => listConversationsForClient({ data: { client_id: id } }) });
const logsOpts = (id: string) => queryOptions({ queryKey: ["client", id, "logs"], queryFn: () => listClientLogs({ data: { client_id: id } }) });
const apptsOpts = (id: string) => queryOptions({ queryKey: ["client", id, "appts"], queryFn: () => listClientAppointments({ data: { client_id: id } }) });

export const Route = createFileRoute("/_authenticated/clients/$id")({
  head: () => ({ meta: [{ title: "Client — Receptionist Engine" }] }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(clientOpts(params.id)),
  component: ClientDetail,
  errorComponent: ({ error }) => <div className="p-8 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-8 text-sm">Client not found.</div>,
});

function ClientDetail() {
  const { id } = Route.useParams();
  const { data: client } = useSuspenseQuery(clientOpts(id));

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Client · {client.slug}</p>
          <h1 className="mt-2 text-display">{client.business_name}</h1>
          {client.niche && <p className="mt-1 text-sm text-muted-foreground">{client.niche}</p>}
        </div>
        <StatusPill status={client.is_active ? "active" : "idle"} />
      </div>

      <Tabs defaultValue="setup" className="mt-8">
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="mt-6 space-y-8">
          <SetupForm client={client} />
          <WebhookCard clientId={client.id} secret={client.webhook_secret} />
          <DangerZone clientId={client.id} isActive={client.is_active} />
        </TabsContent>

        <TabsContent value="conversations" className="mt-6">
          <ConvosTab clientId={client.id} />
        </TabsContent>

        <TabsContent value="appointments" className="mt-6">
          <ApptsTab clientId={client.id} />
        </TabsContent>

        <TabsContent value="logs" className="mt-6">
          <LogsTab clientId={client.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SetupForm({ client }: { client: Awaited<ReturnType<typeof getClient>> }) {
  const update = useServerFn(updateClient);
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    business_name: client.business_name,
    niche: client.niche ?? "",
    services: client.services ?? "",
    icp: client.icp ?? "",
    objection_notes: client.objection_notes ?? "",
    tone_notes: client.tone_notes ?? "",
    faq: client.faq ?? "",
    booking_link: client.booking_link ?? "",
    business_hours: client.business_hours ?? "",
    timezone: client.timezone,
    system_prompt_override: client.system_prompt_override ?? "",
  });

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await update({ data: { id: client.id, ...form } });
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSave} className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-sm font-semibold">Configuration</h2>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Field label="Business name"><Input value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} required /></Field>
        <Field label="Niche"><Input value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} /></Field>
      </div>
      <div className="mt-5 grid gap-5">
        <Field label="Services"><Textarea rows={3} value={form.services} onChange={(e) => setForm({ ...form, services: e.target.value })} /></Field>
        <Field label="Ideal customer (ICP)"><Textarea rows={2} placeholder="Who you serve in 1–2 sentences" value={form.icp} onChange={(e) => setForm({ ...form, icp: e.target.value })} /></Field>
        <Field label="Objection notes"><Textarea rows={4} placeholder="Common objections + how the AI should reframe them" value={form.objection_notes} onChange={(e) => setForm({ ...form, objection_notes: e.target.value })} /></Field>
        <Field label="Tone guidance"><Textarea rows={3} value={form.tone_notes} onChange={(e) => setForm({ ...form, tone_notes: e.target.value })} /></Field>
        <Field label="FAQ"><Textarea rows={4} value={form.faq} onChange={(e) => setForm({ ...form, faq: e.target.value })} /></Field>
        <Field label="Booking link"><Input type="url" placeholder="https://" value={form.booking_link} onChange={(e) => setForm({ ...form, booking_link: e.target.value })} /></Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Business hours"><Input value={form.business_hours} onChange={(e) => setForm({ ...form, business_hours: e.target.value })} /></Field>
          <Field label="Timezone"><Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></Field>
        </div>
        <Field label="System prompt override (advanced)"><Textarea rows={3} value={form.system_prompt_override} onChange={(e) => setForm({ ...form, system_prompt_override: e.target.value })} /></Field>
      </div>
      <div className="mt-6 flex justify-end">
        <Button type="submit" disabled={loading}>{loading ? "Saving…" : "Save changes"}</Button>
      </div>
    </form>
  );
}

function WebhookCard({ clientId, secret }: { clientId: string; secret: string }) {
  const queryClient = useQueryClient();
  const regenerate = useServerFn(regenerateWebhookSecret);
  const [reveal, setReveal] = useState(false);
  const [currentSecret, setCurrentSecret] = useState(secret);
  const [showSnippet, setShowSnippet] = useState(false);

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/public/manychat-webhook`
    : "/api/public/manychat-webhook";

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }

  async function rotate() {
    const res = await regenerate({ data: { id: clientId } });
    setCurrentSecret(res.webhook_secret);
    queryClient.invalidateQueries({ queryKey: ["client", clientId] });
    toast.success("Webhook secret rotated");
  }

  const snippet = JSON.stringify({
    client_id: clientId,
    webhook_secret: currentSecret,
    subscriber_id: "{{user_id}}",
    phone: "{{phone}}",
    first_name: "{{first_name}}",
    message_text: "{{last_input_text}}",
  }, null, 2);

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-sm font-semibold">Webhook configuration</h2>
      <p className="mt-1 text-xs text-muted-foreground">Connect this client's ManyChat flow to the receptionist.</p>

      <div className="mt-5 space-y-4">
        <CopyRow label="Webhook URL" value={webhookUrl} mono onCopy={() => copy("URL", webhookUrl)} />
        <CopyRow label="Client ID" value={clientId} mono onCopy={() => copy("Client ID", clientId)} />
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Webhook secret</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
              {reveal ? currentSecret : "•".repeat(Math.min(48, currentSecret.length))}
            </code>
            <Button type="button" variant="outline" size="icon" onClick={() => setReveal(!reveal)}>
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => copy("Secret", currentSecret)}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={rotate} title="Regenerate">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">Rotating breaks existing ManyChat integrations until you paste the new secret.</p>
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <button type="button" onClick={() => setShowSnippet(!showSnippet)} className="text-xs font-medium text-primary hover:underline">
          {showSnippet ? "Hide" : "How to connect in ManyChat →"}
        </button>
        {showSnippet && (
          <div className="mt-3 space-y-3 text-xs text-muted-foreground">
            <ol className="list-decimal space-y-1 pl-4">
              <li>In your ManyChat flow, add an <strong>External Request</strong> action.</li>
              <li>Set the URL to the webhook URL above, method <code className="font-mono">POST</code>, content type <code className="font-mono">application/json</code>.</li>
              <li>Paste the body below.</li>
              <li>Map the response field <code className="font-mono">ai_reply</code> to a Custom Field, then send that field back to the user.</li>
            </ol>
            <pre className="overflow-x-auto rounded-md border border-border bg-background p-4 font-mono text-xs text-foreground">{snippet}</pre>
            <Button type="button" variant="outline" size="sm" onClick={() => copy("JSON body", snippet)}>
              <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy JSON body
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyRow({ label, value, mono, onCopy }: { label: string; value: string; mono?: boolean; onCopy: () => void }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        <code className={`flex-1 truncate rounded-md border border-border bg-background px-3 py-2 text-xs ${mono ? "font-mono" : ""}`}>{value}</code>
        <Button type="button" variant="outline" size="icon" onClick={onCopy}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function DangerZone({ clientId, isActive }: { clientId: string; isActive: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toggle = useServerFn(toggleClientActive);
  const remove = useServerFn(deleteClient);
  const [active, setActive] = useState(isActive);

  async function flip(v: boolean) {
    setActive(v);
    try {
      await toggle({ data: { id: clientId, is_active: v } });
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      toast.success(v ? "Client activated" : "Client paused");
    } catch (err) {
      setActive(!v);
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    }
  }

  async function onDelete() {
    try {
      await remove({ data: { id: clientId } });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      toast.success("Client deleted");
      navigate({ to: "/clients" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
      <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
      <div className="mt-5 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Active</div>
          <p className="text-xs text-muted-foreground">When paused, the AI will respond with an "unavailable" message.</p>
        </div>
        <Switch checked={active} onCheckedChange={flip} />
      </div>
      <div className="mt-6 flex items-center justify-between gap-4 border-t border-destructive/20 pt-5">
        <div>
          <div className="text-sm font-medium">Delete this client</div>
          <p className="text-xs text-muted-foreground">Removes all conversations, appointments, and logs. Cannot be undone.</p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm"><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete client?</AlertDialogTitle>
              <AlertDialogDescription>This permanently removes the client and every conversation, appointment, and log entry tied to it.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function ConvosTab({ clientId }: { clientId: string }) {
  const { data } = useSuspenseQuery(convsOpts(clientId));
  if (data.length === 0) return <Empty title="No conversations yet" body="Once your ManyChat flow posts to the webhook, threads land here." />;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {data.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-4 px-6 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{c.first_name ?? c.phone ?? c.subscriber_id}</span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="font-mono text-[10px] text-muted-foreground">score {c.lead_score}</span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{relativeTime(c.last_message_at)}</div>
            </div>
            <StatusPill status={c.status} />
            <Link to="/conversations/$id" params={{ id: c.id }} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApptsTab({ clientId }: { clientId: string }) {
  const { data } = useSuspenseQuery(apptsOpts(clientId));
  if (data.length === 0) return <Empty title="No appointments yet" body="As leads qualify and book, they'll appear here." />;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {data.map((a) => (
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
  );
}

function LogsTab({ clientId }: { clientId: string }) {
  const { data } = useSuspenseQuery(logsOpts(clientId));
  if (data.length === 0) return <Empty title="No logs yet" body="Inbound and outbound webhook activity will stream in here." />;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {data.map((l) => (
          <li key={l.id} className="px-6 py-3">
            <details>
              <summary className="flex cursor-pointer items-center gap-3 text-sm">
                <span className="font-mono text-xs uppercase text-muted-foreground">{l.direction}</span>
                <StatusPill status={l.status_code && l.status_code < 300 ? "active" : "lost"} />
                <span className="text-muted-foreground">{relativeTime(l.created_at)}</span>
                {l.error && <span className="text-xs text-destructive">{l.error}</span>}
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px]">
                {JSON.stringify({ payload: l.payload, response: l.response }, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
