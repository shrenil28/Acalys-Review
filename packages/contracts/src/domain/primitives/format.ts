/**
 * Safe rendering of untrusted values into error messages (P0.txt §63, §65, §96).
 *
 * Validation errors must name the offending value to be actionable — "Invalid
 * input" helps nobody (§96). But the offending value is by definition
 * untrusted: it may be megabytes long, contain control characters that corrupt
 * a terminal or log line, or carry content that should not be spliced into a
 * message verbatim.
 *
 * This module is the single sanctioned place to do that rendering, and one of
 * only two files permitted to call `JSON.stringify` (the other is
 * `canonical-json.ts`). The package-wide ban exists because hashing
 * `JSON.stringify` output is non-deterministic (§58) — but quoting a string
 * for a human to read is a different job, and centralizing it here keeps the
 * ban strict while giving call sites a correct tool.
 */

/** Longest rendered value in an error message. Beyond this, truncate. */
const MAX_RENDERED_LENGTH = 120;

/**
 * Renders a value for a human, quoted, escaped, and length-bounded.
 *
 * Escaping matters: a raw value containing a newline or an ANSI escape can
 * forge log lines. `JSON.stringify` escapes control characters, so the output
 * is always a single safe line.
 */
export function quoteValue(value: unknown): string {
  if (typeof value === "string") {
    const quoted = JSON.stringify(value);
    return quoted.length <= MAX_RENDERED_LENGTH
      ? quoted
      : `${quoted.slice(0, MAX_RENDERED_LENGTH)}…" (truncated)`;
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  // Objects and arrays are described by shape, never by content: their
  // contents are untrusted and may be large or sensitive.
  if (Array.isArray(value)) {
    return `<array of ${String(value.length)}>`;
  }
  return `<${typeof value}>`;
}

/**
 * Truncates an untrusted string for an error's `details`.
 *
 * `details` reaches API responses and logs, so an unbounded provider string
 * would blow up both (§65).
 */
export function truncateForDetails(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
