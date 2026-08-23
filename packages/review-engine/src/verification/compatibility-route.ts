/**
 * P1-M.3 — turning a comparison verdict into a verification attempt.
 *
 * Shared by both compatibility capabilities so the abstention rules cannot
 * drift apart between them. Everything specific to a capability arrives as a
 * parameter; nothing about `removed_export` or `required_parameter_added` is
 * decided here.
 *
 * # The abstention that matters
 *
 * A comparison capability handed no comparison revision has learned nothing.
 * The tempting reading — "no base, so nothing was removed" — is a negative
 * conclusion drawn from our own missing input, and it is silent when wrong:
 * the review comes back clean and looks like a review that ran.
 */

import type { ComparisonVerdict } from "./compatibility-probe.js";
import type {
  VerificationAttempt,
  VerificationContext,
  VerificationReason,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

/** Always a completed attempt: this procedure never fails to run. */
type CompletedAttempt = Extract<VerificationAttempt, { status: "completed" }>;

export interface CompatibilityRevisions {
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly headFiles: ReadonlyMap<string, string>;
}

export function adjudicateCompatibility(options: {
  readonly input: VerificationInput;
  readonly context: VerificationContext;
  readonly capability: string;
  readonly run: (
    revisions: CompatibilityRevisions,
  ) => ComparisonVerdict | undefined;
  readonly verifiedReason: VerificationReason;
  readonly rejectedReason: VerificationReason;
}): CompletedAttempt {
  const { context } = options;

  const abstain = (): CompletedAttempt => ({
    status: "completed",
    decision: "inconclusive",
    reasons: ["comparison_revision_unavailable"],
    confidence: 0.2,
    severity: options.input.proposedSeverity,
  });

  if (context.comparison === undefined) return abstain();

  // The whole head revision, never the planner's selection. See the note on
  // `VerificationContext.revision`: compiling against the reading selection
  // makes an unresolved `export *` look like a removal.
  const headFiles =
    context.revision?.files ??
    new Map(context.items.map((item) => [item.path, item.content]));
  const verdict = options.run({
    baseFiles: context.comparison.files,
    headFiles,
  });

  // The claim did not parse into a query this capability can run. Abstaining
  // rather than guessing: a verifier that invented a query would be
  // adjudicating a proposition nobody stated.
  if (verdict === undefined) return abstain();

  if (verdict.kind === "verified") {
    return {
      status: "completed",
      decision: "verified",
      reasons: [options.verifiedReason],
      // The compiler exhibited the break against a consumer proven valid at
      // base. Confidence describes the procedure, not enthusiasm.
      confidence: 0.95,
      severity: options.input.proposedSeverity,
    };
  }

  if (verdict.kind === "rejected") {
    return {
      status: "completed",
      decision: "rejected",
      reasons: [options.rejectedReason],
      confidence: 0.95,
      severity: options.input.proposedSeverity,
    };
  }

  return abstain();
}
