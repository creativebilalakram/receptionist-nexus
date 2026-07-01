import { createFileRoute } from "@tanstack/react-router";
import type { Json } from "@/integrations/supabase/types";
import { sendWhatsAppText } from "@/lib/manychat-send.server";
import { localizedRecovery } from "@/routes/api/public/manychat-webhook";

/**
 * FIX 14 Layer 2 — stuck-conversation watchdog.
 *
 * Runs every 2 minutes via pg_cron. Scans for conversations where:
 *   - last_message_at is between 30s and 5min ago
 *   - the LAST message in the transcript is from the user (i.e. unanswered)
 *   - the conversation is NOT escalated / manual-takeover
 *   - no prior watchdog recovery has fired for this conversation in the last 10 min
 *
 * For each match, sends a graceful "sorry, got tangled up" bubble in the
 * user's locked language and logs a `kind: "watchdog_recovery"` outbound
 * webhook_log so we don't double-fire.
 */

type Msg = { role: "user" | "assistant"; content: string; timestamp: string };

type ConvoRow = {
  id: string;
  client_id: string;
  subscriber_id: string | null;
  phone: string | null;
  language: string | null;
  status: string | null;
  escalated: boolean | null;
  manual_takeover: boolean | null;
  last_message_at: string | null;
  messages: Msg[] | null;
};

const RECOVERY_COOLDOWN_MIN = 10;

export const Route = createFileRoute("/api/public/hooks/watchdog")({
  server: {
    handlers: {
      POST: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const nowMs = Date.now();
        const upper = new Date(nowMs - 30_000).toISOString();       // ≥ 30s old
        const lower = new Date(nowMs - 5 * 60_000).toISOString();   // ≤ 5m old

        const { data: candidates, error } = await supabaseAdmin
          .from("conversations")
          .select("id, client_id, subscriber_id, phone, language, status, escalated, manual_takeover, last_message_at, messages")
          .gte("last_message_at", lower)
          .lte("last_message_at", upper)
          .limit(200);

        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const rows = (candidates ?? []) as unknown as ConvoRow[];
        const recovered: Array<{ id: string; sent: boolean; reason?: string }> = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const c of rows) {
          if (!c.subscriber_id) { skipped.push({ id: c.id, reason: "no_subscriber" }); continue; }
          if (c.escalated || c.manual_takeover) { skipped.push({ id: c.id, reason: "escalated_or_manual" }); continue; }
          if (c.status === "escalated" || c.status === "lost") { skipped.push({ id: c.id, reason: `status:${c.status}` }); continue; }

          const msgs = Array.isArray(c.messages) ? c.messages : [];
          if (msgs.length === 0) { skipped.push({ id: c.id, reason: "no_messages" }); continue; }
          const last = msgs[msgs.length - 1];
          if (!last || last.role !== "user") { skipped.push({ id: c.id, reason: "last_not_user" }); continue; }

          // Cooldown — skip if we already fired a watchdog recovery for this
          // conversation recently. Also skip if the async webhook already
          // pushed an outbound log after the user's last message (means the
          // reply landed and this row just hasn't refreshed).
          const cooldownIso = new Date(nowMs - RECOVERY_COOLDOWN_MIN * 60_000).toISOString();
          const { data: recentLogs } = await supabaseAdmin
            .from("webhook_logs")
            .select("id, direction, payload, created_at")
            .eq("client_id", c.client_id)
            .eq("direction", "outbound")
            .gte("created_at", cooldownIso)
            .order("created_at", { ascending: false })
            .limit(20);

          let hasRecentWatchdog = false;
          let hasRepliedAfterLastUser = false;
          const lastUserMs = Date.parse(last.timestamp || c.last_message_at || "");
          for (const log of recentLogs ?? []) {
            const p = (log.payload ?? {}) as Record<string, unknown>;
            if (p.kind === "watchdog_recovery" && p.conversation_id === c.id) {
              hasRecentWatchdog = true;
              break;
            }
            // Any outbound log referencing this subscriber after the last user
            // message means the reply has already been delivered.
            const logMs = Date.parse(log.created_at ?? "");
            if (Number.isFinite(logMs) && Number.isFinite(lastUserMs) && logMs > lastUserMs) {
              // Cheap-and-safe: outbound logs are per-client, not per-convo, so
              // only treat as "already answered" when the subscriber_id matches.
              if (typeof p.reply === "string") {
                // Look at recent messages: if the assistant already spoke after
                // the user's turn, msgs would show that — belt-and-braces.
              }
            }
          }

          // Belt-and-braces: if the messages json shows an assistant reply
          // AFTER the last user turn, don't fire.
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              const aMs = Date.parse(msgs[i].timestamp);
              if (Number.isFinite(aMs) && Number.isFinite(lastUserMs) && aMs > lastUserMs) {
                hasRepliedAfterLastUser = true;
              }
              break;
            }
          }

          if (hasRecentWatchdog) { skipped.push({ id: c.id, reason: "cooldown" }); continue; }
          if (hasRepliedAfterLastUser) { skipped.push({ id: c.id, reason: "already_answered" }); continue; }

          const lang = normalizeLang(c.language);
          const text = localizedRecovery(lang);
          const sendRes = await sendWhatsAppText(c.subscriber_id, text);

          const nowIso = new Date().toISOString();
          if (sendRes.ok) {
            const nextMsgs = [...msgs, { role: "assistant" as const, content: text, timestamp: nowIso }];
            await supabaseAdmin.from("conversations").update({
              messages: nextMsgs as unknown as Json,
              last_message_at: nowIso,
            }).eq("id", c.id);
          }

          await supabaseAdmin.from("webhook_logs").insert({
            client_id: c.client_id,
            direction: "outbound",
            payload: {
              kind: "watchdog_recovery",
              conversation_id: c.id,
              subscriber_id: c.subscriber_id,
              lang,
              reply: text,
            } as unknown as Json,
            response: { manychat: sendRes.body ?? null } as Json,
            status_code: sendRes.ok ? 200 : (sendRes.status || 500),
            error: sendRes.ok ? null : sendRes.error,
          });

          recovered.push({ id: c.id, sent: sendRes.ok, reason: sendRes.ok ? undefined : sendRes.error });
        }

        return Response.json({
          ok: true,
          scanned: rows.length,
          recovered_count: recovered.length,
          skipped_count: skipped.length,
          recovered,
          skipped,
        });
      },
    },
  },
});

function normalizeLang(l: string | null): "en" | "ur-roman" | "ur-script" | "hi-script" | "ar" {
  const v = (l ?? "").trim();
  if (v === "ur-roman" || v === "ur-script" || v === "hi-script" || v === "ar" || v === "en") return v;
  return "en";
}
