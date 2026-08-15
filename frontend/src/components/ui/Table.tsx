import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function TableShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-line bg-surface",
        className,
      )}
    >
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full min-w-[720px] border-collapse text-sm">{children}</table>;
}

export function Th({
  children,
  sortable,
  direction,
  onSort,
  align = "left",
  className,
}: {
  children: ReactNode;
  sortable?: boolean;
  direction?: "asc" | "desc" | null;
  onSort?: () => void;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  const Icon =
    direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-subtle",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "group inline-flex items-center gap-1 transition-colors hover:text-fg",
            align === "right" && "flex-row-reverse",
          )}
        >
          {children}
          <Icon
            className={cn(
              "h-3 w-3 transition-opacity",
              direction ? "opacity-100 text-fg" : "opacity-0 group-hover:opacity-60",
            )}
          />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  colSpan,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "border-b border-line/60 px-3 py-2.5 text-fg-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        "transition-colors last:[&>td]:border-b-0",
        onClick && "cursor-pointer hover:bg-[var(--cr-hover)]",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TableEmpty({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-10 text-center text-sm text-fg-subtle"
      >
        {children}
      </td>
    </tr>
  );
}
