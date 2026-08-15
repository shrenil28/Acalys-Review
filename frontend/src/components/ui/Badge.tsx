import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "purple"
  | "outline";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-[var(--cr-hover)] text-fg-muted",
  brand: "bg-brand-soft text-brand",
  success: "bg-ok/15 text-ok",
  warning: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  purple: "bg-purple/15 text-purple",
  outline: "border border-line text-fg-subtle",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium leading-4",
        tones[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Severity chips reuse one scale everywhere findings are listed. */
export const severityTone: Record<string, BadgeTone> = {
  Critical: "danger",
  High: "danger",
  Medium: "warning",
  Low: "info",
  Info: "neutral",
};
