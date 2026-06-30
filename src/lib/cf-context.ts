import { AsyncLocalStorage } from "node:async_hooks";

type WaitUntil = (promise: Promise<unknown>) => void;

export const cfStorage = new AsyncLocalStorage<{ waitUntil?: WaitUntil }>();

/**
 * Schedule a promise to run after the HTTP response is sent.
 * On Cloudflare Workers we use ctx.waitUntil so the worker isn't killed.
 * In other environments (dev, Node) we just fire-and-forget.
 */
export function runAfterResponse(promise: Promise<unknown>): void {
  const store = cfStorage.getStore();
  const wu = store?.waitUntil;
  if (typeof wu === "function") {
    try {
      wu(promise.catch((err) => {
        console.error("[runAfterResponse] background task error:", err);
      }));
      return;
    } catch {
      /* fall through to void */
    }
  }
  void promise.catch((err) => {
    console.error("[runAfterResponse] background task error:", err);
  });
}
