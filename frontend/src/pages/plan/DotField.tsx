const GRID = 26;

/** Quiet dotted backdrop behind the planner. Purely decorative. */
export function DotField() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        backgroundImage:
          "radial-gradient(var(--cr-line-strong) 1px, transparent 1px)",
        backgroundSize: `${GRID}px ${GRID}px`,
        backgroundPosition: "12px 12px",
        opacity: 0.5,
      }}
    />
  );
}
