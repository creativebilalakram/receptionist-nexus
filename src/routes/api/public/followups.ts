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
        const maxFollowups = Math.max(1, Math.min(3, Number(url.searchParams.get("max_followups")) || 2));
        const repeatGapHours = Math.max(6, Math.min(168, Number(url.searchParams.get("repeat_gap_hours")) || 24));

        const now = Date.now();
        const idleSince = new Date(now - minIdleMin * 60_000).toISOString();
        const windowStart = new Date(now - windowHours * 60 * 60_000).toISOString();
        const repeatGapCutoff = new Date(now - repeatGapHours * 60 * 60_000).toISOString();

        let q = supabaseAdmin
          .from("conversations")
          .select("id, client_id, subscriber_id, first_name, phone, messages, qualification, lead_score, status, current_stage, last_message_at, manual_takeover, escalated, followup_sent_at, followup_count")
          .eq("manual_takeover", false)
          .eq("escalated", false)
          .not("status", "in", "(booked,lost)")
          .lte("last_message_at", idleSince)
          .gte("last_message_at", windowStart)
          .lt("followup_count", maxFollowups)
          .limit(100);
        if (!force) {
          // Either never followed up, OR last followup is older than repeat gap
          q = q.or(`followup_sent_at.is.null,followup_sent_at.lte.${repeatGapCutoff}`);
        }
        if (onlyPhone) q = q.eq("phone", onlyPhone);
        const { data: candidates, error } = await q;



        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const sent: Array<{ id: string; status: number }> = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const c of candidates ?? []) {
          const messages: Msg[] = Array.isArray(c.messages) ? (c.messages as unknown as Msg[]) : [];
          if (messages.length === 0) { skipped.push({ id: c.id, reason: "empty" }); continue; }

          // --- Fix 9: substance gate ---
          // A followup is only allowed if we have REAL context to reference.
          // "Hi" alone is not context — sending a personalized-sounding followup on
          // that would fabricate a discussion that never happened.
          const userMsgs = messages.filter((m) => m.role === "user");
          const substantiveUserMsgs = userMsgs.filter((m) => {
            const t = (m.content ?? "").trim();
            if (t.length < 15) return false; // very short = greeting/emoji/thanks
            // strip common greetings
            const stripped = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
            if (/^(hi|hey|hello|salam|assalam[uo]?\s?alaikum|aoa|yo|sup|thanks|thank\s?you|shukriya|ok|okay|k)\b/.test(stripped) && stripped.split(/\s+/).length <= 4) return false;
            return true;
          });
          const hasSubstance = substantiveUserMsgs.length > 0;
          const strongStage = ["qualify", "position", "invite", "close"].includes(String(c.current_stage ?? ""));
          const scored = (c.lead_score ?? 0) > 0;

          // Require at least ONE substantive user message. Score/stage alone is not
          // enough — those can get bumped by the bot's own logic without real signal.
          if (!hasSubstance) { skipped.push({ id: c.id, reason: "no_substance" }); continue; }
          if (!strongStage && !scored) { skipped.push({ id: c.id, reason: "not_interested" }); continue; }

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

          const cleanFirstName = sanitizeFirstName(c.first_name);
          const attemptNumber = (c.followup_count ?? 0) + 1;

          const followupRaw = await generateFollowup({
            client,
            firstName: cleanFirstName,
            messages,
            stage: c.current_stage,
            attempt: attemptNumber,
          });
          const followup = followupRaw ? dedupAgainstHistory(followupRaw, messages) : null;
          if (!followup) { skipped.push({ id: c.id, reason: "ai_failed_or_duplicate" }); continue; }

          // Send via ManyChat using the client-specific key if available
          const res = await sendWhatsAppText(c.subscriber_id, followup);
          if (!res.ok) {
            await supabaseAdmin.from("webhook_logs").insert({
              client_id: c.client_id,
              direction: "outbound",
              payload: { followup, subscriber_id: c.subscriber_id, error: res.error, attempt: attemptNumber } as any,
              status_code: res.status,
            });
            skipped.push({ id: c.id, reason: `send_${res.status}` });
            continue;
          }

          // Append to messages, mark followup_sent_at + bump count
          const newMessages = [
            ...messages,
            { role: "assistant" as const, content: followup, timestamp: new Date().toISOString() },
          ];
          await supabaseAdmin.from("conversations").update({
            messages: newMessages as any,
            followup_sent_at: new Date().toISOString(),
            followup_count: attemptNumber,
            last_message_at: new Date().toISOString(),
          }).eq("id", c.id);

          await supabaseAdmin.from("webhook_logs").insert({
            client_id: c.client_id,
            direction: "outbound",
            payload: { followup, subscriber_id: c.subscriber_id, kind: "auto_followup", attempt: attemptNumber } as any,
            status_code: res.status,
          });

          sent.push({ id: c.id, status: res.status });

        }

        return Response.json({ ok: true, checked: candidates?.length ?? 0, sent, skipped });
      },
    },
  },
});

function sanitizeFirstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = String(name).trim();
  if (!t) return null;
  // Unresolved ManyChat placeholders (e.g. "{{first_name}}", "First Name", "n/a")
  if (/[{}]/.test(t)) return null;
  if (/^(first[ _-]?name|full[ _-]?name|n\/?a|null|undefined|user)$/i.test(t)) return null;
  return t;
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

function dedupAgainstHistory(candidate: string, history: Msg[]): string | null {
  const cand = normalizeForCompare(candidate);
  if (!cand) return null;
  const lastAssistants = history.filter((m) => m.role === "assistant").slice(-3);
  for (const m of lastAssistants) {
    const prev = normalizeForCompare(m.content ?? "");
    if (!prev) continue;
    if (prev === cand) return null;
    // If ≥85% of candidate is a substring of a prior message, treat as duplicate
    if (prev.length > 20 && cand.length > 20 && (prev.includes(cand) || cand.includes(prev))) return null;
  }
  return candidate;
}

async function generateFollowup(args: {
  client: { business_name: string; niche: string | null; services: string | null; icp: string | null; tone_notes: string | null; faq: string | null; booking_link: string | null };
  firstName: string | null;
  messages: Msg[];
  stage: string | null;
  attempt: number;
}): Promise<string | null> {
  const aiKey = process.env.OPENAI_API_KEY;
  if (!aiKey) return null;
  const aiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Only include REAL messages the user actually typed. Never invent anything else.
  const trimmed = args.messages.slice(-12);
  const transcript = trimmed.map((m) =>
    `${m.role === "user" ? "USER" : "AI"}: ${(m.content ?? "").trim()}`
  ).join("\n");

  // Extract the user's own words verbatim so the model has an explicit
  // whitelist of what it's allowed to reference.
  const userUtterances = trimmed
    .filter((m) => m.role === "user")
    .map((m) => (m.content ?? "").trim())
    .filter((t) => t.length > 0);
  const userWordsBlock = userUtterances.length
    ? userUtterances.map((t, i) => `  [${i + 1}] "${t}"`).join("\n")
    : "  (none — the lead has not shared any real details yet)";

  const hasRealSubstance = userUtterances.some((t) => t.length >= 15);

  const attemptGuidance = args.attempt <= 1
    ? "This is the FIRST follow-up. Warm, curious, low pressure."
    : `This is follow-up #${args.attempt}. Take a DIFFERENT angle than any prior message — new hook, new question. Do NOT repeat earlier phrasing. Acknowledge time has passed, keep it light, no guilt-trip.`;

  const substanceGuidance = hasRealSubstance
    ? "You MAY reference specifics the user actually shared — but ONLY things that appear verbatim in USER MESSAGES above. Quote or paraphrase them exactly."
    : "The user has NOT shared any real details yet (only greetings). You MUST NOT invent a topic, business type, timeline, pain point, or anything they 'mentioned' — they mentioned nothing. Write a short, light re-open that acknowledges you're still around and asks ONE open, generic question inviting them to share what's on their mind. Do NOT pretend a prior discussion happened.";

  const system = `You are the WhatsApp receptionist for *${args.client.business_name}*. The lead went silent. Write ONE warm, human, personalized follow-up.

BUSINESS: ${args.client.business_name}${args.client.niche ? ` — ${args.client.niche}` : ""}
SERVICES: ${args.client.services ?? "(unspecified)"}
IDEAL CUSTOMER: ${args.client.icp ?? "(unspecified)"}
TONE: ${args.client.tone_notes ?? "friendly, professional, concise"}
LEAD NAME: ${args.firstName ?? "(unknown — do NOT invent one, do NOT write placeholders like 'First Name')"}
STAGE WHEN THEY DROPPED: ${args.stage ?? "open"}

${attemptGuidance}

USER MESSAGES (verbatim — the ONLY things they've actually said):
${userWordsBlock}

FULL TRANSCRIPT (for context — do not reference AI's own past claims as if they were the user's):
${transcript}

ANTI-FABRICATION: ${substanceGuidance}

RULES: mirror their language/script. 1–3 short lines. *bold* key words. No dashes/bullets/headings/numbered lists. End with ONE soft question. Never repeat a message they already received. Never say phrases like "as you mentioned", "regarding what you said about X", "circling back on your interest in Y" unless X/Y literally appears in USER MESSAGES above. Output ONLY the message text.`;


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
    let cleaned = text.trim().replace(/^"+|"+$/g, "").replace(/^```[\s\S]*?\n|```$/g, "").trim();
    // Strip dash separator lines if AI slips
    cleaned = cleaned.split("\n").filter((l) => !/^-{3,}$/.test(l.trim())).join("\n").trim();
    // Scrub unresolved placeholders that might leak into the reply
    cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, "").replace(/\s{2,}/g, " ").trim();
    return cleaned.length > 0 && cleaned.length < 700 ? cleaned : null;
  } catch {
    return null;
  }
}

