import { useMemo, useState } from "react";
import { GitPullRequestArrow, RefreshCw, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { TopBarActions } from "@/components/layout/TopBar";
import {
  LiveEmptyState,
  LiveFailureState,
  LiveMisconfiguredState,
  LiveTableLoading,
} from "@/components/live/LiveDataState";
import { Avatar } from "@/components/ui/Misc";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import {
  useLivePullRequestById,
  useLivePullRequests,
  type LivePullRequest,
} from "@/lib/api/reviewWorkflow";
import { ReviewWorkflowDrawer } from "./ReviewWorkflowDrawer";

const views = [
  { slug: "my_review_inbox", label: "Needs my review", available: false },
  { slug: "authored_by_me", label: "Authored by me", available: false },
  { slug: "all_reviews", label: "All reviews", available: true },
  { slug: "safe_to_close", label: "Safe to close", available: false },
] as const;

function relative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function PrCard({ pr, onOpen }: { pr: LivePullRequest; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-line bg-surface p-3 text-left shadow-card transition-colors hover:border-line-strong"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm leading-snug text-fg">{pr.title}</p>
        <Badge tone={pr.draft ? "neutral" : "info"}>{pr.draft ? "Draft" : pr.state}</Badge>
      </div>
      <p className="mt-1 font-mono text-2xs text-fg-subtle">
        {pr.repositoryName}{pr.number === undefined ? "" : ` #${String(pr.number)}`}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {pr.labels.map((label) => <Badge key={label} tone="outline">{label}</Badge>)}
      </div>
      <footer className="mt-3 flex items-center gap-2 text-2xs text-fg-subtle">
        <Avatar name={pr.author} size={18} />
        <span className="truncate">{pr.author}</span>
        <span className="ml-auto">{relative(pr.updatedAt)}</span>
      </footer>
    </button>
  );
}

export function LiveTriagePage() {
  const [params, setParams] = useSearchParams();
  const [refreshToken, setRefreshToken] = useState(0);
  const source = useLivePullRequests(refreshToken);
  const query = params.get("q") ?? "";
  const selectedId = params.get("pr") ?? undefined;
  const selectedReviewRunId = params.get("review") ?? undefined;
  const rows = source.status === "ready" ? source.value : [];
  const selected = useLivePullRequestById(rows, selectedId);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter((pr) =>
      pr.title.toLowerCase().includes(needle) ||
      pr.repositoryName.toLowerCase().includes(needle) ||
      pr.author.toLowerCase().includes(needle) ||
      String(pr.number ?? "").includes(needle) ||
      pr.labels.some((label) => label.toLowerCase().includes(needle)),
    );
  }, [query, rows]);

  const columns = useMemo(() => {
    const repositories = [...new Set(filtered.map((entry) => entry.repositoryName))].sort();
    return repositories.map((repository) => ({
      repository,
      items: filtered.filter((entry) => entry.repositoryName === repository),
    }));
  }, [filtered]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    if (key === "view") next.set("view", "all_reviews");
    setParams(next, { replace: true });
  };

  const open = (pr: LivePullRequest) => {
    const next = new URLSearchParams(params);
    next.set("pr", pr.id);
    next.delete("review");
    setParams(next, { replace: true });
  };

  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("pr");
    next.delete("review");
    setParams(next, { replace: true });
  };

  const rememberReviewRun = (reviewRunId: string) => {
    const next = new URLSearchParams(params);
    next.set("review", reviewRunId);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full flex-col">
      <TopBarActions>
        <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRefreshToken((value) => value + 1)}>
          Refresh
        </Button>
      </TopBarActions>

      <div className="px-4 pt-4 sm:px-6">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-medium text-fg">Triage</h1>
          <Badge tone="brand">Live</Badge>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Pull-request facts come from the provider-backed API. Priority, AI risk, reviewer assignment, review guidance, change type, diff stats and effort are not exposed yet and are not inferred from fixtures.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-4 py-3 sm:px-6">
        <div className="sticky top-0 hidden w-[260px] shrink-0 flex-col gap-3 self-start md:flex">
          <Input icon={<Search className="h-3.5 w-3.5" />} placeholder="Search pull requests" aria-label="Search pull requests" value={query} onChange={(event) => setParam("q", event.target.value)} />
          <nav aria-label="Triage views" className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-2">
            {views.map((entry) => (
              <button
                key={entry.slug}
                type="button"
                disabled={!entry.available}
                onClick={() => entry.available && setParam("view", entry.slug)}
                title={entry.available ? undefined : "This view needs identity/assignment metadata not exposed by the current API."}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors",
                  entry.available
                    ? "bg-[var(--cr-hover)] font-medium text-fg"
                    : "cursor-not-allowed text-fg-faint",
                )}
              >
                <span className="flex-1 text-left">{entry.label}</span>
                <span className="rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
                  {entry.available && source.status === "ready" ? source.value.length : "—"}
                </span>
              </button>
            ))}
          </nav>
        </div>

        <main className="min-w-0 flex-1 overflow-x-auto">
          {source.status === "loading" ? (
            <LiveTableLoading columns={5} />
          ) : source.status === "misconfigured" ? (
            <LiveMisconfiguredState detail={source.detail} />
          ) : source.status === "failed" ? (
            <LiveFailureState failure={source.failure} />
          ) : source.value.length === 0 ? (
            <LiveEmptyState title="No pull requests" description="No pull requests are currently available from the connected repositories." />
          ) : filtered.length === 0 ? (
            <LiveEmptyState title="No matching pull requests" description={`${String(source.value.length)} pull requests are loaded. Clear the search to see them.`} />
          ) : (
            <div aria-label="Triage board" className="flex h-full min-h-[520px] gap-2">
              {columns.map((column) => (
                <section key={column.repository} className="flex min-w-[300px] flex-1 flex-col rounded-lg border border-line bg-shell/50">
                  <header className="flex items-center gap-2 border-b border-line px-3 py-2">
                    <GitPullRequestArrow className="h-3.5 w-3.5 text-fg-subtle" />
                    <span className="truncate text-xs font-medium text-fg">{column.repository}</span>
                    <span className="ml-auto rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">{column.items.length}</span>
                  </header>
                  <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {column.items.map((pr) => <PrCard key={pr.id} pr={pr} onOpen={() => open(pr)} />)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </main>
      </div>

      <ReviewWorkflowDrawer
        pullRequest={selected}
        reviewRunId={selectedReviewRunId}
        onReviewRunId={rememberReviewRun}
        onClose={close}
      />
    </div>
  );
}
