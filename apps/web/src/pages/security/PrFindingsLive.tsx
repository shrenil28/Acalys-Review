import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, GitPullRequestArrow } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SearchInput, Textarea } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { LiveFailureState, LiveTableLoading } from "@/components/live/LiveDataState";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { loadSecurityFindings, type DashboardSecurityFindingsResponse } from "@/lib/api/dashboardAdmin";
import type { LiveFailure } from "@/lib/api/liveDashboard";

type DashboardSecurityFinding = DashboardSecurityFindingsResponse["items"][number];
import { resolveDataConfig } from "@/lib/api/config";
import { dismissFinding } from "@/lib/api/reviewWorkflow";
import { cn } from "@/lib/utils";

type Group = { id: string; repositoryName: string; number: number | null; title: string; author: string; state: string; findings: DashboardSecurityFinding[] };
function tone(severity: string): BadgeTone { return severity === "critical" || severity === "high" ? "danger" : severity === "medium" ? "warning" : severity === "low" ? "info" : "neutral"; }

export function PrFindingsLive() {
  const config = resolveDataConfig();
  const toast = useToast();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<readonly DashboardSecurityFinding[]>([]);
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [query, setQuery] = useState(""); const [repo, setRepo] = useState("All"); const [severity, setSeverity] = useState("All"); const [expanded, setExpanded] = useState<string[]>([]);
  const [dismissTarget, setDismissTarget] = useState<DashboardSecurityFinding | null>(null); const [reason, setReason] = useState(""); const [dismissing, setDismissing] = useState(false);
  const refresh = async (signal?: AbortSignal) => {
    const result = await loadSecurityFindings({ limit: 1000 }, signal); if (signal?.aborted) return;
    if (result.kind === "ok") { setItems(result.value.items); setState("ready"); return; }
    if (result.kind === "rejected") setFailure({ kind: "rejected", status: result.status, category: result.category, detail: result.detail }); else if (result.kind === "transport" || result.kind === "contract") setFailure({ kind: result.kind, detail: result.detail }); else setFailure({ kind: "contract", detail: result.detail }); setState("failed");
  };
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, []);
  const repos = useMemo(() => ["All", ...new Set(items.map((item) => item.repositoryName))], [items]);
  const groups = useMemo(() => {
    const grouped = new Map<string, Group>();
    for (const finding of items) {
      if (repo !== "All" && finding.repositoryName !== repo) continue; if (severity !== "All" && finding.severity !== severity) continue;
      const key = finding.pullRequestId ?? finding.reviewRunId; const current = grouped.get(key) ?? { id: key, repositoryName: finding.repositoryName, number: finding.pullRequestNumber, title: finding.pullRequestTitle ?? `Review ${finding.reviewRunId.slice(0, 8)}`, author: finding.author ?? "Unknown", state: finding.pullRequestState ?? "review", findings: [] };
      current.findings.push(finding); grouped.set(key, current);
    }
    const needle = query.trim().toLowerCase(); return [...grouped.values()].filter((group) => !needle || group.title.toLowerCase().includes(needle) || group.author.toLowerCase().includes(needle) || group.repositoryName.toLowerCase().includes(needle) || (group.number !== null && String(group.number).includes(needle)));
  }, [items, query, repo, severity]);
  const doDismiss = async () => {
    if (dismissTarget === null || reason.trim() === "" || config.kind !== "api") return; setDismissing(true);
    const result = await dismissFinding(config.baseUrl, dismissTarget.id, reason.trim()); setDismissing(false);
    if (result.kind !== "ok") { toast({ title: "Finding dismissal failed", tone: "error" }); return; }
    setItems((current) => current.map((item) => item.id === dismissTarget.id ? { ...item, lifecycle: "dismissed", updatedAt: new Date().toISOString() } : item)); setDismissTarget(null); setReason(""); toast({ title: "Security finding dismissed", tone: "info" });
  };
  return <Page><PageHeader title="PR Findings" description="Persisted security-category findings from pull-request reviews, grouped by the reviewed PR. Published findings can be dismissed through the canonical finding lifecycle." />
    {state === "loading" ? <div className="mt-5"><LiveTableLoading columns={7} /></div> : null}{state === "failed" && failure ? <div className="mt-5"><LiveFailureState failure={failure} /></div> : null}
    {state === "ready" ? <><div className="mt-5 flex flex-wrap items-center gap-2"><SearchInput placeholder="Search security findings..." value={query} onChange={(event) => setQuery(event.target.value)} wrapperClassName="w-full max-w-xs" /><FilterSelect label="Repository" value={repo} options={repos} onChange={setRepo} /><FilterSelect label="Severity" value={severity} options={["All","critical","high","medium","low","info"]} onChange={setSeverity} /></div>
      <div className="mt-3"><TableShell><Table><thead><tr><Th>Pull request</Th><Th>Repo</Th><Th>Author</Th><Th>State</Th><Th align="right">Closed</Th><Th align="right">Critical / High active</Th><Th align="right">Findings</Th></tr></thead><tbody>{groups.length === 0 ? <TableEmpty colSpan={7}>No security-category PR findings match these filters.</TableEmpty> : groups.map((group) => { const open = expanded.includes(group.id); const closed = group.findings.filter((f) => f.lifecycle === "resolved" || f.lifecycle === "dismissed" || f.lifecycle === "superseded").length; const severe = group.findings.filter((f) => (f.severity === "critical" || f.severity === "high") && (f.lifecycle === "verified" || f.lifecycle === "published" || f.lifecycle === "stale")).length; return <Fragment key={group.id}><Tr onClick={() => setExpanded((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])}><Td><span className="flex items-center gap-2"><ChevronRight className={cn("h-3.5 w-3.5 text-fg-subtle transition-transform", open && "rotate-90")} /><GitPullRequestArrow className="h-3.5 w-3.5 text-fg-subtle" />{group.number !== null ? <span className="font-mono text-xs text-fg-subtle">#{group.number}</span> : null}<span className="font-medium text-fg">{group.title}</span></span></Td><Td className="font-mono text-xs">{group.repositoryName}</Td><Td>{group.author}</Td><Td><Badge tone="outline">{group.state}</Badge></Td><Td align="right">{closed}/{group.findings.length}</Td><Td align="right"><span className={severe > 0 ? "text-danger" : "text-ok"}>{severe}</span></Td><Td align="right">{group.findings.length}</Td></Tr>{open ? <tr><td colSpan={7} className="border-b border-line bg-canvas p-0"><ul className="divide-y divide-line/60">{group.findings.map((finding) => <li key={finding.id} className="flex flex-wrap items-center gap-3 py-3 pl-12 pr-4"><Badge tone={tone(finding.severity)}>{finding.severity}</Badge><Badge tone="outline">{finding.lifecycle}</Badge><div className="min-w-0 flex-1"><p className="text-sm text-fg-muted">{finding.title}</p><p className="font-mono text-2xs text-fg-faint">{finding.path}:{finding.startLine}</p></div>{finding.lifecycle === "resolved" ? <Badge tone="success"><Check className="h-3 w-3" />Resolved</Badge> : null}{finding.lifecycle === "published" ? <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setDismissTarget(finding); setReason(""); }}>Dismiss</Button> : null}</li>)}</ul></td></tr> : null}</Fragment>; })}</tbody></Table></TableShell></div></> : null}
    <Modal open={dismissTarget !== null} onClose={() => { if (!dismissing) setDismissTarget(null); }} title="Dismiss security finding?" description="Dismissal is terminal for this finding record. A recurrence is recorded as a new finding linked by lineage." size="sm" footer={<><Button variant="ghost" disabled={dismissing} onClick={() => setDismissTarget(null)}>Cancel</Button><Button variant="danger" disabled={dismissing || reason.trim() === ""} onClick={() => void doDismiss()}>{dismissing ? "Dismissing…" : "Dismiss"}</Button></>}><Textarea rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this not an actionable security issue?" /></Modal>
  </Page>;
}
