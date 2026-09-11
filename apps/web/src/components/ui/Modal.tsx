import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: "max-w-lg", md: "max-w-2xl", lg: "max-w-4xl" };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 pt-[10vh]">
      <div
        className="fixed inset-0 bg-black/45 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 w-full animate-scale-in rounded-lg border border-line bg-shell shadow-pop",
          widths[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-medium text-fg">{title}</h2>
            {description && (
              <p className="mt-1 text-xs text-fg-subtle">{description}</p>
            )}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
        {children && <div className="px-5 py-5">{children}</div>}
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Two panel shapes, named rather than passed as classes so every drawer in the
 * app lands on one of them instead of drifting to a bespoke geometry per page.
 *
 * `default` is a narrow sheet flush to the right edge, for a form.
 * `wide` is the inset panel used for browsing: it floats clear of the viewport
 * edges and stops short of the left navigation, so the surrounding app stays
 * visible and the panel reads as covering the content rather than replacing it.
 */
const DRAWER_SHAPE = {
  default: "right-0 top-0 h-full max-w-xl border-l border-line",
  wide:
    "inset-y-4 right-2 md:right-3 w-[calc(100%-16px)] md:w-[calc(100%-300px)] " +
    "max-w-[1280px] rounded-lg border border-line-strong",
} as const;

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  size = "default",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof DRAWER_SHAPE;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // The page behind a modal must not scroll: a wheel gesture aimed at the
    // panel otherwise moves the content underneath it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute flex w-full flex-col overflow-hidden bg-shell shadow-pop",
          DRAWER_SHAPE[size],
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">{title}</div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
}
