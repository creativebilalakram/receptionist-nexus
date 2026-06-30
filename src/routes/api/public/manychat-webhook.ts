import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";

const Payload = z.object({
  client_id: z.string().uuid(),
  webhook_secret: z.string().min(10).max(200),
  subscriber_id: z.string().min(1).max(200),
  phone: z.string().max(40).optional().nullable(),
  first_name: z.string().max(120).optional().nullable(),
  message_text: z.string().min(1).max(4000),
});

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
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "invalid_json" }), { status: 400, headers: cors });
        }

        const parsed = Payload.safeParse(raw);
        if (!parsed.success) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: raw as Json, status_code: 400,
            error: parsed.error.message,
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "invalid_payload" }), { status: 400, headers: cors });
        }
        const data = parsed.data;

        const { data: client, error: clientErr } = await supabaseAdmin
          .from("clients").select("*").eq("id", data.client_id).maybeSingle();
        if (clientErr || !client) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: data as unknown as Json, status_code: 404, error: "client_not_found",
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "client_not_found" }), { status: 404, headers: cors });
        }

        if (client.webhook_secret !== data.webhook_secret) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 401, error: "invalid_secret",
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "unauthorized" }), { status: 401, headers: cors });
        }

        if (!client.is_active) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200, error: "client_paused",
          });
          return new Response(JSON.stringify({ ai_reply: "We're temporarily unavailable. We'll be back shortly." }), { headers: cors });
        }

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200,
        });

        // TEMP allowlist: only reply to this phone number for now
        const ALLOWED_PHONES = ["3447306520", "3260660523"];
        const normalized = (data.phone ?? "").replace(/\D/g, "");
        const last10 = normalized.slice(-10);
        if (!ALLOWED_PHONES.includes(last10)) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200, error: "phone_not_allowlisted",
          });
          return new Response(JSON.stringify({ ai_reply: "STOP" }), { headers: cors });
        }

        const nowIso = new Date().toISOString();
        const { data: existing } = await supabaseAdmin
          .from("conversations").select("*")
          .eq("client_id", client.id).eq("subscriber_id", data.subscriber_id).maybeSingle();

        const messages: Msg[] = Array.isArray(existing?.messages) ? (existing!.messages as unknown as Msg[]) : [];
        const priorMessageCount = messages.length;
        messages.push({ role: "user", content: data.message_text, timestamp: nowIso });

        let convoId = existing?.id;
        let qualification = (existing?.qualification ?? {}) as Record<string, unknown>;
        let leadScore = existing?.lead_score ?? 0;
        let status = existing?.status ?? "active";
        let currentStage: Stage = ((existing?.current_stage as Stage | undefined) ?? "open");
        const manualTakeover = existing?.manual_takeover ?? false;
        const alreadyEscalated = existing?.escalated ?? false;

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
            return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "convo_insert_failed" }), { status: 500, headers: cors });
          }
          convoId = newRow.id;
        }

        // If already escalated to a human, log the inbound and skip AI entirely.
        if (alreadyEscalated) {
          await supabaseAdmin.from("conversations").update({
            messages: messages as unknown as Json,
            last_message_at: nowIso,
            phone: data.phone ?? existing?.phone ?? null,
            first_name: data.first_name ?? existing?.first_name ?? null,
          }).eq("id", convoId!);
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "outbound",
            payload: { skipped: "escalated" } as unknown as Json, status_code: 200,
          });
          return new Response(JSON.stringify({ ai_reply: "STOP", skip_send: true }), { headers: cors });
        }

        if (manualTakeover) {
          await supabaseAdmin.from("conversations").update({
            messages: messages as unknown as Json,
            last_message_at: nowIso,
            phone: data.phone ?? existing?.phone ?? null,
            first_name: data.first_name ?? existing?.first_name ?? null,
          }).eq("id", convoId!);
          return new Response(JSON.stringify({ ai_reply: "STOP" }), { headers: cors });
        }

        const isFirstEverMessage = priorMessageCount === 0;
        const systemPrompt = buildSystemPrompt(client as ClientRow, data.first_name ?? null, isFirstEverMessage);
        // Memory ON: include full prior conversation history for context
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
            const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
            });
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
        if (parsedAI?.status_change) status = parsedAI.status_change;
        if (parsedAI?.stage) currentStage = parsedAI.stage;
        const bantKeys = ["budget", "authority", "need", "timing"] as const;
        leadScore = bantKeys.reduce((acc, k) => acc + (qualification[k] === true ? 25 : 0), 0);

        const shouldEscalate = parsedAI?.escalate === true;
        if (shouldEscalate) {
          status = "escalated";
        }

        // ---- BOOKING TOOL LOOP ----
        // If AI requested a booking action, execute it and ask the model to draft a final reply.
        const action = parsedAI?.booking_action;
        let bookedAppointmentId: string | null = null;
        if (!shouldEscalate && action && action.type !== "none") {
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

              // Search range: target day (if any) ± 1 day, else next 7 days
              const anchor = target.date ?? new Date();
              const rangeStart = new Date(anchor.getTime() - 24 * 60 * 60_000);
              const rangeEnd = new Date(anchor.getTime() + 6 * 24 * 60 * 60_000);
              const allSlots = generateSlots(ctx, rangeStart, rangeEnd, 80);

              // Filter slots to same local day as target (if known)
              const sameDay = target.localYmd
                ? allSlots.filter((s) => localYmdInTz(new Date(s.start), tz) === target.localYmd)
                : allSlots;

              // Filter by time window
              const windowed = sameDay.filter((s) => matchesWindow(new Date(s.start), tz, window));

              let exactSlot: { start: string; label: string } | null = null;
              if (target.exactUtcMs) {
                const hit = allSlots.find(
                  (s) => Math.abs(new Date(s.start).getTime() - target.exactUtcMs!) < 60_000,
                );
                if (hit) exactSlot = { start: hit.start, label: hit.label };
              }

              // Nearest 2 alternatives — prefer same day, then nearby; sort by closeness to target
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
            const result = await bookAppointment(supabaseAdmin, {
              clientId: client.id,
              meetingTypeId: null,
              startIso: action.slot_iso_utc,
              contactName: data.first_name ?? null,
              contactPhone: data.phone ?? null,
              contactEmail: action.contact_email ?? null,
              conversationId: convoId ?? null,
              notes: null,
              bookedVia: "ai",
            });
            if (result.ok) {
              bookedAppointmentId = result.appointmentId;
              status = "booked";
              aiReply = await draftBookingReply(aiKey, systemPrompt, messages, {
                tool: "book_slot",
                result: `Booked successfully for ${result.label}.`,
              }) ?? `Booked for *${result.label}*. See you then.`;
            } else {
              aiReply = await draftBookingReply(aiKey, systemPrompt, messages, {
                tool: "book_slot",
                result: `Could not book: ${result.error}. Offer 1-2 nearest alternative slots conversationally.`,
              }) ?? aiReply;
            }
          }
        }

        aiReply = sanitizeReplyText(aiReply);
        messages.push({ role: "assistant", content: aiReply, timestamp: new Date().toISOString() });

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

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: { reply: aiReply, parsed: parsedAI } as unknown as Json,
          response: aiResponseLog as Json,
          status_code: aiStatusCode || 200,
        });

        return new Response(JSON.stringify({ ai_reply: aiReply }), { headers: cors });
      },
    },
  },
});

async function draftBookingReply(
  aiKey: string | undefined,
  systemPrompt: string,
  messages: Msg[],
  toolResult: { tool: string; result: string; timezone?: string },
): Promise<string | null> {
  if (!aiKey) return null;
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
    });
    const json = await resp.json().catch(() => null);
    const txt = json?.choices?.[0]?.message?.content;
    if (typeof txt === "string" && txt.trim().length) return txt.trim();
  } catch { /* ignore */ }
  return null;
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


function buildSystemPrompt(client: ClientRow, firstName: string | null, isFirstEverMessage: boolean): string {
  const blocks: string[] = [];

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
    `TONE & FORMAT RULES (NON-NEGOTIABLE)
- WhatsApp messages: 1-3 short lines (mostly — soft rule, not hard, but never paragraphs).
- One question per message. Maximum.
- Bold the important words using WhatsApp single-asterisk syntax: *word*. Bold only the 1-2 words that carry the meaning of the line — never bold a whole sentence.
- NEVER use dashes as separators or dividers. No "---", no "—", no "–", no horizontal rules. Structure messages with plain line breaks only. If you need to pause, start a new line.
- LANGUAGE MIRRORING (critical — detect from their LATEST message every time, and switch if they switch):
    • English → reply in English.
    • Roman Urdu / Roman Hindi (Urdu or Hindi written in Latin letters, e.g. "kya price hai", "kasa kam karta ha") → reply in Roman Urdu / Roman Hindi. Do NOT switch to Urdu script. Do NOT switch to formal English.
    • Urdu script (اردو) → reply in Urdu script.
    • Hindi script (देवनागरी) → reply in Hindi script.
    • Arabic (العربية) → reply in Arabic.
    • Hinglish / code-mix → mirror the same mix back.
- Match their energy: formal if they're formal, casual if casual.
- Use their first name occasionally, not in every message.
- One emoji per 4-5 messages max, and only if it fits.
- Never use exclamation marks more than once per message.
- Never start a reply with "Great question!" / "Absolutely!" / "I understand" — these are banned, they sound like a bot.`
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

OUTPUT CONTRACT (strict JSON, no markdown)
Respond with ONLY a JSON object, no markdown fences, no prose:
{
  "reply": "<your WhatsApp message to the user>",
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
}`
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
