import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { FilterChip } from "@/components/ui/FilterChip";
import { ViewRail } from "@/components/ui/Tabs";
import { TopBarActions } from "@/components/layout/TopBar";
import { ideCliViews, prReviewViews } from "@/lib/nav";
import { useDashboardFilterDimensions } from "@/lib/api/liveDashboard";
import { makeRange, TimeRangePicker, type TimeRange } from "./TimeRangePicker";

/**
 * Shared chrome for the Grafana-backed dashboards: a view rail on the left,
 * template-variable filters across the top, and the selected view below.
 */
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
  const { repositoryOptions, usernameOptions, teamOptions } =
    useDashboardFilterDimensions();

  return (
    <div className="flex min-h-full">
      <ViewRail items={views} />

      <div className="min-w-0 flex-1">
        <TopBarActions>
          <TimeRangePicker
            range={range}
            onChange={setRange}
            timezone={timezone}
            onTimezoneChange={setTimezone}
            refresh={refresh}
            onRefreshChange={setRefresh}
          />
        </TopBarActions>

        <section
          aria-label="Dashboard filters"
          className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-canvas/95 px-4 py-2 backdrop-blur sm:px-6"
        >
          <FilterChip
            label="Repository Name"
            options={[...repositoryOptions]}
            selected={repo}
            onChange={setRepo}
          />
          <FilterChip
            label="Username"
            options={[...usernameOptions]}
            selected={username}
            onChange={setUsername}
          />
          <FilterChip
            label={isIdeCli ? "Team" : "Teams"}
            options={[...teamOptions]}
            selected={team}
            onChange={setTeam}
          />
        </section>

        <div className="px-4 py-4 sm:px-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
