import { useMemo, useState } from "react";
import { PlusCircle, Search } from "lucide-react";
import { Popover } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";

function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors",
        checked ? "border-brand" : "border-[var(--cr-line-strong)]",
      )}
    >
      {checked && <span className="h-[7px] w-[7px] rounded-full bg-brand" />}
    </span>
  );
}

/**
 * Single-value sibling of {@link FilterChip}: the chip carries the current
 * value inline (`⊕ Role  All`) and the panel is a searchable radio list with a
 * Clear row instead of checkboxes.
 */
export function RadioFilterChip({
  label,
  options,
  value,
  fallback = options[0],
  onChange,
  panelWidth = 220,
}: {
  label: string;
  options: string[];
  value: string;
  /** Value the Clear row restores — the neutral "All"-style option. */
  fallback?: string;
  onChange: (next: string) => void;
  panelWidth?: number;
}) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <Popover
      panelClassName="p-0"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm transition-colors hover:bg-[var(--cr-hover)]",
            open || value !== fallback ? "text-fg" : "text-fg-muted",
          )}
        >
          <PlusCircle className="h-3.5 w-3.5" />
          {label}
          <span className="rounded bg-[var(--cr-hover)] px-1.5 py-0.5 text-2xs text-fg-muted">
            {value}
          </span>
        </button>
      )}
    >
      {(close) => (
        <div style={{ width: panelWidth }}>
          <div className="flex h-9 items-center gap-2 border-b border-line px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={label}
              className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>

          <div className="max-h-[240px] overflow-y-auto py-1">
            {visible.length === 0 ? (
              <p className="px-3 py-5 text-center text-xs text-fg-subtle">
                No matches for "{query}".
              </p>
            ) : (
              visible.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    onChange(option);
                    close();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-[var(--cr-hover)]"
                >
                  <Radio checked={option === value} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      option === value ? "text-fg" : "text-fg-muted",
                    )}
                  >
                    {option}
                  </span>
                </button>
              ))
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (fallback) onChange(fallback);
              setQuery("");
              close();
            }}
            className="w-full border-t border-line py-2 text-center text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
          >
            Clear
          </button>
        </div>
      )}
    </Popover>
  );
}
