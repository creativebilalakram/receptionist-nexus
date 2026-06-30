// Cron-triggered: sends due appointment reminders via ManyChat Send API.
// Auth: requires header `apikey: <SUPABASE_PUBLISHABLE_KEY>`.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/booking-reminders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const now = new Date();
        const horizon = new Date(now.getTime() + 72 * 60 * 60_000).toISOString();

        const { data: appts } = await supabaseAdmin
          .from("appointments")
          .select("id, client_id, scheduled_at, contact_name, contact_phone, conversation_id, reminder_sent_at, second_reminder_sent_at, status, meeting_type_id")
          .eq("status", "scheduled")
          .lte("scheduled_at", horizon)
          .gte("scheduled_at", now.toISOString());

        const sent: Array<{ id: string; kind: string }> = [];
        for (const a of appts ?? []) {
          const { data: settings } = await supabaseAdmin.from("booking_settings")
            .select("*").eq("client_id", a.client_id).maybeSingle();
          if (!settings) continue;
          const { data: client } = await supabaseAdmin.from("clients")
            .select("business_name, timezone").eq("id", a.client_id).maybeSingle();
          const tz = client?.timezone || "UTC";

          const apiKey = settings.manychat_api_key;
          const startMs = new Date(a.scheduled_at).getTime();
          const hoursUntil = (startMs - now.getTime()) / 3_600_000;

          const tplVars = {
            "{business_name}": client?.business_name ?? "",
            "{time}": new Intl.DateTimeFormat("en-US", {
              timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
            }).format(new Date(a.scheduled_at)),
            "{date}": new Intl.DateTimeFormat("en-US", {
              timeZone: tz, weekday: "short", month: "short", day: "numeric",
            }).format(new Date(a.scheduled_at)),
            "{name}": a.contact_name ?? "",
          };
          const render = (tpl: string) =>
            Object.entries(tplVars).reduce((s, [k, v]) => s.split(k).join(String(v)), tpl);

          // First reminder
          if (!a.reminder_sent_at && hoursUntil <= settings.reminder_hours_before && hoursUntil > settings.second_reminder_hours_before) {
            const ok = await sendManychat(apiKey, a, render(settings.reminder_template));
            if (ok) {
              await supabaseAdmin.from("appointments").update({ reminder_sent_at: now.toISOString() }).eq("id", a.id);
              sent.push({ id: a.id, kind: "first" });
            }
          }
          // Second reminder
          if (!a.second_reminder_sent_at && hoursUntil <= settings.second_reminder_hours_before && hoursUntil > 0) {
            const ok = await sendManychat(apiKey, a, render(settings.reminder_template));
            if (ok) {
              await supabaseAdmin.from("appointments").update({ second_reminder_sent_at: now.toISOString() }).eq("id", a.id);
              sent.push({ id: a.id, kind: "second" });
            }
          }
        }

        return Response.json({ ok: true, sent });
      },
    },
  },
});

async function sendManychat(
  apiKey: string | null,
  appt: { conversation_id: string | null; client_id: string },
  message: string,
): Promise<boolean> {
  if (!apiKey || !appt.conversation_id) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: convo } = await supabaseAdmin.from("conversations")
    .select("subscriber_id").eq("id", appt.conversation_id).maybeSingle();
  if (!convo?.subscriber_id) return false;

  try {
    const resp = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        subscriber_id: convo.subscriber_id,
        data: { version: "v2", content: { messages: [{ type: "text", text: message }] } },
        message_tag: "CONFIRMED_EVENT_UPDATE",
      }),
    });
    await supabaseAdmin.from("webhook_logs").insert({
      client_id: appt.client_id, direction: "outbound",
      payload: { reminder: message, subscriber_id: convo.subscriber_id } as any,
      status_code: resp.status,
    });
    return resp.ok;
  } catch {
    return false;
  }
}
