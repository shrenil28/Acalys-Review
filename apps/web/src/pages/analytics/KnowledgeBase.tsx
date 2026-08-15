import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { MultiStatPanel, Panel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { AreaTrend, BarTrend, series } from "@/components/charts/Charts";
import { Badge } from "@/components/ui/Badge";
import {
  knowledgeBase,
  learningsByRepo,
  weeklyLearningsApplied,
} from "@/data/analytics";
import { learnings } from "@/data/review";

export function KnowledgeBaseView() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={4} panels={2} />;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <MultiStatPanel
          title="Path-based Instructions Usage"
          info="How often path instructions applied, and the share of pull requests they covered."
          stats={[
            { label: "PR Coverage", value: knowledgeBase.memoryHitRate, unit: "%" },
            { label: "Times Applied", value: knowledgeBase.pathInstructions },
          ]}
        />
        <MultiStatPanel
          title="Learnings Created"
          info="Learnings recorded in this period, and how many of them are new."
          stats={[
            { label: "Total", value: knowledgeBase.learnings },
            { label: "New", value: knowledgeBase.linkedIssues },
          ]}
        />
        <MultiStatPanel
          title="Learnings Usage"
          info="How often learnings applied, and the share of pull requests they covered."
          stats={[
            { label: "PR Coverage", value: knowledgeBase.memoryHitRate, unit: "%" },
            { label: "Times Applied", value: knowledgeBase.learnings },
          ]}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Weekly Learnings Applied">
          <AreaTrend
            data={weeklyLearningsApplied}
            seriesDefs={[
              { key: "value", label: "Applied", color: series.brand },
            ]}
          />
        </Panel>
        <Panel title="Learnings by Repository">
          <BarTrend
            data={learningsByRepo}
            layout="vertical"
            height={210}
            seriesDefs={[{ key: "value", label: "Learnings", color: series.teal }]}
          />
        </Panel>
      </div>

      <Panel
        title="Most applied learnings"
        actions={
          <Link
            to="/review/learnings"
            className="flex items-center gap-1 text-2xs text-fg-subtle transition-colors hover:text-fg"
          >
            Manage
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        }
      >
        <ul className="divide-y divide-line">
          {learnings.slice(0, 5).map((learning) => (
            <li key={learning.id} className="flex items-start gap-3 py-2.5">
              <Badge tone={learning.scope === "Organization" ? "purple" : "neutral"}>
                {learning.scope === "Organization" ? "Org" : learning.repo}
              </Badge>
              <p className="min-w-0 flex-1 text-sm leading-relaxed text-fg-muted">
                {learning.content}
              </p>
              <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                {learning.appliedCount}×
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
