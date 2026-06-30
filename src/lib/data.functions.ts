import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const dashboardStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: clients } = await supabase
      .from("clients").select("id, is_active").eq("owner_id", userId);
    const clientIds = (clients ?? []).map((c) => c.id);
    const activeClients = (clients ?? []).filter((c) => c.is_active).length;

    if (clientIds.length === 0) {
      return {
        activeClients: 0,
        conversationsToday: 0,
        qualifiedThisWeek: 0,
        appointmentsThisWeek: 0,
        recent: [] as Array<{
          id: string; client_id: string; client_name: string;
          first_name: string | null; phone: string | null;
          status: string; last_message_at: string | null;
        }>,
      };
    }

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - 7);

    const [{ count: convsToday }, { count: qualified }, { count: appts }, recentRes] = await Promise.all([
      supabase.from("conversations").select("id", { count: "exact", head: true })
        .in("client_id", clientIds).gte("last_message_at", startOfDay.toISOString()),
      supabase.from("conversations").select("id", { count: "exact", head: true })
        .in("client_id", clientIds).eq("status", "qualified").gte("last_message_at", startOfWeek.toISOString()),
      supabase.from("appointments").select("id", { count: "exact", head: true })
        .in("client_id", clientIds).gte("created_at", startOfWeek.toISOString()),
      supabase.from("conversations")
        .select("id, client_id, first_name, phone, status, last_message_at, clients:client_id(business_name)")
        .in("client_id", clientIds).order("last_message_at", { ascending: false }).limit(10),
    ]);

    const recent = (recentRes.data ?? []).map((r) => ({
      id: r.id,
      client_id: r.client_id,
      client_name: (r.clients as { business_name: string } | null)?.business_name ?? "—",
      first_name: r.first_name,
      phone: r.phone,
      status: r.status,
      last_message_at: r.last_message_at,
    }));

    return {
      activeClients,
      conversationsToday: convsToday ?? 0,
      qualifiedThisWeek: qualified ?? 0,
      appointmentsThisWeek: appts ?? 0,
      recent,
    };
  });

export const listConversationsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ client_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("conversations")
      .select("id, subscriber_id, first_name, phone, status, lead_score, last_message_at, created_at, escalated, escalation_reason")
      .eq("client_id", data.client_id)
      .order("last_message_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getConversation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("conversations")
      .select("*, clients:client_id(id, business_name)")
      .eq("id", data.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Not found");
    return row;
  });

export const updateConversationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    id: z.string().uuid(),
    status: z.enum(["active", "qualified", "booked", "lost", "idle", "escalated"]).optional(),
    manual_takeover: z.boolean().optional(),
  }).parse(input))
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { error } = await context.supabase.from("conversations").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const resumeAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("conversations").update({
      escalated: false,
      escalation_reason: null,
      escalated_at: null,
      status: "active",
    }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listClientLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ client_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("webhook_logs")
      .select("id, direction, status_code, error, payload, response, created_at")
      .eq("client_id", data.client_id)
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const listWebhookFailures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: clients } = await context.supabase
      .from("clients").select("id, business_name").eq("owner_id", context.userId);
    const ids = (clients ?? []).map((c) => c.id);
    const nameMap = new Map((clients ?? []).map((c) => [c.id, c.business_name]));
    if (ids.length === 0) return [] as Array<{
      id: string; client_id: string; client_name: string;
      direction: string; status_code: number | null; error: string | null;
      payload: unknown; response: unknown; created_at: string;
    }>;
    const { data, error } = await context.supabase
      .from("webhook_logs")
      .select("id, client_id, direction, status_code, error, payload, response, created_at")
      .in("client_id", ids)
      .or("status_code.gte.400,error.not.is.null")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ ...r, client_name: nameMap.get(r.client_id) ?? "—" }));
  });

export const listAppointments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: clients } = await context.supabase
      .from("clients").select("id, business_name").eq("owner_id", context.userId);
    const ids = (clients ?? []).map((c) => c.id);
    const nameMap = new Map((clients ?? []).map((c) => [c.id, c.business_name]));
    if (ids.length === 0) return [] as Array<{
      id: string; client_id: string; client_name: string;
      scheduled_at: string; status: string; notes: string | null;
      conversation_id: string | null;
      duration_minutes: number | null; effective_end_at: string | null;
    }>;
    const { data, error } = await context.supabase
      .from("appointments")
      .select("id, client_id, scheduled_at, status, notes, conversation_id, duration_minutes, effective_end_at")
      .in("client_id", ids)
      .order("scheduled_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((a) => ({ ...a, client_name: nameMap.get(a.client_id) ?? "—" }));
  });

export const listClientAppointments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ client_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("appointments")
      .select("id, scheduled_at, status, notes, conversation_id")
      .eq("client_id", data.client_id)
      .order("scheduled_at", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createAppointment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    client_id: z.string().uuid(),
    conversation_id: z.string().uuid().optional().nullable(),
    scheduled_at: z.string().datetime(),
    notes: z.string().max(2000).optional().nullable(),
  }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("appointments").insert({
      client_id: data.client_id,
      conversation_id: data.conversation_id ?? null,
      scheduled_at: data.scheduled_at,
      notes: data.notes ?? null,
      status: "pending",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
