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
import { AddRepositoriesModal } from "./AddRepositoriesModal";
import { repositories } from "@/data/repos";
import { formatNumber, relativeTime } from "@/lib/utils";

type SortKey = "name" | "openPrs" | "reviewsLast30d" | "commentsLast30d";

export function RepositoriesPage() {
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState("All");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "reviewsLast30d",
    direction: "desc",
  });
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(repositories.map((repo) => [repo.name, repo.reviewsEnabled])),
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = repositories.filter((repo) => {
      if (visibility !== "All" && repo.visibility !== visibility) return false;
      if (!needle) return true;
      return (
        repo.name.toLowerCase().includes(needle) ||
        repo.language.toLowerCase().includes(needle)
      );
    });
    return [...rows].sort((a, b) => {
      const direction = sort.direction === "asc" ? 1 : -1;
      if (sort.key === "name") return a.name.localeCompare(b.name) * direction;
      return (a[sort.key] - b[sort.key]) * direction;
    });
  }, [query, visibility, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" },
    );

  const sortFor = (key: SortKey) => (sort.key === key ? sort.direction : null);

  return (
    <Page>
      <TopBarActions>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() =>
            toast({
              title: "Repositories synced",
              description: "Pulled the latest repository list from GitHub.",
            })
          }
        >
          Sync
        </Button>
        <Button
          size="sm"
          variant="brand"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setAdding(true)}
        >
          Add repositories
        </Button>
      </TopBarActions>

      <PageHeader
        title="Repositories"
        description="Turn reviews on or off per repository. Acalys only reads repositories you enable here."
      />

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
          {Object.values(enabled).filter(Boolean).length} of {repositories.length}{" "}
          enabled
        </span>
      </div>

      <div className="mt-3">
        <TableShell>
          <Table>
            <thead>
              <tr>
                <Th
                  sortable
                  direction={sortFor("name")}
                  onSort={() => toggleSort("name")}
                >
                  Repository
                </Th>
                <Th>Language</Th>
                <Th
                  sortable
                  align="right"
                  direction={sortFor("openPrs")}
                  onSort={() => toggleSort("openPrs")}
                >
                  Open PRs
                </Th>
                <Th
                  sortable
                  align="right"
                  direction={sortFor("reviewsLast30d")}
                  onSort={() => toggleSort("reviewsLast30d")}
                >
                  Reviews (30d)
                </Th>
                <Th
                  sortable
                  align="right"
                  direction={sortFor("commentsLast30d")}
                  onSort={() => toggleSort("commentsLast30d")}
                >
                  Comments (30d)
                </Th>
                <Th align="right">Last review</Th>
                <Th align="right">Reviews</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={7}>
                  No repositories match those filters.
                </TableEmpty>
              ) : (
                rows.map((repo) => (
                  <Tr key={repo.name}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <GitHubIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                        <Link
                          to={`/review/repositories/${repo.name}`}
                          className="font-medium text-fg transition-colors hover:text-brand"
                        >
                          {repo.name}
                        </Link>
                        {repo.visibility === "Private" ? (
                          <Lock className="h-3 w-3 text-fg-faint" />
                        ) : (
                          <Unlock className="h-3 w-3 text-fg-faint" />
                        )}
                        <Badge tone="outline" className="ml-1">
                          {repo.defaultBranch}
                        </Badge>
                      </span>
                    </Td>
                    <Td>{repo.language}</Td>
                    <Td align="right" className="tabular-nums">
                      {repo.openPrs}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {repo.reviewsLast30d}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatNumber(repo.commentsLast30d)}
                    </Td>
                    <Td align="right" className="text-fg-subtle">
                      {repo.lastReviewAt ? relativeTime(repo.lastReviewAt) : "Never"}
                    </Td>
                    <Td align="right">
                      <span className="flex justify-end">
                        <Switch
                          checked={enabled[repo.name]}
                          onChange={(value) => {
                            setEnabled((current) => ({
                              ...current,
                              [repo.name]: value,
                            }));
                            toast({
                              title: value
                                ? `Reviews enabled for ${repo.name}`
                                : `Reviews paused for ${repo.name}`,
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

      <AddRepositoriesModal open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}
