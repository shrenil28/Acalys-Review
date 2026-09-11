import { useEffect, useMemo, useState } from "react";
import { Panel, StatPanel, NoData } from "@/components/charts/Panel";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { FilterSelect } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/Input";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { LiveFailureState, LiveTableLoading } from "@/components/live/LiveDataState";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import {
  loadSecurityFindings,
  type DashboardSecurityFindingsResponse,
} from "@/lib/api/dashboardAdmin";
import type { LiveFailure } from "@/lib/api/liveDashboard";

type Finding = DashboardSecurityFindingsResponse["items"][number];
type Summary = DashboardSecurityFindingsResponse["summary"];

/** Lifecycle states that still describe an open security exposure. */
const ACTIVE_LIFECYCLE = ["verified", "published", "stale"] as const;

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

function severityTone(severity: string): BadgeTone {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "low") return "info";
  return "neutral";
}

function isActive(finding: Finding): boolean {
  return (ACTIVE_LIFECYCLE as readonly string[]).includes(finding.lifecycle);
}

/** Counts by one dimension, ordered by active exposure then by volume. */
function groupBy(
  findings: readonly Finding[],
  key: (finding: Finding) => string | null,
): readonly { readonly name: string; readonly total: number; readonly active: number; readonly severe: number }[] {
  const groups = new Map<string, { name: string; total: number; active: number; severe: number }>();
  for (const finding of findings) {
    const name = key(finding);
    if (name === null) continue;
    const group = groups.get(name) ?? { name, total: 0, active: 0, severe: 0 };
    group.total += 1;
    if (isActive(finding)) {
      group.active += 1;
      if (finding.severity === "critical" || finding.severity === "high") group.severe += 1;
    }
    groups.set(name, group);
  }
  return [...groups.values()].sort(
    (left, right) => right.active - left.active || right.total - left.total || left.name.localeCompare(right.name),
  );
}

export function PrSecurityReviewsLive() {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [items, setItems] = useState<readonly Finding[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [repository, setRepository] = useState("All");
  const [severity, setSeverity] = useState("All");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await loadSecurityFindings({ limit: 1000 }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setItems(result.value.items);
        setSummary(result.value.summary);
        setState("ready");
        return;
      }
      // `misconfigured` is a client-side configuration fact, not a live
      // failure shape, so it is reported as a contract problem rather than
      // widening the failure union the shared states render.
      setFailure(
        result.kind === "rejected"
          ? { kind: "rejected", status: result.status, category: result.category, detail: result.detail }
          : result.kind === "transport" || result.kind === "contract"
            ? { kind: result.kind, detail: result.detail }
            : { kind: "contract", detail: result.detail },
      );
      setState("failed");
    })();
    return () => controller.abort();
  }, []);

  const repositories = useMemo(
    () => ["All", ...new Set(items.map((item) => item.repositoryName))].sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (repository !== "All" && item.repositoryName !== repository) return false;
      if (severity !== "All" && item.severity !== severity) return false;
      if (needle === "") return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.path.toLowerCase().includes(needle) ||
        (item.pullRequestTitle ?? "").toLowerCase().includes(needle) ||
        (item.author ?? "").toLowerCase().includes(needle)
      );
    });
  }, [items, query, repository, severity]);

  const bySeverity = useMemo(
    () =>
      SEVERITY_ORDER.map((level) => ({
        level,
        total: filtered.filter((item) => item.severity === level).length,
        active: filtered.filter((item) => item.severity === level && isActive(item)).length,
      })).filter((row) => row.total > 0),
    [filtered],
  );

  const byRepository = useMemo(() => groupBy(filtered, (item) => item.repositoryName), [filtered]);
  const byAuthor = useMemo(() => groupBy(filtered, (item) => item.author), [filtered]);

  const pullRequests = useMemo(() => {
    const seen = new Set<string>();
    for (const item of filtered) {
      const key = item.pullRequestId ?? item.reviewRunId;
      seen.add(key);
    }
    return seen.size;
  }, [filtered]);

  const resolved = useMemo(
    () => filtered.filter((item) => item.lifecycle === "resolved" || item.lifecycle === "dismissed").length,
    [filtered],
  );

  return (
    <Page>
      <PageHeader
        title="PR Security Reviews"
        description="Security-category findings produced by pull-request reviews, aggregated from the persisted finding lifecycle. Deep scans, dependency scanning, SBOMs, and secrets scanning have their own ledgers and are not counted here."
      />

      {state === "loading" ? (
        <div className="mt-6">
          <LiveTableLoading columns={6} />
        </div>
      ) : null}

      {state === "failed" && failure !== null ? (
        <div className="mt-6">
          <LiveFailureState failure={failure} />
        </div>
      ) : null}

      {state === "ready" ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <SearchInput
              placeholder="Search security findings..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              wrapperClassName="w-full max-w-xs"
            />
            <FilterSelect label="Repository" value={repository} options={repositories} onChange={setRepository} />
            <FilterSelect
              label="Severity"
              value={severity}
              options={["All", ...SEVERITY_ORDER]}
              onChange={setSeverity}
            />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatPanel
              title="Active security findings"
              value={filtered.filter(isActive).length}
              tone="danger"
              footer={`${filtered.length} in the filtered set`}
            />
            <StatPanel
              title="Critical & high active"
              value={
                filtered.filter(
                  (item) => isActive(item) && (item.severity === "critical" || item.severity === "high"),
                ).length
              }
              tone="danger"
              footer={`Across ${byRepository.length} repositories`}
            />
            <StatPanel title="Pull requests with findings" value={pullRequests} tone="purple" />
            <StatPanel
              title="Closed"
              value={resolved}
              tone="ok"
              footer={summary === null ? undefined : `${summary.total} organization-wide`}
            />
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            <Panel title="Severity distribution" info="Counts follow the current filters, not the organization total.">
              {bySeverity.length === 0 ? (
                <NoData />
              ) : (
                <div className="space-y-1.5 py-2">
                  {bySeverity.map((row) => {
                    const max = Math.max(1, ...bySeverity.map((item) => item.total));
                    return (
                      <div key={row.level} className="grid grid-cols-[96px_1fr_72px] items-center gap-3 text-xs">
                        <Badge tone={severityTone(row.level)}>{row.level}</Badge>
                        <div className="h-2 rounded bg-[var(--cr-hover)]">
                          <div
                            className="h-2 rounded bg-brand"
                            style={{ width: `${Math.max(2, (row.total / max) * 100)}%` }}
                          />
                        </div>
                        <span className="text-right tabular-nums text-fg-muted">
                          {row.active}/{row.total}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <Panel title="Repositories">
              <TableShell>
                <Table>
                  <thead>
                    <tr>
                      <Th>Repository</Th>
                      <Th align="right">Active</Th>
                      <Th align="right">Critical / High</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {byRepository.length === 0 ? (
                      <TableEmpty colSpan={4}>No security findings match these filters.</TableEmpty>
                    ) : (
                      byRepository.map((row) => (
                        <Tr key={row.name}>
                          <Td className="font-mono text-xs">{row.name}</Td>
                          <Td align="right">{row.active}</Td>
                          <Td align="right">
                            <span className={row.severe > 0 ? "text-danger" : "text-ok"}>{row.severe}</span>
                          </Td>
                          <Td align="right">{row.total}</Td>
                        </Tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </TableShell>
            </Panel>
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            <Panel title="Authors" info="Attribution comes from the reviewed pull request, where the provider reported one.">
              <TableShell>
                <Table>
                  <thead>
                    <tr>
                      <Th>Author</Th>
                      <Th align="right">Active</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {byAuthor.length === 0 ? (
                      <TableEmpty colSpan={3}>No attributed authors in this range.</TableEmpty>
                    ) : (
                      byAuthor.map((row) => (
                        <Tr key={row.name}>
                          <Td>{row.name}</Td>
                          <Td align="right">{row.active}</Td>
                          <Td align="right">{row.total}</Td>
                        </Tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </TableShell>
            </Panel>

            <Panel title="Most recent findings">
              <TableShell>
                <Table>
                  <thead>
                    <tr>
                      <Th>Finding</Th>
                      <Th>Severity</Th>
                      <Th>Lifecycle</Th>
                      <Th align="right">Updated</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <TableEmpty colSpan={4}>No security findings match these filters.</TableEmpty>
                    ) : (
                      [...filtered]
                        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                        .slice(0, 25)
                        .map((finding) => (
                          <Tr key={finding.id}>
                            <Td>
                              <span className="block font-medium text-fg">{finding.title}</span>
                              <span className="block font-mono text-2xs text-fg-faint">
                                {finding.repositoryName} · {finding.path}:{finding.startLine}
                              </span>
                            </Td>
                            <Td>
                              <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                            </Td>
                            <Td>
                              <Badge tone="outline">{finding.lifecycle}</Badge>
                            </Td>
                            <Td align="right" className="tabular-nums text-xs text-fg-muted">
                              {new Date(finding.updatedAt).toLocaleDateString()}
                            </Td>
                          </Tr>
                        ))
                    )}
                  </tbody>
                </Table>
              </TableShell>
            </Panel>
          </div>
        </>
      ) : null}
    </Page>
  );
}
