// Admin-facing server functions for booking config + ops.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertOwnsClient(supabase: any, userId: string, clientId: string) {
  const { data, error } = await supabase.from("clients").select("id").eq("id", clientId).eq("owner_id", userId).maybeSingle();
  if (error || !data) throw new Error("forbidden");
}

// ---------- Meeting Types ----------
export const listMeetingTypes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: rows, error } = await context.supabase.from("meeting_types")
      .select("*").eq("client_id", data.clientId).order("created_at", { ascending: true });
    if (error) throw error;
    return rows ?? [];
  });

export const upsertMeetingType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid().optional(),
    clientId: z.string().uuid(),
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional().nullable(),
    duration_minutes: z.number().int().min(5).max(480),
    buffer_before_minutes: z.number().int().min(0).max(240).default(0),
    buffer_after_minutes: z.number().int().min(0).max(240).default(0),
    is_default: z.boolean().default(false),
    is_active: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const payload = {
      client_id: data.clientId,
      name: data.name,
      description: data.description ?? null,
      duration_minutes: data.duration_minutes,
      buffer_before_minutes: data.buffer_before_minutes,
      buffer_after_minutes: data.buffer_after_minutes,
      is_default: data.is_default,
      is_active: data.is_active,
    };
    if (data.is_default) {
      await context.supabase.from("meeting_types").update({ is_default: false }).eq("client_id", data.clientId);
    }
    const q = data.id
      ? context.supabase.from("meeting_types").update(payload).eq("id", data.id).select("*").single()
      : context.supabase.from("meeting_types").insert(payload).select("*").single();
    const { data: row, error } = await q;
    if (error) throw error;
    return row;
  });

export const deleteMeetingType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { error } = await context.supabase.from("meeting_types").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

// ---------- Availability ----------
export const listAvailability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: rows, error } = await context.supabase.from("availability_rules")
      .select("*").eq("client_id", data.clientId).order("day_of_week");
    if (error) throw error;
    return rows ?? [];
  });

export const upsertAvailabilityRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    day_of_week: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    is_enabled: z.boolean(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: existing } = await context.supabase.from("availability_rules")
      .select("id").eq("client_id", data.clientId).eq("day_of_week", data.day_of_week).maybeSingle();
    const payload = {
      client_id: data.clientId,
      day_of_week: data.day_of_week,
      start_time: data.start_time,
      end_time: data.end_time,
      is_enabled: data.is_enabled,
    };
    const q = existing
      ? context.supabase.from("availability_rules").update(payload).eq("id", existing.id).select("*").single()
      : context.supabase.from("availability_rules").insert(payload).select("*").single();
    const { data: row, error } = await q;
    if (error) throw error;
    return row;
  });

// ---------- Blocked Dates ----------
export const listBlockedDates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: rows, error } = await context.supabase.from("blocked_dates")
      .select("*").eq("client_id", data.clientId).order("start_at");
    if (error) throw error;
    return rows ?? [];
  });

export const addBlockedDate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    start_at: z.string(),
    end_at: z.string(),
    reason: z.string().max(200).optional().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: row, error } = await context.supabase.from("blocked_dates").insert({
      client_id: data.clientId, start_at: data.start_at, end_at: data.end_at, reason: data.reason ?? null,
    }).select("*").single();
    if (error) throw error;
    return row;
  });

export const deleteBlockedDate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { error } = await context.supabase.from("blocked_dates").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

// ---------- Booking Settings ----------
export const getBookingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { data: row } = await context.supabase.from("booking_settings")
      .select("*").eq("client_id", data.clientId).maybeSingle();
    return row;
  });

export const updateBookingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    min_notice_minutes: z.number().int().min(0).max(10080).optional(),
    max_advance_days: z.number().int().min(1).max(365).optional(),
    cancellation_window_hours: z.number().int().min(0).max(168).optional(),
    reminder_hours_before: z.number().int().min(0).max(168).optional(),
    second_reminder_hours_before: z.number().int().min(0).max(72).optional(),
    confirmation_template: z.string().max(2000).optional(),
    reminder_template: z.string().max(2000).optional(),
    manychat_api_key: z.string().max(500).optional().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { clientId, ...rest } = data;
    const { data: row, error } = await context.supabase.from("booking_settings")
      .update(rest).eq("client_id", clientId).select("*").single();
    if (error) throw error;
    return row;
  });

// ---------- Slots & Booking ops ----------
export const getAvailableSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    meetingTypeId: z.string().uuid().optional().nullable(),
    rangeStart: z.string(),
    rangeEnd: z.string(),
    maxSlots: z.number().int().min(1).max(100).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { loadAvailabilityContext, generateSlots } = await import("./booking-core.server");
    const ctx = await loadAvailabilityContext(context.supabase, data.clientId, data.meetingTypeId ?? null);
    if ("error" in ctx) return { slots: [], error: ctx.error };
    const slots = generateSlots(ctx, new Date(data.rangeStart), new Date(data.rangeEnd), data.maxSlots ?? 24);
    return { slots, timezone: ctx.timezone, duration: ctx.meetingType.duration_minutes };
  });

export const cancelAppointmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid(), clientId: z.string().uuid(), reason: z.string().max(300).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { cancelAppointment } = await import("./booking-core.server");
    return cancelAppointment(context.supabase, data.id, data.reason);
  });

export const rescheduleAppointmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid(), clientId: z.string().uuid(), newStartIso: z.string(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { rescheduleAppointment } = await import("./booking-core.server");
    return rescheduleAppointment(context.supabase, data.id, data.newStartIso);
  });

export const manualBookAppointment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    clientId: z.string().uuid(),
    meetingTypeId: z.string().uuid().optional().nullable(),
    startIso: z.string(),
    contactName: z.string().max(200).optional().nullable(),
    contactPhone: z.string().max(40).optional().nullable(),
    contactEmail: z.string().max(200).optional().nullable(),
    conversationId: z.string().uuid().optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsClient(context.supabase, context.userId, data.clientId);
    const { bookAppointment } = await import("./booking-core.server");
    return bookAppointment(context.supabase, {
      clientId: data.clientId,
      meetingTypeId: data.meetingTypeId ?? null,
      startIso: data.startIso,
      contactName: data.contactName,
      contactPhone: data.contactPhone,
      contactEmail: data.contactEmail,
      conversationId: data.conversationId,
      notes: data.notes,
      bookedVia: "manual",
    });
  });
