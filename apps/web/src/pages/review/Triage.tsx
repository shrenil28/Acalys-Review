import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronLeft, MessageSquare, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Misc";
import { TopBarActions } from "@/components/layout/TopBar";
import { priorityOrder, triagePrs, type Priority, type TriagePr } from "@/data/review";
import { cn } from "@/lib/utils";
import { compare } from "./ordering";
import {
  DisplayMenu,
  FilterMenu,
  defaultDisplay,
  type DisplayState,
  type FacetKey,
  type Facets,
  type GroupKey,
} from "./TriageControls";

/** View slugs match the app's `?view=` parameter so links are shareable. */
const views = [
  { slug: "my_review_inbox", label: "Needs my review" },
  { slug: "authored_by_me", label: "Authored by me" },
  { slug: "all_reviews", label: "All reviews" },
  { slug: "safe_to_close", label: "Safe to close" },
] as const;

type ViewSlug = (typeof views)[number]["slug"];

const priorityTone: Record<
  Priority,
  "danger" | "warning" | "info" | "success" | "neutral"
> = {
  P1: "danger",
  P2: "warning",
  P3: "info",
  "Safe to close": "success",
  "No priority": "neutral",
};

const reviewStateTone = {
  "Needs review": "warning",
  "Changes requested": "danger",
  Approved: "success",
  Draft: "neutral",
} as const;

const riskTone = { High: "danger", Medium: "warning", Low: "success" } as const;

const severityTone = {
  Critical: "danger",
  High: "danger",
  Medium: "warning",
  Low: "info",
  None: "neutral",
} as const;

function matchesView(pr: TriagePr, view: ViewSlug) {
  if (view === "my_review_inbox") return pr.needsMyReview;
  if (view === "authored_by_me") return pr.authoredByMe;
  if (view === "safe_to_close") return pr.priority === "Safe to close";
  return true;
}

/** Values a card can be grouped by, in the order columns should appear. */
function groupValue(pr: TriagePr, key: GroupKey): string {
  if (key === "priority") return pr.priority;
  if (key === "repo") return pr.repo;
  if (key === "author") return pr.author;
  if (key === "reviewState") return pr.reviewState;
  if (key === "changeType") return pr.changeType;
  return pr.risk;
}

function groupOrderFor(key: GroupKey, rows: TriagePr[]): string[] {
  if (key === "priority") return priorityOrder;
  if (key === "reviewState")
    return ["Needs review", "Changes requested", "Approved", "Draft"];
  if (key === "risk") return ["High", "Medium", "Low"];
  return [...new Set(rows.map((pr) => groupValue(pr, key)))].sort();
}

/** Illustration the app shows for an empty group. */
function EmptyBoardArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 76" aria-hidden className={cn("text-[var(--cr-line-strong)]", className)} fill="none">
      <rect x="10" y="6" width="52" height="62" rx="5" className="stroke-current" strokeWidth="2" />
      <rect x="24" y="14" width="44" height="54" rx="5" className="fill-[var(--cr-surface)] stroke-current" strokeWidth="2" />
      <path d="M33 30h26M33 40h26M33 50h16" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
      <circle cx="72" cy="56" r="13" className="fill-[var(--cr-surface)] stroke-current" strokeWidth="2" />
      <path d="m66.5 56 4 4 7.5-8" className="stroke-[var(--cr-brand)]" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PrCard({ pr, display }: { pr: TriagePr; display: DisplayState }) {
  const has = (key: string) => display.properties.includes(key as never);

  return (
    <article className="rounded-md border border-line bg-surface p-3 shadow-card transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm leading-snug text-fg">{pr.title}</p>
        {has("priority") && (
          <Badge tone={priorityTone[pr.priority]} className="shrink-0">
            {pr.priority}
          </Badge>
        )}
      </div>

      <p className="mt-1 font-mono text-2xs text-fg-subtle">
        {pr.repo} #{pr.number}
      </p>

      {has("summary") && (
        <p className="mt-2 text-xs leading-relaxed text-fg-subtle">{pr.summary}</p>
      )}

      {has("reviewGuidance") && (
        <p className="mt-2 rounded border-l-2 border-brand/50 bg-[var(--cr-hover)] py-1.5 pl-2 pr-2 text-xs leading-relaxed text-fg-muted">
          {pr.reviewGuidance}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={reviewStateTone[pr.reviewState]}>{pr.reviewState}</Badge>
        {has("changeType") && <Badge tone="outline">{pr.changeType}</Badge>}
        {has("risk") && <Badge tone={riskTone[pr.risk]}>Risk: {pr.risk}</Badge>}
        {has("securityRisk") && (
          <Badge tone={riskTone[pr.securityRisk]}>Security: {pr.securityRisk}</Badge>
        )}
        {has("issueSeverity") && pr.issueSeverity !== "None" && (
          <Badge tone={severityTone[pr.issueSeverity]}>{pr.issueSeverity}</Badge>
        )}
        {has("blastRadius") && <Badge tone="outline">{pr.blastRadius}% blast</Badge>}
        {has("reviewEffort") && (
          <Badge tone="outline">~{pr.reviewEffort}m review</Badge>
        )}
        {pr.labels.map((label) => (
          <Badge key={label} tone="outline">
            {label}
          </Badge>
        ))}
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-fg-subtle">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={pr.author} size={18} />
          <span className="truncate">{pr.author}</span>
          {has("reviewers") && pr.reviewers.length > 0 && (
            <>
              <span className="text-fg-faint">→</span>
              {pr.reviewers.map((reviewer) => (
                <Avatar key={reviewer} name={reviewer} size={16} />
              ))}
            </>
          )}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="flex items-center gap-1 tabular-nums">
            <MessageSquare className="h-3 w-3" />
            {pr.comments}
          </span>
          <span className="tabular-nums text-ok">+{pr.additions}</span>
          <span className="tabular-nums text-danger">−{pr.deletions}</span>
          {has("lastActivity") && <span>{pr.updatedAt}</span>}
        </span>
      </footer>
    </article>
  );
}

export function TriagePage() {
  const [params, setParams] = useSearchParams();
  const [display, setDisplay] = useState<DisplayState>(defaultDisplay);
  const [facets, setFacets] = useState<Facets>({});
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const view = (views.find((entry) => entry.slug === params.get("view"))?.slug ??
    "authored_by_me");
  const query = params.get("q") ?? "";

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const facetOptions = useMemo(
    () =>
      ({
        repo: [...new Set(triagePrs.map((pr) => pr.repo))].sort(),
        author: [...new Set(triagePrs.map((pr) => pr.author))].sort(),
        reviewers: [...new Set(triagePrs.flatMap((pr) => pr.reviewers))].sort(),
        priority: priorityOrder,
        reviewGuidance: ["Has guidance", "No guidance"],
        risk: ["High", "Medium", "Low"],
        securityRisk: ["High", "Medium", "Low"],
        reviewState: ["Needs review", "Changes requested", "Approved", "Draft"],
        changeType: [...new Set(triagePrs.map((pr) => pr.changeType))].sort(),
      }),
    [],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return triagePrs
      .filter((pr) => {
        if (!matchesView(pr, view)) return false;
        if (
          needle &&
          !(
            pr.title.toLowerCase().includes(needle) ||
            pr.repo.toLowerCase().includes(needle) ||
            pr.author.toLowerCase().includes(needle) ||
            pr.summary.toLowerCase().includes(needle)
          )
        )
          return false;

        for (const [key, values] of Object.entries(facets)) {
          if (!values?.length) continue;
          const facet = key as FacetKey;
          if (facet === "reviewers") {
            if (!pr.reviewers.some((entry) => values.includes(entry))) return false;
          } else if (facet === "reviewGuidance") {
            const has = pr.reviewGuidance.length > 0;
            if (!values.includes(has ? "Has guidance" : "No guidance")) return false;
          } else if (!values.includes(String(pr[facet as keyof TriagePr]))) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => compare(a, b, display));
  }, [view, query, facets, display]);

  const counts = useMemo(() => {
    const map = new Map<ViewSlug, number>();
    for (const entry of views)
      map.set(entry.slug, triagePrs.filter((pr) => matchesView(pr, entry.slug)).length);
    return map;
  }, []);

  const columns = useMemo(() => {
    const keys = groupOrderFor(display.grouping, filtered);
    return keys.map((key) => ({
      key,
      items: filtered.filter((pr) => groupValue(pr, display.grouping) === key),
    }));
  }, [filtered, display.grouping]);

  // Empty groups start collapsed, matching how the app opens on a quiet board.
  const isCollapsed = (key: string, count: number) =>
    collapsed.includes(key) || (count === 0 && !collapsed.includes(`open:${key}`));

  const toggleColumn = (key: string, count: number) => {
    if (isCollapsed(key, count)) {
      setCollapsed((current) => [
        ...current.filter((entry) => entry !== key),
        `open:${key}`,
      ]);
    } else {
      setCollapsed((current) => [
        ...current.filter((entry) => entry !== `open:${key}`),
        key,
      ]);
    }
  };

  const toneFor = (key: string) =>
    display.grouping === "priority"
      ? priorityTone[key as Priority]
      : display.grouping === "risk"
        ? riskTone[key as keyof typeof riskTone]
        : "neutral";

  return (
    <div className="flex h-full flex-col">
      <TopBarActions>
        <DisplayMenu state={display} onChange={setDisplay} />
        <FilterMenu facets={facets} options={facetOptions} onChange={setFacets} />
      </TopBarActions>

      <div className="px-4 pt-4 sm:px-6">
        <h1 className="text-sm font-medium text-fg">Triage</h1>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-4 py-3 sm:px-6">
        <div className="sticky top-0 hidden w-[260px] shrink-0 flex-col gap-3 self-start md:flex">
          <Input
            icon={<Search className="h-3.5 w-3.5" />}
            placeholder="Search pull requests"
            aria-label="Search pull requests"
            value={query}
            onChange={(event) => setParam("q", event.target.value)}
          />

          <nav
            aria-label="Triage views"
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-2"
          >
            {views.map((entry) => (
              <button
                key={entry.slug}
                type="button"
                onClick={() => setParam("view", entry.slug)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors",
                  entry.slug === view
                    ? "bg-[var(--cr-hover)] font-medium text-fg"
                    : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
                )}
              >
                <span className="flex-1 text-left">{entry.label}</span>
                <span
                  aria-label={`${counts.get(entry.slug) ?? 0} pull requests`}
                  className="rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted"
                >
                  {counts.get(entry.slug) ?? 0}
                </span>
              </button>
            ))}
          </nav>
        </div>

        <main className="min-w-0 flex-1 overflow-x-auto">
          {display.layout === "board" ? (
            <div aria-label="Triage board" className="flex h-full min-h-[520px] gap-2">
              {columns.map((column) => {
                const folded = isCollapsed(column.key, column.items.length);

                if (folded)
                  return (
                    <section
                      key={column.key}
                      aria-label={`${column.key} board column`}
                      className="flex w-12 shrink-0 flex-col items-center gap-3 rounded-lg border border-line bg-shell/50 py-3"
                    >
                      <button
                        type="button"
                        aria-label={`Expand ${column.key}, ${column.items.length} pull requests`}
                        onClick={() => toggleColumn(column.key, column.items.length)}
                        className="text-fg-subtle transition-colors hover:text-fg"
                      >
                        <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                      </button>
                      <span className="rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
                        {column.items.length}
                      </span>
                      <span
                        className="text-xs font-medium text-fg-muted"
                        style={{ writingMode: "vertical-rl" }}
                      >
                        {column.key}
                      </span>
                    </section>
                  );

                return (
                  <section
                    key={column.key}
                    aria-label={`${column.key} board column`}
                    className="flex min-w-[280px] flex-1 flex-col rounded-lg border border-line bg-shell/50"
                  >
                    <header className="flex items-center gap-2 border-b border-line px-3 py-2">
                      <button
                        type="button"
                        aria-label={`Collapse ${column.key}`}
                        onClick={() => toggleColumn(column.key, column.items.length)}
                        className="text-fg-subtle transition-colors hover:text-fg"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <Badge tone={toneFor(column.key)}>{column.key}</Badge>
                      <span className="ml-auto rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
                        {column.items.length}
                      </span>
                    </header>

                    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                      {column.items.length === 0 ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
                          <EmptyBoardArt className="h-[68px] w-[86px]" />
                          <p className="text-sm text-fg-subtle">
                            No reviews in this group.
                          </p>
                        </div>
                      ) : (
                        column.items.map((pr) => (
                          <PrCard key={pr.id} pr={pr} display={display} />
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 text-center">
              <EmptyBoardArt className="h-[76px] w-24" />
              <p className="text-sm text-fg-subtle">No reviews in this group.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {columns
                .filter((column) => column.items.length > 0)
                .map((column) => (
                  <section key={column.key}>
                    <header className="mb-2 flex items-center gap-2">
                      <Badge tone={toneFor(column.key)}>{column.key}</Badge>
                      <span className="text-2xs tabular-nums text-fg-subtle">
                        {column.items.length}
                      </span>
                    </header>
                    <div className="space-y-2">
                      {column.items.map((pr) => (
                        <PrCard key={pr.id} pr={pr} display={display} />
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
