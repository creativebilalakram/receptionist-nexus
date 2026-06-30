/**
 * ManyChat WhatsApp Send Content API helper.
 * Used to push messages to a subscriber outside the synchronous webhook reply
 * (necessary because ManyChat External Request enforces a ~10s hard timeout
 * while our AI + booking tool loop can take 10–20s).
 *
 * Docs: https://api.manychat.com/swagger#/Sending
 *   POST https://api.manychat.com/fb/sending/sendContent
 *   Authorization: Bearer <MANYCHAT_API_KEY>
 *
 * For WhatsApp subscribers we use content.type = "whatsapp".
 */

export type SendResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; body?: unknown };

const ENDPOINT = "https://api.manychat.com/fb/sending/sendContent";

export async function sendWhatsAppText(
  subscriberId: string,
  text: string,
  opts?: { messageTag?: string },
): Promise<SendResult> {
  const apiKey = process.env.MANYCHAT_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 0, error: "missing_MANYCHAT_API_KEY" };
  }
  if (!text || !text.trim()) {
    return { ok: false, status: 0, error: "empty_text" };
  }

  const numericSubscriberId = Number(subscriberId);
  const body: Record<string, unknown> = {
    // ManyChat API schema expects an integer here. Full Contact Data sends it
    // as a string, so normalize before pushing the WhatsApp reply.
    subscriber_id: Number.isFinite(numericSubscriberId) ? numericSubscriberId : subscriberId,
    data: {
      version: "v2",
      content: {
        type: "whatsapp",
        messages: [{ type: "text", text: text.trim() }],
      },
    },
  };

  // Do NOT send a default message_tag. ManyChat currently rejects it with:
  // "Message tags are no longer supported for Facebook Messenger." WhatsApp
  // in-window replies succeed without it; only include one if explicitly set.
  if (opts?.messageTag) body.message_tag = opts.messageTag;

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: `manychat_${resp.status}`,
        body: json,
      };
    }
    return { ok: true, status: resp.status, body: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
