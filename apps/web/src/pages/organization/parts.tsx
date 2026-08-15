import { useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { Textarea } from "@/components/ui/Input";
import { cn } from "@/lib/utils";

/** Section card used by every settings group. */
export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        {action}
      </header>
      <div className="divide-y divide-line px-4">{children}</div>
    </section>
  );
}

/**
 * Chip that jumps to the matching block in the live preview, the way the
 * app links each setting to the part of the comment it controls.
 */
export function ViewChip({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-line px-1.5 text-2xs text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
    >
      <Eye className="h-3 w-3" />
      View
    </button>
  );
}

/**
 * Setting row: label (plus optional View chip) and control on one line, with
 * the description wrapping underneath at full width.
 */
export function Row({
  label,
  description,
  control,
  viewTarget,
  onView,
  children,
}: {
  label: string;
  description?: ReactNode;
  control?: ReactNode;
  viewTarget?: string;
  onView?: (target: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-sm text-fg">{label}</p>
          {viewTarget && <ViewChip onClick={() => onView?.(viewTarget)} />}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {description && (
        <div className="mt-1.5 max-w-xl text-xs leading-relaxed text-fg-subtle">
          {description}
        </div>
      )}
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}

/**
 * Long instruction blurb that collapses to two lines behind a "Show more"
 * link, then a free-text box for the override itself.
 */
export function InstructionsBlock({
  label,
  blurb,
  value,
  onChange,
  placeholder = "Content",
}: {
  label: string;
  blurb: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-4">
      <p className="text-sm text-fg">{label}</p>
      <p
        className={cn(
          "mt-1.5 max-w-xl text-xs leading-relaxed text-fg-subtle",
          !expanded && "line-clamp-2",
        )}
      >
        {blurb}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="mt-1 text-xs font-medium text-brand transition-opacity hover:opacity-80"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
      <Textarea
        rows={4}
        className="mt-2.5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 min-w-[136px] appearance-none rounded-md border border-line bg-canvas bg-[length:14px] bg-[right_8px_center] bg-no-repeat py-0 pl-2.5 pr-7 text-sm text-fg outline-none transition-colors hover:border-line-strong"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8493' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export const severityOptions = [
  { value: "off", label: "Off" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
];
