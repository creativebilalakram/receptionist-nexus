import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";
import {
  listMeetingTypes, upsertMeetingType, deleteMeetingType,
  listAvailability, upsertAvailabilityRule,
  listBlockedDates, addBlockedDate, deleteBlockedDate,
  getBookingSettings, updateBookingSettings,
} from "@/lib/booking.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/format";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function BookingTab({ clientId }: { clientId: string }) {
  return (
    <div className="space-y-10">
      <MeetingTypesSection clientId={clientId} />
      <AvailabilitySection clientId={clientId} />
      <BlockedDatesSection clientId={clientId} />
      <BookingSettingsSection clientId={clientId} />
    </div>
  );
}

/* ---------- Meeting Types ---------- */
function MeetingTypesSection({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listMeetingTypes);
  const upsert = useServerFn(upsertMeetingType);
  const del = useServerFn(deleteMeetingType);

  const q = useQuery({ queryKey: ["bk-mt", clientId], queryFn: () => list({ data: { clientId } }) });
  const [editing, setEditing] = useState<any | null>(null);

  const save = useMutation({
    mutationFn: (vals: any) => upsert({ data: { ...vals, clientId } }),
    onSuccess: () => { toast.success("Saved"); setEditing(null); qc.invalidateQueries({ queryKey: ["bk-mt", clientId] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del({ data: { id, clientId } }),
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["bk-mt", clientId] }); },
  });

  return (
    <Section title="Meeting Types" description="What can be booked through WhatsApp. Set a default for AI bookings.">
      <div className="space-y-2">
        {(q.data ?? []).map((mt) => (
          <div key={mt.id} className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium">{mt.name} {mt.is_default && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">default</span>}</p>
              <p className="text-xs text-muted-foreground">{mt.duration_minutes}min · buffer {mt.buffer_before_minutes}/{mt.buffer_after_minutes}min · {mt.is_active ? "active" : "paused"}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(mt)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(mt.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" className="mt-3" onClick={() => setEditing({ name: "", duration_minutes: 15, buffer_before_minutes: 0, buffer_after_minutes: 0, is_default: false, is_active: true, description: "" })}>
        <Plus className="mr-1 h-4 w-4" /> New meeting type
      </Button>
      {editing && (
        <MeetingTypeForm value={editing} onCancel={() => setEditing(null)} onSubmit={(v) => save.mutate(v)} saving={save.isPending} />
      )}
    </Section>
  );
}

function MeetingTypeForm({ value, onSubmit, onCancel, saving }: { value: any; onSubmit: (v: any) => void; onCancel: () => void; saving: boolean }) {
  const [v, setV] = useState(value);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(v); }} className="mt-4 grid grid-cols-1 gap-3 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
      <Labeled label="Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required /></Labeled>
      <Labeled label="Duration (min)"><Input type="number" min={5} max={480} value={v.duration_minutes} onChange={(e) => setV({ ...v, duration_minutes: Number(e.target.value) })} /></Labeled>
      <Labeled label="Buffer before (min)"><Input type="number" min={0} max={240} value={v.buffer_before_minutes} onChange={(e) => setV({ ...v, buffer_before_minutes: Number(e.target.value) })} /></Labeled>
      <Labeled label="Buffer after (min)"><Input type="number" min={0} max={240} value={v.buffer_after_minutes} onChange={(e) => setV({ ...v, buffer_after_minutes: Number(e.target.value) })} /></Labeled>
      <Labeled label="Description" className="sm:col-span-2"><Textarea rows={2} value={v.description ?? ""} onChange={(e) => setV({ ...v, description: e.target.value })} /></Labeled>
      <label className="flex items-center gap-2 text-sm"><Switch checked={v.is_default} onCheckedChange={(c) => setV({ ...v, is_default: c })} /> Default for AI bookings</label>
      <label className="flex items-center gap-2 text-sm"><Switch checked={v.is_active} onCheckedChange={(c) => setV({ ...v, is_active: c })} /> Active</label>
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

/* ---------- Availability ---------- */
function AvailabilitySection({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listAvailability);
  const upsert = useServerFn(upsertAvailabilityRule);
  const q = useQuery({ queryKey: ["bk-av", clientId], queryFn: () => list({ data: { clientId } }) });
  const save = useMutation({
    mutationFn: (v: any) => upsert({ data: { ...v, clientId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bk-av", clientId] }),
    onError: (e: any) => toast.error(e.message),
  });

  const byDay = new Map((q.data ?? []).map((r) => [r.day_of_week, r]));

  return (
    <Section title="Weekly Availability" description="When the AI can offer slots. Times are in the client's timezone.">
      <div className="space-y-2">
        {DAYS.map((label, day) => {
          const r = byDay.get(day);
          const [start, setStart] = [r?.start_time?.slice(0, 5) ?? "10:00", (s: string) => save.mutate({ day_of_week: day, start_time: s, end_time: r?.end_time?.slice(0, 5) ?? "19:00", is_enabled: r?.is_enabled ?? false })];
          const [end, setEnd] = [r?.end_time?.slice(0, 5) ?? "19:00", (s: string) => save.mutate({ day_of_week: day, start_time: r?.start_time?.slice(0, 5) ?? "10:00", end_time: s, is_enabled: r?.is_enabled ?? false })];
          return (
            <div key={day} className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2">
              <Switch checked={r?.is_enabled ?? false} onCheckedChange={(c) => save.mutate({ day_of_week: day, start_time: r?.start_time?.slice(0, 5) ?? "10:00", end_time: r?.end_time?.slice(0, 5) ?? "19:00", is_enabled: c })} />
              <span className="w-12 text-sm font-medium">{label}</span>
              <Input type="time" defaultValue={start} className="w-32" onBlur={(e) => e.target.value !== start && setStart(e.target.value)} />
              <span className="text-muted-foreground">→</span>
              <Input type="time" defaultValue={end} className="w-32" onBlur={(e) => e.target.value !== end && setEnd(e.target.value)} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* ---------- Blocked Dates ---------- */
function BlockedDatesSection({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listBlockedDates);
  const add = useServerFn(addBlockedDate);
  const del = useServerFn(deleteBlockedDate);
  const q = useQuery({ queryKey: ["bk-bl", clientId], queryFn: () => list({ data: { clientId } }) });
  const [draft, setDraft] = useState({ start: "", end: "", reason: "" });

  const addM = useMutation({
    mutationFn: () => add({ data: { clientId, start_at: new Date(draft.start).toISOString(), end_at: new Date(draft.end).toISOString(), reason: draft.reason || null } }),
    onSuccess: () => { toast.success("Blocked"); setDraft({ start: "", end: "", reason: "" }); qc.invalidateQueries({ queryKey: ["bk-bl", clientId] }); },
    onError: (e: any) => toast.error(e.message),
  });
  const delM = useMutation({
    mutationFn: (id: string) => del({ data: { id, clientId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bk-bl", clientId] }),
  });

  return (
    <Section title="Blocked Dates" description="Vacations, holidays, training days — AI won't offer slots inside these.">
      <div className="space-y-2">
        {(q.data ?? []).map((b) => (
          <div key={b.id} className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-2 text-sm">
            <div>
              <p>{formatDateTime(b.start_at)} → {formatDateTime(b.end_at)}</p>
              {b.reason && <p className="text-xs text-muted-foreground">{b.reason}</p>}
            </div>
            <Button size="sm" variant="ghost" onClick={() => delM.mutate(b.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); addM.mutate(); }} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Input type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} required />
        <Input type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} required />
        <Input placeholder="Reason (optional)" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
        <Button type="submit" disabled={addM.isPending}>Block</Button>
      </form>
    </Section>
  );
}

/* ---------- Booking Settings ---------- */
function BookingSettingsSection({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const get = useServerFn(getBookingSettings);
  const upd = useServerFn(updateBookingSettings);
  const q = useQuery({ queryKey: ["bk-set", clientId], queryFn: () => get({ data: { clientId } }) });
  const [form, setForm] = useState<any>(null);

  const data = form ?? q.data;
  const save = useMutation({
    mutationFn: () => upd({ data: { clientId, ...data } }),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["bk-set", clientId] }); setForm(null); },
    onError: (e: any) => toast.error(e.message),
  });

  if (!data) return <Section title="Booking Settings" description=""><p className="text-sm text-muted-foreground">Loading…</p></Section>;

  const patch = (p: any) => setForm({ ...data, ...p });

  return (
    <Section title="Booking Settings" description="Policies + reminder templates + ManyChat API key for outbound reminders.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Labeled label="Min notice (minutes)"><Input type="number" min={0} value={data.min_notice_minutes} onChange={(e) => patch({ min_notice_minutes: Number(e.target.value) })} /></Labeled>
        <Labeled label="Max advance (days)"><Input type="number" min={1} value={data.max_advance_days} onChange={(e) => patch({ max_advance_days: Number(e.target.value) })} /></Labeled>
        <Labeled label="Cancellation window (hours)"><Input type="number" min={0} value={data.cancellation_window_hours} onChange={(e) => patch({ cancellation_window_hours: Number(e.target.value) })} /></Labeled>
        <Labeled label="First reminder (hours before)"><Input type="number" min={0} value={data.reminder_hours_before} onChange={(e) => patch({ reminder_hours_before: Number(e.target.value) })} /></Labeled>
        <Labeled label="Second reminder (hours before)"><Input type="number" min={0} value={data.second_reminder_hours_before} onChange={(e) => patch({ second_reminder_hours_before: Number(e.target.value) })} /></Labeled>
        <Labeled label="ManyChat API key (for reminders)" className="sm:col-span-2">
          <Input type="password" placeholder="Bearer token from ManyChat → Settings → API" value={data.manychat_api_key ?? ""} onChange={(e) => patch({ manychat_api_key: e.target.value })} />
        </Labeled>
        <Labeled label="Confirmation template" className="sm:col-span-2">
          <Textarea rows={2} value={data.confirmation_template} onChange={(e) => patch({ confirmation_template: e.target.value })} />
        </Labeled>
        <Labeled label="Reminder template" className="sm:col-span-2">
          <Textarea rows={2} value={data.reminder_template} onChange={(e) => patch({ reminder_template: e.target.value })} />
        </Labeled>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Template variables: {"{business_name}"}, {"{name}"}, {"{date}"}, {"{time}"}</p>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !form}>{save.isPending ? "Saving…" : "Save settings"}</Button>
      </div>
    </Section>
  );
}

/* ---------- Bits ---------- */
function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
