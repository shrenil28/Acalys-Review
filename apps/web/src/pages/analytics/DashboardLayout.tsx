import { useEffect, useState } from "react";
import { Outlet, useLocation, useOutletContext } from "react-router-dom";
import { FilterChip } from "@/components/ui/FilterChip";
import { ViewRail } from "@/components/ui/Tabs";
import { TopBarActions } from "@/components/layout/TopBar";
import { ideCliViews, prReviewViews } from "@/lib/nav";
import { useDashboardFilterDimensions } from "@/lib/api/liveDashboard";
import { loadDashboardAnalytics, type DashboardAnalyticsResponse } from "@/lib/api/dashboardAdmin";
import { makeRange, TimeRangePicker, type TimeRange } from "./TimeRangePicker";

export type AnalyticsLiveState =
  | { readonly status: "fixtures" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: DashboardAnalyticsResponse }
  | { readonly status: "failed"; readonly detail: string };

export function useAnalyticsLiveState(): AnalyticsLiveState {
  return useOutletContext<{ readonly analytics: AnalyticsLiveState }>().analytics;
}

function refreshMillis(value: string): number | null {
  if (value === "Off") return null;
  if (value === "Auto") return 30_000;
  const match = /^(\d+)(s|m|h|d)$/u.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  const factor = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return amount * factor;
}

/** Shared chrome and one authoritative API snapshot for all analytics child views. */
export function DashboardLayout() {
  const { pathname } = useLocation();
  const isIdeCli = pathname.startsWith("/analytics/ide-cli-reviews");
  const views = isIdeCli ? ideCliViews : prReviewViews;

  const [repo, setRepo] = useState<string[]>([]);
  const [username, setUsername] = useState<string[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [range, setRange] = useState<TimeRange>(() => makeRange());
  const [timezone, setTimezone] = useState<"UTC" | "Browser">("UTC");
  const [refresh, setRefresh] = useState("Off");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [analytics, setAnalytics] = useState<AnalyticsLiveState>({ status: "loading" });
  const { repositoryDirectory, repositoryOptions, usernameOptions: fixtureUsernames, teamOptions: fixtureTeams } = useDashboardFilterDimensions();

  useEffect(() => {
    const ms = refreshMillis(refresh);
    if (ms === null) return;
    const id = window.setInterval(() => {
      if (range.label !== undefined) {
        const span = range.to.getTime() - range.from.getTime();
        const to = new Date();
        setRange({ from: new Date(to.getTime() - span), to, label: range.label });
      } else setRefreshNonce((value) => value + 1);
    }, ms);
    return () => window.clearInterval(id);
  }, [range.from, range.label, range.to, refresh]);

  useEffect(() => {
    if (repositoryDirectory.status !== "ready") {
      if (repositoryDirectory.status === "failed" || repositoryDirectory.status === "misconfigured") {
        setAnalytics({ status: "failed", detail: "Live analytics dimensions are unavailable because the repository directory could not be loaded." });
      } else setAnalytics({ status: "loading" });
      return;
    }
    if (repositoryDirectory.source === "fixtures") {
      setAnalytics({ status: "fixtures" });
      return;
    }
    const controller = new AbortController();
    const repositoryIds = repositoryDirectory.value.filter((entry) => repo.includes(entry.name)).map((entry) => entry.id);
    setAnalytics({ status: "loading" });
    void loadDashboardAnalytics({
      from: range.from.toISOString(), to: range.to.toISOString(), repositoryIds, usernames: username, teams: team,
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setAnalytics({ status: "ready", value: result.value });
      else setAnalytics({ status: "failed", detail: "Acalys could not load the selected analytics snapshot." });
    });
    return () => controller.abort();
  }, [range.from, range.to, refreshNonce, repo, repositoryDirectory, team, username]);

  const usernameOptions = analytics.status === "ready" ? analytics.value.dimensions.usernames : fixtureUsernames;
  const teamOptions = analytics.status === "ready" ? analytics.value.dimensions.teams : fixtureTeams;

  return (
    <div className="flex min-h-full">
      <ViewRail items={views} />
      <div className="min-w-0 flex-1">
        <TopBarActions>
          <TimeRangePicker range={range} onChange={setRange} timezone={timezone} onTimezoneChange={setTimezone} refresh={refresh} onRefreshChange={setRefresh} />
        </TopBarActions>
        <section aria-label="Dashboard filters" className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-canvas/95 px-4 py-2 backdrop-blur sm:px-6">
          <FilterChip label="Repository Name" options={repositoryOptions} selected={repo} onChange={setRepo} />
          <FilterChip label="Username" options={[...usernameOptions]} selected={username} onChange={setUsername} />
          <FilterChip label={isIdeCli ? "Team" : "Teams"} options={[...teamOptions]} selected={team} onChange={setTeam} />
          {analytics.status === "ready" ? <span className="text-2xs text-fg-subtle">{analytics.value.summary.reviews} review runs in the selected range</span> : null}
          {analytics.status === "failed" ? <span className="text-2xs text-danger">Live analytics unavailable</span> : null}
        </section>
        <div className="px-4 py-4 sm:px-6"><Outlet context={{ analytics }} /></div>
      </div>
    </div>
  );
}
