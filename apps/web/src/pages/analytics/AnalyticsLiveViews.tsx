import { Panel, StatPanel, MultiStatPanel, NoData } from "@/components/charts/Panel";
import { Badge } from "@/components/ui/Badge";
import { Table, TableShell, Td, Th, Tr, TableEmpty } from "@/components/ui/Table";
import { useAnalyticsLiveState } from "./DashboardLayout";

function useSnapshot() {
  const state = useAnalyticsLiveState();
  return state;
}
function LoadingOrFailure({ state }: { state: ReturnType<typeof useSnapshot> }) {
  if (state.status === "loading") return <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Loading live analytics…</div>;
  if (state.status === "failed") return <div className="rounded-lg border border-danger/30 bg-surface p-8 text-sm text-fg-subtle">{state.detail}</div>;
  return <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Live analytics are unavailable in this data mode.</div>;
}
const duration = (seconds: number | null) => seconds === null ? "—" : seconds < 60 ? `${Math.round(seconds)}s` : `${(seconds / 60).toFixed(1)}m`;

export function LiveAnalyticsSummary() {
  const state = useSnapshot(); if (state.status !== "ready") return <LoadingOrFailure state={state} />;
  const value = state.value; const completion = value.summary.reviews === 0 ? 0 : Math.round((value.summary.completed / value.summary.reviews) * 100);
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatPanel title="Review runs" value={value.summary.reviews} />
      <StatPanel title="Findings" value={value.summary.findings} tone="purple" footer={`${value.summary.resolvedFindings} resolved`} />
      <StatPanel title="Completed" value={`${completion}%`} tone="ok" footer={`${value.summary.completed} completed · ${value.summary.failed} failed`} />
      <StatPanel title="Average run duration" value={duration(value.summary.averageDurationSeconds)} tone="info" />
    </div>
    <Panel title="Review activity" info="Buckets are selected by the server so long ranges stay bounded.">
      {value.trends.length === 0 ? <NoData /> : <div className="space-y-1.5 py-2">{value.trends.slice(-30).map((point) => {
        const max = Math.max(1, ...value.trends.map((item) => item.reviews));
        return <div key={point.start} className="grid grid-cols-[145px_1fr_48px] items-center gap-3 text-xs"><span className="text-fg-subtle">{new Date(point.start).toLocaleString()}</span><div className="h-2 rounded bg-[var(--cr-hover)]"><div className="h-2 rounded bg-brand" style={{ width: `${Math.max(2, (point.reviews / max) * 100)}%` }} /></div><span className="text-right tabular-nums text-fg-muted">{point.reviews}</span></div>;
      })}</div>}
    </Panel>
  </div>;
}

export function LiveOrganizationTrends() {
  const state = useSnapshot(); if (state.status !== "ready") return <LoadingOrFailure state={state} />; const value=state.value;
  return <div className="grid gap-3 xl:grid-cols-2"><Panel title="Review trend"><TableShell><Table><thead><tr><Th>Bucket</Th><Th>Reviews</Th><Th>Completed</Th><Th>Failed</Th></tr></thead><tbody>{value.trends.length===0?<TableEmpty colSpan={4}>No review runs in this range.</TableEmpty>:value.trends.map((item)=><Tr key={item.start}><Td>{new Date(item.start).toLocaleString()}</Td><Td>{item.reviews}</Td><Td>{item.completed}</Td><Td>{item.failed}</Td></Tr>)}</tbody></Table></TableShell></Panel><Panel title="Active repositories"><TableShell><Table><thead><tr><Th>Repository</Th><Th>Reviews</Th><Th>Findings</Th></tr></thead><tbody>{value.repositories.length===0?<TableEmpty colSpan={3}>No repository activity in this range.</TableEmpty>:value.repositories.map((item)=><Tr key={item.repositoryId}><Td className="font-medium text-fg">{item.name}</Td><Td>{item.reviews}</Td><Td>{item.findings}</Td></Tr>)}</tbody></Table></TableShell></Panel></div>;
}

export function LiveQualityMetrics() {
  const state = useSnapshot(); if (state.status !== "ready") return <LoadingOrFailure state={state} />; const value=state.value;
  return <div className="grid gap-3 xl:grid-cols-2"><Panel title="Findings by severity">{value.severities.length===0?<NoData/>:<div className="space-y-2 py-2">{value.severities.map((item)=><div key={item.severity} className="flex items-center justify-between"><Badge tone={item.severity.toLowerCase()==="critical"?"danger":"neutral"}>{item.severity}</Badge><span className="tabular-nums text-sm text-fg">{item.count}</span></div>)}</div>}</Panel><Panel title="Findings by category">{value.categories.length===0?<NoData/>:<div className="space-y-2 py-2">{value.categories.slice(0,20).map((item)=><div key={item.category} className="flex items-center justify-between gap-3"><span className="truncate text-sm text-fg-muted">{item.category}</span><span className="tabular-nums text-sm text-fg">{item.count}</span></div>)}</div>}</Panel></div>;
}

export function LivePreMergeChecks() {
  const state = useSnapshot(); if (state.status !== "ready") return <LoadingOrFailure state={state} />; const checks=state.value.checks;
  return <div className="grid gap-3 xl:grid-cols-2"><MultiStatPanel title="Pre-merge outcomes" stats={[{label:"Total",value:checks.total},{label:"Passed",value:checks.passed},{label:"Failed",value:checks.failed}]} /><MultiStatPanel title="Other outcomes" stats={[{label:"Inconclusive",value:checks.inconclusive},{label:"Skipped",value:checks.skipped}]} /></div>;
}

export function LiveTimeMetrics() {
  const state=useSnapshot(); if(state.status!=="ready") return <LoadingOrFailure state={state}/>; const value=state.value;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><StatPanel title="Average review-run duration" value={duration(value.summary.averageDurationSeconds)} tone="info"/><StatPanel title="Completed runs" value={value.summary.completed} tone="ok"/><StatPanel title="Cancelled runs" value={value.summary.cancelled} tone="neutral"/></div>;
}

export function LiveDataMetrics() {
  const state=useSnapshot(); if(state.status!=="ready") return <LoadingOrFailure state={state}/>; const value=state.value;
  return <div className="grid gap-3 xl:grid-cols-2"><Panel title="Repository facts"><TableShell><Table><thead><tr><Th>Repository</Th><Th>Reviews</Th><Th>Findings</Th><Th>Avg duration</Th></tr></thead><tbody>{value.repositories.length===0?<TableEmpty colSpan={4}>No repository facts in this range.</TableEmpty>:value.repositories.map((item)=><Tr key={item.repositoryId}><Td className="font-medium text-fg">{item.name}</Td><Td>{item.reviews}</Td><Td>{item.findings}</Td><Td>{duration(item.averageDurationSeconds)}</Td></Tr>)}</tbody></Table></TableShell></Panel><Panel title="Author / team facts"><TableShell><Table><thead><tr><Th>Author</Th><Th>Team</Th><Th>Reviews</Th><Th>Findings</Th></tr></thead><tbody>{value.authors.length===0?<TableEmpty colSpan={4}>No author facts in this range.</TableEmpty>:value.authors.map((item)=><Tr key={`${item.username}:${item.team ?? ""}`}><Td className="font-medium text-fg">{item.username}</Td><Td>{item.team ?? "—"}</Td><Td>{item.reviews}</Td><Td>{item.findings}</Td></Tr>)}</tbody></Table></TableShell></Panel></div>;
}
