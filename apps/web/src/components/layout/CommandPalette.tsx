import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  Gift,
  Key,
  LayoutGrid,
  LogOut,
  Menu,
  MonitorSmartphone,
  Plug,
  Search,
  Shield,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { navigation } from "@/lib/nav";
import { cn } from "@/lib/utils";

type Group =
  | "Configuration Settings"
  | "Navigation"
  | "Settings"
  | "Account"
  | "Help & Support"
  | "Quick Actions"
  | "More Navigation"
  | "More Settings";

const groupOrder: Group[] = [
  "Configuration Settings",
  "Navigation",
  "Settings",
  "Account",
  "Help & Support",
  "Quick Actions",
  "More Navigation",
  "More Settings",
];

interface Command {
  id: string;
  label: string;
  group: Group;
  /** Shown under the label for configuration entries (the settings section). */
  context?: string;
  icon?: LucideIcon;
  to?: string;
  href?: string;
  action?: "expand-sidebar" | "switch-theme";
}

/** Individual settings, addressable straight from the palette. */
const configCommands: Command[] = [
  { id: "cfg-early-access", label: "Early access", group: "Configuration Settings", context: "General", to: "/organization/settings/general" },
  { id: "cfg-language", label: "Language", group: "Configuration Settings", context: "General", to: "/organization/settings/general" },
  { id: "cfg-summary", label: "High level summary", group: "Configuration Settings", context: "Summary", to: "/organization/settings/review/summary" },
  { id: "cfg-walkthrough", label: "Walkthrough", group: "Configuration Settings", context: "Walkthrough", to: "/organization/settings/review/walkthrough" },
  { id: "cfg-diagrams", label: "Sequence diagrams", group: "Configuration Settings", context: "Walkthrough", to: "/organization/settings/review/walkthrough" },
  { id: "cfg-profile", label: "Review profile", group: "Configuration Settings", context: "Behavior", to: "/organization/settings/review/behavior" },
  { id: "cfg-auto-review", label: "Automatic review", group: "Configuration Settings", context: "Behavior", to: "/organization/settings/review/behavior" },
  { id: "cfg-poem", label: "Poem", group: "Configuration Settings", context: "Fun", to: "/organization/settings/fun" },
];

const staticCommands: Command[] = [
  { id: "nav-repos", label: "Go to Repositories", group: "Navigation", icon: Boxes, to: "/review/repositories" },
  { id: "nav-dashboard", label: "Go to Dashboard", group: "Navigation", icon: LayoutGrid, to: "/analytics/pr-reviews" },

  { id: "set-org", label: "Go to Organization Settings", group: "Settings", icon: Building2, to: "/organization/settings/general" },

  { id: "acc-profile", label: "Go to Profile", group: "Account", icon: Users, to: "/settings" },
  { id: "acc-logout", label: "Logout", group: "Account", icon: LogOut, to: "/login" },

  { id: "help-docs", label: "Documentation", group: "Help & Support", icon: BookOpen, href: "https://docs.coderabbit.ai" },
  { id: "help-refer", label: "Refer and Earn", group: "Help & Support", icon: Gift, href: "https://coderabbit.ai/referral" },

  { id: "qa-sidebar", label: "Expand Sidebar", group: "Quick Actions", icon: Menu, action: "expand-sidebar" },
  { id: "qa-theme", label: "Switch Theme", group: "Quick Actions", icon: MonitorSmartphone, action: "switch-theme" },

  { id: "more-integrations", label: "Go to Integrations", group: "More Navigation", icon: Plug, to: "/integrations" },
  { id: "more-reports", label: "Go to Reports", group: "More Navigation", icon: BarChart3, to: "/reports" },
  { id: "more-learnings", label: "Go to Learnings", group: "More Navigation", icon: BookOpen, to: "/review/learnings" },
  { id: "more-triage", label: "Go to Triage", group: "More Navigation", icon: Sparkles, to: "/review/triage" },
  { id: "more-security", label: "Go to Security", group: "More Navigation", icon: Shield, to: "/security/overview" },

  { id: "set-keys", label: "Go to API Keys", group: "More Settings", icon: Key, to: "/settings/api-keys" },
  { id: "set-team", label: "Go to Team Management", group: "More Settings", icon: Users, to: "/settings/team" },
];

/** Everything else in the sidebar stays reachable, ranked last. */
const pageCommands: Command[] = navigation.flatMap((entry) => {
  if (entry.kind !== "group") return [];
  return entry.group.items.map((item) => ({
    id: `page-${item.to}`,
    label: `Go to ${item.label}`,
    group: "More Navigation",
    context: entry.group.label,
    to: item.to,
  }));
});

const all = [...configCommands, ...staticCommands, ...pageCommands];

export function CommandPalette({
  open,
  onClose,
  onExpandSidebar,
}: {
  open: boolean;
  onClose: () => void;
  onExpandSidebar: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const matched = all.filter((command) => {
      if (seen.has(command.label)) return false;
      seen.add(command.label);
      if (!needle) return true;
      return (
        command.label.toLowerCase().includes(needle) ||
        command.context?.toLowerCase().includes(needle)
      );
    });
    return groupOrder.flatMap((group) =>
      matched.filter((command) => command.group === group),
    );
  }, [query]);

  const run = (command: Command) => {
    if (command.action === "expand-sidebar") onExpandSidebar();
    else if (command.action === "switch-theme") {
      const dark = document.documentElement.classList.toggle("dark");
      localStorage.setItem("cr:theme", dark ? "dark" : "light");
    }
    else if (command.href) window.open(command.href, "_blank", "noreferrer");
    else if (command.to) navigate(command.to);
    onClose();
  };

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((value) => Math.min(value + 1, results.length - 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((value) => Math.max(value - 1, 0));
      }
      if (event.key === "Enter" && results[cursor]) run(results[cursor]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, results, cursor]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  let rendered = -1;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center p-4 pt-[14vh]">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Acalys"
        className="relative z-10 w-full max-w-[640px] animate-scale-in overflow-hidden rounded-lg border border-line bg-shell shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search className="h-4 w-4 shrink-0 text-fg-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            className="h-11 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>

        <div ref={listRef} className="max-h-[340px] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-fg-subtle">
              No matches. Try a setting name, a repository, or a page.
            </p>
          ) : (
            groupOrder.map((group) => {
              const items = results.filter((command) => command.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="mb-1 last:mb-0">
                  <p className="px-2 py-1.5 text-xs text-fg-subtle">{group}</p>
                  {items.map((command) => {
                    rendered += 1;
                    const index = rendered;
                    const Icon = command.icon;
                    const active = index === cursor;
                    return (
                      <button
                        key={command.id}
                        type="button"
                        data-active={active}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => run(command)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors",
                          active && "bg-[var(--cr-hover)]",
                        )}
                      >
                        {Icon && (
                          <Icon className="h-4 w-4 shrink-0 text-fg-subtle" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-fg">
                            {command.label}
                          </span>
                          {command.context && (
                            <span className="block truncate text-xs text-fg-subtle">
                              {command.context}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
