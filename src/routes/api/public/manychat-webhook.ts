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

type CheckAvailabilityAction =
  | {
      type: "check_availability";
      user_stated_time?: string;
      preferred_date_label?: string;
      preferred_time_window?: "morning" | "afternoon" | "evening" | "specific_time" | "any" | string;
      specific_time_local?: string | null;
    };

type BookSlotAction = { type: "book_slot"; slot_iso_utc: string; contact_email?: string | null };
type ListBookingsAction = { type: "list_bookings" };
type CancelBookingAction = { type: "cancel_booking"; appointment_id?: string | null; reason?: string | null };
type RescheduleBookingAction = { type: "reschedule_booking"; appointment_id?: string | null; new_slot_iso_utc: string };
type RestoreBookingAction = { type: "restore_booking" };
type NoBookingAction = { type: "none" };
type NormalizedBookingAction =
  | CheckAvailabilityAction
  | BookSlotAction
  | ListBookingsAction
  | CancelBookingAction
  | RescheduleBookingAction
  | RestoreBookingAction
  | NoBookingAction;
type BookingAction = NormalizedBookingAction | ({ type: string } & Record<string, unknown>);

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

// FIX 11 — FRUSTRATION ESCALATION
// Code-level guard: the prompt-side escalation rule alone was not firing
// reliably (audit showed users typing "voice ma" 3x in a row with no
// handoff). This detects repetition + explicit handoff phrases + hard
// frustration cues and force-escalates before the AI call.
const HANDOFF_PHRASES = [
  // English
  "human", "real person", "real human", "actual person", "someone real",
  "talk to someone", "speak to someone", "talk to a person", "speak to a human",
  "customer service", "customer support", "support agent", "manager",
  // Roman Urdu / Hindi
  "insaan", "insan", "banda", "asli banda", "asal banda", "kisi banda",
  "kisi insan", "asli insaan", "koi banda", "koi insaan",
  // Arabic
  "شخص حقيقي", "انسان", "موظف",
];
const FRUSTRATION_PHRASES = [
  // English
  "not working", "you're not understanding", "you are not understanding",
  "this isn't working", "this is not working", "useless", "waste of time",
  "stop repeating", "same thing again", "already said", "already told",
  // Roman Urdu
  "samajh nahi", "samjh nahi", "samajh nai", "nahi samjha", "nahi samjhi",
  "faltu", "bekar", "time waste", "waqt zaya", "phir se", "pehle bhi",
  "already bata", "pehle bata",
];
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeForMatch(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForMatch(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
function detectFrustrationEscalation(
  currentText: string,
  history: Msg[],
): { escalate: boolean; reason: string } | null {
  const norm = normalizeForMatch(currentText);
  if (!norm) return null;

  // 1) Explicit handoff request → immediate escalate
  for (const p of HANDOFF_PHRASES) {
    const np = normalizeForMatch(p);
    if (np && norm.includes(np)) {
      return { escalate: true, reason: `explicit_handoff_request: "${p}"` };
    }
  }

  // 2) Explicit frustration cue → immediate escalate
  for (const p of FRUSTRATION_PHRASES) {
    const np = normalizeForMatch(p);
    if (np && norm.includes(np)) {
      return { escalate: true, reason: `frustration_cue: "${p}"` };
    }
  }

  // 3) SHOUTING (majority uppercase, length > 8) after some history
  const letters = currentText.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 8) {
    const upper = letters.replace(/[^A-Z]/g, "").length;
    if (upper / letters.length >= 0.8 && history.filter((m) => m.role === "user").length >= 1) {
      return { escalate: true, reason: "shouting_caps" };
    }
  }

  // 4) Repetition: current + last 2 user messages are near-duplicates
  const userMsgs = history.filter((m) => m.role === "user").map((m) => m.content);
  const recent = userMsgs.slice(-2); // messages BEFORE current (current not yet pushed at call site)
  if (recent.length === 2) {
    const s1 = jaccardSimilarity(currentText, recent[recent.length - 1]);
    const s2 = jaccardSimilarity(currentText, recent[recent.length - 2]);
    const s3 = jaccardSimilarity(recent[0], recent[1]);
    // Either near-identical repeats, OR short repeated ask (<= 5 words) twice
    const wordCount = normalizeForMatch(currentText).split(" ").filter(Boolean).length;
    if ((s1 >= 0.7 && s2 >= 0.6) || (s1 >= 0.6 && s3 >= 0.6) || (wordCount <= 5 && s1 >= 0.6 && s2 >= 0.5)) {
      return { escalate: true, reason: "repeated_unresolved_ask" };
    }
  }

  return null;
}

// Localized handoff message when code-level escalation fires.
function detectLangHint(text: string): "en" | "ur" | "ar" {
  if (/[\u0600-\u06FF]/.test(text)) {
    // Arabic script — could be Urdu or Arabic; assume Urdu unless clearly Arabic markers
    if (/\bال|في|من|على|هذا|هذه\b/.test(text)) return "ar";
    return "ur";
  }
  const roman = normalizeForMatch(text);
  if (/\b(hai|nahi|kya|kaisay|kaise|ap|aap|acha|theek|mujhe|mera|meri|karo|kro|please plz|mein|mein|krna|karna|dena|dedo|bhej|bata|batao|kar|ho|hoga|hogaya|banda|insaan)\b/.test(roman)) {
    return "ur";
  }
  return "en";
}

// FIX 13 — LANGUAGE MIRRORING (sticky per conversation)
// Fine-grained detector used for the sticky-lang decision. Distinguishes
// Roman Urdu / Hindi from plain English so the AI stops randomly switching
// to formal English mid-thread when the user is clearly typing Roman Urdu.
type LangCode = "en" | "ur-roman" | "ur-script" | "hi-script" | "ar";
const ROMAN_URDU_TOKENS = /\b(hai|hain|hoon|hun|ho|nahi|nahin|nai|kya|kyun|kyu|kaise|kaisay|kasa|kese|ap|aap|apka|apki|mujhe|muja|mera|meri|meray|karo|kro|krna|karna|kar|krta|krti|krte|karta|karti|karte|dena|dedo|dedena|bhej|bhejo|batao|bata|bta|batadein|acha|accha|theek|thk|thik|sahi|sahi|zaroor|zarur|abhi|filhal|matlab|price|paisa|paise|paisay|banda|insaan|mein|mai|humare|hamare|hamara|humara|shukriya|shukria|meherbani|dekhta|dekhti|dekh|chahiye|chahye|chaiye|chahye|hoga|hogi|hongay|hogaya|hogayi|banao|bnao|karega|karegi|kro na|krdo|krdena|salon|dukan|clinic)\b/;
function detectLangFine(text: string): LangCode {
  if (!text) return "en";
  // Devanagari (Hindi) script
  if (/[\u0900-\u097F]/.test(text)) return "hi-script";
  // Arabic script — differentiate Arabic vs Urdu-script.
  if (/[\u0600-\u06FF]/.test(text)) {
    // Urdu-specific letters that don't appear in modern standard Arabic
    if (/[\u0679\u067E\u0686\u0688\u0691\u0698\u06A9\u06AF\u06BA\u06BE\u06C1\u06CC\u06D2]/.test(text)) {
      return "ur-script";
    }
    // Common Arabic function words / definite article
    if (/(^|\s)(ال|في|من|على|هذا|هذه|أن|إلى|هل|كيف|ماذا|لا|نعم)(\s|$)/.test(text)) return "ar";
    return "ur-script";
  }
  const roman = normalizeForMatch(text);
  if (ROMAN_URDU_TOKENS.test(roman)) return "ur-roman";
  return "en";
}
function langLabel(l: LangCode): string {
  switch (l) {
    case "ur-roman": return "Roman Urdu / Roman Hindi (Latin script, e.g. \"kya price hai\")";
    case "ur-script": return "Urdu (اردو script)";
    case "hi-script": return "Hindi (देवनागरी script)";
    case "ar": return "Arabic (العربية)";
    default: return "English";
  }
}
// Decide the LOCKED language for this conversation. Rules:
//   • First user message → lock to whatever they typed.
//   • Once locked, only switch if EITHER
//       (a) the current message is a hard script switch (Urdu / Hindi /
//           Arabic script when we were locked to English or Roman Urdu, or
//           vice versa), OR
//       (b) both of the user's last two messages (including the current)
//           agree on the new language — a single English word inside a
//           Roman Urdu thread must NOT flip the lock.
function resolveStickyLanguage(
  previousLocked: LangCode | null,
  currentText: string,
  priorUserMessages: string[],
): { locked: LangCode; detected: LangCode; switched: boolean } {
  const detected = detectLangFine(currentText);
  if (!previousLocked) return { locked: detected, detected, switched: false };
  if (detected === previousLocked) return { locked: previousLocked, detected, switched: false };
  const isScriptSwitch =
    (["ur-script", "hi-script", "ar"] as LangCode[]).includes(detected) ||
    (["ur-script", "hi-script", "ar"] as LangCode[]).includes(previousLocked);
  if (isScriptSwitch) return { locked: detected, detected, switched: true };
  // Latin-script ambiguity (en ↔ ur-roman). Require the prior user message
  // to also be in the new language before flipping the lock.
  const lastPrior = [...priorUserMessages].reverse().find((t) => (t ?? "").trim().length > 0) ?? "";
  const priorDetected = detectLangFine(lastPrior);
  if (priorDetected === detected) return { locked: detected, detected, switched: true };
  return { locked: previousLocked, detected, switched: false };
}
function handoffMessage(firstName: string | null, lang: "en" | "ur" | "ar"): string {
  const name = firstName ? `, ${firstName}` : "";
  if (lang === "ur") {
    return `bilkul${name} — main abhi apni team ke aik banday ko is chat mein la raha hoon jo aap ki personally madad karein ge. thori der mein wo aap ko yahan reply karein ge.`;
  }
  if (lang === "ar") {
    return `تمام${name} — سأحضر شخصًا من فريقنا ليتابع معك مباشرة هنا. سيتواصل معك بعد قليل.`;
  }
  return `Got it${name} — I'm looping in one of our team right now to take this personally. They'll jump in here shortly.`;
}

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
        const first_name = sanitizePlaceholder(rawData.first_name ?? null);
        const rawMessageText = (rawData.message_text ?? rawData.last_input_text ?? "").trim();
        // FIX 3 — ManyChat greeting / placeholder scrub.
        const cleanedText = sanitizeInboundText(rawMessageText);
        // FIX 12 — MEDIA HANDLING
        // ManyChat forwards WhatsApp voice notes / images / videos / files as
        // attachments with either an empty `last_input_text` or a bare URL.
        // Previously the webhook 400'd on empty text, so the user's voice
        // note produced silence — user then repeats "voice ma" 3x, bot never
        // acknowledges. Detect media, synthesize a marker so the AI sees it,
        // and let the MEDIA HANDLING prompt block route the response.
        const media = detectInboundMedia(rawData, rawMessageText);
        let message_text = cleanedText;
        if (media && (!message_text || message_text === "hi")) {
          message_text = mediaMarkerText(media);
        } else if (media && message_text) {
          // Real text + a media attachment — append marker so AI acknowledges both.
          message_text = `${message_text}\n${mediaMarkerText(media)}`;
        }

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

        if (media) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id, direction: "inbound", payload: { media, marker: message_text } as unknown as Json,
            status_code: 200, error: `media_detected:${media.kind}`,
          });
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

        // Allowlist removed — accept all phone numbers

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200,
        });

        // Fast pre-checks for STOP cases
        const { data: existing } = await supabaseAdmin
          .from("conversations").select("*")
          .eq("client_id", client.id).eq("subscriber_id", data.subscriber_id).maybeSingle();

        const canRecoverAutoRepeatEscalation = isRecoverableAutoRepeatEscalation(existing, data.message_text);
        if (existing?.manual_takeover || (existing?.escalated && !canRecoverAutoRepeatEscalation)) {
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

  // FIX 13 — sticky per-conversation language lock. Prevents the AI from
  // randomly switching to formal English when the user is typing Roman Urdu.
  const priorUserTexts = messages
    .slice(0, -1)
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const previousLocked =
    (["en", "ur-roman", "ur-script", "hi-script", "ar"] as const).includes(
      ((existing as unknown as { language?: string })?.language as LangCode) ?? "__",
    )
      ? (((existing as unknown as { language?: string })?.language as LangCode))
      : null;
  const stickyLang = resolveStickyLanguage(previousLocked, data.message_text, priorUserTexts);

  if (!existing) {
    const { data: newRow, error: insErr } = await supabaseAdmin.from("conversations").insert({
      client_id: client.id,
      subscriber_id: data.subscriber_id,
      phone: data.phone ?? null,
      first_name: data.first_name ?? null,
      messages: messages as unknown as Json,
      last_message_at: nowIso,
      current_stage: "open",
      language: stickyLang.locked,
    }).select("id").single();
    if (insErr || !newRow) {
      console.error("[processAndSend] convo insert failed:", insErr);
      return;
    }
    convoId = newRow.id;
  }

  // FIX 11 — code-level frustration / handoff escalation.
  // Runs BEFORE the AI call. If tripped, we skip the AI entirely, send a
  // localized handoff bubble, mark the conversation escalated, and return.
  // `messages` currently includes the just-pushed user turn as its last item;
  // pass the prior history (everything except the current message) so the
  // repetition check compares current vs the two before it.
  const priorHistory = messages.slice(0, -1);
  const frustration = detectFrustrationEscalation(data.message_text, priorHistory);
  const bypassRepeatEscalation = shouldBypassRepeatEscalation(frustration, data.message_text, priorHistory);
  if (frustration?.escalate && !bypassRepeatEscalation) {
    const lang = detectLangHint(data.message_text);
    const handoff = handoffMessage(data.first_name ?? existing?.first_name ?? null, lang);
    const sendRes = await sendWhatsAppText(data.subscriber_id, handoff);
    const nowIso2 = new Date().toISOString();
    messages.push({ role: "assistant", content: handoff, timestamp: nowIso2 });
    await supabaseAdmin.from("conversations").update({
      messages: messages as unknown as Json,
      status: "escalated",
      escalated: true,
      escalation_reason: `auto: ${frustration.reason}`,
      escalated_at: nowIso2,
      last_message_at: nowIso2,
      phone: data.phone ?? existing?.phone ?? null,
      first_name: data.first_name ?? existing?.first_name ?? null,
    }).eq("id", convoId!);
    await supabaseAdmin.from("webhook_logs").insert({
      client_id: client.id,
      direction: "outbound",
      payload: {
        reply: handoff,
        kind: "auto_escalation",
        reason: frustration.reason,
        lang,
      } as unknown as Json,
      response: { manychat: sendRes.body ?? null } as Json,
      status_code: sendRes.ok ? 200 : (sendRes.status || 500),
      error: sendRes.ok ? null : sendRes.error,
    });
    return;
  }
  if (bypassRepeatEscalation) {
    await supabaseAdmin.from("webhook_logs").insert({
      client_id: client.id,
      direction: "outbound",
      payload: {
        kind: "repeat_escalation_bypassed_for_booking",
        reason: frustration?.reason ?? null,
        user_text: data.message_text,
      } as unknown as Json,
      status_code: 200,
    });
  }

  const isFirstEverMessage = priorMessageCount === 0;

  // FIX 15B — detect exact-repeat user message within 5 minutes. If tripped,
  // inject a runtime fact into the prompt so the AI acknowledges the repeat
  // and offers a different angle (or handoff on the 3rd repeat).
  const repeatInfo = detectRepeatUserMessage(data.message_text, priorHistory);

  const systemPrompt = buildSystemPrompt(
    client,
    data.first_name ?? null,
    isFirstEverMessage,
    stickyLang.locked,
    repeatInfo.runtimeFact,
  );

  // FIX 14 Layer 1 — 25s watchdog. If the AI + tool loop stalls past 25s,
  // fire a localized "still working — one more moment" bubble ONCE so the
  // user never sees pure silence. Processing continues to eventual completion.
  let watchdogFired = false;
  const watchdogTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    watchdogFired = true;
    void sendWhatsAppText(data.subscriber_id, localizedStillWorking(stickyLang.locked)).catch(() => {});
  }, 25_000);
  const clearWatchdog = () => clearTimeout(watchdogTimer);
  const aiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    })),
  ];

  const aiKey = process.env.OPENAI_API_KEY;
  const aiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
  let aiReply = FALLBACK;
  let parsedAI: AIResponse | null = null;
  let aiResponseLog: unknown = null;
  let aiStatusCode = 0;

  if (!aiKey) {
    aiResponseLog = { error: "missing_OPENAI_API_KEY" };
  } else {
    try {
      const { retryFetch } = await import("@/lib/retry");
      const resp = await retryFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${aiKey}`,
        },
        body: JSON.stringify({
          model: aiModel,
          messages: aiMessages,
          response_format: { type: "json_object" },
        }),
      }, { attempts: 3, baseMs: 500, timeoutMs: 18_000, label: "openai-main" });
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
  const recoveringAutoRepeatEscalation = isRecoverableAutoRepeatEscalation(existing, data.message_text);
  if (recoveringAutoRepeatEscalation && status === "escalated") {
    status = "active";
  }
  const bantKeys = ["budget", "authority", "need", "timing"] as const;
  leadScore = bantKeys.reduce((acc, k) => acc + (qualification[k] === true ? 25 : 0), 0);

  const shouldEscalate = parsedAI?.escalate === true && !bypassRepeatEscalation && !recoveringAutoRepeatEscalation;
  if (shouldEscalate) status = "escalated";

  // ---- BOOKING TOOL LOOP ----
  // Bookings hit DB + a second AI call, often 5-15s. Send an immediate
  // "let me check..." ack bubble first so the user sees activity, then
  // continue with the real work and send the final answer as bubble #2.
  let ackSent = false;
  let action = normalizeBookingAction(parsedAI?.booking_action, parsedAI, messages, data.message_text);
  // Code-level override: if user explicitly says "undo / wapas / wrong one /
  // restore" right after a cancellation, force restore_booking even if the
  // model chose otherwise.
  if (action && action.type !== "restore_booking" && looksLikeExplicitRestoreIntent(data.message_text, messages)) {
    action = { type: "restore_booking" };
  }
  // SAFETY: if the conversation is already booked, ignore accidental booking
  // actions on non-booking turns (e.g. "thanks"). BUT do not suppress a real
  // new slot / availability request. This was causing the production failure
  // in the screenshot: AI emitted check_availability, the old guard discarded
  // it because status was already "booked", and only the holding bubble was
  // sent with no second availability/confirmation message.
  // Only suppress a NEW check_availability / book_slot on an already-booked
  // convo when the user didn't clearly ask. List / cancel / reschedule are
  // always legitimate on a booked conversation and must never be suppressed.
  if (
    action &&
    (action.type === "check_availability" || action.type === "book_slot") &&
    existing?.status === "booked" &&
    !looksLikeExplicitBookingTurn(data.message_text, messages)
  ) {
    await supabaseAdmin.from("webhook_logs").insert({
      client_id: client.id,
      direction: "outbound",
      payload: {
        kind: "booking_action_suppressed_after_booked",
        booking_action: action.type,
        user_text: data.message_text,
      } as unknown as Json,
      status_code: 200,
    });
    action = { type: "none" };
  }
  let toolFinalReply = false;
  // Remember the exact/first slot last offered to the user via check_availability
  // so that if the AI later emits book_slot with a hallucinated ISO, we can fall
  // back to what we actually just told them was available.
  let offeredSlotIso: string | null =
    (existing as unknown as { last_offered_slot_iso?: string | null } | null)
      ?.last_offered_slot_iso
      ? new Date((existing as unknown as { last_offered_slot_iso: string }).last_offered_slot_iso).toISOString()
      : null;
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

        const availability = {
          user_stated_time: action.user_stated_time ?? null,
          timezone: tz,
          exact_available: !!exactSlot,
          exact_slot: exactSlot,
          alternatives,
          window_empty: pool.length === 0,
        };

        // Remember what we just offered so a follow-up book_slot with a bad
        // ISO can be recovered to the exact slot the user actually saw.
        offeredSlotIso = exactSlot?.start ?? alternatives[0]?.start ?? offeredSlotIso;

        // Production reliability: do not wait on a second AI call for slot copy.
        // The backend already knows the truth; compose the final useful reply deterministically.
        aiReply = composeAvailabilityReply(availability, data.message_text);
        toolFinalReply = true;
      } else {
        aiReply = pickAvailabilityFailureText(data.message_text);
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: { kind: "availability_context_failed", error: ctx.error } as unknown as Json,
          status_code: 422,
        });
      }
    } else if (action.type === "book_slot") {
      // FIX 4 — booking-drift defense.
      // Root cause of drift: the model sometimes emits slot_iso_utc with the
      // wrong YEAR (training-data drift), or a stale ISO from a prior turn.
      // Old code searched ±24h around the (possibly hallucinated) timestamp,
      // which meant year-drift ISOs found nothing AND the recovery
      // "alternatives" were also anchored to the wrong year.
      //
      // New strategy, in order:
      //   1) exact match ±60s in a ±24h window around the proposed ISO
      //   2) if that fails and the proposed year differs from now, coerce
      //      the ISO to the SAME month/day/time in the current year (and
      //      +1yr if that is in the past) and re-check
      //   3) if still no hit, fall back to nearest real slots anchored to
      //      NOW (never the hallucinated timestamp)
      const ctx = await loadAvailabilityContext(supabaseAdmin, client.id, null);
      const proposed = new Date(action.slot_iso_utc);
      const proposedMs = proposed.getTime();
      const nowMs = Date.now();
      let validatedIso: string | null = null;
      let driftCorrected = false;

      const tryMatchAround = (centerMs: number) => {
        if ("error" in ctx) return null;
        const rs = new Date(centerMs - 24 * 60 * 60_000);
        const re = new Date(centerMs + 24 * 60 * 60_000);
        const slots = generateSlots(ctx, rs, re, 200);
        const hit = slots.find(
          (s) => Math.abs(new Date(s.start).getTime() - centerMs) < 60_000,
        );
        return hit ? hit.start : null;
      };

      if ("error" in ctx) {
        // Settings missing — fail soft below.
      } else if (!Number.isNaN(proposedMs) && proposedMs > nowMs - 5 * 60_000) {
        // (1) direct match
        validatedIso = tryMatchAround(proposedMs);

        // (2) year-drift correction
        if (!validatedIso) {
          const proposedYear = proposed.getUTCFullYear();
          const currentYear = new Date(nowMs).getUTCFullYear();
          if (proposedYear !== currentYear) {
            const corrected = new Date(Date.UTC(
              currentYear,
              proposed.getUTCMonth(),
              proposed.getUTCDate(),
              proposed.getUTCHours(),
              proposed.getUTCMinutes(),
              proposed.getUTCSeconds(),
            ));
            // If that date is already in the past, roll forward one year.
            if (corrected.getTime() < nowMs - 5 * 60_000) {
              corrected.setUTCFullYear(currentYear + 1);
            }
            const hit = tryMatchAround(corrected.getTime());
            if (hit) {
              validatedIso = hit;
              driftCorrected = true;
              await supabaseAdmin.from("webhook_logs").insert({
                client_id: client.id,
                direction: "outbound",
                payload: {
                  kind: "book_slot_year_drift_corrected",
                  original_iso: action.slot_iso_utc,
                  corrected_iso: hit,
                } as unknown as Json,
                status_code: 200,
              });
            }
          }
        }
      }

      // (2b) last-offered fallback — if we still don't have a validated ISO,
      // try the slot we most recently told this user was available. This is
      // the fix for the "confirmed 10am, but book_slot got a random ISO for
      // today" failure: honor what the user actually said yes to.
      if (!validatedIso && !("error" in ctx) && offeredSlotIso) {
        const offeredMs = new Date(offeredSlotIso).getTime();
        if (!Number.isNaN(offeredMs) && offeredMs > nowMs - 5 * 60_000) {
          const hit = tryMatchAround(offeredMs);
          if (hit) {
            validatedIso = hit;
            await supabaseAdmin.from("webhook_logs").insert({
              client_id: client.id,
              direction: "outbound",
              payload: {
                kind: "book_slot_recovered_from_last_offered",
                original_iso: action.slot_iso_utc,
                recovered_iso: hit,
              } as unknown as Json,
              status_code: 200,
            });
          }
        }
      }

      if (!validatedIso && !("error" in ctx)) {
        // (3) recovery — anchor to NOW, never to the hallucinated ISO.
        const tz = ctx.timezone;
        const anchorMs = nowMs;
        const rs = new Date(anchorMs);
        const re = new Date(anchorMs + 7 * 24 * 60 * 60_000);
        const slots = generateSlots(ctx, rs, re, 200);
        // Prefer slots on the day the user seemed to want (using proposed
        // month/day mapped into current year), else earliest available.
        let sameDay: typeof slots = [];
        if (!Number.isNaN(proposedMs)) {
          const wantYmd = localYmdInTz(
            new Date(Date.UTC(
              new Date(anchorMs).getUTCFullYear(),
              proposed.getUTCMonth(),
              proposed.getUTCDate(),
            )),
            tz,
          );
          sameDay = slots.filter((s) => localYmdInTz(new Date(s.start), tz) === wantYmd);
        }
        const pool = sameDay.length ? sameDay : slots;
        const alternatives = pool
          .slice(0, 2)
          .map((s) => ({ start: s.start, label: s.label }));

        aiReply = composeAvailabilityReply(
          {
            user_stated_time: data.message_text,
            timezone: tz,
            exact_available: false,
            exact_slot: null,
            alternatives,
            window_empty: alternatives.length === 0,
          },
          data.message_text,
        );
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: {
            kind: "book_slot_proposed_iso_not_real_slot",
            proposed_iso: action.slot_iso_utc,
            offered_alternatives: alternatives.map((a) => a.start),
          } as unknown as Json,
          status_code: 200,
        });
      }
      void driftCorrected;

      if (validatedIso) {
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
          aiReply = composeBookingSuccessReply(result.label, data.message_text, action.contact_email ?? null);
          toolFinalReply = true;
        } else {
          // Same deterministic failure path — never trust AI for failure copy.
          aiReply = pickBookingFailureText(data.message_text);
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id,
            direction: "outbound",
            payload: { kind: "book_slot_db_failed", error: result.error, iso: validatedIso } as unknown as Json,
            status_code: 422,
          });
          toolFinalReply = true;
        }
      }
    } else if (action.type === "list_bookings") {
      const { rescheduleAppointment: _rs } = await import("@/lib/booking-core.server");
      void _rs;
      const upcoming = await fetchUpcomingForConversation(supabaseAdmin, client.id, convoId ?? null);
      aiReply = composeListBookingsReply(upcoming, data.message_text);
      toolFinalReply = true;
      await supabaseAdmin.from("webhook_logs").insert({
        client_id: client.id,
        direction: "outbound",
        payload: { kind: "list_bookings", count: upcoming.length } as unknown as Json,
        status_code: 200,
      });
    } else if (action.type === "cancel_booking") {
      const ctxCli = await supabaseAdmin.from("clients").select("timezone").eq("id", client.id).maybeSingle();
      const tzCancel = ctxCli.data?.timezone || "UTC";
      const upcoming = await fetchUpcomingForConversation(supabaseAdmin, client.id, convoId ?? null);
      const resolved = await resolveTargetFromExplicitOrText(
        supabaseAdmin, client.id, convoId ?? null,
        action.appointment_id ?? null, upcoming, messages, data.message_text, tzCancel,
      );
      if (resolved.ambiguous) {
        aiReply = composeAmbiguousBookingReply(resolved.candidates, data.message_text, "cancel");
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "outbound",
          payload: { kind: "cancel_booking_ambiguous", candidates: resolved.candidates.map((c) => ({ id: c.id, label: c.label })) } as unknown as Json,
          status_code: 200,
        });
      } else if (!resolved.target) {
        aiReply = composeNoBookingFoundReply(data.message_text);
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "outbound",
          payload: { kind: "cancel_booking_none_found" } as unknown as Json,
          status_code: 404,
        });
      } else {
        const target = resolved.target;
        const { cancelAppointment } = await import("@/lib/booking-core.server");
        const res = await cancelAppointment(supabaseAdmin, target.id, action.reason ?? "cancelled by user via WhatsApp");
        if (res.ok) {
          const remaining = upcoming.filter((u) => u.id !== target.id).length;
          if (status === "booked" && remaining === 0) status = "qualified";
          aiReply = composeCancelSuccessReply(target.label, data.message_text);
          toolFinalReply = true;
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "outbound",
            payload: { kind: "cancel_booking_ok", appointment_id: target.id } as unknown as Json,
            status_code: 200,
          });
        } else {
          aiReply = pickAvailabilityFailureText(data.message_text);
          toolFinalReply = true;
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "outbound",
            payload: { kind: "cancel_booking_failed", error: res.error, appointment_id: target.id } as unknown as Json,
            status_code: 422,
          });
        }
      }
    } else if (action.type === "restore_booking") {
      const ctxCli = await supabaseAdmin.from("clients").select("timezone").eq("id", client.id).maybeSingle();
      const tzR = ctxCli.data?.timezone || "UTC";
      const restored = await restoreLastCancelledForConversation(supabaseAdmin, client.id, convoId ?? null, tzR);
      if (restored.ok) {
        status = "booked";
        aiReply = composeRestoreSuccessReply(restored.label, data.message_text);
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "outbound",
          payload: { kind: "restore_booking_ok", appointment_id: restored.appointmentId } as unknown as Json,
          status_code: 200,
        });
      } else {
        aiReply = composeRestoreFailureReply(data.message_text, restored.reason);
        toolFinalReply = true;
        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "outbound",
          payload: { kind: "restore_booking_failed", reason: restored.reason } as unknown as Json,
          status_code: 422,
        });
      }
    } else if (action.type === "reschedule_booking") {
      const ctxCli = await supabaseAdmin.from("clients").select("timezone").eq("id", client.id).maybeSingle();
      const tzResc = ctxCli.data?.timezone || "UTC";
      const upcoming = await fetchUpcomingForConversation(supabaseAdmin, client.id, convoId ?? null);
      const resolved = await resolveTargetFromExplicitOrText(
        supabaseAdmin, client.id, convoId ?? null,
        action.appointment_id ?? null, upcoming, messages, data.message_text, tzResc,
      );
      const ctx = await loadAvailabilityContext(supabaseAdmin, client.id, null);
      if (resolved.ambiguous) {
        aiReply = composeAmbiguousBookingReply(resolved.candidates, data.message_text, "reschedule");
        toolFinalReply = true;
      } else if (!resolved.target) {
        aiReply = composeNoBookingFoundReply(data.message_text);
        toolFinalReply = true;
      } else if ("error" in ctx) {
        aiReply = pickAvailabilityFailureText(data.message_text);
        toolFinalReply = true;
      } else {
        const target = resolved.target;
        // Validate the new ISO is a real slot; fall back to last_offered if needed.
        const proposed = new Date(action.new_slot_iso_utc);
        const proposedMs = proposed.getTime();
        const nowMs = Date.now();
        let validatedIso: string | null = null;
        const tryMatch = (centerMs: number) => {
          const rs = new Date(centerMs - 24 * 60 * 60_000);
          const re = new Date(centerMs + 24 * 60 * 60_000);
          const slots = generateSlots(ctx, rs, re, 200);
          const hit = slots.find((s) => Math.abs(new Date(s.start).getTime() - centerMs) < 60_000);
          return hit ? hit.start : null;
        };
        if (!Number.isNaN(proposedMs) && proposedMs > nowMs - 5 * 60_000) {
          validatedIso = tryMatch(proposedMs);
        }
        if (!validatedIso && offeredSlotIso) {
          const offMs = new Date(offeredSlotIso).getTime();
          if (!Number.isNaN(offMs) && offMs > nowMs - 5 * 60_000) validatedIso = tryMatch(offMs);
        }
        if (!validatedIso) {
          aiReply = pickBookingFailureText(data.message_text);
          toolFinalReply = true;
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "outbound",
            payload: { kind: "reschedule_slot_unavailable", proposed_iso: action.new_slot_iso_utc } as unknown as Json,
            status_code: 422,
          });
        } else {
          const { rescheduleAppointment } = await import("@/lib/booking-core.server");
          const res = await rescheduleAppointment(supabaseAdmin, target.id, validatedIso);
          if (res.ok) {
            status = "booked";
            const newLabel = formatSlotLabelInTz(new Date(validatedIso), ctx.timezone);
            aiReply = composeRescheduleSuccessReply(target.label, newLabel, data.message_text);
            toolFinalReply = true;
            await supabaseAdmin.from("webhook_logs").insert({
              client_id: client.id, direction: "outbound",
              payload: { kind: "reschedule_ok", appointment_id: target.id, new_iso: validatedIso } as unknown as Json,
              status_code: 200,
            });
          } else {
            aiReply = pickBookingFailureText(data.message_text);
            toolFinalReply = true;
            await supabaseAdmin.from("webhook_logs").insert({
              client_id: client.id, direction: "outbound",
              payload: { kind: "reschedule_failed", error: res.error } as unknown as Json,
              status_code: 422,
            });
          }
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

  // FIX 2: if the sanitizer stripped a JSON-only payload down to nothing,
  // fall back to a safe localized filler instead of shipping an empty bubble
  // or the raw JSON. Language mirrors the last user message.
  if (!aiReply || !aiReply.trim()) {
    aiReply = pickPostAckFiller(data.message_text);
  }

  // FIX 6: de-list — convert any numbered / bulleted list into flowing prose.
  // Skip the premium opener; its "• " bullets are intentional and structural.
  if (!isFirstEverMessage) {
    aiReply = delistReplyText(aiReply);
  }

  // FIX 10: strip any sentence that promises to send a deliverable we don't
  // actually have (video / PDF / brochure / deck / screenshot / case study /
  // recording / walkthrough / sample). Applies to every turn, including the
  // opener. If the scrub leaves an empty reply, fall back to a safe filler.
  const preScrub = aiReply;
  aiReply = scrubImaginaryOffers(aiReply);
  if (!aiReply.trim()) {
    aiReply = pickPostAckFiller(data.message_text) || preScrub;
  }


  // Decide on message parts: prefer model-provided reply_parts, else auto-split.
  // FIX 1: the premium first-message opener MUST arrive as ONE bubble so the
  // closing question is never dropped by autoSplit or a delivery hiccup.
  let parts: string[] = [];
  if (isFirstEverMessage) {
    parts = [aiReply];
  } else {
    const modelParts = !toolFinalReply && Array.isArray(parsedAI?.reply_parts)
      ? parsedAI!.reply_parts!
          .map((p) => (typeof p === "string" ? scrubImaginaryOffers(delistReplyText(sanitizeReplyText(p))) : ""))
          .filter((p) => p && p.trim().length > 0)
      : [];


    if (modelParts.length > 0) {
      parts = modelParts.slice(0, 3); // hard cap 3 bubbles
    } else {
      parts = autoSplitReply(aiReply).filter((p) => p && p.trim().length > 0);
    }
  }
  // FIX 7 — dedupe bubbles. Three sources of duplicate messages we've observed:
  //   (a) model emits reply_parts with two near-identical entries
  //   (b) autoSplit produces adjacent parts whose normalized text matches
  //   (c) one of the parts matches the ack we already sent this turn, or the
  //       previous assistant bubble in history
  // Skip for the premium opener (already single-bubble by design).
  if (!isFirstEverMessage && parts.length > 0) {
    const priorAssistant: string[] = [];
    for (let i = messages.length - 1; i >= 0 && priorAssistant.length < 3; i--) {
      if (messages[i].role === "assistant") priorAssistant.push(messages[i].content);
    }
    const seen = new Set<string>();
    // Seed with recent history so we don't re-echo the last thing we sent.
    for (const m of priorAssistant) {
      const n = normalizeForCompare(m);
      if (n) seen.add(n);
    }
    const deduped: string[] = [];
    for (const p of parts) {
      const n = normalizeForCompare(p);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      deduped.push(p);
    }
    if (deduped.length > 0) parts = deduped;
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
    language: stickyLang.locked,
    last_reasoning: parsedAI?.reasoning ?? null,
    last_message_at: new Date().toISOString(),
    last_offered_slot_iso: offeredSlotIso,
    phone: data.phone ?? existing?.phone ?? null,
    first_name: data.first_name ?? existing?.first_name ?? null,
    ...(recoveringAutoRepeatEscalation && !shouldEscalate
      ? {
          escalated: false,
          escalation_reason: null,
          escalated_at: null,
        }
      : {}),
    ...(shouldEscalate
      ? {
          escalated: true,
          escalation_reason: parsedAI?.escalation_reason ?? "Escalated by AI",
          escalated_at: new Date().toISOString(),
        }
      : {}),
  }).eq("id", convoId!);

  // FIX 14 Layer 1 — final reply is ready, cancel the 25s watchdog before send.
  clearWatchdog();

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
      watchdog_fired: watchdogFired,
      repeat_streak: repeatInfo.repeatCount,
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

type AvailabilitySummary = {
  user_stated_time: string | null;
  timezone: string;
  exact_available: boolean;
  exact_slot: { start: string; label: string } | null;
  alternatives: Array<{ start: string; label: string }>;
  window_empty: boolean;
};

function normalizeBookingAction(
  action: BookingAction | undefined,
  ai: AIResponse | null,
  messages: Msg[],
  lastUserText: string,
): NormalizedBookingAction | undefined {
  const forceAvailabilityCheck = shouldForceAvailabilityCheck(ai, messages, lastUserText);
  if (!action) {
    return forceAvailabilityCheck
      ? buildCheckAvailabilityAction({}, messages, lastUserText)
      : undefined;
  }

  // Production guard: the model often says `ready_to_book=true` and writes a
  // holding reply, but still emits booking_action={type:"none"}. That caused
  // the exact live failure: WhatsApp got only "let me check..." and the backend
  // never checked slots. Code-level booking intent wins over model "none".
  if (action.type === "none") {
    return forceAvailabilityCheck
      ? buildCheckAvailabilityAction({}, messages, lastUserText)
      : { type: "none" };
  }
  if (action.type === "check_availability") {
    return {
      type: "check_availability",
      user_stated_time: typeof action.user_stated_time === "string" ? action.user_stated_time : lastUserText,
      preferred_date_label: typeof action.preferred_date_label === "string" ? action.preferred_date_label : undefined,
      preferred_time_window: typeof action.preferred_time_window === "string" ? action.preferred_time_window : "any",
      specific_time_local: typeof action.specific_time_local === "string" ? action.specific_time_local : null,
    };
  }
  if (action.type === "book_slot") {
    return typeof action.slot_iso_utc === "string" && action.slot_iso_utc.trim()
      ? { type: "book_slot", slot_iso_utc: action.slot_iso_utc, contact_email: typeof action.contact_email === "string" ? action.contact_email : null }
      : { type: "none" };
  }
  if (action.type === "list_bookings") {
    return { type: "list_bookings" };
  }
  if (action.type === "cancel_booking") {
    return {
      type: "cancel_booking",
      appointment_id: typeof action.appointment_id === "string" ? action.appointment_id : null,
      reason: typeof action.reason === "string" ? action.reason : null,
    };
  }
  if (action.type === "reschedule_booking") {
    const iso = typeof action.new_slot_iso_utc === "string" ? action.new_slot_iso_utc
      : typeof (action as Record<string, unknown>).slot_iso_utc === "string" ? String((action as Record<string, unknown>).slot_iso_utc)
      : "";
    if (!iso.trim()) return { type: "none" };
    return {
      type: "reschedule_booking",
      appointment_id: typeof action.appointment_id === "string" ? action.appointment_id : null,
      new_slot_iso_utc: iso,
    };
  }
  if (action.type === "restore_booking") {
    return { type: "restore_booking" };
  }
  if (["restore", "undo_cancel", "undo_cancellation", "unbook", "rebook_previous"].includes(action.type)) {
    return { type: "restore_booking" };
  }





  // Backward compatibility for older / provider-invented tool names.
  // This was the root cause of the stuck screenshot: OpenAI returned
  // { type: "get_slots" }, so the code sent only a holding bubble and never
  // executed availability lookup.
  if (["get_slots", "show_slots", "list_slots", "availability", "get_availability"].includes(action.type)) {
    return buildCheckAvailabilityAction(action, messages, lastUserText);
  }
  if (["cancel", "cancel_appointment", "cancel_meeting"].includes(action.type)) {
    return { type: "cancel_booking", appointment_id: null, reason: null };
  }
  if (["reschedule", "reschedule_appointment", "move_booking", "change_booking"].includes(action.type)) {
    const iso = typeof (action as Record<string, unknown>).new_slot_iso_utc === "string"
      ? String((action as Record<string, unknown>).new_slot_iso_utc)
      : typeof (action as Record<string, unknown>).slot_iso_utc === "string"
        ? String((action as Record<string, unknown>).slot_iso_utc)
        : "";
    if (!iso.trim()) return { type: "none" };
    return { type: "reschedule_booking", appointment_id: null, new_slot_iso_utc: iso };
  }
  if (["my_bookings", "list_appointments", "get_bookings", "upcoming"].includes(action.type)) {
    return { type: "list_bookings" };
  }

  if (forceAvailabilityCheck) {
    return buildCheckAvailabilityAction(action, messages, lastUserText);
  }

  return { type: "none" };
}

function buildCheckAvailabilityAction(
  raw: Record<string, unknown>,
  messages: Msg[],
  lastUserText: string,
): CheckAvailabilityAction {
  const contextText = recentUserBookingContext(messages, lastUserText);
  const specific = parseSpecificTimeLocal(lastUserText) ?? parseSpecificTimeLocal(contextText) ?? null;
  return {
    type: "check_availability",
    user_stated_time: lastUserText,
    preferred_date_label: inferPreferredDateLabel(raw, messages, lastUserText) ?? undefined,
    preferred_time_window: inferTimeWindow(`${contextText}\n${lastUserText}`, specific),
    specific_time_local: specific,
  };
}

function shouldForceAvailabilityCheck(ai: AIResponse | null, messages: Msg[], lastUserText: string): boolean {
  if (looksLikeExplicitBookingTurn(lastUserText, messages)) return true;
  if (ai?.ready_to_book && looksLikeAvailabilityAsk(lastUserText)) return true;
  if (isPokeAfterAvailabilityHold(lastUserText, messages)) return true;
  return false;
}

function recentUserBookingContext(messages: Msg[], lastUserText: string): string {
  const recentUsers = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .slice(-4);
  if (!recentUsers.includes(lastUserText)) recentUsers.push(lastUserText);
  return recentUsers.join(" \n ");
}

function isPokeAfterAvailabilityHold(text: string, messages: Msg[]): boolean {
  const t = normalizeForMatch(text);
  const isPoke = /^(\?|\?\?|hello|helo|hey|hi|update|still|any update|kya hua|kia hua|kaha ho|kidhar|batao|btado)$/.test(t)
    || /^\?+$/.test((text ?? "").trim());
  if (!isPoke) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content.toLowerCase() ?? "";
  const hadRecentBookingAsk = messages
    .filter((m) => m.role === "user")
    .slice(-4)
    .some((m) => looksLikeExplicitBookingTurn(m.content, messages));
  return hadRecentBookingAsk && /\b(check|checking|availability|available|slot|let me check|ek sec|one sec)\b/i.test(lastAssistant);
}

function looksLikeAvailabilityAsk(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(avb|avail|available|availability|slot|slots|time|timing|when|kab|konsa|dikhao|show)\b/.test(t);
}

function looksLikeExplicitBookingTurn(text: string, messages: Msg[]): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (looksLikeAvailabilityAsk(t)) return true;
  if (parseSpecificTimeLocal(t)) return true;

  const hasBookingVerb = /\b(book|booking|appointment|demo|schedule|schedul|reschedule|cancel|lock|confirm|reserve|pakka|fix|set)\b/.test(t)
    || /\b(book\s*kar|lock\s*kar|confirm\s*kar|kar\s*do|kr\s*do|kar\s*dun|kr\s*dun)\b/.test(t);
  if (hasBookingVerb) return true;

  const dateish = /\b(today|tomorrow|tmrw|kal|aaj|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?)\b/.test(t);
  const timeish = /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(t);
  if (dateish && timeish) return true;

  const affirmative = /^(yes|yep|yeah|ok|okay|sure|confirm|confirmed|lock|book|done|haan|han|ha|jee|ji|theek|thk|sahi|kar do|kr do|kardo|krdo)\b/.test(t.trim());
  if (affirmative) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content.toLowerCase() ?? "";
    if (/\b(available|slot|lock|book|confirm|work|works|kar dun|kr dun)\b/.test(lastAssistant)) return true;
  }

  return false;
}

function shouldBypassRepeatEscalation(
  frustration: { escalate: boolean; reason: string } | null,
  currentText: string,
  priorHistory: Msg[],
): boolean {
  return frustration?.reason === "repeated_unresolved_ask"
    && looksLikeExplicitBookingTurn(currentText, priorHistory);
}

function isRecoverableAutoRepeatEscalation(existing: ConvRow | null, currentText: string): boolean {
  if (!existing?.escalated || existing.manual_takeover) return false;
  const reason = String(existing.escalation_reason ?? "");
  const wasAutoRepeatEscalation = reason.includes("repeated_unresolved_ask");
  const history: Msg[] = Array.isArray(existing.messages) ? (existing.messages as unknown as Msg[]) : [];
  return wasAutoRepeatEscalation && looksLikeExplicitBookingTurn(currentText, history);
}

function inferPreferredDateLabel(
  raw: Record<string, unknown>,
  messages: Msg[],
  lastUserText: string,
): string | null {
  if (typeof raw.preferred_date_label === "string" && raw.preferred_date_label.trim()) {
    return raw.preferred_date_label.trim();
  }
  if (raw.days === 0 || raw.day_offset === 0) return "today";
  if (raw.days === 1 || raw.day_offset === 1) return "tomorrow";

  const recent = [...messages.slice(-8).map((m) => m.content), lastUserText].join(" \n ").toLowerCase();
  if (/\b(tomorrow|tmrw|kal)\b/.test(recent)) return "tomorrow";
  if (/\b(today|aaj)\b/.test(recent)) return "today";
  const weekday = recent.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) return weekday[1];
  const iso = recent.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  return inferDayOfMonthDateLabel(recent);
}

function inferDayOfMonthDateLabel(text: string): string | null {
  const t = (text ?? "").toLowerCase();
  const matches = [...t.matchAll(/(?:\b(?:on|for|date|day|tareekh|tarikh|ko|ka|at)\s+)?\b([1-9]|[12]\d|3[01])(st|nd|rd|th)?\b(?!\s*(?:am|pm|:))/g)];
  for (const m of matches) {
    const raw = m[0];
    const suffix = !!m[2];
    const hasDateContext = /\b(on|for|date|day|tareekh|tarikh|ko|ka|at)\b/.test(raw);
    if (!suffix && !hasDateContext) continue;

    const day = parseInt(m[1], 10);
    const now = new Date();
    const y = now.getUTCFullYear();
    const month = now.getUTCMonth();
    let candidate = new Date(Date.UTC(y, month, day, 12));
    if (candidate.getUTCMonth() !== month) continue;
    if (candidate.getTime() < now.getTime() - 24 * 60 * 60_000) {
      candidate = new Date(Date.UTC(y, month + 1, day, 12));
      if (candidate.getUTCDate() !== day) continue;
    }
    return candidate.toISOString().slice(0, 10);
  }
  return null;
}

function inferTimeWindow(text: string, specific: string | null): CheckAvailabilityAction["preferred_time_window"] {
  const t = text.toLowerCase();
  if (specific) return "specific_time";
  if (/\b(morning|subah)\b/.test(t)) return "morning";
  if (/\b(afternoon|dopahar|dupehar)\b/.test(t)) return "afternoon";
  if (/\b(evening|shaam|sham|raat|night)\b/.test(t)) return "evening";
  return "any";
}

function parseSpecificTimeLocal(text: string): string | null {
  const t = text.toLowerCase();
  const withMinutes = t.match(/\b(1[0-2]|0?[1-9]|2[0-3])[:.]([0-5]\d)\s*(am|pm)?\b/);
  if (withMinutes) {
    let h = parseInt(withMinutes[1], 10);
    const m = parseInt(withMinutes[2], 10);
    const mer = withMinutes[3];
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const hourOnly = t.match(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/);
  if (hourOnly) {
    let h = parseInt(hourOnly[1], 10);
    const mer = hourOnly[2];
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
  }

  return null;
}

function composeAvailabilityReply(summary: AvailabilitySummary, lastUserText: string): string {
  if (summary.exact_available && summary.exact_slot) {
    return localizedText(lastUserText, {
      roman: `Haan, *${summary.exact_slot.label}* available hai. Lock kar dun?`,
      english: `Yes, *${summary.exact_slot.label}* is available. Should I lock it in?`,
      urdu: `جی، *${summary.exact_slot.label}* دستیاب ہے۔ بُک کر دوں؟`,
      hindi: `हाँ, *${summary.exact_slot.label}* available है। बुक कर दूँ?`,
      arabic: `نعم، *${summary.exact_slot.label}* متاح. أحجزه لك؟`,
    });
  }

  if (summary.alternatives.length > 0) {
    const times = summary.alternatives.map((s) => `*${s.label}*`).join(" or ");
    return localizedText(lastUserText, {
      roman: `${summary.user_stated_time ? "Wo exact time available nahi." : "Available slots ye hain."} ${times} ${summary.timezone} work karega?`,
      english: `${summary.user_stated_time ? "That exact time is taken." : "Available slots:"} ${times} ${summary.timezone}. Which works?`,
      urdu: `وہ exact time دستیاب نہیں۔ ${times} ${summary.timezone} میں سے کون سا ٹھیک ہے؟`,
      hindi: `वो exact time available नहीं है। ${times} ${summary.timezone} में कौन सा ठीक रहेगा?`,
      arabic: `ذلك الوقت غير متاح. ${times} ${summary.timezone} أيهما يناسبك؟`,
    });
  }

  return pickAvailabilityFailureText(lastUserText);
}

function composeBookingSuccessReply(label: string, lastUserText: string, email: string | null): string {
  if (email) {
    return localizedText(lastUserText, {
      roman: `Done, demo *${label}* par book ho gayi. Calendar invite email par aa jayega.`,
      english: `Done, your demo is booked for *${label}*. The calendar invite will hit your email shortly.`,
      urdu: `Done، آپ کا demo *${label}* پر book ہو گیا۔ Calendar invite email پر آ جائے گا۔`,
      hindi: `Done, आपका demo *${label}* पर book हो गया। Calendar invite email पर आ जाएगा।`,
      arabic: `تم، حجزت العرض في *${label}*. ستصلك دعوة التقويم على البريد قريباً.`,
    });
  }
  return localizedText(lastUserText, {
    roman: `Done, demo *${label}* par book ho gayi. Email bhej dein, calendar invite bhi send kar deta hun.`,
    english: `Done, your demo is booked for *${label}*. Send your email so I can send a calendar invite too.`,
    urdu: `Done، demo *${label}* پر book ہو گیا۔ Email bhej dein, calendar invite bhi send kar deta hun.`,
    hindi: `Done, demo *${label}* पर book हो गया। Email भेज दें, calendar invite भी भेज दूँगा.`,
    arabic: `تم، حجزت العرض في *${label}*. أرسل بريدك لأرسل دعوة التقويم أيضاً.`,
  });
}

function pickAvailabilityFailureText(lastUserText: string): string {
  return localizedText(lastUserText, {
    roman: "Abhi matching *slot* nahi mil raha. Koi aur day ya time bata dein?",
    english: "I’m not seeing a matching *slot* right now. What other day or time works?",
    urdu: "ابھی matching *slot* نہیں مل رہا۔ کوئی اور دن یا وقت بتائیں؟",
    hindi: "अभी matching *slot* नहीं मिल रहा। कोई और दिन या समय बताएँ?",
    arabic: "لا أرى موعداً مناسباً الآن. ما اليوم أو الوقت الآخر الذي يناسبك؟",
  });
}

// ---------- List / cancel / reschedule helpers ----------

type AppointmentTarget = { id: string; label: string; startIso: string; scheduledAt: Date };

async function fetchUpcomingForConversation(
  supabase: SupabaseAdmin,
  clientId: string,
  conversationId: string | null,
): Promise<AppointmentTarget[]> {
  const nowIso = new Date().toISOString();
  let q = supabase.from("appointments")
    .select("id, scheduled_at, status, meeting_type_id")
    .eq("client_id", clientId)
    .in("status", ["scheduled", "confirmed"])
    .gte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(10);
  if (conversationId) q = q.eq("conversation_id", conversationId);
  const { data, error } = await q;
  if (error || !data) return [];
  const { data: cli } = await supabase.from("clients").select("timezone").eq("id", clientId).maybeSingle();
  const tz = cli?.timezone || "UTC";
  return data.map((a) => ({
    id: a.id,
    startIso: a.scheduled_at,
    scheduledAt: new Date(a.scheduled_at),
    label: formatSlotLabelInTz(new Date(a.scheduled_at), tz),
  }));
}

// Resolve which appointment the user actually means.
// Rules (priority order):
//   1) explicit appointment_id from AI, scoped to THIS conversation (never cross-conversation).
//   2) match by date + time inferred from user's recent messages.
//   3) match by date alone if only one that day.
//   4) if a single upcoming exists in the whole convo, use it.
//   5) otherwise ambiguous — return candidates and let caller ask.
async function resolveTargetFromExplicitOrText(
  supabase: SupabaseAdmin,
  clientId: string,
  conversationId: string | null,
  explicitId: string | null,
  upcoming: AppointmentTarget[],
  messages: Msg[],
  lastUserText: string,
  tz: string,
): Promise<{ target?: AppointmentTarget; ambiguous?: boolean; candidates: AppointmentTarget[] }> {
  // 1) explicit id — only accept if it belongs to this conversation. This
  // prevents an AI hallucination from cancelling someone else's booking.
  if (explicitId && conversationId) {
    const hit = upcoming.find((u) => u.id === explicitId);
    if (hit) return { target: hit, candidates: upcoming };
    const { data } = await supabase
      .from("appointments")
      .select("id, scheduled_at, conversation_id")
      .eq("id", explicitId)
      .eq("client_id", clientId)
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (data) {
      return {
        target: {
          id: data.id,
          startIso: data.scheduled_at,
          scheduledAt: new Date(data.scheduled_at),
          label: formatSlotLabelInTz(new Date(data.scheduled_at), tz),
        },
        candidates: upcoming,
      };
    }
    // Explicit id given but not in this conversation → treat as unknown and
    // fall through to text-based matching.
  }

  if (upcoming.length === 0) return { candidates: upcoming };

  // 2) match by inferred date/time from user text.
  const contextText = recentUserBookingContext(messages, lastUserText);
  const timeLocal =
    parseSpecificTimeLocal(lastUserText) ??
    parseSpecificTimeLocal(contextText) ??
    null;
  const dateLabel = inferPreferredDateLabel({}, messages, lastUserText);
  const targetDT = resolveTargetDateTime(dateLabel ?? null, timeLocal, tz);

  let matches = upcoming;
  if (targetDT.localYmd) {
    const byDay = upcoming.filter((u) => localYmdInTz(u.scheduledAt, tz) === targetDT.localYmd);
    if (byDay.length > 0) matches = byDay;
  }
  if (targetDT.exactUtcMs != null) {
    const byExact = matches.filter(
      (u) => Math.abs(u.scheduledAt.getTime() - (targetDT.exactUtcMs as number)) < 60 * 60_000,
    );
    if (byExact.length > 0) matches = byExact;
  }

  if (matches.length === 1) return { target: matches[0], candidates: upcoming };

  // 4) if user gave no date/time hint and only one upcoming exists overall, use it.
  if (!targetDT.localYmd && targetDT.exactUtcMs == null && upcoming.length === 1) {
    return { target: upcoming[0], candidates: upcoming };
  }

  return { ambiguous: true, candidates: matches.length > 0 ? matches : upcoming };
}

// Restore the most recently cancelled appointment (within last 60 min) for
// this conversation — used when the user says "wapas book kar do" / "undo".
async function restoreLastCancelledForConversation(
  supabase: SupabaseAdmin,
  clientId: string,
  conversationId: string | null,
  tz: string,
): Promise<{ ok: true; appointmentId: string; label: string } | { ok: false; reason: string }> {
  if (!conversationId) return { ok: false, reason: "no_conversation" };
  const sinceIso = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("id, scheduled_at, meeting_type_id, contact_name, contact_phone, contact_email, notes")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .eq("status", "cancelled")
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "no_recent_cancel" };
  const start = new Date(data.scheduled_at);
  if (start.getTime() < Date.now() + 5 * 60_000) return { ok: false, reason: "slot_in_past" };

  const { bookAppointment } = await import("@/lib/booking-core.server");
  const res = await bookAppointment(supabase, {
    clientId,
    meetingTypeId: data.meeting_type_id,
    startIso: data.scheduled_at,
    contactName: data.contact_name,
    contactPhone: data.contact_phone,
    contactEmail: data.contact_email,
    conversationId,
    notes: data.notes,
    bookedVia: "restore",
  });
  if (!res.ok) return { ok: false, reason: res.error };
  return { ok: true, appointmentId: res.appointmentId, label: formatSlotLabelInTz(start, tz) };
}

function formatSlotLabelInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}

function composeListBookingsReply(list: AppointmentTarget[], lastUserText: string): string {
  if (list.length === 0) return composeNoBookingFoundReply(lastUserText);
  if (list.length === 1) {
    const label = list[0].label;
    return localizedText(lastUserText, {
      roman: `Aap ki upcoming booking *${label}* pe hai. Reschedule ya cancel karni ho to bata dein.`,
      english: `Your upcoming booking is on *${label}*. Want to reschedule or cancel?`,
      urdu: `آپ کی upcoming booking *${label}* پر ہے۔ Reschedule یا cancel کرنی ہو تو بتائیں۔`,
      hindi: `आपकी upcoming booking *${label}* पर है। Reschedule या cancel करनी हो तो बताएँ।`,
      arabic: `حجزك القادم في *${label}*. تريد إعادة الجدولة أو الإلغاء؟`,
    });
  }
  const first = list[0].label, second = list[1].label;
  return localizedText(lastUserText, {
    roman: `Aap ki upcoming bookings: *${first}* aur *${second}*. Kis pe kaam karna hai?`,
    english: `Your upcoming bookings: *${first}* and *${second}*. Which one do you want to work on?`,
    urdu: `آپ کی upcoming bookings: *${first}* اور *${second}*۔ کس پر کام کرنا ہے؟`,
    hindi: `आपकी upcoming bookings: *${first}* और *${second}*। किस पर काम करना है?`,
    arabic: `حجوزاتك القادمة: *${first}* و *${second}*. أيها تريد التعامل معه؟`,
  });
}

function composeNoBookingFoundReply(lastUserText: string): string {
  return localizedText(lastUserText, {
    roman: "Aap ki koi upcoming booking nahi mili. Nayi book karni ho to time bata dein.",
    english: "I don’t see any upcoming booking on file. Want me to set one up?",
    urdu: "آپ کی کوئی upcoming booking نہیں مل رہی۔ نئی book کرنی ہو تو time بتائیں۔",
    hindi: "आपकी कोई upcoming booking नहीं मिल रही। नई book करनी हो तो time बताएँ।",
    arabic: "لا أرى أي حجز قادم لك. تريد أن أرتب لك حجزاً جديداً؟",
  });
}

function composeCancelSuccessReply(label: string, lastUserText: string): string {
  return localizedText(lastUserText, {
    roman: `Ho gaya, *${label}* wali booking cancel kar di. Nayi time chahiye to bata dein.`,
    english: `Done, your *${label}* booking has been cancelled. Want to pick a new time?`,
    urdu: `ہو گیا، *${label}* والی booking cancel کر دی۔ نیا time چاہیے تو بتائیں۔`,
    hindi: `हो गया, *${label}* वाली booking cancel कर दी। नया time चाहिए तो बताएँ।`,
    arabic: `تم إلغاء حجز *${label}*. تريد اختيار وقت جديد؟`,
  });
}

function composeAmbiguousBookingReply(
  candidates: AppointmentTarget[],
  lastUserText: string,
  intent: "cancel" | "reschedule",
): string {
  const labels = candidates.slice(0, 3).map((c) => `*${c.label}*`).join(candidates.length === 2 ? " ya " : ", ");
  const verb = intent === "cancel" ? "cancel" : "reschedule";
  return localizedText(lastUserText, {
    roman: `Aap ki ek se zyada bookings hain: ${labels}. Kis wali ${verb} karni hai? Date ya time bata dein.`,
    english: `You have more than one booking: ${labels}. Which one should I ${verb}? Send the date or time.`,
    urdu: `آپ کی ایک سے زیادہ bookings ہیں: ${labels}۔ کون سی ${verb} کرنی ہے؟ Date یا time بھیج دیں۔`,
    hindi: `आपकी एक से ज़्यादा bookings हैं: ${labels}। कौन सी ${verb} करनी है? Date या time भेजें।`,
    arabic: `لديك أكثر من حجز: ${labels}. أيها تريد أن ${intent === "cancel" ? "أُلغي" : "أعيد جدولته"}؟ أرسل التاريخ أو الوقت.`,
  });
}

function composeRestoreSuccessReply(label: string, lastUserText: string): string {
  return localizedText(lastUserText, {
    roman: `Ho gaya, *${label}* wali booking wapas laga di. Calendar invite phir se aa jayegi.`,
    english: `Done, your *${label}* booking is back on the calendar. A fresh invite will arrive shortly.`,
    urdu: `ہو گیا، *${label}* والی booking دوبارہ لگا دی۔ Calendar invite دوبارہ آ جائے گی۔`,
    hindi: `हो गया, *${label}* वाली booking वापस लगा दी। Calendar invite फिर से आएगा।`,
    arabic: `تم إعادة حجز *${label}* على التقويم. ستصلك دعوة جديدة قريباً.`,
  });
}

function composeRestoreFailureReply(lastUserText: string, reason: string): string {
  const past = reason === "slot_in_past";
  const none = reason === "no_recent_cancel" || reason === "no_conversation";
  return localizedText(lastUserText, {
    roman: none
      ? "Mujhe pichhle ghante mein kisi cancelled booking ka record nahi mila. Naya time bata dein?"
      : past
        ? "Wo time ab guzar chuka hai. Naya time bata dein, dobara book kar deta hun."
        : "Wo slot ab available nahi. Alternative time bata dein?",
    english: none
      ? "I don’t see a recent cancellation in the last hour. Want to pick a new time?"
      : past
        ? "That time has already passed. Share a new time and I’ll rebook."
        : "That slot isn’t free anymore. Want to pick another time?",
    urdu: none
      ? "پچھلے گھنٹے میں کوئی cancelled booking نہیں ملی۔ نیا time بتائیں؟"
      : past
        ? "وہ وقت گزر چکا ہے۔ نیا time بتائیں، دوبارہ book کر دیتا ہوں۔"
        : "وہ slot اب available نہیں۔ کوئی اور time بتائیں؟",
    hindi: none
      ? "पिछले घंटे में कोई cancelled booking नहीं मिली। नया time बताएँ?"
      : past
        ? "वो time निकल चुका है। नया time बताएँ, दोबारा book कर देता हूँ।"
        : "वो slot अब available नहीं। कोई और time बताएँ?",
    arabic: none
      ? "لا أرى إلغاءً حديثاً في الساعة الماضية. تريد اختيار وقت جديد؟"
      : past
        ? "الوقت مضى بالفعل. أرسل وقتاً جديداً وسأعيد الحجز."
        : "الموعد لم يعد متاحاً. تريد وقتاً آخر؟",
  });
}

function composeRescheduleSuccessReply(oldLabel: string, newLabel: string, lastUserText: string): string {
  return localizedText(lastUserText, {
    roman: `Ho gaya, *${oldLabel}* se move karke *${newLabel}* pe reschedule kar di.`,
    english: `Done, moved from *${oldLabel}* to *${newLabel}*.`,
    urdu: `ہو گیا، *${oldLabel}* سے *${newLabel}* پر reschedule کر دی۔`,
    hindi: `हो गया, *${oldLabel}* से *${newLabel}* पर reschedule कर दी।`,
    arabic: `تم النقل من *${oldLabel}* إلى *${newLabel}*.`,
  });
}

function resolveSlotFromConversation(
  ctx: { timezone: string },
  messages: Msg[],
  lastUserText: string,
  generateSlotsFn: (ctx: never, rangeStart: Date, rangeEnd: Date, maxSlots?: number) => Array<{ start: string; label: string }>,
): string | null {
  const wanted = inferWantedHour(lastUserText, messages);
  if (wanted == null) return null;

  const dateLabel = inferPreferredDateLabel({}, messages, lastUserText) ?? "tomorrow";
  const target = resolveTargetDateTime(dateLabel, null, ctx.timezone);
  const anchor = target.date ?? new Date();
  const slots = generateSlotsFn(ctx as never, new Date(anchor.getTime() - 24 * 60 * 60_000), new Date(anchor.getTime() + 6 * 24 * 60 * 60_000), 120);
  const daySlots = target.localYmd
    ? slots.filter((s) => localYmdInTz(new Date(s.start), ctx.timezone) === target.localYmd)
    : slots;
  const hit = daySlots.find((s) => localHourInTz(new Date(s.start), ctx.timezone) === wanted);
  return hit?.start ?? null;
}

function inferWantedHour(lastUserText: string, messages: Msg[]): number | null {
  const specific = parseSpecificTimeLocal(lastUserText);
  if (specific) return parseInt(specific.slice(0, 2), 10);

  const n = lastUserText.trim().match(/^([1-9]|1[0-2])$/)?.[1];
  if (!n) return null;
  const hour = parseInt(n, 10);
  const recentAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content.toLowerCase() ?? "";
  const offeredPm = new RegExp(`\\b${hour}(?::00)?\\s*pm\\b`).test(recentAssistant);
  const offeredAm = new RegExp(`\\b${hour}(?::00)?\\s*am\\b`).test(recentAssistant);
  if (offeredPm && hour < 12) return hour + 12;
  if (offeredAm) return hour === 12 ? 0 : hour;
  return hour >= 8 ? hour : hour + 12;
}

function localizedText(
  text: string,
  variants: { roman: string; english: string; urdu: string; hindi: string; arabic: string },
): string {
  const t = text.toLowerCase();
  if (/[\u0600-\u06FF]/.test(text)) return variants.urdu;
  if (/[\u0900-\u097F]/.test(text)) return variants.hindi;
  if (/\b(arabic|عربي)\b/.test(t)) return variants.arabic;

  const romanHits = [
    "kya", "ka ", "ko ", " ma ", " ha", "hai", "kar", "mujh", "mera",
    "kasa", "btao", "thora", "abi", "nahi", "kal", "yar", "acha", "karo",
  ].filter((w) => t.includes(w)).length;
  return romanHits >= 2 ? variants.roman : variants.english;
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
    const aiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const resp = await retryFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${aiKey}` },
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "system",
            content: `TOOL_RESULT (${toolResult.tool})${toolResult.timezone ? ` [timezone: ${toolResult.timezone}]` : ""}:\n${toolResult.result}\n\nNow draft ONLY the final WhatsApp reply text (no JSON, no preamble, no markdown fences). Follow ALL tone rules (1-3 lines, *bold* on key words, no dashes/dividers, mirror their language). For check_availability: if exact_available=true → confirm naturally and ask to lock it in (one short question). If exact_available=false and alternatives exist → naturally mention 1-2 alternatives conversationally in flowing prose (NEVER numbered lists, NEVER bullets — write "I have *2:30pm* or *4pm* same day, either work?"). If window_empty=true → acknowledge warmly and widen the question (e.g. ask about a different day). Always state the timezone label naturally when giving a time. For book_slot: warm 1-2 line confirmation; if no contact email known yet, ask for it in the same message framed as "so I can send a calendar invite too".`,
          },
        ],
      }),
    }, { attempts: 3, baseMs: 500, timeoutMs: 15_000, label: "openai-booking" });
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
  actionType: "check_availability" | "book_slot" | "list_bookings" | "cancel_booking" | "reschedule_booking" | "restore_booking",
): string {
  const candidate = (aiFirstPass ?? "").trim();
  // Use AI's holding phrase only if it's genuinely short (< 90 chars, 1 line).
  if (candidate && candidate.length <= 90 && !candidate.includes("\n")) {
    return candidate;
  }
  const t = lastUserText ?? "";
  const verbFor = (
    lang: "roman" | "english" | "urdu" | "hindi" | "arabic",
  ): string => {
    const map: Record<typeof lang, Record<typeof actionType, string>> = {
      roman: {
        check_availability: "ek sec, *check* karta hun…",
        book_slot: "ek sec, *book* kar raha hun…",
        list_bookings: "ek sec, *bookings* nikaal raha hun…",
        cancel_booking: "ek sec, *cancel* kar raha hun…",
        reschedule_booking: "ek sec, *reschedule* kar raha hun…",
        restore_booking: "ek sec, wo booking *wapas* laata hun…",
      },
      english: {
        check_availability: "one sec, let me *check*…",
        book_slot: "one sec, *booking* it now…",
        list_bookings: "one sec, pulling up your *bookings*…",
        cancel_booking: "one sec, *cancelling* now…",
        reschedule_booking: "one sec, *rescheduling* now…",
        restore_booking: "one sec, *restoring* that booking…",
      },
      urdu: {
        check_availability: "ایک سیکنڈ، چیک کرتا ہوں…",
        book_slot: "ایک سیکنڈ، بُک کر رہا ہوں…",
        list_bookings: "ایک سیکنڈ، آپ کی bookings دیکھتا ہوں…",
        cancel_booking: "ایک سیکنڈ، cancel کر رہا ہوں…",
        reschedule_booking: "ایک سیکنڈ، reschedule کر رہا ہوں…",
        restore_booking: "ایک سیکنڈ، وہ booking واپس لاتا ہوں…",
      },
      hindi: {
        check_availability: "एक सेकंड, चेक करता हूँ…",
        book_slot: "एक सेकंड, बुक कर रहा हूँ…",
        list_bookings: "एक सेकंड, आपकी bookings देखता हूँ…",
        cancel_booking: "एक सेकंड, cancel कर रहा हूँ…",
        reschedule_booking: "एक सेकंड, reschedule कर रहा हूँ…",
        restore_booking: "एक सेकंड, वो booking वापस लाता हूँ…",
      },
      arabic: {
        check_availability: "لحظة، أتحقق لك…",
        book_slot: "لحظة، أحجز لك الآن…",
        list_bookings: "لحظة، أجلب حجوزاتك…",
        cancel_booking: "لحظة، ألغي الحجز الآن…",
        reschedule_booking: "لحظة، أعيد الجدولة الآن…",
        restore_booking: "لحظة، أستعيد الحجز…",
      },
    };
    return map[lang][actionType];
  };
  if (/[\u0600-\u06FF]/.test(t)) return verbFor("urdu");
  if (/[\u0900-\u097F]/.test(t)) return verbFor("hindi");
  if (/[\u0621-\u064A]/.test(t)) return verbFor("arabic");
  const lower = t.toLowerCase();
  const romanHits = ["kya", "ka ", "ko ", " ma ", " ha ", "kar", "mujh", "mera", "kasa", "btao", "thora", "abi", "nahi"]
    .filter((w) => lower.includes(w)).length;
  if (romanHits >= 2) return verbFor("roman");
  return verbFor("english");
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

/**
 * FIX 3 — strip ManyChat placeholder tokens that leak into inbound payloads.
 * Handles {{first_name}}, [[phone]], <<email>> and bare placeholder words
 * ManyChat renders when the underlying variable is null.
 */
const PLACEHOLDER_WORDS = new Set([
  "first name", "firstname", "last name", "lastname", "full name", "fullname",
  "phone", "phone number", "email", "email address", "name", "user", "customer",
  "n/a", "na", "null", "undefined",
]);

function sanitizePlaceholder(v: string | null | undefined): string | null {
  if (v == null) return null;
  const cleaned = String(v)
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/<<[^>]*>>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (PLACEHOLDER_WORDS.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

function sanitizeInboundText(raw: string): string {
  if (!raw) return "";
  // Strip unresolved template tokens but keep the rest of the sentence.
  const stripped = raw
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/<<[^>]*>>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  // If what's left is just a placeholder word, treat as a bare "hi" so the
  // premium opener fires cleanly instead of the AI parroting "First Name".
  if (PLACEHOLDER_WORDS.has(stripped.toLowerCase())) return "hi";
  return stripped;
}

// FIX 12 — MEDIA HANDLING
// Detect voice notes / images / videos / files / bare links so the AI
// acknowledges them instead of ignoring the inbound.
type InboundMediaKind = "voice" | "audio" | "image" | "video" | "file" | "link";
type InboundMedia = { kind: InboundMediaKind; url?: string };

const MEDIA_TYPE_MAP: Record<string, InboundMediaKind> = {
  audio: "voice",
  voice: "voice",
  ptt: "voice",
  image: "image",
  photo: "image",
  video: "video",
  file: "file",
  document: "file",
  sticker: "image",
};

function pickAttachmentUrl(a: unknown): string | undefined {
  if (!a || typeof a !== "object") return undefined;
  const o = a as Record<string, unknown>;
  const direct = typeof o.url === "string" ? o.url : undefined;
  if (direct) return direct;
  const payload = o.payload;
  if (payload && typeof payload === "object") {
    const pu = (payload as Record<string, unknown>).url;
    if (typeof pu === "string") return pu;
  }
  return undefined;
}

function detectInboundMedia(raw: Record<string, unknown>, rawText: string): InboundMedia | null {
  // 1) Explicit type fields ManyChat / WhatsApp forwards can carry.
  const typeCandidates = [
    raw.last_input_type, raw.last_message_type, raw.message_type, raw.type, raw.attachment_type,
    raw.last_attachment_type,
  ];
  for (const t of typeCandidates) {
    if (typeof t !== "string") continue;
    const key = t.toLowerCase().trim();
    const kind = MEDIA_TYPE_MAP[key];
    if (kind) {
      let url: string | undefined;
      const attUrl = raw.last_attachment_url ?? raw.attachment_url ?? raw.media_url;
      if (typeof attUrl === "string") url = attUrl;
      return { kind, url };
    }
  }
  // 2) Attachments array shape (ManyChat FB / IG relay style).
  const attArrays: unknown[] = [];
  if (Array.isArray(raw.attachments)) attArrays.push(...(raw.attachments as unknown[]));
  if (Array.isArray(raw.last_input_attachments)) attArrays.push(...(raw.last_input_attachments as unknown[]));
  for (const a of attArrays) {
    if (!a || typeof a !== "object") continue;
    const t = (a as Record<string, unknown>).type;
    if (typeof t === "string") {
      const kind = MEDIA_TYPE_MAP[t.toLowerCase()];
      if (kind) return { kind, url: pickAttachmentUrl(a) };
    }
  }
  // 3) Bare URL in the text (image/audio/video links). Only flag if the
  //    text is essentially just the URL — otherwise treat as normal text.
  const text = (rawText || "").trim();
  const urlMatch = text.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    const stripped = text.replace(urlMatch[0], "").trim();
    if (stripped.length <= 3) {
      const u = urlMatch[0].toLowerCase();
      if (/\.(png|jpe?g|gif|webp|heic|bmp)(\?|$)/.test(u)) return { kind: "image", url: urlMatch[0] };
      if (/\.(mp4|mov|webm|m4v)(\?|$)/.test(u)) return { kind: "video", url: urlMatch[0] };
      if (/\.(mp3|m4a|ogg|opus|wav|aac)(\?|$)/.test(u)) return { kind: "voice", url: urlMatch[0] };
      if (/\.(pdf|docx?|xlsx?|pptx?|zip)(\?|$)/.test(u)) return { kind: "file", url: urlMatch[0] };
      return { kind: "link", url: urlMatch[0] };
    }
  }
  return null;
}

function mediaMarkerText(m: InboundMedia): string {
  switch (m.kind) {
    case "voice": return "[user sent a voice note — no transcription available]";
    case "audio": return "[user sent an audio clip — no transcription available]";
    case "image": return `[user sent an image${m.url ? `: ${m.url}` : ""}]`;
    case "video": return `[user sent a video${m.url ? `: ${m.url}` : ""}]`;
    case "file":  return `[user sent a file${m.url ? `: ${m.url}` : ""}]`;
    case "link":  return `[user shared a link${m.url ? `: ${m.url}` : ""}]`;
  }
}


/**
 * FIX 2 — JSON leak guard.
 * The AI occasionally emits raw JSON (or a fenced ```json block, or a prose
 * preamble + JSON) instead of plain text. Never let that reach WhatsApp.
 * Strategy: detect any JSON-looking payload anywhere in the text, extract
 * `reply` / `reply_parts` / `message`, and fall back to stripping fences.
 * As a last resort, if the string still smells like JSON, return empty so
 * the caller can substitute a safe fallback rather than shipping garbage.
 */
function sanitizeReplyText(text: string): string {
  if (!text) return text;
  let out = text.trim();
  if (!out) return out;

  // 1) Strip ```json ... ``` (or plain ```) fences even mid-string.
  const fence = out.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    const inner = fence[1].trim();
    // If the fenced content parses as JSON, unwrap fields; else use inner text.
    const parsed = safeParseAIJson(inner);
    if (parsed) {
      const r = (parsed as { reply?: unknown; message?: unknown; reply_parts?: unknown }).reply
        ?? (parsed as { message?: unknown }).message;
      if (typeof r === "string" && r.trim()) return r.trim();
      const rp = (parsed as { reply_parts?: unknown }).reply_parts;
      if (Array.isArray(rp)) {
        const joined = rp.filter((x) => typeof x === "string").join("\n\n").trim();
        if (joined) return joined;
      }
    }
    out = inner;
  }

  // 2) Whole-string JSON? Unwrap.
  if (out.startsWith("{") || out.startsWith("[")) {
    const parsed = safeParseAIJson(out);
    if (parsed) {
      const r = (parsed as { reply?: unknown; message?: unknown }).reply
        ?? (parsed as { message?: unknown }).message;
      if (typeof r === "string" && r.trim()) return r.trim();
      const rp = (parsed as { reply_parts?: unknown }).reply_parts;
      if (Array.isArray(rp)) {
        const joined = rp.filter((x) => typeof x === "string").join("\n\n").trim();
        if (joined) return joined;
      }
    }
  }

  // 3) Embedded JSON blob (prose preamble + {...} tail, common Gemini leak).
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const candidate = out.slice(first, last + 1);
    const parsed = safeParseAIJson(candidate);
    if (parsed && typeof (parsed as { reply?: unknown }).reply === "string") {
      const r = (parsed as { reply: string }).reply.trim();
      if (r) return r;
    }
  }

  // 4) Kill any leftover key-looking fragments that would spook a user.
  //    (e.g. "reply": "..." bleeding in.)
  out = out
    .replace(/^\s*"?(reply|reply_parts|message|ai_reply|tool_calls|tool_result)"?\s*:\s*/i, "")
    .replace(/,?\s*"(tool_calls|reply_parts|reasoning|current_stage|escalate|qualification|lead_score)"\s*:[\s\S]*$/i, "")
    .trim();

  // 5) Last-resort smell test: if the payload still looks like JSON structure,
  //    return empty so the caller substitutes a safe fallback.
  if (/^[{\[]/.test(out) && /[}\]]$/.test(out) && /"\s*:\s*"/.test(out)) {
    return "";
  }
  return out;
}

/**
 * FIX 6 — De-list formatter. Converts robotic numbered / bulleted lists into
 * conversational flowing prose. WhatsApp receptionists don't send:
 *   "1. Option A\n2. Option B\n3. Option C"
 * They send: "Option A, Option B, or Option C — which works?"
 *
 * Applied to every reply EXCEPT the premium first-message opener, which uses
 * intentional "• " bullets that are part of its designed structure.
 */
function delistReplyText(text: string): string {
  if (!text) return text;
  const raw = text.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  // Detect list items: "1. ", "1) ", "- ", "* ", "• ", "· ", "→ ", "▪ "
  const listRe = /^\s*(?:\d{1,2}[.)]\s+|[-*•·▪→]\s+)(.+?)\s*$/;
  const items: string[] = [];
  const nonList: string[] = [];
  let listRun = 0;

  for (const line of lines) {
    const m = line.match(listRe);
    if (m) {
      items.push(m[1].trim().replace(/[.,;:]+$/, ""));
      listRun++;
    } else if (line.trim() === "" && listRun > 0) {
      // blank inside/after list — keep, don't reset yet
    } else {
      nonList.push(line);
    }
  }

  // Only rewrite if we actually detected a list of 2+ items.
  if (items.length < 2) return text;

  const prose = items.length === 2
    ? `${items[0]} or ${items[1]}`
    : `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;

  const kept = nonList.map((l) => l.trim()).filter(Boolean).join("\n");
  return (kept ? kept + " " : "") + prose;
}

/**
 * FIX 10 — Scrub imaginary deliverable offers.
 *
 * The bot has been caught offering things it cannot actually send: demo
 * videos, PDFs, brochures, decks, case studies, screenshots, recordings,
 * walkthroughs, samples. None of those exist as artifacts in this system —
 * the only thing we can legitimately share is the *booking_link* and, once
 * booked, a calendar invite. Offering anything else breaks trust the moment
 * the user says "haan bhejo" and nothing arrives.
 *
 * This pass drops any sentence that promises to send/share such a deliverable
 * (English + Roman Urdu). If the entire reply was one such sentence, it is
 * replaced with a safe generic re-open so we don't ship an empty bubble.
 */
const IMAGINARY_ARTIFACT_RE = /(video|videos|pdf|pdfs|brochure|deck|slide\s?deck|slides|screenshot|screen\s?shot|case[\s-]?stud(?:y|ies)|recording|walk[\s-]?through(?:\s+video)?|sample|portfolio\s+file|attachment|attach)/i;
const SEND_VERB_RE = /(send|share|forward|attach|drop|deliver|email|whatsapp\s+you|bhej\w*|forwar\w*|share\s+kar\w*|send\s+kar\w*|bhej\s*d\w*|arsalna|أرسل|ارسل|ابعث)/i;

function scrubImaginaryOffers(text: string): string {
  if (!text) return text;
  // Split into sentences while preserving line breaks.
  const chunks = text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const kept = chunks.filter((s) => {
    // Drop if the sentence both mentions a deliverable AND a send verb.
    return !(IMAGINARY_ARTIFACT_RE.test(s) && SEND_VERB_RE.test(s));
  });
  if (kept.length === 0) return "";
  return kept.join(" ");
}








function buildSystemPrompt(client: ClientRow, firstName: string | null, isFirstEverMessage: boolean, lockedLang: LangCode = "en", runtimeFacts: string | null = null): string {
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

  // BLOCK 0B — LOCKED LANGUAGE (FIX 13)
  // The conversation is locked to the language the user opened in. Do NOT
  // drift to formal English mid-thread just because the user borrowed one
  // English word (words like "price", "demo", "email", "salon", "booking"
  // are normal loanwords inside Roman Urdu — they are NOT a language switch).
  blocks.push(
    `LOCKED CONVERSATION LANGUAGE (FIX 13 — sticky, do NOT drift)
This conversation is locked to: ${langLabel(lockedLang)}.
Every reply — including tool-result replies, confirmations, error recoveries,
and clarifying questions — MUST be written in ${langLabel(lockedLang)}.
${lockedLang === "ur-roman" ? `- Reply in Roman Urdu (Latin script), NOT Urdu script and NOT formal English.
- Loanwords like "price", "demo", "email", "booking", "slot", "salon", "clinic", "PKT" stay in English inside Roman Urdu — that is natural, keep going in Roman Urdu.
- Never respond in a paragraph of formal English just because the user asked a factual question. Answer the same question in Roman Urdu.
- Example: user asks "price kya hai?" → reply in Roman Urdu ("*price* aap ke use case pe depend karti hai — 2 min ki quick call laga lein?"), NOT "Our pricing depends on...".` : ""}
${lockedLang === "ur-script" ? "- Reply in Urdu script (اردو). Do not switch to Roman Urdu or English." : ""}
${lockedLang === "hi-script" ? "- Reply in Hindi (देवनागरी script). Do not switch to Roman Hindi or English." : ""}
${lockedLang === "ar" ? "- Reply in Arabic (العربية). Do not switch to English." : ""}
${lockedLang === "en" ? "- Reply in natural English. Do not switch to Urdu/Roman Urdu unless the user's LATEST message is clearly in that language." : ""}
The only situation in which you may switch languages is when the user's LATEST
message is UNAMBIGUOUSLY in a different language (e.g. a full sentence in
Urdu/Arabic script, or several clear Roman-Urdu sentences in a row). A single
foreign word or English loanword inside their sentence is NOT a language switch.`
  );

  // BLOCK 1 — IDENTITY & ROLE
  blocks.push(
    `You are the AI concierge for ${client.business_name}. You message leads on WhatsApp the way a sharp, warm, premium human receptionist would — never like a chatbot, never like a form, never like a salesperson chasing a close. You are calm, confident, curious, and you carry the brand's premium energy in every reply.`
  );

  // BLOCK 2A — FIRST MESSAGE ONLY (premium opener)
  // FIX 1: Enforce SINGLE-BUBBLE structure. No double line-breaks anywhere
  // (autoSplit would treat them as bubble boundaries and could drop the
  // closing question). Keep total under 500 chars.
  if (isFirstEverMessage) {
    blocks.push(
      `FIRST MESSAGE ONLY — this is the very first message in this conversation (no prior history). Do NOT use the standard Stage 1 single-question opener. Send ONE premium message (delivered as ONE WhatsApp bubble) with this EXACT structure — use SINGLE line-breaks only, NEVER a blank line between sections:
Line 1: warm one-line welcome${firstName ? ` using their first name (${firstName})` : " (use their first name if known)"} — genuinely glad-you're-here, fresh wording, never generic.
Line 2: • <short outcome-focused capability of ${client.business_name}, no trailing period>
Line 3: • <second capability, no trailing period>
Line 4: • <third capability, no trailing period>
Line 5: ONE warm, specific, open discovery question that flows naturally after the bullets.
HARD RULES for this opener:
- Total message MUST be under 500 characters.
- Use SINGLE newlines (\\n) between every line. NEVER emit a blank line / double newline anywhere — that would split the message into separate bubbles and the closing question would be lost.
- Do NOT emit reply_parts for this opener. Put the entire opener into the single "reply" field.
- Use "• " (bullet + space) for the three bullets, not markdown dashes.
- No exclamation spam. Confident, unhurried premium tone.
After this first message, all future replies follow the normal Stage 1-7 flow below. This special structure applies ONLY to message #1, never again.`
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
- NEVER use numbered lists ("1. ...", "2. ...") or bullet points ("- ", "* ", "• ") anywhere in normal replies. Write options as flowing prose: "*2:30pm* or *4pm*, which works?" — NOT "1. 2:30pm  2. 4pm". Lists feel like a form; humans don't send forms on WhatsApp.
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
- Defending price when objected to (instead: understand WHY)

CAPABILITY INVENTORY (FIX 10 — do NOT offer anything not on this list):
The ONLY things you can actually deliver in this conversation are:
  (a) a booked demo/appointment (via the booking tools),
  (b) the booking link once available,
  (c) a calendar invite AFTER a booking is confirmed.
You do NOT have — and MUST NEVER offer to send — any of the following:
demo videos, walkthrough videos, screen recordings, PDFs, brochures,
decks, slide decks, screenshots, case studies, portfolios, samples,
attachments, files, or "I'll email/WhatsApp you a ..." of any kind.
If the user asks for a video / PDF / brochure / case study, do NOT
promise to send one. Instead, offer a short *live demo call* on their
preferred time as the alternative. Ban phrases like "video bhej doon",
"send you a quick video", "share a PDF", "brochure bhej dun",
"case study bhejta hoon", "screenshot share kar doon".`

  );

  // BLOCK 4B — MEDIA HANDLING (FIX 12)
  blocks.push(
    `MEDIA HANDLING (FIX 12 — voice notes, images, videos, files, links)
The user's message may include a marker in square brackets such as:
  [user sent a voice note — no transcription available]
  [user sent an image: <url>]
  [user sent a video: <url>]
  [user sent a file: <url>]
  [user shared a link: <url>]
When you see any of these markers:
- ACKNOWLEDGE the media in ONE short, warm line — never ignore it, never
  pretend to have listened / watched / opened it, never guess its contents.
- For a voice note: warmly ask them to type the key point in one line so
  you can help fast (you cannot process audio). Match their language.
  Example shape (write fresh, never verbatim): "got your voice note — mind
  typing the main thing in one line so I can jump on it right away?"
- For an image / video / file / link: acknowledge and ask ONE specific
  question about what they'd like you to look at or what it relates to.
  Example: "got the pic — what would you like me to check on this?"
- NEVER quote the URL back to them. NEVER echo the marker text.
- NEVER claim to have transcribed audio or seen image contents.
- If they send voice notes 2+ times after you've asked them to type, set
  escalate=true so a real person can pick up.
- Do NOT abandon whatever stage you were in. After acknowledging the media,
  continue the conversation naturally.`
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
- **NEVER invent or guess a clock time.** Only state specific times (e.g. "2pm", "14:30") that came from the most recent check_availability TOOL_RESULT in this conversation. If you do not have a tool result yet, ask for their preference instead — do NOT make up "available" times.
- Always state the timezone label naturally when giving a time.
- booking_action = { "type": "none" } for any non-booking turn.
- **AFTER A BOOKING IS CONFIRMED** (status="booked" or you have just seen a successful book_slot TOOL_RESULT earlier in this thread): do NOT emit another booking_action. Reply conversationally (thanks, follow-up questions, scheduling notes). Only emit a new booking_action if the user EXPLICITLY asks to reschedule, change, or cancel — in which case acknowledge and ask for the new preferred time first.
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
    | { "type": "list_bookings" }
    | { "type": "cancel_booking", "appointment_id": "<id|null>", "reason": "<short reason|null>" }
    | { "type": "reschedule_booking", "appointment_id": "<id|null>", "new_slot_iso_utc": "<iso>" }
    | { "type": "restore_booking" }
}

REPLY_PARTS RULES:
- ALWAYS prefer reply_parts over reply for natural human bursts.
- 1 bubble = simple acknowledgement or single question. 2 bubbles = ack + question, OR statement + question. 3 bubbles = ONLY the premium first-message opener.
- Each bubble independently follows tone rules (short, *bold* keywords, no dashes, mirrored language).
- "reply" should still contain the full text (parts joined) as a fallback.

TOOL CATALOG — pick ONE action per turn. The backend runs it and returns real data. Never fabricate the result.

1) "none"
   USE WHEN: any turn that does not need to touch the calendar (chat, discovery, objections, general questions, small talk, confirmations after a successful booking).

2) "check_availability"  →  is this time free? what alternatives exist?
   USE WHEN: user asks about a time / a date / "kya available hai" / "when can we meet" / gives a specific time / says "morning" / "evening" / etc.
   FIELDS: user_stated_time (their exact phrase), preferred_date_label ("tomorrow" | "friday" | "2026-07-03"...), preferred_time_window ("morning"|"afternoon"|"evening"|"specific_time"|"any"), specific_time_local ("14:00" or null).
   BACKEND RETURNS: exact_available (bool), exact_slot, alternatives[], window_empty. You then confirm or offer 1-2 alternatives in prose.

3) "book_slot"  →  actually create the appointment.
   USE WHEN: user has clearly said YES to a specific time you (or they) previously proposed and that time appeared in a check_availability tool result THIS conversation.
   FIELDS: slot_iso_utc (must be the exact ISO from the most recent check_availability result — never invent), contact_email (if you already collected it, else null).
   HARD RULE: never emit book_slot without a recent successful check_availability. If unsure, run check_availability first.

4) "list_bookings"  →  what does this contact currently have booked?
   USE WHEN: user asks "kya meri booking hai?", "when is my demo?", "check my appointment", or before offering to cancel/reschedule and you don't already have the appointment in mind.
   NO FIELDS.

5) "cancel_booking"  →  cancel an existing appointment.
   USE WHEN: user clearly says "cancel my booking" / "cancel kar do" / "I want to cancel" / "meeting cancel". If they haven't said which one and multiple exist, run list_bookings first.
   FIELDS: appointment_id (null = cancel their soonest upcoming), reason (short natural reason, optional).

6) "reschedule_booking"  →  move an existing appointment to a new time.
   USE WHEN: user wants to change the time of an existing booking AND has confirmed the new time (which must have come from a recent check_availability result).
   FLOW: (a) if you don't know the new time yet, run check_availability first. (b) once they confirm, emit reschedule_booking with new_slot_iso_utc.
   FIELDS: appointment_id (null = reschedule their soonest upcoming), new_slot_iso_utc (exact ISO from the recent check_availability).

7) "restore_booking"  →  undo a cancellation that just happened.
   USE WHEN: user says the last cancel was a mistake / wrong one ("wapas laga do", "undo", "no that was wrong", "restore my booking", "phir se book kar do wo wali") within the last hour.
   NO FIELDS. The backend automatically restores the most recently cancelled booking in this conversation.

CROSS-CONVERSATION SAFETY:
- You can ONLY cancel or reschedule bookings that were made in THIS conversation with this user. Never touch anyone else's appointment.
- If the user in this chat asks to cancel a booking they didn't make here, do NOT emit cancel_booking. Say you can only manage bookings made through this chat and offer a handoff.

DECISION SHORTCUTS:
- User asks "kya available hai / any slots / kab free ho" → check_availability.
- User says a specific time ("Wed 4pm", "kal 11am") → check_availability with that time.
- User replies "haan" / "yes" / "kar do" to a time you just offered → book_slot with that ISO.
- User says "cancel" / "cancel kar do" / "don't want it anymore" → cancel_booking (if multiple bookings, list_bookings first).
- User says "reschedule" / "change time" / "move to X" → check_availability for X (if given) or ask; then reschedule_booking.
- User says "when is my booking?" / "kya time hai meri booking?" → list_bookings.
- User says "wapas book kar do" / "no that was the wrong one" / "undo" right after you cancelled → restore_booking.
- Anything else → "none".

STRICT TOOL NAME RULE:
- booking_action.type MUST be exactly one of: "none", "check_availability", "book_slot", "list_bookings", "cancel_booking", "reschedule_booking", "restore_booking".
- NEVER invent tool names like "get_slots", "show_slots", "availability", "confirm_booking", "delete_booking".
- Exactly ONE action per turn. If two things are needed (e.g. check + book), take the FIRST step this turn and the next step on the next turn.`
  );

  // BLOCK 8B — RUNTIME FACTS (FIX 15B and future dynamic hints)
  // Injected only when the code layer detects a runtime condition the AI
  // must react to (e.g. exact-repeat message, stuck-flow recovery).
  if (runtimeFacts && runtimeFacts.trim()) {
    blocks.push(`RUNTIME FACTS (dynamic — apply these to THIS turn only):\n${runtimeFacts.trim()}`);
  }

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

// ---------- FIX 14 / FIX 15B helpers ----------

/**
 * FIX 14 Layer 1 — deterministic "still working" bubble sent at 25s if the AI
 * + tool loop hasn't produced a final reply yet. Localized per sticky lang.
 */
export function localizedStillWorking(lang: LangCode): string {
  switch (lang) {
    case "ur-roman": return "abhi bhi check kar raha hoon — ek moment aur…";
    case "ur-script": return "ابھی بھی چیک کر رہا ہوں — ایک لمحہ اور…";
    case "hi-script": return "अभी भी देख रहा हूँ — एक क्षण और…";
    case "ar": return "ما زلت أتحقق — لحظة أخرى من فضلك…";
    case "en":
    default: return "still working on this — one more moment…";
  }
}

/**
 * FIX 14 Layer 2 — graceful recovery bubble for the watchdog cron.
 */
export function localizedRecovery(lang: LangCode): string {
  switch (lang) {
    case "ur-roman": return "sorry, thora tangle ho gaya tha — aap kya bata rahe the?";
    case "ur-script": return "معذرت، تھوڑا سا الجھ گیا تھا — آپ کیا کہہ رہے تھے؟";
    case "hi-script": return "माफ़ कीजिए, ज़रा उलझ गया था — आप क्या कह रहे थे?";
    case "ar": return "آسف، حصل تشويش صغير — تفضل، شو كنت تقول؟";
    case "en":
    default: return "sorry, got tangled up for a second — you were saying?";
  }
}

/**
 * FIX 15B — exact-repeat user message detection.
 *
 * Returns a runtime fact string for the system prompt when the user has sent
 * the same message text again within 5 minutes. Counts the total repeat streak
 * (2 = second identical, 3+ = third+ — offer handoff).
 */
export function detectRepeatUserMessage(
  currentText: string,
  priorHistory: Array<{ role: string; content: string; timestamp: string }>,
): { isRepeat: boolean; repeatCount: number; runtimeFact: string | null } {
  const norm = (s: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const cur = norm(currentText);
  if (!cur || cur.length < 2) return { isRepeat: false, repeatCount: 0, runtimeFact: null };

  const nowMs = Date.now();
  // Walk backwards through history, counting consecutive matching USER turns
  // within the 5-minute window. Assistant turns in between don't reset the
  // streak (the user is repeating themselves TO the bot).
  let streak = 1; // includes the current message
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const m = priorHistory[i];
    if (m.role !== "user") continue;
    const t = Date.parse(m.timestamp);
    if (!Number.isFinite(t)) break;
    if (nowMs - t > 5 * 60_000) break;
    if (norm(m.content) === cur) {
      streak += 1;
    } else {
      break;
    }
  }

  if (streak < 2) return { isRepeat: false, repeatCount: streak, runtimeFact: null };

  const handoffLine = streak >= 3
    ? "This is the 3rd+ identical repeat. Offer a warm human handoff now (e.g. 'let me get a real teammate on this with you') and set escalate=true with a short escalation_reason."
    : "Do NOT repeat your previous response verbatim. Acknowledge briefly that you heard them, then either (a) ask ONE clarifying question about what specifically wasn't answered, or (b) offer a different angle on the same topic. Never re-fire the premium opener.";

  return {
    isRepeat: true,
    repeatCount: streak,
    runtimeFact: `The user just repeated their previous message (streak: ${streak}). ${handoffLine}`,
  };
}
