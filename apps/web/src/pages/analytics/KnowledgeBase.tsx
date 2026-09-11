import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, BarChart3 } from "lucide-react";
import { MultiStatPanel, Panel } from "@/components/charts/Panel";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/Misc";
import {
  LiveFailureState,
  LiveMisconfiguredState,
} from "@/components/live/LiveDataState";
import { useKnowledgeDirectory } from "@/lib/api/liveDashboard";

const KnowledgeBaseFixture = lazy(async () => {
  const module = await import("./KnowledgeBaseFixture.js");
  return { default: module.KnowledgeBaseFixture };
});

export function KnowledgeBaseView() {
  const directory = useKnowledgeDirectory();

  if (directory.status === "loading") return <DashboardSkeleton tiles={4} panels={2} />;
  if (directory.status === "misconfigured") {
    return <LiveMisconfiguredState detail={directory.detail} />;
  }
  if (directory.status === "failed") {
    return <LiveFailureState failure={directory.failure} />;
  }
  if (directory.source === "fixtures") {
    return (
      <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}>
        <KnowledgeBaseFixture />
      </Suspense>
    );
  }

  const items = directory.value;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <MultiStatPanel
          title="Path-based Instructions Usage"
          info="How often path instructions applied, and the share of pull requests they covered."
          stats={[
            { label: "PR Coverage", value: "—" },
            { label: "Times Applied", value: "—" },
          ]}
        />
        <MultiStatPanel
          title="Learnings Created"
          info="Learnings recorded in this period, and how many of them are new."
          stats={[
            { label: "Total", value: items.length },
            { label: "New", value: "—" },
          ]}
        />
        <MultiStatPanel
          title="Learnings Usage"
          info="How often learnings applied, and the share of pull requests they covered."
          stats={[
            { label: "PR Coverage", value: "—" },
            { label: "Times Applied", value: "—" },
          ]}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Weekly Learnings Applied">
          <EmptyState
            icon={<BarChart3 />}
            title="Usage trend not available yet"
            description="The knowledge records are live. Time-series usage analytics are owned by Phase 13 and are not fabricated from fixtures in API mode."
            className="min-h-[210px] border-0"
          />
        </Panel>
        <Panel title="Learnings by Repository">
          <EmptyState
            icon={<BarChart3 />}
            title="Repository usage analytics not available yet"
            description="Repository-level knowledge usage aggregation is scheduled for Phase 13."
            className="min-h-[210px] border-0"
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
        {items.length === 0 ? (
          <EmptyState
            title="No learnings yet"
            description="Live knowledge is connected, but this organization has not recorded any learnings."
            className="border-0"
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.slice(0, 5).map((learning) => (
              <li key={learning.id} className="flex items-start gap-3 py-2.5">
                <Badge tone={learning.scope === "Organization" ? "purple" : "neutral"}>
                  {learning.scope === "Organization"
                    ? "Org"
                    : learning.scope === "Path"
                      ? learning.path ?? "Path"
                      : learning.repo ?? "Repository"}
                </Badge>
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-fg-muted">
                  {learning.content}
                </p>
                <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                  {learning.appliedCount === null ? "—" : `${String(learning.appliedCount)}×`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
