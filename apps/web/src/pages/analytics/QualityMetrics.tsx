import { Panel, StatPanel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { BarTrend, series, severityColors } from "@/components/charts/Charts";
import {
  acceptanceByCategory,
  acceptanceBySeverity,
  commentCountBySeverity,
  commentsByCategory,
} from "@/data/analytics";

export function QualityMetrics() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={4} panels={4} />;

  const weighted =
    acceptanceBySeverity.reduce((sum, entry) => sum + entry.value, 0) /
    acceptanceBySeverity.length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatPanel
          title="Overall Acceptance Rate"
          value={`${Math.round(weighted)}%`}
          tone="ok"
          delta={{ value: "+4 pts vs. previous period", direction: "up" }}
        />
        <StatPanel
          title="Comments Posted"
          value="1,284"
          delta={{ value: "+11% vs. previous period", direction: "up" }}
        />
        <StatPanel
          title="Critical & High Findings"
          value="155"
          tone="danger"
          footer="Across 146 merged pull requests"
        />
        <StatPanel
          title="Resolved Before Merge"
          value="88%"
          tone="info"
          footer="Findings addressed in the same PR"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Acceptance Rate by Severity">
          <BarTrend
            data={acceptanceBySeverity}
            layout="vertical"
            height={210}
            valueFormatter={(value) => `${value}%`}
            seriesDefs={[
              { key: "value", label: "Acceptance rate", color: series.ok },
            ]}
          />
        </Panel>

        <Panel title="Acceptance Rate by Category">
          <BarTrend
            data={acceptanceByCategory}
            layout="vertical"
            height={210}
            valueFormatter={(value) => `${value}%`}
            seriesDefs={[
              { key: "value", label: "Acceptance rate", color: series.brand },
            ]}
          />
        </Panel>

        <Panel title="Review Comment Count by Severity">
          <BarTrend
            data={commentCountBySeverity}
            height={210}
            seriesDefs={[{ key: "value", label: "Comments", color: series.warn }]}
          />
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {commentCountBySeverity.map((entry) => (
              <li key={entry.label} className="flex items-center gap-1.5 text-2xs">
                <span
                  className="h-2 w-2 rounded-[2px]"
                  style={{ background: severityColors[entry.label] }}
                />
                <span className="text-fg-subtle">{entry.label}</span>
                <span className="tabular-nums text-fg-muted">{entry.value}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Review Comment Count by Category">
          <BarTrend
            data={commentsByCategory}
            layout="vertical"
            height={210}
            seriesDefs={[{ key: "value", label: "Comments", color: series.purple }]}
          />
        </Panel>
      </div>
    </div>
  );
}
