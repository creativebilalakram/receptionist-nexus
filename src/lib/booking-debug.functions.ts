// Server functions powering the Booking Debug panel.
// Read-only introspection + a couple destructive admin ops (hard delete, wipe).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";


async function assertOwnsClient(supabase: any, userId: string, clientId: string) {
  const { data, error } = await supabase
    .from("clients").select("id, business_name, timezone").eq("id", clientId).eq("owner_id", userId).maybeSingle();
  if (error || !data) throw new Error("forbidden");
  return data as { id: string; business_name: string; timezone: string | null };
}

// ============ 1. Raw appointments ============
export const debugListAppointments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: rows, error } = await context.supabase
      .from("appointments").select("*")
      .eq("client_id", data.clientId)
      .order("scheduled_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return rows ?? [];
  });

export const debugHardDeleteAppointment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { error } = await context.supabase.from("appointments").delete().eq("id", data.id).eq("client_id", data.clientId);
    if (error) throw error;
    await context.supabase.from("webhook_logs").insert({
      client_id: data.clientId,
      direction: "system",
      status_code: 200,
      payload: { marker: "manual_hard_delete_appointment", appointment_id: data.id, by_user: context.userId } as any,
    });
    return { ok: true };
  });

// ============ 6. Nuke all appointments ============
export const debugWipeAllAppointments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid(), confirmBusinessName: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const client = await assertOwnsClient(context.supabase, context.userId, data.clientId);
    if (client.business_name.trim().toLowerCase() !== data.confirmBusinessName.trim().toLowerCase()) {
      throw new Error("confirmation_mismatch");
    }
    const { data: existing } = await context.supabase.from("appointments").select("id").eq("client_id", data.clientId);
    const count = existing?.length ?? 0;
    const { error } = await context.supabase.from("appointments").delete().eq("client_id", data.clientId);
    if (error) throw error;
    await context.supabase.from("webhook_logs").insert({
      client_id: data.clientId,
      direction: "system",
      status_code: 200,
      payload: {
        marker: "manual_test_data_wipe",
        deleted_count: count,
        by_user: context.userId,
        at: new Date().toISOString(),
      } as any,
    });
    return { ok: true, deleted: count };
  });

// ============ 2/3/4. Rules / blocks / settings ============
export const debugConfigSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const client = await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const [rulesRes, blocksRes, setRes, mtRes] = await Promise.all([
      context.supabase.from("availability_rules").select("*").eq("client_id", data.clientId).order("day_of_week"),
      context.supabase.from("blocked_dates").select("*").eq("client_id", data.clientId).order("start_at"),
      context.supabase.from("booking_settings").select("*").eq("client_id", data.clientId).maybeSingle(),
      context.supabase.from("meeting_types").select("*").eq("client_id", data.clientId).order("created_at"),
    ]);
    return {
      client,
      rules: rulesRes.data ?? [],
      blocks: blocksRes.data ?? [],
      settings: setRes.data ?? null,
      meetingTypes: mtRes.data ?? [],
    };
  });

// ============ 5. Live slot generator + rejection audit ============
type AuditEntry = { time_iso: string; time_label: string; included: boolean; reason: string };

export const debugGenerateSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    meetingTypeId: z.string().uuid().optional().nullable(),
    rangeStart: z.string(), // ISO
    rangeEnd: z.string(),   // ISO
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { loadAvailabilityContext, generateSlots } = await import("./booking-core.server");
    const ctx = await loadAvailabilityContext(context.supabase, data.clientId, data.meetingTypeId ?? null);
    if ("error" in ctx) return { error: ctx.error, slots: [] as any[], audit: [] as AuditEntry[] };

    const start = new Date(data.rangeStart);
    const end = new Date(data.rangeEnd);
    const slots = generateSlots(ctx, start, end, 500);

    // Build parallel audit — 15-min candidates across full window explaining each decision.
    const dur = ctx.meetingType.duration_minutes;
    const bb = ctx.meetingType.buffer_before_minutes ?? 0;
    const ba = ctx.meetingType.buffer_after_minutes ?? 0;
    const autoBuf = ctx.settings.auto_buffer_after_minutes ?? 15;
    const footprint = dur + ba + autoBuf;
    const now = new Date();
    const earliest = new Date(now.getTime() + ctx.settings.min_notice_minutes * 60_000);
    const latest = new Date(now.getTime() + ctx.settings.max_advance_days * 86_400_000);

    const tz = ctx.timezone;
    const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(d);

    const audit: AuditEntry[] = [];
    const includedIso = new Set(slots.map((s) => s.start));
    const CANDIDATE_STEP = 15;

    for (let t = new Date(start); t < end && audit.length < 200; t = new Date(t.getTime() + CANDIDATE_STEP * 60_000)) {
      const slotStart = t;
      const occupyEnd = new Date(t.getTime() + footprint * 60_000);
      const iso = slotStart.toISOString();
      const label = fmt(slotStart);

      if (includedIso.has(iso)) {
        audit.push({ time_iso: iso, time_label: label, included: true, reason: "passed all checks" });
        continue;
      }
      if (slotStart < earliest) {
        audit.push({ time_iso: iso, time_label: label, included: false,
          reason: `below min_notice (earliest allowed ${fmt(earliest)})` });
        continue;
      }
      if (occupyEnd > latest) {
        audit.push({ time_iso: iso, time_label: label, included: false, reason: "beyond max_advance_days" });
        continue;
      }
      // Weekday rule check (evaluate weekday in client tz)
      const dowStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(slotStart);
      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(dowStr);
      const rule = ctx.rules.find((r) => r.day_of_week === dow);
      if (!rule) {
        audit.push({ time_iso: iso, time_label: label, included: false,
          reason: `no availability rule for ${dowStr}` });
        continue;
      }
      // Check window in client tz
      const localHM = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(slotStart);
      const localHMEnd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(occupyEnd);
      if (localHM < rule.start_time.slice(0,5) || localHMEnd > rule.end_time.slice(0,5)) {
        audit.push({ time_iso: iso, time_label: label, included: false,
          reason: `outside availability window (${rule.start_time.slice(0,5)}-${rule.end_time.slice(0,5)} ${dowStr})` });
        continue;
      }
      // Blocked dates
      const blockHit = ctx.blocks.find((b) => {
        const bs = new Date(b.start_at), be = new Date(b.end_at);
        return slotStart < be && occupyEnd > bs;
      });
      if (blockHit) {
        audit.push({ time_iso: iso, time_label: label, included: false,
          reason: `blocked_date overlap: ${blockHit.id} (${blockHit.reason ?? "no reason"})` });
        continue;
      }
      // Busy overlap
      const conflictStart = new Date(slotStart.getTime() - bb * 60_000);
      const busyHit = ctx.busy.find((x) => conflictStart < x.end && occupyEnd > x.start);
      if (busyHit) {
        audit.push({ time_iso: iso, time_label: label, included: false,
          reason: `busy overlap: appointment blocks ${fmt(busyHit.start)}–${fmt(busyHit.end)}` });
        continue;
      }
      audit.push({ time_iso: iso, time_label: label, included: false, reason: "step-misaligned (not on slot grid)" });
    }

    return {
      error: null as string | null,
      timezone: ctx.timezone,
      duration: dur,
      step_minutes: dur + bb + ba + autoBuf,
      footprint_minutes: footprint,
      busy_snapshot: ctx.busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
      slots,
      audit,
    };
  });

// ============ 7. Recent webhook logs ============
export const debugRecentLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid(), onlyFailures: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    let q = context.supabase.from("webhook_logs").select("*")
      .eq("client_id", data.clientId).order("created_at", { ascending: false }).limit(40);
    if (data.onlyFailures) q = q.gte("status_code", 400);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

// ============ 8. Outbound jobs ============
export const debugRecentJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: rows, error } = await context.supabase.from("outbound_jobs")
      .select("*").eq("client_id", data.clientId).order("created_at", { ascending: false }).limit(40);
    if (error) throw error;
    return rows ?? [];
  });
