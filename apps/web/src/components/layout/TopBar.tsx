import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { buildCrumbs } from "@/lib/breadcrumbs";

const ACTIONS_SLOT = "cr-topbar-actions";

/**
 * Pages mount their top-bar controls through this portal so the header owns
 * layout while each page owns its own actions.
 */
export function TopBarActions({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById(ACTIONS_SLOT)), []);
  if (!host) return null;
  return createPortal(
    <ErrorBoundary compact label="Controls unavailable">
      {children}
    </ErrorBoundary>,
    host,
  );
}

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { pathname } = useLocation();
  const crumbs = buildCrumbs(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 bg-canvas/95 px-4 backdrop-blur">
      <Button
        size="icon-sm"
        variant="ghost"
        className="md:hidden"
        aria-label="Open navigation"
        onClick={onOpenMobileNav}
      >
        <Menu className="h-4 w-4" />
      </Button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
            {index > 0 && <span className="shrink-0 text-sm text-fg-faint">/</span>}
            {crumb.to && index < crumbs.length - 1 ? (
              <Link
                to={crumb.to}
                className="truncate text-sm text-fg-subtle transition-colors hover:text-fg"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={
                  index === crumbs.length - 1
                    ? "truncate text-sm font-medium text-fg"
                    : "truncate text-sm text-fg-subtle"
                }
              >
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div id={ACTIONS_SLOT} className="ml-auto flex items-center gap-2" />
    </header>
  );
}
