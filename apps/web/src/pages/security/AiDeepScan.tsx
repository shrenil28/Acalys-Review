import { useMemo, useState, type ReactNode } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { Badge, severityTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { FilterChip } from "@/components/ui/FilterChip";
import { TableSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { Drawer } from "@/components/ui/Modal";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { ScanRepositoryButton } from "@/components/layout/SecurityBanner";
import { TopBarActions } from "@/components/layout/TopBar";
import {
  findingCategories,
  findingStatuses,
  severities,
  type DeepScanFinding,
  type FindingStatus,
} from "@/data/security";
import { repoNames, repositories } from "@/data/repos";
import { relativeTime } from "@/lib/utils";
import { useDeepScanFindings } from "@/lib/api/useDeepScanFindings";

const statusTone = {
  Open: "danger",
  "In review": "warning",
  Fixed: "success",
  Ignored: "neutral",
} as const;

/** Stable, so the row memo does not rerun on every render. */
const EMPTY: readonly DeepScanFinding[] = [];

/** Refuses a state the union says cannot exist. */
function assertNever(value: never): never {
  throw new Error(`Unhandled deep-scan state: ${String(value)}`);
}

export function AiDeepScanPage({ reviewId }: { reviewId?: string }) {
  const simulatedLoad = usePageLoad();
  // Fetching lives in the hook so this component renders fixtures, real data
  // and test data identically, without knowing which it was given.
  const source = useDeepScanFindings(reviewId);
  const findings = source.status === "ready" ? source.findings : EMPTY;
  const loading = simulatedLoad || source.status === "loading";
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState<string[]>([]);
  const [severity, setSeverity] = useState<string[]>([]);
  const [category, setCategory] = useState<string[]>([]);
  const [status, setStatus] = useState<string[]>([]);
  const [selected, setSelected] = useState<DeepScanFinding | null>(null);
  // Local triage decisions only — an override on top of the status the finding
  // arrived with. Seeding it from the fixture list meant every API finding had
  // `undefined` here, which rendered an empty badge and made the Status filter
  // exclude the entire table into "No vulnerabilities found".
  const [statuses, setStatuses] = useState<Record<string, FindingStatus>>({});
  const statusOf = (finding: DeepScanFinding): FindingStatus =>
    statuses[finding.id] ?? finding.status;

  // Whether anything the user chose is narrowing the list. An empty table with
  // a filter applied is not a statement about the code, and must not borrow
  // the clean-scan sentence.
  const filtersActive =
    query.trim() !== "" ||
    repo.length > 0 ||
    severity.length > 0 ||
    category.length > 0 ||
    status.length > 0;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return findings.filter((finding) => {
      const currentStatus = statuses[finding.id] ?? finding.status;
      if (repo.length > 0 && !repo.includes(finding.repo)) return false;
      if (severity.length > 0 && !severity.includes(finding.severity)) return false;
      if (category.length > 0 && !category.includes(finding.category)) return false;
      if (status.length > 0 && !status.includes(currentStatus)) return false;
      if (!needle) return true;
      return (
        finding.summary.toLowerCase().includes(needle) ||
        finding.file.toLowerCase().includes(needle) ||
        finding.id.toLowerCase().includes(needle)
      );
    });
  }, [findings, query, repo, severity, category, status, statuses]);

  const neverScanned = repositories.filter(
    (entry) => entry.security.lastScanAt === null,
  ).length;

  const setStatusFor = (id: string, next: FindingStatus) =>
    setStatuses((current) => ({ ...current, [id]: next }));

  if (loading)
    return (
      <Page>
        <TableSkeleton filters={4} rows={8} columns={3} />
      </Page>
    );

  // ── What an empty table means, decided once and exhaustively ────────────
  //
  // A ternary chain here branched on `failed` alone, so `misconfigured` fell
  // through to "No vulnerabilities found in the analyzed scope" — a build that
  // never asked anything reporting a clean scan, which is the exact failure
  // the data-mode seam exists to prevent.
  //
  // A `switch` closed by `assertNever`, the discipline `lib/findings.ts` and
  // `lib/premerge.ts` already use, makes the next state added to
  // `DeepScanState` a compile error instead of a reassuring sentence.
  //
  // `null` means "there is something real to show"; every other branch is the
  // same empty-state shell with a different sentence. No new visual element.
  const emptyState: ReactNode = ((): ReactNode => {
    switch (source.status) {
      // `loading` is absent because the skeleton returned above and the
      // compiler knows it: naming it here is a "not comparable" error, which
      // is the exhaustiveness check working in the other direction.
      case "failed":
        // A failed request and a clean scan both produce zero rows. Saying
        // "none found" here would report an outage as good news — the
        // frontend restatement of a rule the backend already enforces, where
        // a verifier outage must not read as a clean review.
        return (
          <TableEmpty colSpan={7}>
            Findings could not be loaded, so this list is not a statement about
            your code. {source.detail}.
          </TableEmpty>
        );
      case "misconfigured":
        // Nothing was requested, so nothing is known. Its own sentence rather
        // than the failure one, because the remedy is a deployment variable
        // and not a retry — and never the clean-scan one, which would present
        // a missing configuration as a security result.
        return (
          <TableEmpty colSpan={7}>
            This build is not configured to load findings, so this list is not
            a statement about your code. {source.detail}.
          </TableEmpty>
        );
      case "ready":
        if (rows.length > 0) return null;
        // Zero rows because the user narrowed the list is not zero findings.
        // The Status, Category and Repository filters can each empty the
        // table on their own, and the clean-scan copy would then describe the
        // filter as a security posture.
        return filtersActive ? (
          <TableEmpty colSpan={7}>
            No findings match the current filters. {findings.length} findings
            are loaded; clear the filters to see them.
          </TableEmpty>
        ) : (
          <TableEmpty colSpan={7}>
            No vulnerabilities found in the analyzed scope. Coverage is
            incomplete. {neverScanned} repositories have no completed AI Deep
            Scan.
          </TableEmpty>
        );
      default:
        return assertNever(source);
    }
  })();

  return (
    <Page>
      <TopBarActions>
        <ScanRepositoryButton />
      </TopBarActions>

      <PageHeader
        title="AI Deep Scan"
        description="Findings from whole-codebase reasoning. Deep Scan traces data flow across files to surface issues a per-file linter cannot see."
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search findings..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="w-full max-w-xs"
        />
        <FilterChip
          label="Repository"
          options={repoNames}
          selected={repo}
          onChange={setRepo}
        />
        <FilterChip
          label="Severity"
          options={(severities as string[]).filter((entry) => entry !== "All")}
          selected={severity}
          onChange={setSeverity}
        />
        <FilterChip
          label="Category"
          options={findingCategories.filter((entry) => entry !== "All")}
          selected={category}
          onChange={setCategory}
        />
        <FilterChip
          label="Status"
          options={(findingStatuses as string[]).filter((entry) => entry !== "All")}
          selected={status}
          onChange={setStatus}
        />
      </div>

      <div className="mt-3">
        <TableShell>
          <Table>
            <thead>
              <tr>
                <Th>Category</Th>
                <Th>Repo</Th>
                <Th>Subsystem</Th>
                <Th>Status</Th>
                <Th>Severity</Th>
                <Th>File</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {emptyState ?? (
                rows.map((finding) => (
                  <Tr key={finding.id} onClick={() => setSelected(finding)}>
                    <Td>
                      <span className="font-medium text-fg">{finding.category}</span>
                      <span className="mt-0.5 block max-w-md truncate text-xs text-fg-subtle">
                        {finding.summary}
                      </span>
                    </Td>
                    <Td className="font-mono text-xs">{finding.repo}</Td>
                    <Td>{finding.subsystem}</Td>
                    <Td>
                      <Badge tone={statusTone[statusOf(finding)]}>
                        {statusOf(finding)}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={severityTone[finding.severity]}>
                        {finding.severity}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs">
                      {finding.file}:{finding.line}
                    </Td>
                    <Td align="right">
                      <span
                        className="flex justify-end"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Popover
                          align="end"
                          trigger={({ toggle }) => (
                            <Button size="sm" variant="ghost" onClick={toggle}>
                              Set status
                            </Button>
                          )}
                        >
                          {(close) => (
                            <>
                              {(["Open", "In review", "Fixed", "Ignored"] as const).map(
                                (option) => (
                                  <MenuItem
                                    key={option}
                                    selected={statusOf(finding) === option}
                                    onClick={() => {
                                      setStatusFor(finding.id, option);
                                      close();
                                    }}
                                  >
                                    {option}
                                  </MenuItem>
                                ),
                              )}
                            </>
                          )}
                        </Popover>
                      </span>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </TableShell>
      </div>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={
          selected && (
            <div className="flex items-center gap-2">
              <Badge tone={severityTone[selected.severity]}>{selected.severity}</Badge>
              <span className="font-mono text-xs text-fg-subtle">{selected.id}</span>
              <Badge tone={statusTone[statusOf(selected)]}>
                {statusOf(selected)}
              </Badge>
            </div>
          )
        }
        footer={
          selected && (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setStatusFor(selected.id, "Ignored");
                  setSelected(null);
                }}
              >
                Ignore finding
              </Button>
              <Button
                variant="brand"
                icon={<ShieldCheck className="h-3.5 w-3.5" />}
                onClick={() => {
                  setStatusFor(selected.id, "Fixed");
                  setSelected(null);
                }}
              >
                Mark as fixed
              </Button>
            </>
          )
        }
      >
        {selected && (
          <div className="space-y-5">
            <div>
              <h3 className="text-base font-medium leading-snug text-fg">
                {selected.summary}
              </h3>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-fg-subtle">
                <span>{selected.repo}</span>
                <span className="text-fg-faint">/</span>
                <span>
                  {selected.file}:{selected.line}
                </span>
                {selected.cwe && (
                  <a
                    href={`https://cwe.mitre.org/data/definitions/${selected.cwe.replace("CWE-", "")}.html`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    {selected.cwe}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </p>
            </div>

            <section>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
                What is happening
              </h4>
              <p className="text-sm leading-relaxed text-fg-muted">{selected.detail}</p>
            </section>

            <section>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
                How to fix it
              </h4>
              <p className="text-sm leading-relaxed text-fg-muted">
                {selected.remediation}
              </p>
            </section>

            <section className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 text-xs">
              <div>
                <p className="text-fg-faint">Category</p>
                <p className="mt-0.5 text-fg-muted">{selected.category}</p>
              </div>
              <div>
                <p className="text-fg-faint">Subsystem</p>
                <p className="mt-0.5 text-fg-muted">{selected.subsystem}</p>
              </div>
              <div>
                <p className="text-fg-faint">Detected</p>
                <p className="mt-0.5 text-fg-muted">
                  {relativeTime(selected.detectedAt)}
                </p>
              </div>
              <div>
                <p className="text-fg-faint">Finding ID</p>
                <p className="mt-0.5 font-mono text-fg-muted">{selected.id}</p>
              </div>
            </section>
          </div>
        )}
      </Drawer>
    </Page>
  );
}
