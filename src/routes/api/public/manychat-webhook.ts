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
        const ALLOWED_PHONES = ["3447306520"];
        const normalized = (data.phone ?? "").replace(/\D/g, "");
        const last10 = normalized.slice(-10);
        if (!ALLOWED_PHONES.includes(last10)) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data as unknown as Json, status_code: 200, error: "phone_not_allowlisted",
          });
          return new Response(JSON.stringify({ ai_reply: "" }), { headers: cors });
        }

        const nowIso = new Date().toISOString();
        const { data: existing } = await supabaseAdmin
          .from("conversations").select("*")
          .eq("client_id", client.id).eq("subscriber_id", data.subscriber_id).maybeSingle();

        const messages: Msg[] = Array.isArray(existing?.messages) ? (existing!.messages as unknown as Msg[]) : [];
        messages.push({ role: "user", content: data.message_text, timestamp: nowIso });

        let convoId = existing?.id;
        let qualification = (existing?.qualification ?? {}) as Record<string, unknown>;
        let leadScore = existing?.lead_score ?? 0;
        let status = existing?.status ?? "active";
        let currentStage: Stage = ((existing?.current_stage as Stage | undefined) ?? "open");
        const manualTakeover = existing?.manual_takeover ?? false;

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

        if (manualTakeover) {
          await supabaseAdmin.from("conversations").update({
            messages: messages as unknown as Json,
            last_message_at: nowIso,
            phone: data.phone ?? existing?.phone ?? null,
            first_name: data.first_name ?? existing?.first_name ?? null,
          }).eq("id", convoId!);
          return new Response(JSON.stringify({ ai_reply: "" }), { headers: cors });
        }

        const systemPrompt = buildSystemPrompt(client as ClientRow, data.first_name ?? null);
        // TEMP: memory disabled — only send the current user message, no prior history
        const aiMessages = [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: data.message_text },
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
              try {
                parsedAI = JSON.parse(content) as AIResponse;
                if (typeof parsedAI.reply === "string" && parsedAI.reply.trim().length > 0) {
                  aiReply = parsedAI.reply.trim();
                }
              } catch {
                aiReply = content.slice(0, 500);
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

function buildSystemPrompt(client: ClientRow, firstName: string | null): string {
  const blocks: string[] = [];

  // BLOCK 1 — IDENTITY & ROLE
  blocks.push(
    `You are the AI concierge for ${client.business_name}. You message leads on WhatsApp the way a sharp, warm, premium human receptionist would — never like a chatbot, never like a form, never like a salesperson chasing a close. You are calm, confident, curious, and you carry the brand's premium energy in every reply.`
  );

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

Examples of the pattern (do not copy verbatim, adapt to context):

If "too expensive":
→ "Totally fair. Out of curiosity — is it the number itself, or you're not sure yet what kind of return it would bring you?"

If "let me think about it":
→ "Of course. What's the part you want to think over?"

If "I'll ask my partner / manager":
→ "Makes sense. What do you think they'll want to know first?"

If "we already have a system":
→ "Got it. What does your current one do really well, and where does it fall short for you?"

If "send me details / send a brochure":
→ "Happy to — but most of what makes this work depends on your specific setup. A 15-min call would tell you more in 5 minutes than any deck could. Want me to lock a time?"

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

  // BLOCK 8 — OUTPUT CONTRACT
  blocks.push(
    `OUTPUT CONTRACT (strict JSON, no markdown)
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
  "status_change": "qualified" | "booked" | "lost" | null
}`
  );

  return blocks.join("\n\n");
}
