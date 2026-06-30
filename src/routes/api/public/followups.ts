// Cron-triggered: sends ONE personalized follow-up to conversations that
// went silent ~1h after showing interest, only if they never booked.
// Auth: requires header `apikey: <SUPABASE_PUBLISHABLE_KEY>`.
import { createFileRoute } from "@tanstack/react-router";
import { sendWhatsAppText } from "@/lib/manychat-send.server";

type Msg = { role: "user" | "assistant"; content: string; timestamp: string };

export const Route = createFileRoute("/api/public/followups")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const url = new URL(request.url);
        const windowHours = Math.max(1, Math.min(168, Number(url.searchParams.get("window_hours")) || 24));
        const minIdleMin = Math.max(5, Number(url.searchParams.get("min_idle_minutes")) || 60);
        const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
        const onlyPhone = url.searchParams.get("phone");

        const now = Date.now();
        const idleSince = new Date(now - minIdleMin * 60_000).toISOString();
        const windowStart = new Date(now - windowHours * 60 * 60_000).toISOString();

        let q = supabaseAdmin
          .from("conversations")
          .select("id, client_id, subscriber_id, first_name, phone, messages, qualification, lead_score, status, current_stage, last_message_at, manual_takeover, escalated, followup_sent_at")
          .eq("manual_takeover", false)
          .eq("escalated", false)
          .not("status", "in", "(booked,lost)")
          .lte("last_message_at", idleSince)
          .gte("last_message_at", windowStart)
          .limit(100);
        if (!force) q = q.is("followup_sent_at", null);
        if (onlyPhone) q = q.eq("phone", onlyPhone);
        const { data: candidates, error } = await q;


        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const sent: Array<{ id: string; status: number }> = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const c of candidates ?? []) {
          // Skip if no real interest signal
          const interested =
            (c.lead_score ?? 0) > 0 ||
            ["qualify", "position", "invite", "close"].includes(String(c.current_stage ?? ""));
          if (!interested) { skipped.push({ id: c.id, reason: "not_interested" }); continue; }

          // Skip if already has a scheduled/confirmed appointment
          const { data: appts } = await supabaseAdmin
            .from("appointments")
            .select("id")
            .eq("conversation_id", c.id)
            .in("status", ["scheduled", "confirmed"])
            .limit(1);
          if (appts && appts.length > 0) {
            await supabaseAdmin.from("conversations").update({ followup_sent_at: new Date().toISOString() }).eq("id", c.id);
            skipped.push({ id: c.id, reason: "already_booked" });
            continue;
          }

          const messages: Msg[] = Array.isArray(c.messages) ? (c.messages as unknown as Msg[]) : [];
          if (messages.length === 0) { skipped.push({ id: c.id, reason: "empty" }); continue; }

          // Load client context
          const { data: client } = await supabaseAdmin
            .from("clients")
            .select("business_name, niche, services, icp, tone_notes, faq, booking_link")
            .eq("id", c.client_id)
            .maybeSingle();
          if (!client) { skipped.push({ id: c.id, reason: "no_client" }); continue; }

          const { data: settings } = await supabaseAdmin
            .from("booking_settings")
            .select("manychat_api_key")
            .eq("client_id", c.client_id)
            .maybeSingle();
          const mcKey = settings?.manychat_api_key ?? process.env.MANYCHAT_API_KEY ?? null;
          if (!mcKey) { skipped.push({ id: c.id, reason: "no_manychat_key" }); continue; }

          const followup = await generateFollowup({
            client,
            firstName: c.first_name,
            messages,
            stage: c.current_stage,
          });
          if (!followup) { skipped.push({ id: c.id, reason: "ai_failed" }); continue; }

          // Send via ManyChat using the client-specific key if available
          const res = await sendWhatsAppText(c.subscriber_id, followup);
          if (!res.ok) {
            await supabaseAdmin.from("webhook_logs").insert({
              client_id: c.client_id,
              direction: "outbound",
              payload: { followup, subscriber_id: c.subscriber_id, error: res.error } as any,
              status_code: res.status,
            });
            skipped.push({ id: c.id, reason: `send_${res.status}` });
            continue;
          }

          // Append to messages, mark followup_sent_at
          const newMessages = [
            ...messages,
            { role: "assistant" as const, content: followup, timestamp: new Date().toISOString() },
          ];
          await supabaseAdmin.from("conversations").update({
            messages: newMessages as any,
            followup_sent_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
          }).eq("id", c.id);

          await supabaseAdmin.from("webhook_logs").insert({
            client_id: c.client_id,
            direction: "outbound",
            payload: { followup, subscriber_id: c.subscriber_id, kind: "auto_followup" } as any,
            status_code: res.status,
          });

          sent.push({ id: c.id, status: res.status });
        }

        return Response.json({ ok: true, checked: candidates?.length ?? 0, sent, skipped });
      },
    },
  },
});

async function generateFollowup(args: {
  client: { business_name: string; niche: string | null; services: string | null; icp: string | null; tone_notes: string | null; faq: string | null; booking_link: string | null };
  firstName: string | null;
  messages: Msg[];
  stage: string | null;
}): Promise<string | null> {
  const aiKey = process.env.OPENAI_API_KEY;
  if (!aiKey) return null;
  const aiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const transcript = args.messages.slice(-12).map((m) =>
    `${m.role === "user" ? "USER" : "AI"}: ${m.content}`
  ).join("\n");

  const system = `You are the WhatsApp receptionist for *${args.client.business_name}*. The lead went silent. Write ONE warm, human, personalized follow-up.

BUSINESS: ${args.client.business_name}${args.client.niche ? ` — ${args.client.niche}` : ""}
SERVICES: ${args.client.services ?? "(unspecified)"}
IDEAL CUSTOMER: ${args.client.icp ?? "(unspecified)"}
TONE: ${args.client.tone_notes ?? "friendly, professional, concise"}
LEAD NAME: ${args.firstName ?? "(unknown)"}
STAGE WHEN THEY DROPPED: ${args.stage ?? "open"}

CONVERSATION SO FAR:
${transcript}

RULES: mirror their language/script. 1–3 short lines. *bold* key words. No dashes/bullets/headings. Reference something specific they said. End with ONE soft question. Output ONLY the message text.`;

  try {
    const { retryFetch } = await import("@/lib/retry");
    const resp = await retryFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${aiKey}` },
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Write the follow-up message now." },
        ],
      }),
    }, { attempts: 2, baseMs: 500, timeoutMs: 15_000, label: "openai-followup" });
    if (!resp.ok) return null;
    const json: any = await resp.json().catch(() => null);
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    const cleaned = text.trim().replace(/^"+|"+$/g, "").replace(/^```[\s\S]*?\n|```$/g, "").trim();
    // Strip dash separator lines if AI slips
    const noDashes = cleaned.split("\n").filter((l) => !/^-{3,}$/.test(l.trim())).join("\n").trim();
    return noDashes.length > 0 && noDashes.length < 700 ? noDashes : null;
  } catch {
    return null;
  }
}
