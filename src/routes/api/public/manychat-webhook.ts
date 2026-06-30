import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { sendWhatsAppText, sendWhatsAppTextParts } from "@/lib/manychat-send.server";

type SupabaseAdmin = Awaited<ReturnType<typeof loadAdmin>>;
async function loadAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}


// Accepts ManyChat "Full Contact Data" payload directly.
// client_id + webhook_secret are passed as URL query params.
const Payload = z
  .object({
    id: z.union([z.string(), z.number()]).optional().nullable(),
    key: z.string().optional().nullable(),
    first_name: z.string().max(120).optional().nullable(),
    last_name: z.string().max(120).optional().nullable(),
    name: z.string().max(240).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    whatsapp_phone: z.string().max(40).optional().nullable(),
    last_input_text: z.string().max(4000).optional().nullable(),
    // Back-compat: still allow legacy custom-field shape
    client_id: z.string().uuid().optional(),
    webhook_secret: z.string().optional(),
    subscriber_id: z.string().optional(),
    message_text: z.string().optional(),
  })
  .passthrough();


const FALLBACK = "Give me one moment, let me check on that for you.";

type Stage = "open" | "discover" | "qualify" | "position" | "invite" | "objection" | "close" | "park";

type BookingAction =
  | {
      type: "check_availability";
      user_stated_time?: string;
      preferred_date_label?: string;
      preferred_time_window?: "morning" | "afternoon" | "evening" | "specific_time" | "any" | string;
      specific_time_local?: string | null;
    }
  | { type: "book_slot"; slot_iso_utc: string; contact_email?: string | null }
  | { type: "none" };

type AIResponse = {
  reply: string;
  reply_parts?: string[];
  stage?: Stage;
  qualification_update?: {
    budget?: boolean | null;
    authority?: boolean | null;
    need?: boolean | null;
    timing?: boolean | null;
  };
  reasoning?: string;
  ready_to_book?: boolean;
  status_change?: "qualified" | "booked" | "lost" | null;
  escalate?: boolean;
  escalation_reason?: string;
  booking_action?: BookingAction;
};

type Msg = { role: "user" | "assistant"; content: string; timestamp: string };

type ClientRow = {
  business_name: string;
  niche: string | null;
  services: string | null;
  icp: string | null;
  objection_notes: string | null;
  tone_notes: string | null;
  faq: string | null;
  business_hours: string | null;
  timezone: string | null;
  booking_link: string | null;
  system_prompt_override: string | null;
};

export const Route = createFileRoute("/api/public/manychat-webhook")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type",
          },
        }),
      POST: async ({ request }) => {
        const cors = {
          "Access-Control-Allow-Origin": "*",
          "content-type": "application/json",
        } as const;
        const ackEmpty = () =>
          new Response(JSON.stringify({ ai_reply: "" }), { headers: cors });
        const ackStop = () =>
          new Response(JSON.stringify({ ai_reply: "STOP" }), { headers: cors });

        const supabaseAdmin = await loadAdmin();

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return new Response(JSON.stringify({ ai_reply: "", error: "invalid_json" }), { status: 400, headers: cors });
        }

        const parsed = Payload.safeParse(raw);
        if (!parsed.success) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: raw as Json, status_code: 400,
            error: parsed.error.message,
          });
          return new Response(JSON.stringify({ ai_reply: "", error: "invalid_payload" }), { status: 400, headers: cors });
        }
        const rawData = parsed.data;

        // Pull credentials from URL query params (preferred) or fall back to body
        const url = new URL(request.url);
        const qClientId = url.searchParams.get("client_id") ?? undefined;
        const qSecret = url.searchParams.get("secret") ?? url.searchParams.get("webhook_secret") ?? undefined;

        const client_id = rawData.client_id ?? qClientId;
        const webhook_secret = rawData.webhook_secret ?? qSecret;
        const subscriber_id = rawData.subscriber_id ?? (rawData.id != null ? String(rawData.id) : "");
        const phone = rawData.phone ?? rawData.whatsapp_phone ?? null;
        const first_name = rawData.first_name ?? null;
        const message_text = (rawData.message_text ?? rawData.last_input_text ?? "").trim();

        if (!client_id || !webhook_secret || !subscriber_id || !message_text) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: raw as Json, status_code: 400,
            error: `missing_fields: ${[
              !client_id && "client_id",
              !webhook_secret && "webhook_secret",
              !subscriber_id && "subscriber_id",
              !message_text && "message_text",
            ].filter(Boolean).join(",")}`,
          });
          return new Response(JSON.stringify({ ai_reply: "", error: "invalid_payload" }), { status: 400, headers: cors });
        }

        const data = { client_id, webhook_secret, subscriber_id, phone, first_name, message_text };

        const { data: client, error: clientErr } = await supabaseAdmin
          .from("clients").select("*").eq("id", data.client_id).maybeSingle();
        if (clientErr || !client) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: data as unknown as Json, status_code: 404, error: "client_not_found",
          });
          return new Response(JSON.stringify({ ai_reply: "", error: "client_not_found" }), { status: 404, headers: cors });
        }

        if (client.webhook_secret !== data.webhook_secret) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 401, error: "invalid_secret",
          });
          return new Response(JSON.stringify({ ai_reply: "", error: "unauthorized" }), { status: 401, headers: cors });
        }

        if (!client.is_active) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200, error: "client_paused",
          });
          return ackStop();
        }

        // TEMP allowlist
        const ALLOWED_PHONES = ["3447306520", "3260660523"];
        const normalized = (data.phone ?? "").replace(/\D/g, "");

        const last10 = normalized.slice(-10);
        if (!ALLOWED_PHONES.includes(last10)) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200, error: "phone_not_allowlisted",
          });
          return ackStop();
        }

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200,
        });

        // Fast pre-checks for STOP cases
        const { data: existing } = await supabaseAdmin
          .from("conversations").select("*")
          .eq("client_id", client.id).eq("subscriber_id", data.subscriber_id).maybeSingle();

        if (existing?.escalated || existing?.manual_takeover) {
          const nowIso = new Date().toISOString();
          const msgs: Msg[] = Array.isArray(existing.messages) ? (existing.messages as unknown as Msg[]) : [];
          msgs.push({ role: "user", content: data.message_text, timestamp: nowIso });
          await supabaseAdmin.from("conversations").update({
            messages: msgs as unknown as Json,
            last_message_at: nowIso,
            phone: data.phone ?? existing.phone ?? null,
            first_name: data.first_name ?? existing.first_name ?? null,
          }).eq("id", existing.id);
          return ackStop();
        }

        // IMPORTANT: Do the Send API push in-request. The previous fire-and-forget
        // path could be killed by the production runtime after the 200 ack, leaving
        // an inbound log but no outbound WhatsApp message.
        try {
          await processAndSend(supabaseAdmin, client as ClientRow & { id: string }, data, existing ?? null);
        } catch (err) {
          console.error("[manychat-webhook] processAndSend failed:", err);
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "outbound",
            payload: { error: "processAndSend_threw" } as unknown as Json,
            response: { message: err instanceof Error ? err.message : String(err) } as Json,
            status_code: 500,
          });
        }

        return ackEmpty();
      },
    },
  },
});

type ConvRow = NonNullable<Awaited<ReturnType<typeof fetchExistingConv>>>;
async function fetchExistingConv(
  supabaseAdmin: SupabaseAdmin,
  clientId: string,
  subscriberId: string,
) {
  const { data } = await supabaseAdmin
    .from("conversations").select("*")
    .eq("client_id", clientId).eq("subscriber_id", subscriberId).maybeSingle();
  return data;
}

type NormalizedPayload = {
  client_id: string;
  webhook_secret: string;
  subscriber_id: string;
  phone: string | null;
  first_name: string | null;
  message_text: string;
};

async function processAndSend(
  supabaseAdmin: SupabaseAdmin,
  client: ClientRow & { id: string },
  data: NormalizedPayload,
  existing: ConvRow | null,
): Promise<void> {

  const nowIso = new Date().toISOString();
  const messages: Msg[] = Array.isArray(existing?.messages) ? (existing!.messages as unknown as Msg[]) : [];
  const priorMessageCount = messages.length;
  messages.push({ role: "user", content: data.message_text, timestamp: nowIso });

  let convoId = existing?.id;
  let qualification = (existing?.qualification ?? {}) as Record<string, unknown>;
  let leadScore = existing?.lead_score ?? 0;
  let status = existing?.status ?? "active";
  let currentStage: Stage = ((existing?.current_stage as Stage | undefined) ?? "open");

  if (!existing) {
    const { data: newRow, error: insErr } = await supabaseAdmin.from("conversations").insert({
      client_id: client.id,
      subscriber_id: data.subscriber_id,
      phone: data.phone ?? null,
      first_name: data.first_name ?? null,
      messages: messages as unknown as Json,
      last_message_at: nowIso,
      current_stage: "open",
    }).select("id").single();
    if (insErr || !newRow) {
      console.error("[processAndSend] convo insert failed:", insErr);
      return;
    }
    convoId = newRow.id;
  }

  const isFirstEverMessage = priorMessageCount === 0;
  const systemPrompt = buildSystemPrompt(client, data.first_name ?? null, isFirstEverMessage);
  const aiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    })),
  ];

  const aiKey = process.env.LOVABLE_API_KEY;
  let aiReply = FALLBACK;
  let parsedAI: AIResponse | null = null;
  let aiResponseLog: unknown = null;
  let aiStatusCode = 0;

  if (!aiKey) {
    aiResponseLog = { error: "missing_LOVABLE_API_KEY" };
  } else {
    try {
      const { retryFetch } = await import("@/lib/retry");
      const resp = await retryFetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Lovable-API-Key": aiKey,
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: aiMessages,
          response_format: { type: "json_object" },
        }),
      }, { attempts: 3, baseMs: 500, timeoutMs: 18_000, label: "ai-gateway-main" });
      aiStatusCode = resp.status;
      const json = await resp.json().catch(() => null);
      aiResponseLog = json;
      if (resp.ok && json?.choices?.[0]?.message?.content) {
        const content = json.choices[0].message.content as string;
        parsedAI = safeParseAIJson(content);
        if (parsedAI && typeof parsedAI.reply === "string" && parsedAI.reply.trim().length > 0) {
          aiReply = parsedAI.reply.trim();
        }
      }
    } catch (err) {
      aiResponseLog = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (parsedAI?.qualification_update) {
    qualification = { ...qualification, ...parsedAI.qualification_update };
  }
  // SAFETY: never let the AI self-declare "booked" — only a successful
  // book_slot tool insert (below) is allowed to flip status to "booked".
  // Otherwise the AI can hallucinate "confirm hai" with no DB row.
  if (parsedAI?.status_change && parsedAI.status_change !== "booked") {
    status = parsedAI.status_change;
  }
  if (parsedAI?.stage) currentStage = parsedAI.stage;
  const bantKeys = ["budget", "authority", "need", "timing"] as const;
  leadScore = bantKeys.reduce((acc, k) => acc + (qualification[k] === true ? 25 : 0), 0);

  const shouldEscalate = parsedAI?.escalate === true;
  if (shouldEscalate) status = "escalated";

  // ---- BOOKING TOOL LOOP ----
  // Bookings hit DB + a second AI call, often 5-15s. Send an immediate
  // "let me check..." ack bubble first so the user sees activity, then
  // continue with the real work and send the final answer as bubble #2.
  let ackSent = false;
  const action = parsedAI?.booking_action;
  if (!shouldEscalate && action && action.type !== "none") {
    const ackText = pickAckText(parsedAI?.reply, data.message_text, action.type);
    if (ackText) {
      const ackRes = await sendWhatsAppText(data.subscriber_id, ackText);
      if (ackRes.ok) {
        ackSent = true;
        // Log ack as its own assistant turn so the chat view feels human too.
        messages.push({ role: "assistant", content: ackText, timestamp: new Date().toISOString() });
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: { reply: ackText, kind: "ack_bubble", booking_action: action.type } as unknown as Json,
          response: { manychat: ackRes.body ?? null } as Json,
          status_code: 200,
        });
      }
    }

    const { loadAvailabilityContext, generateSlots, bookAppointment } =
      await import("@/lib/booking-core.server");

    if (action.type === "check_availability") {
      const ctx = await loadAvailabilityContext(supabaseAdmin, client.id, null);
      if (!("error" in ctx)) {
        const tz = ctx.timezone;
        const target = resolveTargetDateTime(
          action.preferred_date_label ?? null,
          action.specific_time_local ?? null,
          tz,
        );
        const window = (action.preferred_time_window || "any").toLowerCase();

        const anchor = target.date ?? new Date();
        const rangeStart = new Date(anchor.getTime() - 24 * 60 * 60_000);
        const rangeEnd = new Date(anchor.getTime() + 6 * 24 * 60 * 60_000);
        const allSlots = generateSlots(ctx, rangeStart, rangeEnd, 80);

        const sameDay = target.localYmd
          ? allSlots.filter((s) => localYmdInTz(new Date(s.start), tz) === target.localYmd)
          : allSlots;
        const windowed = sameDay.filter((s) => matchesWindow(new Date(s.start), tz, window));

        let exactSlot: { start: string; label: string } | null = null;
        if (target.exactUtcMs) {
          const hit = allSlots.find(
            (s) => Math.abs(new Date(s.start).getTime() - target.exactUtcMs!) < 60_000,
          );
          if (hit) exactSlot = { start: hit.start, label: hit.label };
        }

        const pool = (windowed.length ? windowed : sameDay.length ? sameDay : allSlots);
        const anchorMs = target.exactUtcMs ?? anchor.getTime();
        const alternatives = pool
          .filter((s) => !exactSlot || s.start !== exactSlot.start)
          .map((s) => ({ s, d: Math.abs(new Date(s.start).getTime() - anchorMs) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 2)
          .map((x) => ({ start: x.s.start, label: x.s.label }));

        const summary = JSON.stringify({
          user_stated_time: action.user_stated_time ?? null,
          timezone: tz,
          exact_available: !!exactSlot,
          exact_slot: exactSlot,
          alternatives,
          window_empty: pool.length === 0,
        });

        aiReply = await draftBookingReply(aiKey, systemPrompt, messages, {
          tool: "check_availability",
          result: summary,
          timezone: tz,
        }) ?? aiReply;
      }
    } else if (action.type === "book_slot") {
      // HARD VALIDATE the AI-proposed slot before touching the DB.
      // The AI has been known to hallucinate year/date — reject anything
      // that isn't a valid future ISO within max_advance_days.
      const ctx = await loadAvailabilityContext(supabaseAdmin, client.id, null);
      const proposed = new Date(action.slot_iso_utc);
      const proposedMs = proposed.getTime();
      const nowMs = Date.now();
      let validatedIso: string | null = null;

      if ("error" in ctx) {
        // Settings missing — fail soft.
      } else if (!Number.isNaN(proposedMs) && proposedMs > nowMs - 5 * 60_000) {
        // Try to find this exact slot (±1 min) in a freshly generated window
        // around the proposed time. This catches both stale ISOs and
        // hallucinated-year ISOs (which fall outside the window entirely).
        const rs = new Date(proposedMs - 24 * 60 * 60_000);
        const re = new Date(proposedMs + 24 * 60 * 60_000);
        const slots = generateSlots(ctx, rs, re, 200);
        const hit = slots.find(
          (s) => Math.abs(new Date(s.start).getTime() - proposedMs) < 60_000,
        );
        if (hit) validatedIso = hit.start;
      }

      if (!validatedIso) {
        // Deterministic failure reply — DO NOT let the AI write this, it
        // hallucinates "All set!" even when told the booking failed.
        aiReply = pickBookingFailureText(data.message_text);
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: {
            kind: "book_slot_validation_failed",
            proposed_iso: action.slot_iso_utc,
            reason: !Number.isNaN(proposedMs) && proposedMs <= nowMs - 5 * 60_000 ? "past_or_too_close" : "slot_not_in_availability",
          } as unknown as Json,
          status_code: 422,
        });
      } else {
        const result = await bookAppointment(supabaseAdmin, {
          clientId: client.id,
          meetingTypeId: null,
          startIso: validatedIso,
          contactName: data.first_name ?? null,
          contactPhone: data.phone ?? null,
          contactEmail: action.contact_email ?? null,
          conversationId: convoId ?? null,
          notes: null,
          bookedVia: "ai",
        });
        if (result.ok) {
          status = "booked";
          aiReply = await draftBookingReply(aiKey, systemPrompt, messages, {
            tool: "book_slot",
            result: `Booked successfully for ${result.label}.`,
          }) ?? `Booked for *${result.label}*. See you then.`;
        } else {
          // Same deterministic failure path — never trust AI for failure copy.
          aiReply = pickBookingFailureText(data.message_text);
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id,
            direction: "outbound",
            payload: { kind: "book_slot_db_failed", error: result.error, iso: validatedIso } as unknown as Json,
            status_code: 422,
          });
        }
      }
    }
  }
  // Mark that an ack was already pushed so the final send skips re-sending it.
  void ackSent;

  // Dedupe: if the final reply is identical or a substring-prefix match of the
  // ack we already sent, replace it with a deterministic short follow-up so the
  // user doesn't see the same bubble twice.
  if (ackSent) {
    const lastAck = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") return messages[i].content;
      }
      return "";
    })();
    if (lastAck && normalizeForCompare(aiReply) === normalizeForCompare(lastAck)) {
      aiReply = pickPostAckFiller(data.message_text);
    }
  }


  aiReply = sanitizeReplyText(aiReply);

  // Decide on message parts: prefer model-provided reply_parts, else auto-split.
  let parts: string[] = [];
  const modelParts = Array.isArray(parsedAI?.reply_parts)
    ? parsedAI!.reply_parts!.map((p) => (typeof p === "string" ? sanitizeReplyText(p) : "")).filter(Boolean)
    : [];
  if (modelParts.length > 0) {
    parts = modelParts.slice(0, 3); // hard cap 3 bubbles
  } else {
    parts = autoSplitReply(aiReply);
  }
  // Final guard: never send empty
  if (parts.length === 0) parts = [aiReply];

  // Log the full reply text in the conversation as one assistant turn (joined),
  // so the chat view still reads naturally.
  const joinedForLog = parts.join("\n\n");
  messages.push({ role: "assistant", content: joinedForLog, timestamp: new Date().toISOString() });

  await supabaseAdmin.from("conversations").update({
    messages: messages as unknown as Json,
    qualification: qualification as unknown as Json,
    lead_score: leadScore,
    status,
    current_stage: currentStage,
    last_reasoning: parsedAI?.reasoning ?? null,
    last_message_at: new Date().toISOString(),
    phone: data.phone ?? existing?.phone ?? null,
    first_name: data.first_name ?? existing?.first_name ?? null,
    ...(shouldEscalate
      ? {
          escalated: true,
          escalation_reason: parsedAI?.escalation_reason ?? "Escalated by AI",
          escalated_at: new Date().toISOString(),
        }
      : {}),
  }).eq("id", convoId!);

  // Push to user via ManyChat Send API as multiple human-like bubbles.
  const sendRes = parts.length > 1
    ? await sendWhatsAppTextParts(data.subscriber_id, parts)
    : await sendWhatsAppText(data.subscriber_id, parts[0]);

  await supabaseAdmin.from("webhook_logs").insert({
    client_id: client.id,
    direction: "outbound",
    payload: {
      reply: joinedForLog,
      parts_count: parts.length,
      parsed: parsedAI,
      ai_status: aiStatusCode || 200,
      manychat_send_ok: sendRes.ok,
      manychat_send_status: sendRes.status,
      manychat_send_error: sendRes.ok ? null : sendRes.error,
    } as unknown as Json,
    response: { ai: aiResponseLog, manychat: sendRes.body ?? null } as Json,
    status_code: sendRes.ok ? 200 : (sendRes.status || 500),
    error: sendRes.ok ? null : sendRes.error,
  });
}

/**
 * Auto-split a single reply into 1-2 short WhatsApp bubbles for a human feel.
 * Splits on double newline first, else on sentence boundary near the midpoint
 * if the message is long (>180 chars). Never splits short messages.
 */
function autoSplitReply(text: string): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  // Respect explicit paragraph breaks from the model first.
  const paraSplit = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (paraSplit.length >= 2) return paraSplit.slice(0, 3);
  // Short message → single bubble.
  if (t.length <= 180) return [t];
  // Find sentence boundary nearest the middle.
  const mid = Math.floor(t.length / 2);
  const matches = [...t.matchAll(/[.!?؟।]\s+/g)];
  if (matches.length === 0) return [t];
  let best = matches[0];
  let bestDist = Math.abs((best.index ?? 0) - mid);
  for (const m of matches) {
    const d = Math.abs((m.index ?? 0) - mid);
    if (d < bestDist) { best = m; bestDist = d; }
  }
  const cut = (best.index ?? 0) + best[0].length;
  const a = t.slice(0, cut).trim();
  const b = t.slice(cut).trim();
  if (!a || !b) return [t];
  return [a, b];
}


async function draftBookingReply(
  aiKey: string | undefined,
  systemPrompt: string,
  messages: Msg[],
  toolResult: { tool: string; result: string; timezone?: string },
): Promise<string | null> {
  if (!aiKey) return null;
  try {
    const { retryFetch } = await import("@/lib/retry");
    const resp = await retryFetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "Lovable-API-Key": aiKey },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "system",
            content: `TOOL_RESULT (${toolResult.tool})${toolResult.timezone ? ` [timezone: ${toolResult.timezone}]` : ""}:\n${toolResult.result}\n\nNow draft ONLY the final WhatsApp reply text (no JSON, no preamble, no markdown fences). Follow ALL tone rules (1-3 lines, *bold* on key words, no dashes/dividers, mirror their language). For check_availability: if exact_available=true → confirm naturally and ask to lock it in (one short question). If exact_available=false and alternatives exist → naturally mention 1-2 alternatives conversationally in flowing prose (NEVER numbered lists, NEVER bullets — write "I have *2:30pm* or *4pm* same day, either work?"). If window_empty=true → acknowledge warmly and widen the question (e.g. ask about a different day). Always state the timezone label naturally when giving a time. For book_slot: warm 1-2 line confirmation; if no contact email known yet, ask for it in the same message framed as "so I can send a calendar invite too".`,
          },
        ],
      }),
    }, { attempts: 3, baseMs: 500, timeoutMs: 15_000, label: "ai-gateway-booking" });
    const json = await resp.json().catch(() => null);
    const txt = json?.choices?.[0]?.message?.content;
    if (typeof txt === "string" && txt.trim().length) return txt.trim();
  } catch { /* ignore */ }
  return null;
}

/**
 * Pick a short, language-aware "let me check..." ack bubble for slow tool calls.
 * Prefers the AI's first-pass `reply` (it's prompted to provide a brief holding
 * phrase), but only if it's actually short and not the full answer.
 * Falls back to a localized template based on the user's last message script.
 */
function pickAckText(
  aiFirstPass: string | undefined,
  lastUserText: string,
  actionType: "check_availability" | "book_slot",
): string {
  const candidate = (aiFirstPass ?? "").trim();
  // Use AI's holding phrase only if it's genuinely short (< 90 chars, 1 line).
  if (candidate && candidate.length <= 90 && !candidate.includes("\n")) {
    return candidate;
  }
  // Detect script / language from the last user message.
  const t = lastUserText ?? "";
  if (/[\u0600-\u06FF]/.test(t)) {
    return actionType === "book_slot" ? "ایک سیکنڈ، بُک کر رہا ہوں…" : "ایک سیکنڈ، چیک کرتا ہوں…";
  }
  if (/[\u0900-\u097F]/.test(t)) {
    return actionType === "book_slot" ? "एक सेकंड, बुक कर रहा हूँ…" : "एक सेकंड, चेक करता हूँ…";
  }
  if (/[\u0621-\u064A]/.test(t)) {
    return actionType === "book_slot" ? "لحظة، أحجز لك الآن…" : "لحظة، أتحقق لك…";
  }
  // Roman Urdu heuristic
  const lower = t.toLowerCase();
  const romanHits = ["kya", "ka ", "ko ", " ma ", " ha ", "kar", "mujh", "mera", "kasa", "btao", "thora", "abi", "nahi"]
    .filter((w) => lower.includes(w)).length;
  if (romanHits >= 2) {
    return actionType === "book_slot" ? "ek sec, *book* kar raha hun…" : "ek sec, *check* karta hun…";
  }
  return actionType === "book_slot" ? "one sec, *booking* it now…" : "one sec, let me *check*…";
}

/**
 * Deterministic, language-aware failure reply for book_slot.
 * Used when the AI proposes an invalid/past/hallucinated slot OR the DB insert
 * fails. We never let the AI write this — it has been observed to write
 * "All set!" even when told the booking failed, which is the worst-case
 * trust-breaking bug.
 */
function pickBookingFailureText(lastUserText: string): string {
  const t = lastUserText ?? "";
  if (/[\u0600-\u06FF]/.test(t)) {
    return "معذرت، یہ سلاٹ ابھی *دستیاب نہیں*۔ کوئی اور وقت بتائیں؟";
  }
  if (/[\u0900-\u097F]/.test(t)) {
    return "माफ़ कीजिए, ये स्लॉट अभी *उपलब्ध नहीं* है। कोई और समय बताएँ?";
  }
  if (/[\u0621-\u064A]/.test(t)) {
    return "عذراً، هذا الموعد غير *متاح* حالياً. أي وقت آخر يناسبك؟";
  }
  const lower = t.toLowerCase();
  const romanHits = ["kya", "ka ", "ko ", " ma ", " ha ", "kar", "mujh", "mera", "kasa", "btao", "thora", "abi", "nahi", "kal", "kab"]
    .filter((w) => lower.includes(w)).length;
  if (romanHits >= 2) {
    return "Sorry, wo slot abhi *available nahi* hai. Koi aur time bata dein?";
  }
  return "Sorry, that slot is no longer *available*. What other time works?";
}

/**
 * Deterministic short filler used only when the planned final reply is a
 * duplicate of the ack we already sent. Keeps the conversation moving instead
 * of repeating the same bubble.
 */
function pickPostAckFiller(lastUserText: string): string {
  const t = lastUserText ?? "";
  if (/[\u0600-\u06FF]/.test(t)) return "ایک سیکنڈ اور…";
  if (/[\u0900-\u097F]/.test(t)) return "बस एक पल और…";
  if (/[\u0621-\u064A]/.test(t)) return "لحظة واحدة فقط…";
  const lower = t.toLowerCase();
  const romanHits = ["kya", "ka ", "ko ", " ma ", " ha ", "kar", "nahi", "kal"]
    .filter((w) => lower.includes(w)).length;
  if (romanHits >= 2) return "bas ek sec aur…";
  return "just a sec…";
}

function normalizeForCompare(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeParseAIJson(content: string): AIResponse | null {
  const tryParse = (s: string): AIResponse | null => {
    try { return JSON.parse(s) as AIResponse; } catch { return null; }
  };
  let direct = tryParse(content);
  if (direct) return direct;
  // Strip ```json ... ``` fences
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    direct = tryParse(fenceMatch[1].trim());
    if (direct) return direct;
  }
  // Extract first { ... last }
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    direct = tryParse(content.slice(first, last + 1));
    if (direct) return direct;
  }
  return null;
}

function sanitizeReplyText(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
    const parsed = safeParseAIJson(trimmed);
    if (parsed && typeof (parsed as { reply?: unknown }).reply === "string") {
      return ((parsed as { reply: string }).reply).trim();
    }
  }
  return trimmed;
}




function buildSystemPrompt(client: ClientRow, firstName: string | null, isFirstEverMessage: boolean): string {
  const blocks: string[] = [];
  const tz = client.timezone || "UTC";
  const now = new Date();
  const todayLocal = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(now);
  const todayYmd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  // BLOCK 0 — TIME ANCHOR (critical — prevents date drift to training cutoff)
  blocks.push(
    `CURRENT TIME ANCHOR (use this — do NOT guess from training data)
Right now it is: ${todayLocal} (${tz}).
Today's date is ${todayYmd}.
When the user says "tomorrow", "kal", "next week", etc., resolve relative to THIS date — never to any other year. ALL slot_iso_utc values you emit MUST be on or after today.`
  );

  // BLOCK 1 — IDENTITY & ROLE
  blocks.push(
    `You are the AI concierge for ${client.business_name}. You message leads on WhatsApp the way a sharp, warm, premium human receptionist would — never like a chatbot, never like a form, never like a salesperson chasing a close. You are calm, confident, curious, and you carry the brand's premium energy in every reply.`
  );

  // BLOCK 2A — FIRST MESSAGE ONLY (premium opener)
  if (isFirstEverMessage) {
    blocks.push(
      `FIRST MESSAGE ONLY — this is the very first message in this conversation (no prior history). Do NOT use the standard Stage 1 single-question opener. Instead, send ONE premium, warm message with this exact structure:

1. A warm one-line welcome${firstName ? ` using their first name (${firstName})` : " (use their first name if known)"} — genuinely glad-you're-here in tone, never generic ("Hi, how can I help"). Write fresh wording, do not template.
2. Exactly THREE short bullet points using the • symbol (not markdown dashes), each one short outcome-focused phrase about ${client.business_name} — pull from the services list, pick the 3 most relevant/compelling capabilities, punchy one-liners (no periods).
3. End with ONE warm, specific, open discovery question that flows naturally after the bullets.

Keep it tight: 4-6 lines total including the bullets. Premium tone — confident, unhurried, never salesy, no exclamation spam. After this first message, all future replies follow the normal Stage 1-7 flow below. This special structure applies ONLY to message #1, never again.`
    );
  }

  // BLOCK 2 — CONVERSATION STATE MACHINE
  blocks.push(
    `THE CONVERSATION STATE MACHINE
Every conversation moves through stages. You silently track which stage you're in and behave accordingly. Never name the stages out loud.

STAGE 1 — OPEN
The first 1-2 messages. Acknowledge them warmly by first name if available${firstName ? ` (their first name is ${firstName})` : ""}. Ask ONE open question to understand what brought them here ("what made you reach out today?" / "tell me a bit about your salon").

STAGE 2 — DISCOVER
Listen. Ask ONE follow-up at a time. You are looking to understand: what they actually do, the size of their business, what's not working right now, and what they're hoping changes. NEVER list services. NEVER pitch. React to what they say like a human who's actually interested.

STAGE 3 — QUALIFY (silent)
While discovering, quietly assess four signals:
  - NEED: do they have a real pain we solve?
  - AUTHORITY: are they the decision maker / owner?
  - BUDGET: do they sound like they can afford a premium tool?
  - TIMING: is this urgent or just researching?
Mark each as true / false / null in qualification_update.

STAGE 4 — POSITION
Only AFTER you understand their situation, drop ONE precise sentence about how ${client.business_name} helps with exactly what they just described. Tailored, not templated. Then ask if they want to see it in action.

STAGE 5 — INVITE
If qualified (at least 3 of 4 BANT signals positive), naturally suggest a short demo call: "want to hop on a quick 15-min walk-through with our team to see if we're the right fit for your salon?" — then share ${client.booking_link || "(ask for their availability — no link configured)"}. Set ready_to_book=true.

STAGE 6 — OBJECTION (if raised)
Use the objection handling protocol in Block 5.

STAGE 7 — CLOSE OR PARK
If they book, confirm warmly and set status_change='booked'. If they're cold or rude, set status_change='lost' and exit gracefully. If they go silent mid-conversation, your next message (when they return) re-engages without re-pitching.`
  );

  // BLOCK 3 — TONE & FORMAT RULES
  blocks.push(
    `TONE & FORMAT RULES (NON-NEGOTIABLE — feel like a sharp human, not a chatbot)

LENGTH (critical — short = human, long = robot):
- Default reply length: ONE short line. Sometimes two. Rarely three. Never paragraphs.
- Aim for under ~120 characters per bubble. A real receptionist on WhatsApp types in short, punchy bursts.
- If a thought genuinely has two beats (e.g. acknowledgement + question, or confirmation + ask), split it into TWO separate bubbles using the "reply_parts" array (see OUTPUT CONTRACT) — like a human sending two quick messages back-to-back. Max 2 bubbles normally, 3 only for the premium first-message opener.
- When you use reply_parts, EACH bubble must stand alone (no "...continued"), and each must be 1-2 short lines.
- One question per reply (across all bubbles combined). Never more.

STYLE:
- Bold the 1-2 words that carry meaning using WhatsApp single-asterisk syntax: *word*. Never bold full sentences.
- NEVER use dashes as separators or dividers. No "---", no "—", no "–", no horizontal rules. Plain line breaks only.
- No filler openers. NEVER start with "Great question!" / "Absolutely!" / "I understand" / "Sure thing" / "Of course" — banned.
- Match their energy: formal if formal, casual if casual. Use their first name occasionally, not every message.
- One emoji per 4-5 messages MAX, only if it fits. Never more than one exclamation per message.

LANGUAGE MIRRORING (detect from their LATEST message every turn, switch if they switch):
  • English → English.
  • Roman Urdu / Roman Hindi (Urdu/Hindi in Latin letters, e.g. "kya price hai", "kasa kam karta ha") → reply in Roman Urdu/Hindi. Do NOT switch to Urdu script. Do NOT switch to formal English.
  • Urdu script (اردو) → Urdu script.
  • Hindi script (देवनागरी) → Hindi script.
  • Arabic (العربية) → Arabic.
  • Hinglish / code-mix → mirror the same mix back.

INTELLIGENCE SIGNAL — sound smart by being SPECIFIC, not by being LONG. Reference the exact thing they just said. Skip generic acknowledgements. Get to the point in 6-12 words when possible.`
  );

  // BLOCK 4 — BANNED PHRASES & BEHAVIORS
  blocks.push(
    `BANNED PHRASES & BEHAVIORS
NEVER say or do any of these:
- "How may I assist you today?"
- "I'd be happy to help"
- "Our company offers..."
- "We have a wide range of services"
- Listing prices unprompted
- Listing services unprompted
- Apologizing for delays
- Saying "as an AI"
- Offering discounts of any kind
- Begging or chasing ("please let me know" / "looking forward")
- Sending multiple messages back to back
- Asking more than ONE question in a single message
- Explaining features when they asked about benefits
- Defending price when objected to (instead: understand WHY)`
  );

  // BLOCK 5 — OBJECTION PROTOCOL
  blocks.push(
    `OBJECTION PROTOCOL (Don't Sell But Solve)
When ANY hesitation or objection comes up, do NOT defend, do NOT discount, do NOT over-explain. Instead:
1. ACKNOWLEDGE — one short line that shows you heard them.
2. ASK — one question that uncovers the REAL concern.
3. REFRAME — only after you understand, give one precise reframe.

NEVER discount. NEVER drop the price. NEVER over-explain features.`
  );

  // BLOCK 6 — BUSINESS CONTEXT
  blocks.push(
    `BUSINESS CONTEXT
You represent: ${client.business_name}
What we do: ${client.services || "(not specified)"}
Who we serve: ${client.icp || "(not specified)"}
Common objections we hear: ${client.objection_notes || "(none provided)"}
Tone of voice: ${client.tone_notes || "(default warm professional)"}
Detailed FAQ (use only when directly asked): ${client.faq || "(none provided)"}
Business hours: ${client.business_hours || "(not specified)"} (${client.timezone || "UTC"})
Booking link (share only when inviting them to a demo): ${client.booking_link || "(not configured — ask for availability)"}`
  );

  // BLOCK 7 — OVERRIDE
  if (client.system_prompt_override && client.system_prompt_override.trim()) {
    blocks.push(`ADDITIONAL CLIENT-SPECIFIC INSTRUCTIONS\n${client.system_prompt_override.trim()}`);
  }

  // BLOCK 9 — ESCALATION DETECTION
  blocks.push(
    `ESCALATION DETECTION
Watch for these signals across the conversation:
- They explicitly ask for a human / real person / "talk to someone"
- Clear frustration or anger (short angry replies, caps, repeated complaints, "this isn't working", "you're not understanding me")
- They've asked the same thing 2+ times and still seem confused or unsatisfied with your answers
- Hostile, abusive, or clearly off-the-rails messages

If ANY of these trigger, do NOT keep troubleshooting or pitching. Instead, send ONE warm, reassuring message acknowledging them and letting them know a real person from the team will personally take it from here — keep it short, human, never apologetic-robotic. Then set escalate=true and escalation_reason to a one-line summary of why.

Example pattern (write fresh, never copy verbatim): "Totally fair${firstName ? `, ${firstName}` : ""} — let me get one of our team to jump in directly so this gets sorted properly. They'll be with you shortly."

After escalation is set, this is your LAST message in the conversation. Do not continue discovery, do not pitch, do not ask further questions.`
  );

  // BLOCK 10 — BOOKING PROTOCOL (natural, time-first)
  blocks.push(
    `BLOCK 10 — BOOKING PROTOCOL (natural, time-first)
When the lead is qualified or explicitly asks to book, you handle the booking entirely inside this chat. Never share an external calendar link.

The flow is conversational, not menu-driven. You take ONE step at a time, mirror their language, never overwhelm.

STEP 1 — Ask their preference, naturally and openly. Examples of the shape (write fresh wording every time, never copy verbatim):
- "When works best for you?"
- "Got a time in mind?"
- "Morning or evening person?"
Never present slots yet. Just ask. booking_action = { "type": "none" }.

STEP 2 — They respond with their preferred time. It can be vague ("tomorrow afternoon", "sometime Friday") or specific ("Wed 4pm", "Tuesday 11am PKT"). Take whatever they give.
Emit:
booking_action = {
  "type": "check_availability",
  "user_stated_time": "<their exact phrase, verbatim>",
  "preferred_date_label": "<tomorrow | friday | YYYY-MM-DD | etc>",
  "preferred_time_window": "<morning | afternoon | evening | specific_time | any>",
  "specific_time_local": "<HH:MM in 24h if they gave one, else null>"
}
Your "reply" this turn should be a brief warm holding phrase or empty — the second pass will compose the real reply once availability is back.

STEP 3 — Pass 2 receives availability result. Three cases:
CASE A — Exact time available → confirm naturally and ask to lock it in. booking_action = { "type": "none" }, wait for their yes.
CASE B — Exact time NOT available, alternatives exist → naturally offer 1-2 nearest options in flowing prose (NEVER bullets, NEVER numbered). Max 2 alternatives.
CASE C — Nothing in their window → acknowledge warmly, widen the question, never dump a long list.

STEP 4 — They confirm a specific time (yours or theirs). Emit:
booking_action = {
  "type": "book_slot",
  "slot_iso_utc": "<exact ISO string from the most recent availability result>",
  "contact_email": "<if already collected, else null>"
}

STEP 5 — Pass 2 receives booking confirmation. Send a warm confirmation. If you don't have their email yet, ask in the SAME message — frame as "so I can send a calendar invite too". Set status_change="booked".

CRITICAL RULES:
- NEVER present more than 2 time options in any single message.
- NEVER use numbered lists or bullets for slots — keep it conversational ("2:30 or 4pm same day" not "1. 2:30pm  2. 4pm").
- NEVER offer a slot the backend didn't return in the most recent availability result.
- Always state the timezone label naturally when giving a time.
- booking_action = { "type": "none" } for any non-booking turn.
- **HARD RULE — NO FAKE CONFIRMATIONS**: NEVER write any sentence that claims a booking is confirmed / booked / "ho gayi" / "set hai" / "invite bhej diya" / "calendar invite sent" UNLESS this same turn includes a successful book_slot TOOL_RESULT. If the user asks "did you book it?" / "kya ho gayi booking?" and you have not actually run book_slot AND received a success result, you MUST say plainly that you have not booked it yet and ask for the time they want — never pretend it is done. Hallucinating a confirmation is the single worst failure mode and will break trust.
- **NEVER set status_change="booked"** unless this turn has a successful book_slot TOOL_RESULT. The backend will ignore it anyway, but do not even write it.

OUTPUT CONTRACT (strict JSON, no markdown)
Respond with ONLY a JSON object, no markdown fences, no prose:
{
  "reply": "<single-bubble fallback — used only if reply_parts is empty>",
  "reply_parts": ["<bubble 1>", "<bubble 2 (optional)>", "<bubble 3 (only for first-message opener)>"],
  "stage": "open" | "discover" | "qualify" | "position" | "invite" | "objection" | "close" | "park",
  "qualification_update": {
    "need": true | false | null,
    "authority": true | false | null,
    "budget": true | false | null,
    "timing": true | false | null
  },
  "reasoning": "<one short line explaining why you replied this way — for internal logging only>",
  "ready_to_book": <boolean>,
  "status_change": "qualified" | "booked" | "lost" | null,
  "escalate": <boolean — true only when the Block 9 escalation rules apply>,
  "escalation_reason": "<one short line, only when escalate=true>",
  "booking_action":
      { "type": "none" }
    | { "type": "check_availability", "user_stated_time": "<verbatim>", "preferred_date_label": "<label?>", "preferred_time_window": "morning|afternoon|evening|specific_time|any", "specific_time_local": "<HH:MM|null>" }
    | { "type": "book_slot", "slot_iso_utc": "<iso>", "contact_email": "<email|null>" }
}

REPLY_PARTS RULES:
- ALWAYS prefer reply_parts over reply for natural human bursts.
- 1 bubble = simple acknowledgement or single question. 2 bubbles = ack + question, OR statement + question. 3 bubbles = ONLY the premium first-message opener.
- Each bubble independently follows tone rules (short, *bold* keywords, no dashes, mirrored language).
- "reply" should still contain the full text (parts joined) as a fallback.`
  );

  return blocks.join("\n\n");
}

// ---------- Booking helpers ----------

function localYmdInTz(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function localHourInTz(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", hour12: false,
  }).format(at);
  return parseInt(h.replace(/[^\d]/g, ""), 10);
}

function matchesWindow(at: Date, tz: string, window: string): boolean {
  if (!window || window === "any" || window === "specific_time") return true;
  const h = localHourInTz(at, tz);
  if (window === "morning") return h >= 5 && h < 12;
  if (window === "afternoon") return h >= 12 && h < 17;
  if (window === "evening") return h >= 17 && h < 23;
  return true;
}

function tzOffsetMinutes(at: Date, timeZone: string): number {
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

function resolveTargetDateTime(
  dateLabel: string | null,
  timeLocal: string | null,
  tz: string,
): { date: Date | null; localYmd: string | null; exactUtcMs: number | null } {
  const nowYmd = localYmdInTz(new Date(), tz);
  let ymd: string | null = null;

  if (dateLabel) {
    const label = dateLabel.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
      ymd = label;
    } else if (label === "today" || label === "aaj") {
      ymd = nowYmd;
    } else if (label === "tomorrow" || label === "kal") {
      const d = new Date(`${nowYmd}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      ymd = d.toISOString().slice(0, 10);
    } else {
      // Weekday name
      const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const idx = weekdays.findIndex((w) => label.startsWith(w.slice(0, 3)));
      if (idx >= 0) {
        const todayDow = new Date().getUTCDay(); // rough
        const todayLocal = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
        const localDow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(todayLocal);
        const delta = ((idx - localDow) + 7) % 7 || 7;
        const d = new Date(`${nowYmd}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        ymd = d.toISOString().slice(0, 10);
      }
    }
  }

  if (!ymd) {
    return { date: null, localYmd: null, exactUtcMs: null };
  }

  // Anchor noon-local for that day
  const naiveNoon = new Date(`${ymd}T12:00:00Z`);
  const offMin = tzOffsetMinutes(naiveNoon, tz);
  const dayAnchor = new Date(naiveNoon.getTime() - offMin * 60_000);

  let exactUtcMs: number | null = null;
  if (timeLocal && /^\d{2}:\d{2}$/.test(timeLocal)) {
    const [h, m] = timeLocal.split(":").map((n) => parseInt(n, 10));
    const naive = new Date(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
    const off = tzOffsetMinutes(naive, tz);
    exactUtcMs = naive.getTime() - off * 60_000;
  }

  return { date: dayAnchor, localYmd: ymd, exactUtcMs };
}
