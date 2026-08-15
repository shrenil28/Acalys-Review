import { useMemo, useState } from "react";
import { PlusCircle, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/Misc";
import { Popover } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";

/** One row of the value list — checkbox plus label, the whole row clickable. */
function Option({
  label,
  checked,
  onToggle,
  emphasis,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--cr-hover)]"
    >
      <Checkbox checked={checked} onChange={onToggle} label={label} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          emphasis ? "text-fg" : "text-fg-muted",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * `⊕ Label` filter chip. The panel is searchable rather than scroll-only, with
 * "Selected" and "All" rows above the values — long repository lists are
 * unusable otherwise.
 */
export function FilterChip({
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
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = onlySelected
      ? options.filter((option) => selected.includes(option))
      : options;
    if (!needle) return pool;
    return pool.filter((option) => option.toLowerCase().includes(needle));
  }, [options, query, onlySelected, selected]);

  const toggle = (option: string) =>
    onChange(
      selected.includes(option)
        ? selected.filter((entry) => entry !== option)
        : [...selected, option],
    );

  return (
    <Popover
      panelClassName="w-[260px] p-0"
      trigger={({ open, toggle: openPanel }) => (
        <button
          type="button"
          onClick={openPanel}
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
      <div className="p-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={label}
            className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>
      </div>

      <div className="border-t border-line px-2 py-1">
        <Option
          label={`Selected (${selected.length})`}
          checked={onlySelected}
          onToggle={() => setOnlySelected((value) => !value)}
          emphasis
        />
        <Option
          label="All"
          checked={selected.length === 0}
          onToggle={() => {
            onChange([]);
            setOnlySelected(false);
          }}
          emphasis
        />
      </div>

      <div className="max-h-[248px] overflow-y-auto border-t border-line px-2 py-1">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-fg-subtle">
            No matches for "{query}".
          </p>
        ) : (
          visible.map((option) => (
            <Option
              key={option}
              label={option}
              checked={selected.includes(option)}
              onToggle={() => toggle(option)}
            />
          ))
        )}
      </div>
    </Popover>
  );
}
