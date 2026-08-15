import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Lightweight popover used for every dropdown in the app chrome. */
export function Popover({
  trigger,
  children,
  align = "start",
  className,
  panelClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 min-w-[200px] animate-scale-in rounded-lg border border-line bg-shell p-1 shadow-pop",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
          role="menu"
        >
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  onClick,
  selected,
  disabled,
  tone = "default",
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
        tone === "danger" ? "text-danger hover:bg-danger/10" : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        disabled && "cursor-not-allowed text-fg-faint hover:bg-transparent hover:text-fg-faint",
      )}
    >
      {icon && <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {selected && <Check className="h-3.5 w-3.5 text-brand" />}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-fg-faint">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />;
}

/**
 * Filter control used across dashboards — renders as
 * `[icon] Label · value ▾` the way the Grafana-backed views do.
 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  icon?: ReactNode;
}) {
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title={`${label}: ${value}`}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs transition-colors hover:bg-[var(--cr-hover)]",
            open ? "bg-[var(--cr-hover)] text-fg" : "text-fg-muted",
          )}
        >
          {icon}
          <span>{label}</span>
          <span className="text-fg-faint">·</span>
          <span className="max-w-[120px] truncate text-fg">{value}</span>
          <ChevronDown className="h-3 w-3 text-fg-subtle" />
        </button>
      )}
      panelClassName="max-h-72 overflow-auto"
    >
      {(close) => (
        <>
          {options.map((option) => (
            <MenuItem
              key={option}
              selected={option === value}
              onClick={() => {
                onChange(option);
                close();
              }}
            >
              {option}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}
