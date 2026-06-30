/**
 * Retry helpers for outbound HTTP calls (AI Gateway, ManyChat Send API).
 *
 * Strategy:
 *   - Up to N attempts with exponential backoff + small jitter.
 *   - Retry on network errors, HTTP 408/425/429, and any 5xx.
 *   - Honor Retry-After header on 429/503 when present (capped).
 */

export type RetryOptions = {
  attempts?: number;       // total attempts including the first (default 3)
  baseMs?: number;         // initial backoff (default 400ms)
  maxMs?: number;          // upper bound per wait (default 4000ms)
  timeoutMs?: number;      // per-attempt timeout (default 15000ms)
  label?: string;          // for logs
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 8000);
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), 8000);
  return null;
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const label = opts.label ?? "retryFetch";

  let lastErr: unknown = null;

  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(t);
      if (resp.ok) return resp;
      if (i < attempts - 1 && isRetriableStatus(resp.status)) {
        const ra = parseRetryAfter(resp.headers.get("retry-after"));
        const backoff = Math.min(maxMs, baseMs * 2 ** i) + Math.floor(Math.random() * 200);
        const wait = ra ?? backoff;
        console.warn(`[${label}] attempt ${i + 1} status=${resp.status}, retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return resp; // non-retriable or final
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = Math.min(maxMs, baseMs * 2 ** i) + Math.floor(Math.random() * 200);
        console.warn(`[${label}] attempt ${i + 1} threw (${err instanceof Error ? err.message : String(err)}), retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`[${label}] exhausted retries`);
}
