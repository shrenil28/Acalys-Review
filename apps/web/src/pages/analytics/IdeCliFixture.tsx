import { Panel, StatPanel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import {
  AreaTrend,
  BarTrend,
  DonutChart,
  series,
} from "@/components/charts/Charts";
import {
  activeUsersByExtension,
  ideCli,
  learningsUsage,
  pathInstructionsUsage,
  reviewsByExtension,
  weeklyIdeActiveUsers,
  weeklyIdeReviews,
} from "@/data/analytics";
import { formatNumber } from "@/lib/utils";

const extensionColors = {
  "VS Code": series.info,
  JetBrains: series.brand,
  CLI: series.teal,
};

export function IdeCliSummary() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={5} panels={4} />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatPanel title="Total Reviews" value={formatNumber(ideCli.totalReviews)} />
        <StatPanel title="Total Users" value={ideCli.totalUsers} tone="info" />
        <StatPanel title="Repositories" value={ideCli.repositories} tone="purple" />
        <StatPanel
          title="Review Comments"
          value={formatNumber(ideCli.reviewComments)}
          tone="ok"
        />
        <StatPanel title="Tool Findings" value={ideCli.toolFindings} tone="danger" />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Active Users by Extension Type">
          <DonutChart
            data={activeUsersByExtension}
            colors={extensionColors}
            centerValue={ideCli.totalUsers}
            centerLabel="users"
          />
        </Panel>
        <Panel title="Reviews by Extension Type">
          <DonutChart
            data={reviewsByExtension}
            colors={extensionColors}
            centerValue={formatNumber(ideCli.totalReviews)}
            centerLabel="reviews"
          />
        </Panel>
        <Panel title="Reviews">
          <AreaTrend
            data={weeklyIdeReviews}
            seriesDefs={[{ key: "value", label: "Reviews", color: series.brand }]}
          />
        </Panel>
        <Panel title="Active Users">
          <AreaTrend
            data={weeklyIdeActiveUsers}
            seriesDefs={[
              { key: "value", label: "Active users", color: series.info },
            ]}
          />
        </Panel>
        <Panel title="Path-based Instructions Usage">
          <BarTrend
            data={pathInstructionsUsage}
            layout="vertical"
            height={190}
            seriesDefs={[{ key: "value", label: "Applied", color: series.purple }]}
          />
        </Panel>
        <Panel title="Learnings Usage">
          <AreaTrend
            data={learningsUsage}
            seriesDefs={[{ key: "value", label: "Applied", color: series.teal }]}
          />
        </Panel>
      </div>
    </div>
  );
}
