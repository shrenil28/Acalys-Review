import type { LiveFailure } from "@/lib/api/liveDashboard";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Info, PlusCircle, Search, Trash2, X } from "lucide-react";
import { LiveEmptyState, LiveFailureState, LiveTableLoading } from "@/components/live/LiveDataState";
import { Page } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { Checkbox } from "@/components/ui/Misc";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { deleteReviewCaches, loadReviewCaches, type DashboardReviewCache } from "@/lib/api/dashboardAdmin";
import { cn } from "@/lib/utils";

function HeadCell({ label, hint, sortable, onSort }: { label: string; hint: string; sortable?: boolean; onSort?: () => void }) {
  return (
    <th scope="col" className="border-b border-line px-3 py-2.5 text-left text-xs font-medium text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span title={hint} aria-label={hint} className="inline-flex"><Info className="h-3 w-3 text-fg-faint" /></span>
        {sortable ? <button type="button" onClick={onSort} aria-label={`Sort by ${label}`} className="text-fg-subtle transition-colors hover:text-fg"><ChevronDown className="h-3 w-3" /></button> : null}
      </span>
    </th>
  );
}

function FilterChip({ label, options, selected, onChange }: { label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <Popover
      panelClassName="w-[220px] max-h-72 overflow-auto"
      trigger={({ open, toggle }) => (
        <button type="button" onClick={toggle} className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm transition-colors hover:bg-[var(--cr-hover)]", open || selected.length > 0 ? "text-fg" : "text-fg-muted")}>
          <PlusCircle className="h-3.5 w-3.5" />
          {label}
          {selected.length > 0 ? <span className="rounded bg-brand-soft px-1.5 text-2xs text-brand">{selected.length}</span> : null}
        </button>
      )}
    >
      {options.map((option) => (
        <MenuItem key={option} selected={selected.includes(option)} onClick={() => onChange(selected.includes(option) ? selected.filter((entry) => entry !== option) : [...selected, option])}>
          {option}
        </MenuItem>
      ))}
    </Popover>
  );
}

function failure(result: Awaited<ReturnType<typeof loadReviewCaches>>): LiveFailure {
  if (result.kind === "rejected") return { kind: "rejected", status: result.status, category: result.category, detail: result.detail };
  if (result.kind === "transport" || result.kind === "contract") return { kind: result.kind, detail: result.detail };
  return { kind: "contract", detail: result.kind === "misconfigured" ? result.detail : "The cache response could not be loaded." };
}

export function LiveCachesPage() {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [failureState, setFailureState] = useState<ReturnType<typeof failure> | null>(null);
  const [caches, setCaches] = useState<readonly DashboardReviewCache[]>([]);
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [ascending, setAscending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadReviewCaches(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setCaches(result.value.items);
        setFailureState(null);
        setState("ready");
      } else {
        setFailureState(failure(result));
        setState("failed");
      }
    });
    return () => controller.abort();
  }, []);

  const repoOptions = useMemo(() => [...new Set(caches.map((entry) => entry.repositoryName))].sort(), [caches]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...caches]
      .filter((entry) => {
        if (repoFilter.length > 0 && !repoFilter.includes(entry.repositoryName)) return false;
        if (!needle) return true;
        return entry.repositoryName.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle) || entry.fingerprint.includes(needle);
      })
      .sort((left, right) => ascending ? left.updatedAt.localeCompare(right.updatedAt) : right.updatedAt.localeCompare(left.updatedAt));
  }, [ascending, caches, query, repoFilter]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  const deleteSelected = async () => {
    if (selected.length === 0 || deleting) return;
    setDeleting(true);
    const result = await deleteReviewCaches(selected);
    setDeleting(false);
    if (result.kind !== "ok") {
      toast({ title: "Cache deletion failed", description: result.kind === "misconfigured" ? result.detail : "Reload the page and try again.", tone: "error" });
      return;
    }
    const removed = new Set(selected);
    setCaches((current) => current.filter((entry) => !removed.has(entry.id)));
    toast({ title: `${result.value.deleted} ${result.value.deleted === 1 ? "cache" : "caches"} deleted`, description: "Matching analysis is recomputed before it can be cached again.", tone: "info" });
    setSelected([]);
    setConfirming(false);
  };

  return (
    <Page className="max-w-[1040px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-fg">Caches</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">
          Acalys keeps successful deterministic review-analysis results for unchanged risk clusters so later reviews can reuse proven work instead of recomputing it.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">
          Only ready, non-expired review caches are shown. Entries expire automatically after 7 days. Deleting one removes the reusable result immediately; a future matching review must recompute it before a new cache is available.
        </p>
      </header>

      {state === "loading" ? <div className="mt-6"><LiveTableLoading columns={6} /></div> : null}
      {state === "failed" && failureState !== null ? <div className="mt-6"><LiveFailureState failure={failureState} /></div> : null}
      {state === "ready" && caches.length === 0 ? <div className="mt-6"><LiveEmptyState title="No ready review caches" description="A cache appears after a successful review analyzes a reusable cluster." /></div> : null}
      {state === "ready" && caches.length > 0 ? (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Input icon={<Search className="h-3.5 w-3.5" />} placeholder="Search repositories or cache IDs" value={query} onChange={(event) => setQuery(event.target.value)} wrapperClassName="w-full max-w-[240px]" />
            <FilterChip label="Repository" options={repoOptions} selected={repoFilter} onChange={setRepoFilter} />
            <Badge tone="info">Review</Badge>
            {selected.length > 0 ? (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs tabular-nums text-fg-subtle">{selected.length} selected</span>
                <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirming(true)}>Delete</Button>
                <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => setSelected([])}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ) : null}
          </div>

          <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead><tr>
                  <th scope="col" className="w-10 border-b border-line px-3 py-2.5"><Checkbox checked={allSelected} indeterminate={!allSelected && selected.length > 0} onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.id))} label="Select all caches" /></th>
                  <HeadCell label="Repository" hint="The repository whose deterministic cluster result can be reused." />
                  <HeadCell label="Workflow" hint="This durable cache is consumed only by the review workflow." />
                  <HeadCell label="Last refreshed" hint="When this reusable analysis result was most recently written." sortable onSort={() => setAscending((value) => !value)} />
                  <HeadCell label="Size" hint="Serialized analysis-result payload size, not repository or sandbox size." />
                  <HeadCell label="Cache ID" hint="Stable identifier for this persisted reusable analysis result." />
                  <th scope="col" className="w-10 border-b border-line px-3 py-2.5" />
                </tr></thead>
                <tbody>
                  {rows.map((entry) => {
                    const checked = selected.includes(entry.id);
                    return <tr key={entry.id} className={cn("border-b border-line/60 transition-colors last:border-b-0 hover:bg-[var(--cr-hover)]", checked && "bg-[var(--cr-hover)]")}>
                      <td className="px-3 py-2.5"><Checkbox checked={checked} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== entry.id) : [...current, entry.id])} label={`Select ${entry.id}`} /></td>
                      <td className="px-3 py-2.5 font-medium text-fg">{entry.repositoryName}</td>
                      <td className="px-3 py-2.5"><Badge tone="info">Review</Badge></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">{new Date(entry.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">{entry.sizeBytes < 1024 ? `${entry.sizeBytes} B` : `${(entry.sizeBytes / 1024).toFixed(1)} KB`}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-muted">acl-cache-{entry.id.slice(0, 12)}</td>
                      <td className="px-3 py-2.5 text-right"><Button size="icon-sm" variant="ghost" aria-label={`Delete ${entry.id}`} onClick={() => { setSelected([entry.id]); setConfirming(true); }}><Trash2 className="h-3.5 w-3.5" /></Button></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <Modal open={confirming} onClose={() => { if (!deleting) setConfirming(false); }} title={selected.length === 1 ? "Delete this cache?" : `Delete ${selected.length} caches?`} description="Acalys removes the persisted analysis result immediately. The next matching review recomputes that work before it can be cached again." size="sm" footer={<><Button variant="ghost" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</Button><Button variant="danger" disabled={deleting} onClick={() => void deleteSelected()}>{deleting ? "Deleting…" : "Delete"}</Button></>} />
    </Page>
  );
}
