import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Placeholder block. The app fills these with a fine dot texture rather than a
 * sweeping shimmer, so they read as "shape known, content pending".
 */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      style={{
        backgroundImage:
          "radial-gradient(var(--cr-line-strong) 0.5px, transparent 0.5px)",
        backgroundSize: "4px 4px",
        ...style,
      }}
      className={cn("rounded-md bg-[var(--cr-hover)]", className)}
    />
  );
}

/**
 * Every page waits a beat before showing content so the skeleton is visible,
 * the way it is against the real API. Drop this once the backend is wired and
 * drive `loading` from the request instead.
 */
export function usePageLoad(ms = 550) {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return loading;
}

function Header({ action = true }: { action?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3.5 w-80" />
      </div>
      {action && <Skeleton className="h-8 w-28" />}
    </div>
  );
}

/** Stat tiles over chart panels — the analytics and security overviews. */
export function DashboardSkeleton({
  tiles = 4,
  panels = 4,
  wide = true,
}: {
  tiles?: number;
  panels?: number;
  wide?: boolean;
}) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <Header />
      <div className="grid grid-cols-2 gap-3 pt-2 lg:grid-cols-4">
        {Array.from({ length: tiles }, (_, index) => (
          <Skeleton key={index} className="h-[104px]" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: panels }, (_, index) => (
          <Skeleton key={index} className="h-[104px]" />
        ))}
      </div>
      {wide && <Skeleton className="h-[200px]" />}
    </div>
  );
}

/** Filter chips over a table — the listing pages. */
export function TableSkeleton({
  filters = 3,
  rows = 8,
  columns = 3,
}: {
  filters?: number;
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <Header />

      {filters > 0 && (
        <div className="flex flex-wrap gap-2 pt-2">
          {Array.from({ length: filters }, (_, index) => (
            <Skeleton key={index} className="h-8 w-24" />
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="grid gap-4 border-b border-line/60 px-3 py-3 last:border-b-0"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }, (_, column) => (
              <Skeleton key={column} className="h-3.5" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stacked setting cards — the form-shaped pages. */
export function FormSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <Header />
      <div className="space-y-3 pt-2">
        {Array.from({ length: cards }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-surface p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2.5 h-3 w-72" />
            <Skeleton className="mt-4 h-8 w-full max-w-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Kanban columns — Triage. */
export function BoardSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex gap-2" role="status" aria-label="Loading">
      {Array.from({ length: columns }, (_, index) => (
        <div
          key={index}
          className="flex min-w-[260px] flex-1 flex-col gap-2 rounded-lg border border-line bg-shell/50 p-2"
        >
          <Skeleton className="h-6 w-full" />
          {Array.from({ length: 3 - (index % 2) }, (_, card) => (
            <Skeleton key={card} className="h-[104px] w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
