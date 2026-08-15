import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Styled hover label. Portalled to the body because the rail it is used from
 * scrolls, and a scroll container would clip an absolutely positioned chip.
 */
export function Tooltip({
  label,
  side = "right",
  children,
}: {
  label: string;
  side?: "right" | "top";
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const anchorRef = useRef<HTMLSpanElement>(null);

  const show = () => {
    // The wrapper is `display: contents` and has no box of its own, so the
    // position has to come from the element it wraps.
    const target = anchorRef.current?.firstElementChild ?? anchorRef.current;
    const rect = target?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    setPosition(
      side === "right"
        ? { top: rect.top + rect.height / 2, left: rect.right + 8 }
        : { top: rect.top - 8, left: rect.left + rect.width / 2 },
    );
  };

  return (
    <>
      <span
        ref={anchorRef}
        className="contents"
        onMouseEnter={show}
        onMouseLeave={() => setPosition(null)}
        onFocus={show}
        onBlur={() => setPosition(null)}
      >
        {children}
      </span>
      {position &&
        createPortal(
          <span
            role="tooltip"
            style={{
              top: position.top,
              left: position.left,
              transform:
                side === "right" ? "translateY(-50%)" : "translate(-50%, -100%)",
            }}
            className="pointer-events-none fixed z-[90] whitespace-nowrap rounded-md border border-line bg-shell px-2 py-1 text-xs text-fg shadow-pop"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
