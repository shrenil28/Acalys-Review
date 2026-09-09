import { useMemo, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Pagination } from "@/components/ui/Misc";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { GitHubIcon } from "@/components/icons";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { ScanRepositoryButton } from "@/components/layout/SecurityBanner";
import { TopBarActions } from "@/components/layout/TopBar";
import {
  LiveEmptyState,
  LiveFailureState,
  LiveMisconfiguredState,
  LiveTableLoading,
} from "@/components/live/LiveDataState";
import { useRepositoryDirectory } from "@/lib/api/liveDashboard";
import { cn, relativeTime } from "@/lib/utils";

type SortKey = "name" | "deepScan" | "dependencies" | "secrets";

/** "NA" reads as "never scanned" for screen readers, matching the app. */
function ScanCell({ value }: { value: number | null }) {
  if (value === null)
    return (
      <span aria-label="Scan data unavailable" className="text-fg-faint">
        NA
      </span>
    );
  return (
    <span
      className={cn(
        "tabular-nums",
        value === 0 ? "text-ok" : value > 4 ? "text-danger" : "text-warn",
      )}
    >
      {value}
    </span>
  );
}

export function SecurityRepositoriesPage() {
  const directory = useRepositoryDirectory();
  const repositories = directory.status === "ready" ? directory.value : [];
  const [query, setQuery] = useState("");
  const [scanned, setScanned] = useState("All");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  });

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = repositories.filter((repo) => {
      if (scanned === "Scanned" && repo.security.lastScanAt === null) return false;
      if (scanned === "Never scanned" && repo.security.lastScanAt !== null) return false;
      if (!needle) return true;
      return repo.name.toLowerCase().includes(needle);
    });
    return [...rows].sort((a, b) => {
      const direction = sort.direction === "asc" ? 1 : -1;
      if (sort.key === "name") return a.name.localeCompare(b.name) * direction;
      const left = a.security[sort.key] ?? -1;
      const right = b.security[sort.key] ?? -1;
      return (left - right) * direction;
    });
  }, [repositories, query, scanned, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );

  const sortFor = (key: SortKey) => (sort.key === key ? sort.direction : null);

  return (
    <Page>
      <TopBarActions>
        <ScanRepositoryButton
          disabled={directory.status === "ready" && directory.source === "api"}
        />
      </TopBarActions>

      <PageHeader
        title="Repositories"
        description="Scan coverage per repository. Run a scan to populate deep scan, dependency, and secret counts."
      />

      {directory.status === "loading" ? (
        <div className="mt-5"><LiveTableLoading columns={6} /></div>
      ) : directory.status === "misconfigured" ? (
        <div className="mt-5"><LiveMisconfiguredState detail={directory.detail} /></div>
      ) : directory.status === "failed" ? (
        <div className="mt-5"><LiveFailureState failure={directory.failure} /></div>
      ) : repositories.length === 0 ? (
        <div className="mt-5">
          <LiveEmptyState
            title="No repositories connected"
            description="There are no repositories available to scan in this workspace."
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
              label="Scan status"
              value={scanned}
              options={["All", "Scanned", "Never scanned"]}
              onChange={(value) => {
                setScanned(value);
                setPage(1);
              }}
            />
          </div>

          <div className="mt-3">
            <TableShell>
              <Table>
                <thead>
                  <tr>
                    <Th sortable direction={sortFor("name")} onSort={() => toggleSort("name")}>Repository</Th>
                    <Th sortable align="right" direction={sortFor("deepScan")} onSort={() => toggleSort("deepScan")}>AI Deep Scan</Th>
                    <Th sortable align="right" direction={sortFor("dependencies")} onSort={() => toggleSort("dependencies")}>Dependencies Vulnerable</Th>
                    <Th sortable align="right" direction={sortFor("secrets")} onSort={() => toggleSort("secrets")}>Secrets Detected</Th>
                    <Th align="right">Last scan</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <TableEmpty colSpan={6}>No repositories match those filters.</TableEmpty>
                  ) : (
                    rows.map((repo) => (
                      <Tr key={repo.id}>
                        <Td>
                          <span className="flex items-center gap-2">
                            <GitHubIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                            <span className="font-medium text-fg">{repo.name}</span>
                          </span>
                        </Td>
                        <Td align="right"><ScanCell value={repo.security.deepScan} /></Td>
                        <Td align="right"><ScanCell value={repo.security.dependencies} /></Td>
                        <Td align="right"><ScanCell value={repo.security.secrets} /></Td>
                        <Td align="right" className="text-fg-subtle">
                          {repo.security.lastScanAt ? relativeTime(repo.security.lastScanAt) : directory.source === "api" ? "—" : "Never"}
                        </Td>
                        <Td align="right">
                          <Button size="sm" variant="ghost" icon={<ScanLine className="h-3.5 w-3.5" />} disabled={directory.source === "api"}>
                            Scan
                          </Button>
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
    </Page>
  );
}
