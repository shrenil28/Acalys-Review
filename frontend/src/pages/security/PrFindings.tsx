import { Fragment, useMemo, useState } from "react";
import { Check, ChevronRight, GitPullRequestArrow } from "lucide-react";
import { Badge, severityTone } from "@/components/ui/Badge";
import { SearchInput } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import {
  FeedbackButton,
  ScanRepositoryButton,
} from "@/components/layout/SecurityBanner";
import { TopBarActions } from "@/components/layout/TopBar";
import { prFindings, severities } from "@/data/security";
import { repoFilterOptions } from "@/data/repos";
import { cn } from "@/lib/utils";

const stateTone = { Open: "info", Merged: "purple", Closed: "neutral" } as const;

export function PrFindingsPage() {
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("All");
  const [severity, setSeverity] = useState("All");
  const [expanded, setExpanded] = useState<string[]>([]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prFindings.filter((entry) => {
      if (repo !== "All" && entry.repo !== repo) return false;
      if (
        severity !== "All" &&
        !entry.findings.some((finding) => finding.severity === severity)
      )
        return false;
      if (!needle) return true;
      return (
        entry.prTitle.toLowerCase().includes(needle) ||
        entry.author.toLowerCase().includes(needle) ||
        String(entry.prNumber).includes(needle)
      );
    });
  }, [query, repo, severity]);

  const toggle = (id: string) =>
    setExpanded((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );

  return (
    <Page>
      <TopBarActions>
        <FeedbackButton />
        <ScanRepositoryButton />
      </TopBarActions>

      <PageHeader
        title="PR Findings"
        description="Security issues surfaced during pull request reviews, grouped by PR. Expand a PR to see its findings."
      />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search findings..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="w-full max-w-xs"
        />
        <FilterSelect
          label="Repository"
          value={repo}
          options={repoFilterOptions}
          onChange={setRepo}
        />
        <FilterSelect
          label="Severity"
          value={severity}
          options={severities as string[]}
          onChange={setSeverity}
        />
      </div>

      <div className="mt-3">
        <TableShell>
          <Table>
            <thead>
              <tr>
                <Th>Pull request</Th>
                <Th>Repo</Th>
                <Th>Author</Th>
                <Th>State</Th>
                <Th align="right">Fixed</Th>
                <Th align="right">Critical / High</Th>
                <Th align="right">Last activity</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={7}>
                  No pull request findings yet. Issues found during PR reviews will
                  appear here.
                </TableEmpty>
              ) : (
                rows.map((entry) => {
                  const open = expanded.includes(entry.id);
                  return (
                    <Fragment key={entry.id}>
                      <Tr onClick={() => toggle(entry.id)}>
                        <Td>
                          <span className="flex items-center gap-2">
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform",
                                open && "rotate-90",
                              )}
                            />
                            <GitPullRequestArrow className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                            <span className="font-mono text-xs text-fg-subtle">
                              #{entry.prNumber}
                            </span>
                            <span className="font-medium text-fg">
                              {entry.prTitle}
                            </span>
                          </span>
                        </Td>
                        <Td className="font-mono text-xs">{entry.repo}</Td>
                        <Td>{entry.author}</Td>
                        <Td>
                          <Badge tone={stateTone[entry.state]}>{entry.state}</Badge>
                        </Td>
                        <Td align="right" className="tabular-nums">
                          {entry.fixed}/{entry.total}
                        </Td>
                        <Td align="right">
                          <span
                            className={cn(
                              "tabular-nums",
                              entry.criticalHigh > 0 ? "text-danger" : "text-ok",
                            )}
                          >
                            {entry.criticalHigh}
                          </span>
                        </Td>
                        <Td align="right" className="text-fg-subtle">
                          {entry.lastActivity}
                        </Td>
                      </Tr>
                      {open && (
                        <tr>
                          <td colSpan={7} className="border-b border-line bg-canvas p-0">
                            <ul className="divide-y divide-line/60">
                              {entry.findings.map((finding, index) => (
                                <li
                                  key={index}
                                  className="flex flex-wrap items-center gap-3 py-2.5 pl-12 pr-4"
                                >
                                  <Badge tone={severityTone[finding.severity]}>
                                    {finding.severity}
                                  </Badge>
                                  <span className="text-sm text-fg-muted">
                                    {finding.summary}
                                  </span>
                                  <span className="font-mono text-2xs text-fg-faint">
                                    {finding.file}
                                  </span>
                                  <span className="ml-auto">
                                    {finding.fixed ? (
                                      <Badge tone="success">
                                        <Check className="h-3 w-3" />
                                        Fixed
                                      </Badge>
                                    ) : (
                                      <Badge tone="outline">{finding.category}</Badge>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </Table>
        </TableShell>
      </div>
    </Page>
  );
}
