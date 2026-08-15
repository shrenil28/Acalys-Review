import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "danger"
  | "brand";
type Size = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  primary:
    "bg-fg text-canvas hover:bg-fg/90 disabled:bg-fg/40 disabled:text-canvas/60",
  brand:
    "bg-brand text-[oklch(0.18_0.03_55)] hover:bg-brand/90 font-medium disabled:opacity-50",
  secondary:
    "bg-[var(--cr-hover)] text-fg hover:bg-[var(--cr-active)] disabled:text-fg-faint",
  outline:
    "border border-line bg-transparent text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg disabled:text-fg-faint",
  ghost:
    "bg-transparent text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg disabled:text-fg-faint",
  danger:
    "bg-transparent border border-danger/40 text-danger hover:bg-danger/10 disabled:opacity-40",
};

const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded",
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-8 px-3 text-sm gap-2 rounded-md",
  lg: "h-9 px-4 text-sm gap-2 rounded-md",
  icon: "h-8 w-8 rounded-md",
  "icon-sm": "h-7 w-7 rounded",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  trailing?: ReactNode;
}

export function buttonClass(variant: Variant = "outline", size: Size = "md") {
  return cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium leading-none transition-colors disabled:cursor-not-allowed",
    variants[variant],
    sizes[size],
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "outline",
      size = "md",
      icon,
      trailing,
      children,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium leading-none transition-colors disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {trailing}
    </button>
  ),
);
Button.displayName = "Button";
