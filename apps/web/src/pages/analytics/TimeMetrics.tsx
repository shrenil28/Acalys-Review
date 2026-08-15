import { Panel, StatPanel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { AreaTrend, series } from "@/components/charts/Charts";
import {
  timeMetrics,
  weeklyReviewReadyToHumanReview,
  weeklyReviewReadyToLastCommit,
  weeklyReviewReadyToMerge,
} from "@/data/analytics";

const hours = (value: number | string) => `${value}h`;

export function TimeMetrics() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={3} panels={2} />;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <StatPanel
          title="Time to Merge"
          value={timeMetrics.timeToMergeHours}
          unit="hours (median)"
          tone="ok"
          delta={{ value: "2.1h faster than last period", direction: "up" }}
        />
        <StatPanel
          title="Time to Last Commit"
          value={timeMetrics.timeToLastCommitHours}
          unit="hours (median)"
          tone="info"
          delta={{ value: "0.4h faster than last period", direction: "up" }}
        />
        <StatPanel
          title="Time to Last Human Review"
          value={timeMetrics.timeToLastHumanReviewHours}
          unit="hours (median)"
          tone="purple"
          delta={{ value: "0.9h slower than last period", direction: "down" }}
        />
      </div>

      <Panel title="Weekly Review-Ready → Merge Time">
        <AreaTrend
          data={weeklyReviewReadyToMerge}
          valueFormatter={hours}
          seriesDefs={[
            { key: "value", label: "Median hours", color: series.ok },
          ]}
        />
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Weekly Review-Ready → Last Commit Time">
          <AreaTrend
            data={weeklyReviewReadyToLastCommit}
            valueFormatter={hours}
            seriesDefs={[
              { key: "value", label: "Median hours", color: series.info },
            ]}
          />
        </Panel>
        <Panel title="Weekly Review-Ready → Last Human Review Time">
          <AreaTrend
            data={weeklyReviewReadyToHumanReview}
            valueFormatter={hours}
            seriesDefs={[
              { key: "value", label: "Median hours", color: series.purple },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
