import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/AppShell";
import { listWebhookFailures } from "@/lib/data.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/failures")({
  head: () => ({ meta: [{ title: "Failures · Receptionist Engine" }] }),
  component: FailuresPage,
});

function FailuresPage() {
  const fetchFailures = useServerFn(listWebhookFailures);
  const qc = useQueryClient();
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["webhook-failures"],
    queryFn: () => fetchFailures(),
    refetchInterval: 15_000,
  });

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Webhook Failures
            </h1>
            <p className="text-sm text-muted-foreground">
              Last 100 inbound/outbound errors across your clients. Refreshes every 15s.
            </p>
          </div>
          <Button
            size="sm" variant="outline"
            onClick={() => qc.invalidateQueries({ queryKey: ["webhook-failures"] })}
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : !data || data.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">
            No failures in the recent window. 🎉
          </Card>
        ) : (
          <div className="space-y-2">
            {data.map((r) => {
              const errSummary = r.error
                ?? (typeof r.payload === "object" && r.payload && "manychat_send_error" in (r.payload as object)
                  ? String((r.payload as Record<string, unknown>).manychat_send_error ?? "")
                  : null);
              return (
                <Card key={r.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={r.direction === "outbound" ? "default" : "secondary"} className="font-mono">
                      {r.direction}
                    </Badge>
                    <Badge variant="destructive" className="font-mono">
                      {r.status_code ?? "—"}
                    </Badge>
                    <span className="font-medium">{r.client_name}</span>
                    <span className="ml-auto font-mono text-muted-foreground">
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  {errSummary && (
                    <div className="mt-2 font-mono text-xs text-destructive break-words">
                      {errSummary}
                    </div>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">payload / response</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-snug">
{JSON.stringify({ payload: r.payload, response: r.response }, null, 2)}
                    </pre>
                  </details>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
