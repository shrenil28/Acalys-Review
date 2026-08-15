import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";

/**
 * Draft state measured against a saved baseline, so a page knows whether it is
 * dirty without every field maintaining its own "changed" flag.
 */
export function useUnsaved<T extends object>(initial: T) {
  const [baseline, setBaseline] = useState<T>(initial);
  const [draft, setDraft] = useState<T>(initial);

  const patch = useCallback(
    (part: Partial<T>) => setDraft((current) => ({ ...current, ...part })),
    [],
  );

  return {
    draft,
    patch,
    setDraft,
    dirty: JSON.stringify(draft) !== JSON.stringify(baseline),
    reset: () => setDraft(baseline),
    commit: () => setBaseline(draft),
  };
}

/**
 * Floating "you have unsaved changes" bar. Every page that holds edits behind
 * an explicit save uses this one, so the affordance is identical everywhere.
 * Portalled to the body: pages that scroll inside a panel would otherwise clip
 * or scroll it away.
 */
export function UnsavedBar({
  open,
  onReset,
  onSave,
  message = "You have unsaved changes",
  saveLabel = "Save changes",
  resetLabel = "Reset",
  saving,
}: {
  open: boolean;
  onReset: () => void;
  onSave: () => void;
  message?: string;
  saveLabel?: string;
  resetLabel?: string;
  saving?: boolean;
}) {
  if (!open) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex animate-scale-in items-center gap-3 rounded-lg border border-line bg-shell py-2 pl-4 pr-2 shadow-pop">
        <span className="text-sm text-fg">{message}</span>
        <Button size="sm" variant="danger" onClick={onReset} disabled={saving}>
          {resetLabel}
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
