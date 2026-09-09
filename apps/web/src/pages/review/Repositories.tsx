import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Lock, Plus, RefreshCw, Unlock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Pagination, Switch } from "@/components/ui/Misc";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { GitHubIcon } from "@/components/icons";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { useToast } from "@/components/ui/Toast";
import {
  LiveEmptyState,
  LiveFailureState,
  LiveMisconfiguredState,
  LiveTableLoading,
} from "@/components/live/LiveDataState";
import { useRepositoryDirectory, type RepositoryView } from "@/lib/api/liveDashboard";
import { formatNumber, relativeTime } from "@/lib/utils";
import { AddRepositoriesModal } from "./AddRepositoriesModal";

type SortKey = "name" | "openPrs" | "reviewsLast30d" | "commentsLast30d";

function metric(repo: RepositoryView, key: Exclude<SortKey, "name">): number | null {
  return repo[key];
}

function displayMetric(value: number | null, formatted = false): string | number {
  if (value === null) return "—";
  return formatted ? formatNumber(value) : value;
}

export function RepositoriesPage() {
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState("All");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "reviewsLast30d",
    direction: "desc",
  });
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adding, setAdding] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const directory = useRepositoryDirectory(refreshToken);
  const toast = useToast();

  const repositories = directory.status === "ready" ? directory.value : [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = repositories.filter((repo) => {
      if (visibility !== "All" && repo.visibility !== visibility) return false;
      if (!needle) return true;
      return (
        repo.name.toLowerCase().includes(needle) ||
        (repo.language?.toLowerCase().includes(needle) ?? false)
      );
    });
    return [...rows].sort((a, b) => {
      const direction = sort.direction === "asc" ? 1 : -1;
      if (sort.key === "name") return a.name.localeCompare(b.name) * direction;
      const left = metric(a, sort.key);
      const right = metric(b, sort.key);
      if (left === null && right === null) return a.name.localeCompare(b.name);
      if (left === null) return 1;
      if (right === null) return -1;
      return (left - right) * direction;
    });
  }, [repositories, query, visibility, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" },
    );

  const sortFor = (key: SortKey) => (sort.key === key ? sort.direction : null);
  const enabledCount = repositories.filter(
    (repo) => enabled[repo.id] ?? repo.reviewsEnabled,
  ).length;

  return (
    <Page>
      <TopBarActions>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => {
            setRefreshToken((value) => value + 1);
            toast({
              title: "Refreshing repositories",
              description: "Requesting the latest repository list from Acalys.",
            });
          }}
        >
          Sync
        </Button>
        <Button
          size="sm"
          variant="brand"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setAdding(true)}
          disabled={directory.status === "ready" && directory.source === "api"}
        >
          Add repositories
        </Button>
      </TopBarActions>

      <PageHeader
        title="Repositories"
        description="Turn reviews on or off per repository. Acalys only reads repositories you enable here."
      />

      {directory.status === "loading" ? (
        <div className="mt-5">
          <LiveTableLoading columns={7} />
        </div>
      ) : directory.status === "misconfigured" ? (
        <div className="mt-5">
          <LiveMisconfiguredState detail={directory.detail} />
        </div>
      ) : directory.status === "failed" ? (
        <div className="mt-5">
          <LiveFailureState failure={directory.failure} />
        </div>
      ) : repositories.length === 0 ? (
        <div className="mt-5">
          <LiveEmptyState
            title="No repositories connected"
            description="The organization has no repositories available to this Acalys session."
          />
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <SearchInput
              placeholder="Search repositories..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              wrapperClassName="w-full max-w-xs"
            />
            <FilterSelect
              label="Visibility"
              value={visibility}
              options={["All", "Private", "Public"]}
              onChange={(value) => {
                setVisibility(value);
                setPage(1);
              }}
            />
            <span className="ml-auto text-xs text-fg-subtle">
              {enabledCount} of {repositories.length} enabled
            </span>
          </div>

          <div className="mt-3">
            <TableShell>
              <Table>
                <thead>
                  <tr>
                    <Th sortable direction={sortFor("name")} onSort={() => toggleSort("name")}>
                      Repository
                    </Th>
                    <Th>Language</Th>
                    <Th sortable align="right" direction={sortFor("openPrs")} onSort={() => toggleSort("openPrs")}>
                      Open PRs
                    </Th>
                    <Th sortable align="right" direction={sortFor("reviewsLast30d")} onSort={() => toggleSort("reviewsLast30d")}>
                      Reviews (30d)
                    </Th>
                    <Th sortable align="right" direction={sortFor("commentsLast30d")} onSort={() => toggleSort("commentsLast30d")}>
                      Comments (30d)
                    </Th>
                    <Th align="right">Last review</Th>
                    <Th align="right">Reviews</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <TableEmpty colSpan={7}>No repositories match those filters.</TableEmpty>
                  ) : (
                    rows.map((repo) => (
                      <Tr key={repo.id}>
                        <Td>
                          <span className="flex items-center gap-2">
                            <GitHubIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                            <Link
                              to={`/review/repositories/${encodeURIComponent(repo.name)}`}
                              className="font-medium text-fg transition-colors hover:text-brand"
                            >
                              {repo.name}
                            </Link>
                            {repo.visibility === "Private" ? (
                              <Lock className="h-3 w-3 text-fg-faint" />
                            ) : repo.visibility === "Public" ? (
                              <Unlock className="h-3 w-3 text-fg-faint" />
                            ) : null}
                            <Badge tone="outline" className="ml-1">
                              {repo.defaultBranch}
                            </Badge>
                          </span>
                        </Td>
                        <Td>{repo.language ?? "—"}</Td>
                        <Td align="right" className="tabular-nums">{displayMetric(repo.openPrs)}</Td>
                        <Td align="right" className="tabular-nums">{displayMetric(repo.reviewsLast30d)}</Td>
                        <Td align="right" className="tabular-nums">{displayMetric(repo.commentsLast30d, true)}</Td>
                        <Td align="right" className="text-fg-subtle">
                          {repo.lastReviewAt ? relativeTime(repo.lastReviewAt) : directory.source === "api" ? "—" : "Never"}
                        </Td>
                        <Td align="right">
                          <span className="flex justify-end">
                            <Switch
                              checked={enabled[repo.id] ?? repo.reviewsEnabled}
                              disabled={directory.source === "api"}
                              onChange={(value) => {
                                setEnabled((current) => ({ ...current, [repo.id]: value }));
                                toast({
                                  title: value ? `Reviews enabled for ${repo.name}` : `Reviews paused for ${repo.name}`,
                                  tone: value ? "success" : "info",
                                });
                              }}
                              label={`Reviews for ${repo.name}`}
                            />
                          </span>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
              <Pagination
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={filtered.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </TableShell>
          </div>
        </>
      )}

      <AddRepositoriesModal
        open={
          adding &&
          directory.status === "ready" &&
          directory.source === "fixtures"
        }
        onClose={() => setAdding(false)}
      />
    </Page>
  );
}
