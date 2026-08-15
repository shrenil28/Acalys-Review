import { Plus } from "lucide-react";
import { Panel, StatPanel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { AreaTrend, DonutChart, series } from "@/components/charts/Charts";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Table, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import {
  customChecks,
  preMergeResults,
  weeklyPreMergeRuns,
} from "@/data/analytics";

const resultColors = {
  Passed: series.ok,
  Failed: series.danger,
  Skipped: "oklch(0.585 0.0161 305)",
};

export function PreMergeChecks() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={3} panels={2} />;

  const totalRuns = preMergeResults.reduce((sum, entry) => sum + entry.value, 0);
  const passRate = Math.round(
    ((preMergeResults.find((entry) => entry.name === "Passed")?.value ?? 0) /
      totalRuns) *
      100,
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <StatPanel
          title="Custom Pre-merge Checks Configured"
          value={customChecks.length}
          footer="2 blocking · 2 warning"
        />
        <StatPanel title="Pre-Merge Check Runs" value={totalRuns} tone="info" />
        <StatPanel
          title="Pass Rate"
          value={`${passRate}%`}
          tone="ok"
          delta={{ value: "+2 pts vs. previous period", direction: "up" }}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Weekly Pre-Merge Check Runs">
          <AreaTrend
            data={weeklyPreMergeRuns}
            seriesDefs={[{ key: "value", label: "Runs", color: series.brand }]}
          />
        </Panel>
        <Panel title="Pre-Merge Check Results">
          <DonutChart
            data={preMergeResults}
            colors={resultColors}
            centerValue={`${passRate}%`}
            centerLabel="passed"
          />
        </Panel>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-fg">Custom Checks</h2>
          <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />}>
            New check
          </Button>
        </div>
        <TableShell>
          <Table>
            <thead>
              <tr>
                <Th>Check</Th>
                <Th>Mode</Th>
                <Th align="right">Runs</Th>
                <Th align="right">Pass rate</Th>
                <Th align="right">Last updated</Th>
              </tr>
            </thead>
            <tbody>
              {customChecks.map((check) => (
                <Tr key={check.name}>
                  <Td className="font-medium text-fg">{check.name}</Td>
                  <Td>
                    <Badge tone={check.mode === "Blocking" ? "danger" : "warning"}>
                      {check.mode}
                    </Badge>
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {check.runs}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {check.passRate}%
                  </Td>
                  <Td align="right" className="text-fg-subtle">
                    {check.updatedAt}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
      </div>
    </div>
  );
}
