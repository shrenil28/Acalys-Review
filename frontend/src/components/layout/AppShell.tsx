import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsModal } from "./ShortcutsModal";
import { Sidebar } from "./Sidebar";
import { CollapsedRail } from "./CollapsedRail";
import { TopBar } from "./TopBar";

const COLLAPSE_KEY = "cr:sidebar-collapsed";

export function AppShell() {
  // The app remembers the sidebar state between visits.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "true",
  );

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      // "?" opens the shortcut sheet, but never while the user is typing.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "?" && !typing) {
        event.preventDefault();
        setShortcutsOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-full bg-shell">
      {collapsed ? (
        <CollapsedRail
          onSearch={() => setPaletteOpen(true)}
          onExpand={() => setCollapsed(false)}
        />
      ) : (
        <Sidebar
          className="hidden md:flex"
          onCollapse={() => setCollapsed(true)}
          onSearch={() => setPaletteOpen(true)}
        />
      )}

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 top-0 h-full animate-fade-in">
            <Sidebar
              onCollapse={() => setMobileOpen(false)}
              onSearch={() => {
                setMobileOpen(false);
                setPaletteOpen(true);
              }}
            />
          </div>
        </div>
      )}

      <div className="mt-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-2xl border-l border-t border-line bg-canvas">
        <TopBar onOpenMobileNav={() => setMobileOpen(true)} />

        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Keyed by route so navigating away clears a contained failure. */}
          <ErrorBoundary resetKey={pathname} label="This page could not be shown">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onExpandSidebar={() => setCollapsed(false)}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
