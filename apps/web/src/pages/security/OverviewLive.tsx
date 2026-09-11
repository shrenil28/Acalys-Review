import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { LiveEmptyState, LiveFailureState, LiveTableLoading } from "@/components/live/LiveDataState";
import { StatPanel } from "@/components/charts/Panel";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody } from "@/components/ui/Card";
import { loadSecurityFindings, type DashboardSecurityFindingsResponse } from "@/lib/api/dashboardAdmin";

export function SecurityOverviewLive() {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [data, setData] = useState<DashboardSecurityFindingsResponse | null>(null);
  const [failure, setFailure] = useState<{ kind: "transport" | "contract" | "rejected"; detail: string; status?: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadSecurityFindings({ limit: 20 }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") { setData(result.value); setState("ready"); return; }
      if (result.kind === "rejected") setFailure({ kind: "rejected", status: result.status, detail: result.detail });
      else if (result.kind === "transport" || result.kind === "contract") setFailure({ kind: result.kind, detail: result.detail });
      else setFailure({ kind: "contract", detail: result.detail });
      setState("failed");
    });
    return () => controller.abort();
  }, []);

  return <Page>
    <PageHeader title="Security overview" description="Security-category findings produced by pull-request reviews. Deep scans, dependency scanning, SBOMs, and secrets scanning are not reported here until their own runtime ledgers exist." />
    {state === "loading" ? <div className="mt-6"><LiveTableLoading columns={4} /></div> : null}
    {state === "failed" && failure ? <div className="mt-6"><LiveFailureState failure={failure} /></div> : null}
    {state === "ready" && data ? <>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatPanel title="Active security findings" value={data.summary.active} tone="danger" />
        <StatPanel title="Critical & high active" value={data.summary.criticalHighActive} tone="danger" footer={`Across ${data.summary.repositoriesWithFindings} repositories`} />
        <StatPanel title="Resolved" value={data.summary.resolved} tone="ok" />
        <StatPanel title="Dismissed" value={data.summary.dismissed} tone="info" />
      </div>
      <Card className="mt-6"><CardBody>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-danger/10 text-danger"><ShieldAlert className="h-4 w-4" /></span>
          <div><h2 className="text-sm font-medium text-fg">Review security lifecycle</h2><p className="mt-1 text-sm leading-relaxed text-fg-muted">These counts come directly from persisted review findings: {data.summary.verified} verified, {data.summary.published} published, {data.summary.stale} stale, and {data.summary.superseded} superseded.</p></div>
        </div>
      </CardBody></Card>
      <section className="mt-7"><h2 className="text-sm font-medium text-fg">Recent security findings</h2>
        {data.items.length === 0 ? <div className="mt-3"><LiveEmptyState title="No security findings yet" description="Security-category findings from PR reviews will appear here." /></div> : <div className="mt-3 space-y-2">{data.items.slice(0, 8).map((item) => <div key={item.id} className="rounded-lg border border-line bg-surface px-4 py-3"><div className="flex flex-wrap items-center gap-2"><Badge tone={item.severity === "critical" || item.severity === "high" ? "danger" : item.severity === "medium" ? "warning" : "info"}>{item.severity}</Badge><Badge tone="outline">{item.lifecycle}</Badge><span className="text-sm font-medium text-fg">{item.title}</span><span className="ml-auto font-mono text-xs text-fg-subtle">{item.repositoryName}</span></div><p className="mt-1 text-xs text-fg-muted">{item.path}:{item.startLine}</p></div>)}</div>}
      </section>
    </> : null}
  </Page>;
}
