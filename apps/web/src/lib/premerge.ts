/**
 * Whether the merge is blocked, and why — never as a boolean.
 *
 * # Enforcement is not a boolean
 *
 * The obvious shape is `blocked: boolean`, and it is wrong in a specific,
 * dangerous way. Every unknown collapses to `false`:
 *
 * ```ts
 * const blocked = !!result?.blocking;   // offline → false → "merge allowed"
 * ```
 *
 * A failed request means the frontend does not know whether merging is safe.
 * That is not the same as knowing it is. So this is a union with an explicit
 * `unknown`, and the wrong answer is unrepresentable rather than merely
 * discouraged.
 *
 * # Status is not blocking
 *
 * Two independent facts, and the UI must not fuse them:
 *
 * ```
 * status     what did the check conclude?
 * blocking   does policy make that conclusion prevent merge?
 * ```
 *
 * `failed` with `blocking: false` is a real and common state — a reviewer that
 * blocks merges the day it is installed gets uninstalled. It reads as *check
 * failed, merge not blocked*, and never as `Passed`.
 *
 * This is the P1-I separation arriving at the last surface that could undo it:
 *
 * ```
 * truth ─→ publication policy ─→ what a developer is told
 *   └────→ pre-merge policy ───→ whether they may merge
 * ```
 *
 * Nothing here derives one from the other. Severity does not decide blocking;
 * the backend already decided it.
 */

import type { PreMergeCheckDto } from "@acalys/contracts/api/v1";

function assertNever(value: never): never {
  throw new Error(`Unhandled pre-merge value: ${String(value)}`);
}

/** How a single check reads. Deliberate for every status the contract has. */
export type CheckPresentation =
  | { readonly kind: "settled"; readonly label: string }
  /** Still running, or never ran. Not a verdict. */
  | { readonly kind: "unsettled"; readonly label: string };

export function presentStatus(
  status: PreMergeCheckDto["status"],
): CheckPresentation {
  switch (status) {
    case "passed":
      return { kind: "settled", label: "Passed" };
    case "failed":
      return { kind: "settled", label: "Failed" };
    case "inconclusive":
      // The check ran and could not decide. Not `Passed` — nothing was
      // established — and not `Failed`, because nothing was refuted either.
      return { kind: "settled", label: "Inconclusive" };
    case "skipped":
      return { kind: "settled", label: "Skipped" };
    case "pending":
      return { kind: "unsettled", label: "Pending" };
    case "running":
      return { kind: "unsettled", label: "Running" };
    default:
      return assertNever(status);
  }
}

export interface CheckView {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** Straight from the backend. Never inferred from status or severity. */
  readonly blocking: boolean;
  readonly settled: boolean;
  readonly explanation: string | undefined;
}

/**
 * What the enforcement surface may say.
 *
 * `unknown` is a first-class answer, and the reason it exists: a transport
 * failure, a contract failure, or a result for a revision other than the one on
 * screen all mean the frontend cannot speak to whether this change may merge.
 * Rendering any of them as "not blocked" would be the enforcement equivalent of
 * reporting an outage as a clean review.
 */
export type MergeGate =
  | { readonly kind: "blocked"; readonly checks: readonly CheckView[] }
  | { readonly kind: "not_blocked"; readonly checks: readonly CheckView[] }
  | { readonly kind: "unknown"; readonly reason: string };

export function toCheckViews(
  checks: readonly PreMergeCheckDto[],
): readonly CheckView[] {
  return checks.map((check) => {
    const presentation = presentStatus(check.status);
    return {
      id: check.id,
      name: check.name,
      label: presentation.label,
      blocking: check.blocking,
      settled: presentation.kind === "settled",
      explanation: check.explanation,
    };
  });
}

/**
 * Whether these checks block the merge.
 *
 * The rule is the backend's, copied deliberately rather than reasoned out
 * again:
 *
 * ```
 * blocking && status === "failed"
 * ```
 *
 * The first version of this function blocked on `blocking` alone, which would
 * have stopped a merge on a check that PASSED while being configured to block.
 * Two implementations of one policy is one policy too many — this mirrors
 * `blocksMerge` in the review engine, and a divergence between them is a bug
 * in this file by definition.
 *
 * It consults nothing else. Not severity, not the number of findings, and it
 * does not treat "no checks" as permission — a review that evaluated nothing
 * has not approved anything.
 */
export function gateFrom(checks: readonly PreMergeCheckDto[]): MergeGate {
  const views = toCheckViews(checks);

  if (views.length === 0) {
    return {
      kind: "unknown",
      reason: "no pre-merge checks were reported for this revision",
    };
  }

  // A blocking check that has not finished is not permission either. `pending`
  // means the answer has not arrived, and calling that `not_blocked` would let
  // a merge proceed on a check that was still running.
  const unsettledBlocking = views.filter(
    (view) => view.blocking && !view.settled,
  );
  if (unsettledBlocking.length > 0) {
    return {
      kind: "unknown",
      reason: `${String(unsettledBlocking.length)} blocking check(s) have not finished`,
    };
  }

  return checks.some(
    (check) => check.blocking && check.status === "failed",
  )
    ? { kind: "blocked", checks: views }
    : { kind: "not_blocked", checks: views };
}
