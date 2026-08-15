import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-line", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            "relative flex h-9 items-center gap-2 px-3 text-sm transition-colors",
            tab.value === value
              ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand"
              : "text-fg-subtle hover:text-fg-muted",
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Left rail used by the dashboards and settings screens. The app renders this
 * as a self-contained card rather than a bordered column, so it reads as a
 * panel sitting on the canvas next to the content.
 */
export function ViewRail({
  items,
  ariaLabel = "Dashboard views",
  className,
}: {
  items: { label: string; to: string }[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "hidden w-[250px] shrink-0 self-start p-4 lg:block",
        "sticky top-0",
        className,
      )}
    >
      <nav
        aria-label={ariaLabel}
        className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-2"
      >
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) =>
              cn(
                "flex h-9 items-center rounded-md px-3 text-sm transition-colors",
                isActive
                  ? "bg-[var(--cr-hover)] font-medium text-fg"
                  : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
