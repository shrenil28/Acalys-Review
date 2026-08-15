import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { Button } from "./Button";

export function Avatar({
  src,
  name,
  size = 24,
  className,
}: {
  src?: string;
  name: string;
  size?: number;
  className?: string;
}) {
  return src ? (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full object-cover", className)}
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-[var(--cr-active)] font-medium text-fg-muted",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand" : "bg-[var(--cr-line-strong)]",
      )}
    >
      <span
        className={cn(
          "absolute h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[16px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  indeterminate?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked || indeterminate
          ? "border-brand bg-brand text-[oklch(0.18_0.03_55)]"
          : "border-line-strong bg-transparent hover:border-fg-subtle",
      )}
    >
      {indeterminate ? (
        <span className="h-0.5 w-2 rounded-full bg-current" />
      ) : checked ? (
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-canvas p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2 py-1 text-xs font-medium transition-colors",
            option.value === value
              ? "bg-[var(--cr-active)] text-fg"
              : "text-fg-subtle hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--cr-hover)] text-fg-subtle [&>svg]:h-5 [&>svg]:w-5">
          {icon}
        </span>
      )}
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        {description && (
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-fg-subtle">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  detached,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  /** Right-aligned pill below the table rather than a footer row inside it. */
  detached?: boolean;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center gap-3 px-3 py-1.5",
        detached
          ? "ml-auto w-fit divide-x divide-line rounded-lg border border-line bg-surface"
          : "justify-between border-t border-line py-2",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-fg-subtle">
        <span>Rows per page</span>
        <span className="relative flex items-center">
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange?.(Number(event.target.value))}
            className="h-6 appearance-none rounded bg-transparent pl-1 pr-5 text-xs text-fg outline-none hover:bg-[var(--cr-hover)]"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <ChevronsUpDown className="pointer-events-none absolute right-1 h-3 w-3 text-fg-subtle" />
        </span>
      </div>

      <div className={cn("flex items-center gap-1", pageCount <= 1 && "hidden")}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        {Array.from({ length: Math.min(pageCount, 5) }, (_, index) => {
          const target =
            pageCount <= 5
              ? index + 1
              : Math.min(Math.max(page - 2, 1), pageCount - 4) + index;
          return (
            <button
              key={target}
              type="button"
              onClick={() => onPageChange(target)}
              className={cn(
                "h-7 min-w-[28px] rounded px-1.5 text-xs transition-colors",
                target === page
                  ? "bg-[var(--cr-active)] text-fg"
                  : "text-fg-subtle hover:bg-[var(--cr-hover)] hover:text-fg",
              )}
            >
              {target}
            </button>
          );
        })}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      <span className={cn("text-xs tabular-nums text-fg-subtle", detached && "pl-3")}>
        {from}–{to} / {total}
      </span>
    </nav>
  );
}

export function Progress({
  value,
  tone = "brand",
  className,
}: {
  value: number;
  tone?: "brand" | "ok" | "danger" | "warn" | "info";
  className?: string;
}) {
  const toneClass = {
    brand: "bg-brand",
    ok: "bg-ok",
    danger: "bg-danger",
    warn: "bg-warn",
    info: "bg-info",
  }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--cr-hover)]", className)}>
      <div
        className={cn("h-full rounded-full transition-[width]", toneClass)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
