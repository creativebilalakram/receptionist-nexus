// Server-only booking core: slot generation, conflict detection, booking writes.
// Imported by server functions and public route handlers (AI tool loop, cron).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type SB = SupabaseClient<Database>;

export type Slot = { start: string; end: string; label: string };

export type MeetingType = Database["public"]["Tables"]["meeting_types"]["Row"];
export type BookingSettings = Database["public"]["Tables"]["booking_settings"]["Row"];

// Slot stepping is derived from meeting footprint, never hardcoded.
// step = meeting.duration + meeting.buffer_before + meeting.buffer_after + booking_settings.auto_buffer_after
function computeStepMinutes(mt: MeetingType, settings: BookingSettings): number {
  const dur = mt.duration_minutes ?? 30;
  const bb = mt.buffer_before_minutes ?? 0;
  const ba = mt.buffer_after_minutes ?? 0;
  const auto = settings.auto_buffer_after_minutes ?? 15;
  return Math.max(5, dur + bb + ba + auto);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

// Build a Date for a given local YYYY-MM-DD + HH:MM in a target IANA timezone.
function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  // Construct a naive ISO then derive the offset for that wall time in tz.
  const [h, m] = timeStr.split(":").map((n) => parseInt(n, 10));
  const naive = new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const offset = getTzOffsetMinutes(naive, timeZone);
  return new Date(naive.getTime() - offset * 60_000);
}

function getTzOffsetMinutes(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
    parseInt(parts.hour), parseInt(parts.minute), parseInt(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function dayOfWeekInTz(at: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

function localYmdInTz(at: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return dtf.format(at);
}

export type AvailabilityContext = {
  meetingType: MeetingType;
  settings: BookingSettings;
  timezone: string;
  rules: Database["public"]["Tables"]["availability_rules"]["Row"][];
  blocks: Database["public"]["Tables"]["blocked_dates"]["Row"][];
  busy: Array<{ start: Date; end: Date }>;
};

export async function loadAvailabilityContext(
  supabase: SB,
  clientId: string,
  meetingTypeId: string | null,
): Promise<AvailabilityContext | { error: string }> {
  const [mtRes, setRes, clientRes] = await Promise.all([
    meetingTypeId
      ? supabase.from("meeting_types").select("*").eq("id", meetingTypeId).eq("client_id", clientId).maybeSingle()
      : supabase.from("meeting_types").select("*").eq("client_id", clientId).eq("is_default", true).eq("is_active", true).maybeSingle(),
    supabase.from("booking_settings").select("*").eq("client_id", clientId).maybeSingle(),
    supabase.from("clients").select("timezone").eq("id", clientId).maybeSingle(),
  ]);
  if (mtRes.error || !mtRes.data) return { error: "meeting_type_not_found" };
  if (setRes.error || !setRes.data) return { error: "booking_settings_missing" };

  const timezone = clientRes.data?.timezone || "UTC";

  const [rulesRes, blocksRes, apptsRes] = await Promise.all([
    supabase.from("availability_rules").select("*").eq("client_id", clientId).eq("is_enabled", true),
    supabase.from("blocked_dates").select("*").eq("client_id", clientId),
    supabase.from("appointments").select("scheduled_at,duration_minutes,meeting_type_id,status,effective_end_at")
      .eq("client_id", clientId).neq("status", "cancelled"),
  ]);

  const meetingType = mtRes.data;
  const settings = setRes.data;
  const autoBuf = settings.auto_buffer_after_minutes ?? 15;
  const busy = (apptsRes.data ?? []).map((a) => {
    const start = new Date(a.scheduled_at);
    if (a.effective_end_at) {
      return { start, end: new Date(a.effective_end_at) };
    }
    const dur = a.duration_minutes ?? meetingType.duration_minutes;
    // Fallback: duration + meeting after-buffer + global auto-buffer
    return { start, end: addMinutes(start, dur + (meetingType.buffer_after_minutes ?? 0) + autoBuf) };
  });

  return {
    meetingType,
    settings,
    timezone,
    rules: rulesRes.data ?? [],
    blocks: blocksRes.data ?? [],
    busy,
  };
}

export function generateSlots(
  ctx: AvailabilityContext,
  rangeStart: Date,
  rangeEnd: Date,
  maxSlots = 24,
): Slot[] {
  const { meetingType, settings, timezone, rules, blocks, busy } = ctx;
  const now = new Date();
  const earliest = addMinutes(now, settings.min_notice_minutes);
  const latest = addMinutes(now, settings.max_advance_days * 24 * 60);

  const lowerBound = new Date(Math.max(rangeStart.getTime(), earliest.getTime()));
  const upperBound = new Date(Math.min(rangeEnd.getTime(), latest.getTime()));

  const slots: Slot[] = [];
  if (lowerBound >= upperBound) return slots;

  // Iterate day by day in the client's timezone
  const startYmd = localYmdInTz(lowerBound, timezone);
  const endYmd = localYmdInTz(upperBound, timezone);

  const cursor = new Date(`${startYmd}T00:00:00Z`);
  const stop = new Date(`${endYmd}T00:00:00Z`);

  while (cursor <= stop && slots.length < maxSlots) {
    const dateStr = ymd(cursor);
    const probe = zonedTimeToUtc(dateStr, "12:00", timezone);
    const dow = dayOfWeekInTz(probe, timezone);
    const rule = rules.find((r) => r.day_of_week === dow);
    if (rule) {
      const winStart = zonedTimeToUtc(dateStr, rule.start_time.slice(0, 5), timezone);
      const winEnd = zonedTimeToUtc(dateStr, rule.end_time.slice(0, 5), timezone);
      const step = SLOT_STEP_MIN;
      const dur = meetingType.duration_minutes;
      const bb = meetingType.buffer_before_minutes;
      const ba = meetingType.buffer_after_minutes;

      for (let t = new Date(winStart); addMinutes(t, dur) <= winEnd; t = addMinutes(t, step)) {
        if (slots.length >= maxSlots) break;
        const slotStart = t;
        const slotEnd = addMinutes(t, dur);
        if (slotStart < lowerBound || slotEnd > upperBound) continue;

        const blockHit = blocks.some((b) => {
          const bs = new Date(b.start_at), be = new Date(b.end_at);
          return slotStart < be && slotEnd > bs;
        });
        if (blockHit) continue;

        const conflictStart = addMinutes(slotStart, -bb);
        const conflictEnd = addMinutes(slotEnd, ba);
        const busyHit = busy.some((x) => conflictStart < x.end && conflictEnd > x.start);
        if (busyHit) continue;

        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          label: formatSlotLabel(slotStart, timezone),
        });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return slots;
}

export function formatSlotLabel(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}

export async function bookAppointment(
  supabase: SB,
  args: {
    clientId: string;
    meetingTypeId: string | null;
    startIso: string;
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    conversationId?: string | null;
    notes?: string | null;
    bookedVia?: string;
  },
): Promise<{ ok: true; appointmentId: string; start: string; label: string } | { ok: false; error: string }> {
  const ctx = await loadAvailabilityContext(supabase, args.clientId, args.meetingTypeId);
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const start = new Date(args.startIso);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "invalid_start" };
  const end = addMinutes(start, ctx.meetingType.duration_minutes);

  // Re-check the slot is still inside availability + free
  const validSlots = generateSlots(ctx, addMinutes(start, -1), addMinutes(end, 1), 5);
  const ok = validSlots.some((s) => Math.abs(new Date(s.start).getTime() - start.getTime()) < 60_000);
  if (!ok) return { ok: false, error: "slot_unavailable" };

  const { data, error } = await supabase.from("appointments").insert({
    client_id: args.clientId,
    meeting_type_id: ctx.meetingType.id,
    scheduled_at: start.toISOString(),
    duration_minutes: ctx.meetingType.duration_minutes,
    contact_name: args.contactName ?? null,
    contact_phone: args.contactPhone ?? null,
    contact_email: args.contactEmail ?? null,
    conversation_id: args.conversationId ?? null,
    notes: args.notes ?? null,
    booked_via: args.bookedVia ?? "ai",
    status: "scheduled",
  }).select("id").single();

  if (error || !data) return { ok: false, error: error?.message || "insert_failed" };
  return { ok: true, appointmentId: data.id, start: start.toISOString(), label: formatSlotLabel(start, ctx.timezone) };
}

export async function cancelAppointment(
  supabase: SB,
  id: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from("appointments").update({
    status: "cancelled",
    cancellation_reason: reason ?? null,
  }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function rescheduleAppointment(
  supabase: SB,
  id: string,
  newStartIso: string,
): Promise<{ ok: boolean; error?: string; appointmentId?: string }> {
  const { data: original, error: getErr } = await supabase.from("appointments")
    .select("*").eq("id", id).maybeSingle();
  if (getErr || !original) return { ok: false, error: "appointment_not_found" };

  // Cancel original, create child appointment.
  await supabase.from("appointments").update({ status: "rescheduled" }).eq("id", id);
  const booked = await bookAppointment(supabase, {
    clientId: original.client_id,
    meetingTypeId: original.meeting_type_id,
    startIso: newStartIso,
    contactName: original.contact_name,
    contactPhone: original.contact_phone,
    contactEmail: original.contact_email,
    conversationId: original.conversation_id,
    notes: original.notes,
    bookedVia: "reschedule",
  });
  if (!booked.ok) {
    await supabase.from("appointments").update({ status: original.status }).eq("id", id);
    return { ok: false, error: booked.error };
  }
  await supabase.from("appointments").update({
    parent_appointment_id: id,
    reschedule_count: (original.reschedule_count ?? 0) + 1,
  }).eq("id", booked.appointmentId);
  return { ok: true, appointmentId: booked.appointmentId };
}
