import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const clientInput = z.object({
  business_name: z.string().trim().min(1).max(120),
  niche: z.string().trim().max(120).optional().nullable(),
  services: z.string().trim().max(4000).optional().nullable(),
  tone_notes: z.string().trim().max(4000).optional().nullable(),
  faq: z.string().trim().max(8000).optional().nullable(),
  booking_link: z.string().trim().url().max(500).optional().or(z.literal("")).nullable(),
  business_hours: z.string().trim().max(200).optional().nullable(),
  timezone: z.string().trim().max(80).default("America/New_York"),
  system_prompt_override: z.string().trim().max(8000).optional().nullable(),
});

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clients")
      .select("id, business_name, slug, niche, is_active, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const counts: Record<string, number> = {};
    if (data && data.length) {
      const ids = data.map((c) => c.id);
      const { data: convs } = await context.supabase
        .from("conversations")
        .select("client_id, last_message_at")
        .in("client_id", ids);
      const lastByClient: Record<string, string> = {};
      if (convs) {
        for (const row of convs) {
          counts[row.client_id] = (counts[row.client_id] ?? 0) + 1;
          const ts = row.last_message_at ?? "";
          if (ts && (!lastByClient[row.client_id] || ts > lastByClient[row.client_id])) {
            lastByClient[row.client_id] = ts;
          }
        }
      }
      return data.map((c) => ({ ...c, conversation_count: counts[c.id] ?? 0, last_activity: lastByClient[c.id] ?? null }));
    }
    return [];
  });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: client, error } = await context.supabase
      .from("clients").select("*").eq("id", data.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!client) throw new Error("Not found");
    return client;
  });

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => clientInput.parse(input))
  .handler(async ({ data, context }) => {
    const insertRow = {
      ...data,
      booking_link: data.booking_link || null,
      owner_id: context.userId,
    };
    const { data: row, error } = await context.supabase
      .from("clients").insert(insertRow).select("id, slug").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => clientInput.extend({ id: z.string().uuid(), is_active: z.boolean().optional() }).parse(input))
  .handler(async ({ data, context }) => {
    const { id, ...rest } = data;
    const update = { ...rest, booking_link: rest.booking_link || null };
    const { error } = await context.supabase.from("clients").update(update).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleClientActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("clients").update({ is_active: data.is_active }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const regenerateWebhookSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // generate a 48-char hex secret on the server side
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await context.supabase.from("clients").update({ webhook_secret: secret }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { webhook_secret: secret };
  });

export const deleteClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("clients").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
