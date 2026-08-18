/**
 * The trust boundary: deciding what becomes product output.
 *
 * Everything before this point is allowed to be wrong. Analyzers hypothesize,
 * verification fails to establish things, workers retry and contradict
 * themselves. After this point:
 *
 * > Acalys has decided that this defect is sufficiently established **and**
 * > sufficiently actionable to consume a developer's attention.
 *
 * Those are two decisions, not one, and collapsing them is the mistake this
 * module exists to prevent:
 *
 * ```
 * verification      is the defect real?
 * publication       should the developer be interrupted about it, here?
 * ```
 *
 * A real, verified bug can legitimately be **withheld** — below the configured
 * severity floor, in an excluded path, already commented on last push. So
 * `verified → published` is not automatic, and nothing in this file lets it
 * become so.
 *
 * # Deterministic on purpose
 *
 * No model. Same finding, same configuration, same prior state — same decision
 * and same reason, every time. A nondeterministic gate at the trust boundary
 * would make "why did it comment on this?" unanswerable, which is the one
 * question a reviewer must always be able to answer.
 *
 * # It emits a plan, not provider rows
 *
 * ```
 * PublicationPolicy → PublicationPlan → ProviderPublisher → effects
 * ```
 *
 * never
 *
 * ```
 * PublicationPolicy → INSERT github_publications
 * ```
 *
 * The same verified defect must not need re-verifying because the rendering
 * destination changed from GitHub to GitLab, a CLI, or an IDE.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";

/**
 * Why a finding was published or withheld.
 *
 * Closed, because "why is this bot commenting?" and "why did it go quiet?" are
 * the two questions asked of a reviewer in production, and free text makes
 * neither aggregatable.
 */
export const PUBLICATION_REASONS = [
  "actionable",
  "severity_below_threshold",
  "category_disabled",
  "path_excluded",
  "duplicate_existing_comment",
  "superseded_by_later_revision",
  "comment_budget_exhausted",
] as const;

export type PublicationReason = (typeof PUBLICATION_REASONS)[number];

/** Which decision each reason can justify. Table-driven, like the verifier's. */
export const REASON_DECIDES: Readonly<
  Record<PublicationReason, "publish" | "withhold">
> = {
  actionable: "publish",
  severity_below_threshold: "withhold",
  category_disabled: "withhold",
  path_excluded: "withhold",
  duplicate_existing_comment: "withhold",
  superseded_by_later_revision: "withhold",
  comment_budget_exhausted: "withhold",
};

export interface PublicationDecision {
  readonly findingId: string;
  readonly decision: "publish" | "withhold";
  readonly reason: PublicationReason;
}

/**
 * A finding that has already cleared verification.
 *
 * The type deliberately has no `verification` field to inspect: policy is not
 * where verification is re-litigated, and a policy that could see a decision
 * could be tempted to override it. Only verified findings are constructed as
 * this type — the promotion gate is what enforces that, in `promote.ts`.
 */
export interface PublishableFinding {
  readonly findingId: string;
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly path: string;
}

export interface PublicationConfig {
  /** Findings below this are withheld. Inclusive. */
  readonly minimumSeverity: FindingSeverity;
  readonly disabledCategories: readonly string[];
  /** Path prefixes excluded from comment surfaces. */
  readonly excludedPaths: readonly string[];
  /**
   * Ceiling on comments per review.
   *
   * A reviewer that leaves forty comments has not been thorough; it has been
   * ignored. The cap is part of the product, not a safety valve.
   */
  readonly maxComments: number;
}

export const DEFAULT_PUBLICATION_CONFIG: PublicationConfig = {
  minimumSeverity: "low",
  disabledCategories: [],
  excludedPaths: [],
  maxComments: 25,
};

/** What is already on the pull request, so the same defect is not re-posted. */
export interface PublicationState {
  /** Fingerprints already carrying a live comment. */
  readonly alreadyCommented: ReadonlySet<string>;
  /** Fingerprints whose finding a later revision superseded. */
  readonly superseded: ReadonlySet<string>;
}

export const EMPTY_PUBLICATION_STATE: PublicationState = {
  alreadyCommented: new Set(),
  superseded: new Set(),
};

const SEVERITY_ORDER: readonly FindingSeverity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

function meetsSeverity(
  severity: FindingSeverity,
  minimum: FindingSeverity,
): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minimum);
}

export interface PublicationPlan {
  readonly decisions: readonly PublicationDecision[];
  /** Findings that will be rendered. A subset, and legitimately empty. */
  readonly publish: readonly PublishableFinding[];
  readonly withheld: readonly PublicationDecision[];
  /**
   * True when nothing will be published.
   *
   * A first-class successful outcome, not an error and not something to fill
   * with a manufactured finding. "Seven candidates, three rejected, four
   * inconclusive, nothing to say" is a healthy review, and so is "three
   * verified, all below the configured threshold".
   */
  readonly noActionableFindings: boolean;
}

/**
 * Decides, in a fixed order, what reaches a developer.
 *
 * The order is the policy. Cheapest and most absolute exclusions first, so that
 * a finding withheld for several reasons is reported under the one a human
 * would give: a disabled category is *why* it was withheld, even if it also
 * happened to be a duplicate.
 *
 * Ordering findings by severity before applying the comment budget is
 * load-bearing — a budget applied in arbitrary order silently makes review
 * quality depend on file naming.
 */
export function planPublication(
  findings: readonly PublishableFinding[],
  config: PublicationConfig = DEFAULT_PUBLICATION_CONFIG,
  state: PublicationState = EMPTY_PUBLICATION_STATE,
): PublicationPlan {
  const ordered = [...findings].sort((left, right) => {
    const bySeverity =
      SEVERITY_ORDER.indexOf(right.severity) -
      SEVERITY_ORDER.indexOf(left.severity);
    return bySeverity !== 0
      ? bySeverity
      : left.fingerprint < right.fingerprint
        ? -1
        : 1;
  });

  const decisions: PublicationDecision[] = [];
  const publish: PublishableFinding[] = [];
  let budget = config.maxComments;

  for (const finding of ordered) {
    const withhold = (reason: PublicationReason): void => {
      decisions.push({
        findingId: finding.findingId,
        decision: "withhold",
        reason,
      });
    };

    if (state.superseded.has(finding.fingerprint)) {
      withhold("superseded_by_later_revision");
      continue;
    }
    if (config.disabledCategories.includes(finding.category)) {
      withhold("category_disabled");
      continue;
    }
    if (
      config.excludedPaths.some((prefix) => finding.path.startsWith(prefix))
    ) {
      withhold("path_excluded");
      continue;
    }
    if (!meetsSeverity(finding.severity, config.minimumSeverity)) {
      withhold("severity_below_threshold");
      continue;
    }
    if (state.alreadyCommented.has(finding.fingerprint)) {
      // Don't interrupt a developer twice about a defect they have already been
      // shown. This is what the fingerprint work has been for.
      withhold("duplicate_existing_comment");
      continue;
    }
    if (budget <= 0) {
      withhold("comment_budget_exhausted");
      continue;
    }

    budget -= 1;
    publish.push(finding);
    decisions.push({
      findingId: finding.findingId,
      decision: "publish",
      reason: "actionable",
    });
  }

  return {
    decisions,
    publish,
    withheld: decisions.filter((decision) => decision.decision === "withhold"),
    noActionableFindings: publish.length === 0,
  };
}

/** Rejects a decision its reason cannot justify. */
export function assertReasonDecides(decision: PublicationDecision): void {
  if (REASON_DECIDES[decision.reason] !== decision.decision) {
    throw new Error(
      `Reason \`${decision.reason}\` cannot justify \`${decision.decision}\` — ` +
        `it decides \`${REASON_DECIDES[decision.reason]}\`.`,
    );
  }
}
