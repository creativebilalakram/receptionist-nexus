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

type AIResponse = {
  reply: string;
  qualification_update?: {
    budget?: boolean | null;
    authority?: boolean | null;
    need?: boolean | null;
    timing?: boolean | null;
  };
  ready_to_book?: boolean;
  status_change?: "qualified" | "booked" | "lost" | null;
};

type Msg = { role: "user" | "assistant"; content: string; timestamp: string };

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
            direction: "inbound", payload: raw as object, status_code: 400,
            error: parsed.error.message,
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "invalid_payload" }), { status: 400, headers: cors });
        }
        const data = parsed.data;

        // Load client
        const { data: client, error: clientErr } = await supabaseAdmin
          .from("clients").select("*").eq("id", data.client_id).maybeSingle();
        if (clientErr || !client) {
          await supabaseAdmin.from("webhook_logs").insert({
            direction: "inbound", payload: data, status_code: 404, error: "client_not_found",
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "client_not_found" }), { status: 404, headers: cors });
        }

        if (client.webhook_secret !== data.webhook_secret) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data, status_code: 401, error: "invalid_secret",
          });
          return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "unauthorized" }), { status: 401, headers: cors });
        }

        if (!client.is_active) {
          await supabaseAdmin.from("webhook_logs").insert({
            client_id: client.id, direction: "inbound", payload: data, status_code: 200, error: "client_paused",
          });
          return new Response(JSON.stringify({ ai_reply: "We're temporarily unavailable. We'll be back shortly." }), { headers: cors });
        }

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id, direction: "inbound", payload: data, status_code: 200,
        });

        // Upsert conversation
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
        const manualTakeover = existing?.manual_takeover ?? false;

        if (!existing) {
          const { data: newRow, error: insErr } = await supabaseAdmin.from("conversations").insert({
            client_id: client.id,
            subscriber_id: data.subscriber_id,
            phone: data.phone ?? null,
            first_name: data.first_name ?? null,
            messages: messages as unknown as Json,
            last_message_at: nowIso,
          }).select("id").single();
          if (insErr || !newRow) {
            return new Response(JSON.stringify({ ai_reply: FALLBACK, error: "convo_insert_failed" }), { status: 500, headers: cors });
          }
          convoId = newRow.id;
        }

        if (manualTakeover) {
          // Save user msg but don't generate AI reply
          await supabaseAdmin.from("conversations").update({
            messages: messages as unknown as Json,
            last_message_at: nowIso,
            phone: data.phone ?? existing?.phone ?? null,
            first_name: data.first_name ?? existing?.first_name ?? null,
          }).eq("id", convoId!);
          return new Response(JSON.stringify({ ai_reply: "" }), { headers: cors });
        }

        // Build system prompt
        const systemPrompt = buildSystemPrompt(client);
        const trimmed = messages.slice(-20);
        const aiMessages = [
          { role: "system" as const, content: systemPrompt },
          ...trimmed.map((m) => ({ role: m.role, content: m.content })),
        ];

        // Call Lovable AI
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

        // Merge qualification & status
        if (parsedAI?.qualification_update) {
          qualification = { ...qualification, ...parsedAI.qualification_update };
        }
        if (parsedAI?.status_change) status = parsedAI.status_change;
        // Lead score = count of true BANT fields
        const bantKeys = ["budget", "authority", "need", "timing"] as const;
        leadScore = bantKeys.reduce((acc, k) => acc + (qualification[k] === true ? 25 : 0), 0);

        // Append assistant reply
        messages.push({ role: "assistant", content: aiReply, timestamp: new Date().toISOString() });

        await supabaseAdmin.from("conversations").update({
          messages: messages as unknown as Json,
          qualification: qualification as unknown as Json,
          lead_score: leadScore,
          status,
          last_message_at: new Date().toISOString(),
          phone: data.phone ?? existing?.phone ?? null,
          first_name: data.first_name ?? existing?.first_name ?? null,
        }).eq("id", convoId!);

        await supabaseAdmin.from("webhook_logs").insert({
          client_id: client.id,
          direction: "outbound",
          payload: { reply: aiReply, parsed: parsedAI },
          response: aiResponseLog as object,
          status_code: aiStatusCode || 200,
        });

        return new Response(JSON.stringify({ ai_reply: aiReply }), { headers: cors });
      },
    },
  },
});

function buildSystemPrompt(client: {
  business_name: string;
  niche: string | null;
  services: string | null;
  tone_notes: string | null;
  faq: string | null;
  business_hours: string | null;
  booking_link: string | null;
  system_prompt_override: string | null;
}): string {
  const blocks: string[] = [];

  blocks.push(
    `You are the AI receptionist for ${client.business_name}${client.niche ? `, a ${client.niche}` : ""}. ` +
    `You communicate like a sharp, warm, professional human receptionist on WhatsApp — never like a bot or a form.`
  );

  blocks.push(
    [
      "Behavior rules:",
      "- Reply in 1–3 short sentences max — this is WhatsApp, not email.",
      "- Ask ONE thoughtful question at a time and react to what they say.",
      "- Never list services upfront, never pitch directly, never sound like a form.",
      "- Match the user's language (English, Urdu, Hindi, Spanish, etc — reply in the same).",
      "- Quietly assess qualification through natural conversation: real need, ability to afford, decision-making authority, urgency.",
      "- Only when qualification feels strong, naturally suggest a booking: \"let's hop on a quick call to see if we're the right fit\".",
      "- If they raise price or hesitation, solve don't sell — understand the real objection. Never discount. Never over-explain.",
      "- If they ask something outside business scope, gently redirect.",
    ].join("\n")
  );

  blocks.push(
    [
      "Business context:",
      `Services offered: ${client.services || "(not specified)"}`,
      `Tone guidance: ${client.tone_notes || "(default warm professional)"}`,
      `FAQ: ${client.faq || "(none provided)"}`,
      `Business hours: ${client.business_hours || "(not specified)"}`,
      `Booking link to share when ready: ${client.booking_link || "(not configured — ask them to leave their availability)"}`,
    ].join("\n")
  );

  blocks.push(
    [
      "Respond with a JSON object only, no markdown:",
      "{",
      '  "reply": "<your message to the user>",',
      '  "qualification_update": {',
      '    "budget": true | false | null,',
      '    "authority": true | false | null,',
      '    "need": true | false | null,',
      '    "timing": true | false | null',
      "  },",
      '  "ready_to_book": <true if you are suggesting booking now>,',
      '  "status_change": "qualified" | "booked" | "lost" | null',
      "}",
    ].join("\n")
  );

  if (client.system_prompt_override && client.system_prompt_override.trim()) {
    blocks.push(`Additional instructions:\n${client.system_prompt_override.trim()}`);
  }

  return blocks.join("\n\n");
}
