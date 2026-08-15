import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import { PanelLeftOpen, Search } from "lucide-react";
import { navigation, type NavEntry, type NavGroup } from "@/lib/nav";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { UserMenu } from "./UserMenu";

/**
 * Flyout shown when hovering a group in the collapsed rail, so sub-pages stay
 * reachable without expanding the sidebar first.
 */
function GroupFlyout({ group }: { group: NavGroup }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>();

  const isWithin =
    pathname.startsWith(group.match) ||
    (group.alsoMatch ?? []).some((prefix) => pathname.startsWith(prefix));

  /*
   * The rail scrolls, and a scroll container clips anything positioned outside
   * it — so the panel is portalled to the body and placed from the icon's rect.
   */
  const show = () => {
    window.clearTimeout(closeTimer.current);
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      const height = group.items.length * 32 + 40;
      setPosition({
        top: Math.min(rect.top, Math.max(8, window.innerHeight - height - 8)),
        left: rect.right + 6,
      });
    }
    setOpen(true);
  };
  // A short grace period lets the pointer cross the gap into the panel.
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const Icon = group.icon;

  return (
    <div
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <NavLink
        to={group.items[0].to}
        aria-label={group.label}
        aria-expanded={open}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          isWithin
            ? "bg-[var(--cr-hover)] text-fg"
            : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        )}
      >
        <Icon className="h-4 w-4" />
      </NavLink>

      {open &&
        createPortal(
          <div
            role="menu"
            aria-label={group.label}
            data-flyout={group.id}
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{ top: position.top, left: position.left }}
            className="fixed z-[80] w-[212px] animate-scale-in rounded-lg border border-line bg-shell p-1 shadow-pop"
          >
            <p className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-fg-faint">
              {group.label}
            </p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex h-8 items-center gap-2 rounded px-2 text-sm transition-colors",
                    isActive
                      ? "bg-[var(--cr-hover)] font-medium text-fg"
                      : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge && (
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium leading-4",
                      item.badge.tone === "brand"
                        ? "bg-brand-soft text-brand"
                        : "bg-[var(--cr-hover)] text-fg-muted",
                    )}
                  >
                    {item.badge.label}
                  </span>
                )}
              </NavLink>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function RailLink({ entry }: { entry: Extract<NavEntry, { kind: "link" }> }) {
  const Icon = entry.leaf.icon;
  return (
    <Tooltip label={entry.leaf.label}>
    <NavLink
      to={entry.leaf.to}
      end={entry.leaf.to === "/"}
      aria-label={entry.leaf.label}
      className={({ isActive }) =>
        cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          isActive
            ? "bg-[var(--cr-hover)] text-fg"
            : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        )
      }
    >
      {Icon && <Icon className="h-4 w-4" />}
    </NavLink>
    </Tooltip>
  );
}

/** Icon-only rail shown when the sidebar is collapsed. */
export function CollapsedRail({
  onSearch,
  onExpand,
}: {
  onSearch: () => void;
  onExpand: () => void;
}) {
  return (
    <aside className="hidden w-12 shrink-0 flex-col bg-shell md:flex">
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2.5">
      <Tooltip label="Expand sidebar">
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </Tooltip>
      <Tooltip label="Search">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search"
          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
        >
          <Search className="h-4 w-4" />
        </button>
      </Tooltip>
      <div className="my-0.5 h-px w-6 bg-line" />

      {navigation.map((entry) => {
        if (entry.kind === "divider")
          return <div key={entry.id} className="my-0.5 h-px w-6 bg-line" />;
        if (entry.kind === "link")
          return <RailLink key={entry.leaf.to} entry={entry} />;
        return <GroupFlyout key={entry.group.id} group={entry.group} />;
      })}

      </div>

      {/* Outside the scroll container so the popover is never clipped. */}
      <div className="shrink-0 pb-1">
        <UserMenu collapsed />
      </div>
    </aside>
  );
}
