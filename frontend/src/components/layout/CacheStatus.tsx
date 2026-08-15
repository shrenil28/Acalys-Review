import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

function label(from: number, now: number) {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * `Last updated … Cached ⟳ Refresh` cluster the account pages mount into the
 * top bar. Refresh is local only — there is no server to re-query yet.
 */
export function CacheStatus({
  initialAgeMs = 8 * 60 * 60 * 1000,
  onRefresh,
}: {
  initialAgeMs?: number;
  onRefresh?: () => void;
}) {
  const [updatedAt, setUpdatedAt] = useState(() => Date.now() - initialAgeMs);
  const [now, setNow] = useState(() => Date.now());
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!spinning) return;
    const timer = window.setTimeout(() => setSpinning(false), 600);
    return () => window.clearTimeout(timer);
  }, [spinning]);

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-fg-subtle sm:inline">
        Last updated {label(updatedAt, now)}
      </span>
      <span className="rounded bg-brand-soft px-1.5 py-0.5 text-2xs font-medium text-brand">
        Cached
      </span>
      <button
        type="button"
        onClick={() => {
          setUpdatedAt(Date.now());
          setNow(Date.now());
          setSpinning(true);
          onRefresh?.();
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
      >
        <RefreshCw className={cn("h-3.5 w-3.5 text-brand", spinning && "animate-spin")} />
        Refresh
      </button>
    </div>
  );
}
