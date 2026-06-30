/**
 * One-off admin endpoint: re-deliver the stored first AI reply for
 * conversations where the opener was generated but never reached the user
 * (delivery silently dropped). Auth via ?token=RESEND_ADMIN_TOKEN.
 *
 * Strategy:
 *  - Find conversations with exactly 2 messages (user opener + assistant reply)
 *  - Optional ?phone=+92... to target one number
 *  - Optional ?ids=uuid,uuid to target explicit conversation IDs
 *  - Optional ?dry=1 to preview without sending
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/resend-openers")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");
        if (!token || token !== process.env.RESEND_ADMIN_TOKEN) {
          return new Response("unauthorized", { status: 401 });
        }
        const dry = url.searchParams.get("dry") === "1";
        const phoneFilter = url.searchParams.get("phone");
        const idsParam = url.searchParams.get("ids");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { sendWhatsAppText } = await import("@/lib/manychat-send.server");

        let query = supabaseAdmin
          .from("conversations")
          .select("id, subscriber_id, phone, first_name, messages, created_at")
          .order("created_at", { ascending: false })
          .limit(200);

        if (idsParam) {
          query = query.in("id", idsParam.split(",").map((s) => s.trim()).filter(Boolean));
        } else if (phoneFilter) {
          query = query.eq("phone", phoneFilter);
        } else {
          // Last 14 days, exclude broken {{phone}} placeholders
          const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
          query = query.gte("created_at", since).not("phone", "like", "%{%");
        }

        const { data, error } = await query;
        if (error) return Response.json({ error: error.message }, { status: 500 });

        type Msg = { role: string; content: string };
        const candidates = (data ?? []).filter((c) => {
          const msgs = (c.messages as Msg[] | null) ?? [];
          if (msgs.length !== 2) return false;
          return msgs[0]?.role === "user" && msgs[1]?.role === "assistant";
        });

        const results: Array<{
          id: string;
          phone: string | null;
          subscriber_id: string;
          ok: boolean;
          status: number;
          error?: string;
        }> = [];

        for (const c of candidates) {
          const msgs = c.messages as Msg[];
          const reply = msgs[1]?.content ?? "";
          if (!reply.trim() || !c.subscriber_id) {
            results.push({
              id: c.id,
              phone: c.phone,
              subscriber_id: c.subscriber_id,
              ok: false,
              status: 0,
              error: "empty_reply_or_subscriber",
            });
            continue;
          }
          if (dry) {
            results.push({
              id: c.id,
              phone: c.phone,
              subscriber_id: c.subscriber_id,
              ok: true,
              status: 0,
              error: "dry_run",
            });
            continue;
          }
          const r = await sendWhatsAppText(c.subscriber_id, reply);
          results.push({
            id: c.id,
            phone: c.phone,
            subscriber_id: c.subscriber_id,
            ok: r.ok,
            status: r.status,
            error: r.ok ? undefined : r.error,
          });
          // small spacing between sends to be polite to ManyChat
          await new Promise((res) => setTimeout(res, 400));
        }

        return Response.json({
          dry,
          total_candidates: candidates.length,
          results,
        });
      },
    },
  },
});
