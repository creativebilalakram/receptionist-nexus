import { cn } from "@/lib/utils";
import { statusClass } from "@/lib/format";

export function StatusPill({ status, className }: { status: string | null | undefined; className?: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
      statusClass(status),
      className,
    )}>
      {(status ?? "idle").replace("_", " ")}
    </span>
  );
}
