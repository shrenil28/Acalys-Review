import { Panel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import {
  AreaTrend,
  BarTrend,
  DonutChart,
  series,
  severityColors,
} from "@/components/charts/Charts";
import {
  toolFindingsBySeverity,
  toolFindingsByTool,
  weeklyActiveUsers,
  weeklyAvgReviewsPerUser,
  weeklyReviewCommentsTotal,
  weeklyReviews,
} from "@/data/analytics";
import { formatNumber } from "@/lib/utils";

export function OrganizationTrends() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={0} panels={6} />;

  const totalFindings = toolFindingsBySeverity.reduce(
    (sum, entry) => sum + entry.value,
    0,
  );

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title="Weekly Active Users">
        <AreaTrend
          data={weeklyActiveUsers}
          seriesDefs={[{ key: "value", label: "Active users", color: series.brand }]}
        />
      </Panel>

      <Panel title="Weekly Reviews">
        <AreaTrend
          data={weeklyReviews}
          seriesDefs={[{ key: "value", label: "Reviews", color: series.info }]}
        />
      </Panel>

      <Panel title="Weekly Review Comments">
        <BarTrend
          data={weeklyReviewCommentsTotal}
          seriesDefs={[{ key: "value", label: "Comments", color: series.purple }]}
        />
      </Panel>

      <Panel title="Weekly Avg Reviews per User">
        <AreaTrend
          data={weeklyAvgReviewsPerUser}
          seriesDefs={[
            { key: "value", label: "Avg reviews", color: series.teal },
          ]}
        />
      </Panel>

      <Panel title="Tool Findings by Severity">
        <DonutChart
          data={toolFindingsBySeverity}
          colors={severityColors}
          centerValue={formatNumber(totalFindings)}
          centerLabel="findings"
        />
      </Panel>

      <Panel title="Tool Findings by Tool Name">
        <BarTrend
          data={toolFindingsByTool}
          layout="vertical"
          height={210}
          seriesDefs={[{ key: "value", label: "Findings", color: series.warn }]}
        />
      </Panel>
    </div>
  );
}
