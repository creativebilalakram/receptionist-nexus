import { formatDistanceToNow, format } from "date-fns";

export function relativeTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  try {
    return format(new Date(date), "MMM d, yyyy · h:mm a");
  } catch {
    return "—";
  }
}

export const STATUS_TONE: Record<string, string> = {
  active: "bg-primary/15 text-primary border-primary/30",
  qualified: "bg-info/15 text-info border-info/30",
  booked: "bg-success/15 text-success border-success/30",
  lost: "bg-destructive/10 text-destructive border-destructive/25",
  idle: "bg-muted text-muted-foreground border-border",
  pending: "bg-warning/15 text-warning border-warning/30",
  confirmed: "bg-success/15 text-success border-success/30",
  completed: "bg-muted text-muted-foreground border-border",
  no_show: "bg-destructive/10 text-destructive border-destructive/25",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export function statusClass(status: string | null | undefined): string {
  return STATUS_TONE[status ?? "idle"] ?? STATUS_TONE.idle;
}
