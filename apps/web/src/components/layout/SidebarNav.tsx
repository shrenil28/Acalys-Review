import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import { navigation, type NavGroup, type NavLeaf } from "@/lib/nav";
import { cn } from "@/lib/utils";

function LeafLink({ leaf, nested }: { leaf: NavLeaf; nested?: boolean }) {
  const Icon = leaf.icon;
  return (
    <NavLink
      to={leaf.to}
      end={leaf.to === "/"}
      className={({ isActive }) =>
        cn(
          "group relative flex h-8 items-center gap-2 rounded px-2 text-sm transition-colors",
          isActive
            ? nested
              ? "font-medium text-brand"
              : "bg-[var(--cr-hover)] font-medium text-fg"
            : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Nested items mark the active row with the orange rail from the app. */}
          {nested && isActive && (
            <span className="absolute -left-[13.5px] inset-y-1 w-0.5 rounded-full bg-brand" />
          )}
          {Icon && <Icon className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{leaf.label}</span>
          {leaf.badge && (
            <span
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium leading-4",
                leaf.badge.tone === "brand"
                  ? "bg-brand-soft text-brand"
                  : "bg-[var(--cr-hover)] text-fg-muted",
              )}
            >
              {leaf.badge.label}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function Group({ group }: { group: NavGroup }) {
  const location = useLocation();
  const isWithin =
    location.pathname.startsWith(group.match) ||
    (group.alsoMatch ?? []).some((prefix) => location.pathname.startsWith(prefix));
  const [open, setOpen] = useState(isWithin);

  // Navigating into a group opens it, matching the app's sidebar behaviour.
  useEffect(() => {
    if (isWithin) setOpen(true);
  }, [isWithin]);

  const Icon = group.icon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm transition-colors",
          isWithin
            ? "bg-[var(--cr-hover)] font-medium text-fg"
            : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        {group.badge && (
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium leading-4",
              group.badge.tone === "brand"
                ? "bg-brand-soft text-brand"
                : "bg-[var(--cr-hover)] text-fg-muted",
            )}
          >
            {group.badge.label}
          </span>
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-[15px] mt-0.5 flex flex-col gap-0.5 border-l border-line pl-3">
            {group.items.map((leaf) => (
              <LeafLink key={leaf.to} leaf={leaf} nested />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Floating pill the app shows when the nav overflows — clicking it scrolls
 * the list rather than the page.
 */
function ScrollPill({
  direction,
  onClick,
}: {
  direction: "up" | "down";
  onClick: () => void;
}) {
  const Icon = direction === "up" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "up" ? "Scroll up" : "Scroll down"}
      className={cn(
        "absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-shell px-2.5 py-1 text-xs font-medium text-fg-muted shadow-pop transition-colors hover:text-fg",
        direction === "up" ? "top-1.5" : "bottom-1.5",
      )}
    >
      <Icon className="h-3 w-3" />
      View more
    </button>
  );
}

export function SidebarNav() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ up: false, down: false });

  const syncOverflow = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    setOverflow({
      up: node.scrollTop > 8,
      down: node.scrollTop + node.clientHeight < node.scrollHeight - 8,
    });
  }, []);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    // The viewport can stay the same size while expanding a group changes the
    // scrollable content height, so observe both boxes.
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(node);
    if (contentRef.current) observer.observe(contentRef.current);
    const frame = requestAnimationFrame(syncOverflow);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [syncOverflow]);

  const scrollBy = (direction: -1 | 1) => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollBy({
      top: direction * Math.max(180, node.clientHeight * 0.62),
      behavior: "smooth",
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {overflow.up && <ScrollPill direction="up" onClick={() => scrollBy(-1)} />}
      {overflow.down && (
        <ScrollPill direction="down" onClick={() => scrollBy(1)} />
      )}
      <div
        ref={scrollerRef}
        onScroll={syncOverflow}
        className="sidebar-nav-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div ref={contentRef}>
          <NavList />
        </div>
      </div>
    </div>
  );
}

function NavList() {
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-1">
      {navigation.map((entry) => {
        if (entry.kind === "divider")
          return <div key={entry.id} className="my-1.5 h-px w-full bg-line" />;
        if (entry.kind === "link")
          return <LeafLink key={entry.leaf.to} leaf={entry.leaf} />;
        return <Group key={entry.group.id} group={entry.group} />;
      })}

    </nav>
  );
}
