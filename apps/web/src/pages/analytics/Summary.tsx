import { MultiStatPanel, Panel, StatPanel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import {
  AreaTrend,
  BarTrend,
  DonutChart,
  LineTrend,
  series,
  severityColors,
} from "@/components/charts/Charts";
import {
  reviewCommentsBySeverity,
  summary,
  weeklyActiveUsers,
  weeklyAvgPrPerUser,
  weeklyChatSessions,
  weeklyComments,
  weeklyPipelineFailures,
  weeklyPullRequests,
} from "@/data/analytics";
import { formatNumber } from "@/lib/utils";

export function AnalyticsSummary() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={4} panels={4} />;

  const totalComments = reviewCommentsBySeverity.reduce(
    (sum, entry) => sum + entry.value,
    0,
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MultiStatPanel
          title="Active Users"
          info="Users with review activity, split by whether they have a seat assigned."
          stats={[
            { label: "Assigned", value: summary.activeUsers },
            { label: "Unassigned", value: 2 },
          ]}
        />
        <StatPanel
          title="Active Repositories"
          value={summary.activeRepositories}
          tone="info"
          delta={{ value: "+1 vs. previous period", direction: "up" }}
        />
        <MultiStatPanel
          title="Merged Pull Requests"
          info="Pull requests merged in this period, and the average per active user."
          stats={[
            { label: "Total Merged", value: summary.mergedPullRequests },
            {
              label: "Avg per User",
              value: (summary.mergedPullRequests / summary.activeUsers).toFixed(1),
            },
          ]}
        />
        <StatPanel
          title="Reviewer Time Saved"
          value={summary.reviewerTimeSavedHours}
          unit="hours"
          tone="purple"
          footer="Estimated from review comments accepted"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Weekly Pull Requests: Created & Merged">
          <AreaTrend
            data={weeklyPullRequests}
            seriesDefs={[
              { key: "created", label: "Created", color: series.info },
              { key: "merged", label: "Merged", color: series.ok },
            ]}
          />
        </Panel>

        <Panel title="Weekly Avg Comments per Pull Request: Acalys & Human">
          <BarTrend
            data={weeklyComments}
            seriesDefs={[
              { key: "coderabbit", label: "Acalys", color: series.brand },
              { key: "human", label: "Human", color: series.purple },
            ]}
            stacked
          />
        </Panel>

        <Panel title="Weekly Active Users">
          <AreaTrend
            data={weeklyActiveUsers}
            seriesDefs={[{ key: "value", label: "Active users", color: series.brand }]}
          />
        </Panel>

        <Panel title="Review Comments by Severity">
          <DonutChart
            data={reviewCommentsBySeverity}
            colors={severityColors}
            centerValue={formatNumber(totalComments)}
            centerLabel="comments"
          />
        </Panel>

        <Panel title="Weekly Avg Pull Requests per User">
          <LineTrend
            data={weeklyAvgPrPerUser}
            seriesDefs={[{ key: "value", label: "Avg PRs", color: series.teal }]}
          />
        </Panel>

        <Panel title="Weekly Chat Sessions">
          <BarTrend
            data={weeklyChatSessions}
            seriesDefs={[{ key: "value", label: "Sessions", color: series.info }]}
          />
        </Panel>

        <Panel title="Weekly Pipeline Failures" className="xl:col-span-2">
          <AreaTrend
            data={weeklyPipelineFailures}
            seriesDefs={[
              { key: "value", label: "Failures", color: series.danger },
            ]}
            height={150}
          />
        </Panel>
      </div>
    </div>
  );
}
