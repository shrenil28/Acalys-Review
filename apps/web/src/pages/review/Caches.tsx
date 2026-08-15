import { useMemo, useState } from "react";
import { ChevronDown, Info, PlusCircle, Search, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { Checkbox } from "@/components/ui/Misc";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { Page } from "@/components/layout/PageHeader";
import { caches as seed, type CacheEntry } from "@/data/review";
import { cn } from "@/lib/utils";

const workflows = ["Review", "Chat", "Fix"] as const;

const workflowTone = {
  Review: "info",
  Chat: "purple",
  Fix: "warning",
} as const;

/** Column header with the small info affordance the app shows. */
function HeadCell({
  label,
  hint,
  sortable,
  onSort,
  className,
}: {
  label: string;
  hint: string;
  sortable?: boolean;
  onSort?: () => void;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line px-3 py-2.5 text-left text-xs font-medium text-fg-muted",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span title={hint} aria-label={hint} className="inline-flex">
          <Info className="h-3 w-3 text-fg-faint" />
        </span>
        {sortable && (
          <button
            type="button"
            onClick={onSort}
            aria-label={`Sort by ${label}`}
            className="text-fg-subtle transition-colors hover:text-fg"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </span>
    </th>
  );
}

/** Filter chip that opens a value picker, matching "+ Repository" / "+ Workflow". */
function FilterChip({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Popover
      panelClassName="w-[220px] max-h-72 overflow-auto"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm transition-colors hover:bg-[var(--cr-hover)]",
            open || selected.length > 0 ? "text-fg" : "text-fg-muted",
          )}
        >
          <PlusCircle className="h-3.5 w-3.5" />
          {label}
          {selected.length > 0 && (
            <span className="rounded bg-brand-soft px-1.5 text-2xs text-brand">
              {selected.length}
            </span>
          )}
        </button>
      )}
    >
      {options.map((option) => (
        <MenuItem
          key={option}
          selected={selected.includes(option)}
          onClick={() =>
            onChange(
              selected.includes(option)
                ? selected.filter((entry) => entry !== option)
                : [...selected, option],
            )
          }
        >
          {option}
        </MenuItem>
      ))}
    </Popover>
  );
}

export function CachesPage() {
  const toast = useToast();
  const [caches, setCaches] = useState<CacheEntry[]>(seed);
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [workflowFilter, setWorkflowFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [ascending, setAscending] = useState(false);

  const repoOptions = useMemo(
    () => [...new Set(seed.map((entry) => entry.repo))].sort(),
    [],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return caches
      .filter((entry) => {
        if (repoFilter.length > 0 && !repoFilter.includes(entry.repo)) return false;
        if (workflowFilter.length > 0 && !workflowFilter.includes(entry.workflow))
          return false;
        if (!needle) return true;
        return (
          entry.repo.toLowerCase().includes(needle) ||
          entry.cacheId.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) =>
        ascending
          ? a.workflow.localeCompare(b.workflow)
          : b.timestamp.localeCompare(a.timestamp),
      );
  }, [caches, query, repoFilter, workflowFilter, ascending]);

  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  const deleteSelected = () => {
    setCaches((current) => current.filter((entry) => !selected.includes(entry.id)));
    toast({
      title: `${selected.length} ${selected.length === 1 ? "cache" : "caches"} deleted`,
      description: "Acalys rebuilds them on the next run.",
      tone: "info",
    });
    setSelected([]);
    setConfirming(false);
  };

  return (
    <Page className="max-w-[1040px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-fg">Caches</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">
          Acalys saves reusable sandbox caches after it prepares a repository
          for review, chat, or fix workflows. Each cache includes the prepared
          repository and installed dependencies so future runs can start faster.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-fg-muted">
          This page only shows ready caches Acalys can use. Caches expire
          automatically after 7 days. Delete a cache to remove Acalys's saved
          sandbox copy or to make Acalys rebuild it on the next run.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Input
          icon={<Search className="h-3.5 w-3.5" />}
          placeholder="Search repositories or cache IDs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="w-full max-w-[240px]"
        />
        <FilterChip
          label="Repository"
          options={repoOptions}
          selected={repoFilter}
          onChange={setRepoFilter}
        />
        <FilterChip
          label="Workflow"
          options={[...workflows]}
          selected={workflowFilter}
          onChange={setWorkflowFilter}
        />
        {selected.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs tabular-nums text-fg-subtle">
              {selected.length} selected
            </span>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setConfirming(true)}
            >
              Delete
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setSelected([])}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className="w-10 border-b border-line px-3 py-2.5">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && selected.length > 0}
                    onChange={() =>
                      setSelected(allSelected ? [] : rows.map((row) => row.id))
                    }
                    label="Select all caches"
                  />
                </th>
                <HeadCell
                  label="Repository"
                  hint="The repository this sandbox was prepared from."
                />
                <HeadCell
                  label="Workflow"
                  hint="Which workflow prepared the cache: review, chat, or fix."
                  sortable
                  onSort={() => setAscending((value) => !value)}
                />
                <HeadCell
                  label="Timestamp"
                  hint="When the snapshot was taken. Caches expire after 7 days."
                />
                <HeadCell
                  label="Cache ID"
                  hint="Identifier for the stored sandbox copy."
                />
                <th scope="col" className="w-10 border-b border-line px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-16 text-center text-sm text-fg-subtle"
                  >
                    No caches yet.
                  </td>
                </tr>
              ) : (
                rows.map((entry) => {
                  const checked = selected.includes(entry.id);
                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        "border-b border-line/60 transition-colors last:border-b-0 hover:bg-[var(--cr-hover)]",
                        checked && "bg-[var(--cr-hover)]",
                      )}
                    >
                      <td className="px-3 py-2.5">
                        <Checkbox
                          checked={checked}
                          onChange={() =>
                            setSelected((current) =>
                              checked
                                ? current.filter((id) => id !== entry.id)
                                : [...current, entry.id],
                            )
                          }
                          label={`Select ${entry.cacheId}`}
                        />
                      </td>
                      <td className="px-3 py-2.5 font-medium text-fg">{entry.repo}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={workflowTone[entry.workflow]}>
                          {entry.workflow}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">
                        {new Date(entry.timestamp).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-muted">
                        {entry.cacheId}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${entry.cacheId}`}
                          onClick={() => {
                            setSelected([entry.id]);
                            setConfirming(true);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={
          selected.length === 1 ? "Delete this cache?" : `Delete ${selected.length} caches?`
        }
        description="Acalys removes its saved sandbox copy and rebuilds it on the next run, which makes that run slower than usual."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteSelected}>
              Delete
            </Button>
          </>
        }
      />
    </Page>
  );
}
