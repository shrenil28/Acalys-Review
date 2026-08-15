import type { ReactNode } from "react";
import { Info, MoreHorizontal } from "lucide-react";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";

/**
 * Grafana-style panel. Every analytics tile in Acalys is one of these:
 * a hairline-bordered card with a small title bar and a hover-revealed menu.
 */
export function Panel({
  title,
  description,
  info,
  children,
  className,
  bodyClassName,
  actions,
}: {
  title: string;
  description?: string;
  /** Tooltip behind the ⓘ in the panel header. */
  info?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "group/panel flex min-w-0 flex-col rounded-lg border border-line bg-surface shadow-card",
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-3">
        <h2
          title={title}
          className="min-w-0 flex-1 truncate text-xs font-medium text-fg-muted"
        >
          {title}
        </h2>
        {description && (
          <span className="hidden shrink-0 text-2xs text-fg-faint sm:inline">
            {description}
          </span>
        )}
        {info && (
          <span title={info} aria-label={info} className="inline-flex shrink-0">
            <Info className="h-3 w-3 text-fg-faint" />
          </span>
        )}
        {actions}
        <Popover
          align="end"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={`${title} panel menu`}
              className="rounded p-0.5 text-fg-faint opacity-0 transition-opacity hover:text-fg-muted focus-visible:opacity-100 group-hover/panel:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={close}>View</MenuItem>
              <MenuItem onClick={close}>Edit</MenuItem>
              <MenuItem onClick={close}>Share</MenuItem>
              <MenuItem onClick={close}>Export CSV</MenuItem>
            </>
          )}
        </Popover>
      </header>
      <div className={cn("min-h-0 flex-1 px-3 pb-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Single big number, the "stat" panel type. */
export function StatPanel({
  title,
  value,
  unit,
  delta,
  tone = "brand",
  footer,
  className,
}: {
  title: string;
  value: string | number;
  unit?: string;
  delta?: { value: string; direction: "up" | "down" | "flat" };
  tone?: "brand" | "ok" | "danger" | "info" | "purple" | "neutral";
  footer?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    brand: "text-brand",
    ok: "text-ok",
    danger: "text-danger",
    info: "text-info",
    purple: "text-purple",
    neutral: "text-fg",
  }[tone];

  return (
    <Panel title={title} className={className} bodyClassName="flex items-center">
      <div className="w-full">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("text-[32px] font-semibold leading-none tabular-nums", toneClass)}>
            {value}
          </span>
          {unit && <span className="text-sm text-fg-subtle">{unit}</span>}
        </div>
        {delta && (
          <p
            className={cn(
              "mt-2 text-xs tabular-nums",
              delta.direction === "up"
                ? "text-ok"
                : delta.direction === "down"
                  ? "text-danger"
                  : "text-fg-subtle",
            )}
          >
            {delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→"}{" "}
            {delta.value}
          </p>
        )}
        {footer && <div className="mt-2 text-xs text-fg-subtle">{footer}</div>}
      </div>
    </Panel>
  );
}

export function NoData({ label = "No data" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-fg-subtle">
      {label}
    </div>
  );
}


/**
 * Panel holding two or more figures side by side — "Total / New",
 * "PR Coverage / Times Applied". Each segment highlights on hover, the way the
 * app lets you focus one figure within a tile.
 */
export function MultiStatPanel({
  title,
  info,
  stats,
  className,
}: {
  title: string;
  info?: string;
  stats: { label: string; value: string | number; unit?: string; tone?: string }[];
  className?: string;
}) {
  return (
    <Panel title={title} info={info} className={className} bodyClassName="p-0 pb-0">
      <div className="flex h-full items-stretch">
        {stats.map((stat) => (
          <div
            key={stat.label}
            tabIndex={0}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-transparent px-3 py-6",
              "transition-colors hover:border-fg-subtle focus-visible:border-fg-subtle",
            )}
          >
            <span className="text-xs text-fg-muted">{stat.label}</span>
            <span className="flex items-baseline gap-0.5">
              <span className="text-[34px] font-semibold leading-none tabular-nums text-fg">
                {stat.value}
              </span>
              {stat.unit && (
                <span className="text-lg text-fg-subtle">{stat.unit}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
