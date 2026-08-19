/**
 * The measurement vocabulary, built before there is any inference to measure.
 *
 * Instrumenting an empty provider boundary is the one moment when the
 * accounting semantics can be got right without also debugging a live pipeline.
 * Everything here is designed so that the day a model call appears, no existing
 * metric changes meaning.
 *
 * # Four kinds of number, and only one of them is a plain number
 *
 * The failure this file exists to prevent is a future comparison that reads:
 *
 * ```
 * before models   cost / review = $0.00
 * after models    cost / review = $0.14
 * ```
 *
 * and concludes the system went from free to fourteen cents. It never cost
 * $0.00. Nobody measured CPU, Docker, Postgres or storage, and reporting an
 * unmeasured quantity as zero is how that becomes historical fact.
 *
 * So a quantity is one of:
 *
 * ```
 * measured     we counted it, and this is the count — including a real 0
 * notApplicable no such work occurred, so there is nothing to count
 * unmeasured   the work occurs and we do not account for it
 * undefined    a ratio whose denominator is zero
 * ```
 *
 * `model inference cost` today is `measured 0` — there are no model calls, so
 * zero is the true count. `infrastructure cost` is `unmeasured`. `total cost`
 * is therefore `unmeasured` too, and cannot be rendered as a number at all.
 * That distinction is in the type, so a dashboard cannot flatten it by
 * accident.
 */

export type Quantity<T = number> =
  /** Counted. `0` here means genuinely none, not "we did not look". */
  | { readonly kind: "measured"; readonly value: T }
  /**
   * The work did not happen, so there is nothing to count.
   *
   * Distinct from `measured: 0`. "No model returned any tokens" and "models
   * returned zero tokens" are different statements, and only the second is a
   * measurement.
   */
  | { readonly kind: "notApplicable"; readonly because: string }
  /** The work happens and this system does not account for it. */
  | { readonly kind: "unmeasured"; readonly because: string }
  /** A ratio with a zero denominator. */
  | { readonly kind: "undefinedRatio"; readonly because: string };

export const measured = <T>(value: T): Quantity<T> => ({
  kind: "measured",
  value,
});
export const notApplicable = <T>(because: string): Quantity<T> => ({
  kind: "notApplicable",
  because,
});
export const unmeasured = <T>(because: string): Quantity<T> => ({
  kind: "unmeasured",
  because,
});

/** A ratio, or the reason it has no value. */
export function ratio(
  numerator: number,
  denominator: number,
  because: string,
): Quantity {
  return denominator === 0
    ? { kind: "undefinedRatio", because }
    : { kind: "measured", value: Number((numerator / denominator).toFixed(4)) };
}

/**
 * Adding two quantities, with the rules stated rather than improvised.
 *
 * Individually correct fields can still compose into nonsense, and the
 * combination is where that happens: two honest components summed by a naive
 * `+` produce a confident total that neither supports.
 *
 * ```
 * measured + measured        measured        both counted
 * measured + notApplicable   measured        the absent part contributes nothing
 * anything + unmeasured      unmeasured      one part is unknown, so the total is
 * ```
 *
 * The third rule is the one that matters. `modelInferenceCost measured(0)` plus
 * `infrastructureCost unmeasured` is **unmeasured**, never `measured(0)` — an
 * unknown component makes the sum unknown, however small the known part is.
 *
 * `notApplicable` may only be treated as zero because it means *this component
 * does not exist within this aggregate*, which is a fact about the total. That
 * is different from not having looked.
 */
export function add(left: Quantity, right: Quantity): Quantity {
  // Checked first: unknown is absorbing, whatever it is paired with.
  if (left.kind === "unmeasured") return left;
  if (right.kind === "unmeasured") return right;

  // A ratio has no place in an additive aggregate. Reaching here means a
  // denominator-less value was routed into a sum, which is a category error
  // rather than a value to propagate.
  if (left.kind === "undefinedRatio" || right.kind === "undefinedRatio") {
    return unmeasured(
      "a ratio was combined additively; ratios are not summable components",
    );
  }

  if (left.kind === "notApplicable" && right.kind === "notApplicable") {
    return left;
  }
  if (left.kind === "notApplicable") return right;
  if (right.kind === "notApplicable") return left;

  return measured(left.value + right.value);
}

/** Adds many, left to right. Empty sums to a measured zero. */
export function sum(quantities: readonly Quantity[]): Quantity {
  return quantities.reduce<Quantity>(
    (total, next) => add(total, next),
    measured(0),
  );
}

/** Renders a quantity for a report, without inventing a number. */
export function render(quantity: Quantity): string {
  switch (quantity.kind) {
    case "measured":
      return String(quantity.value);
    case "notApplicable":
      return `N/A (${quantity.because})`;
    case "unmeasured":
      return `unmeasured (${quantity.because})`;
    case "undefinedRatio":
      return `undefined (${quantity.because})`;
  }
}

/**
 * What was assembled and shown, before anyone reasons about it.
 *
 * `tokenEstimate` is named for what it is. It must never be aliased to
 * `inputTokens`: that name is reserved for provider-reported inference usage,
 * and letting an estimate occupy it would silently redefine every economics
 * number the day a model arrives.
 */
export interface ContextUsage {
  readonly items: number;
  readonly characters: number;
  readonly tokenEstimate: number;
  readonly omittedItems: number;
  readonly assemblyMs: number;
}

/**
 * Provider-reported inference usage. Every field absent today.
 *
 * Absent, not zero. The schema exists now so the transition adds values rather
 * than adding fields — and so that a report can say `N/A` with a reason instead
 * of a confident nothing.
 */
export interface InferenceUsage {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  /**
   * Which price list produced {@link estimatedCostUsd}.
   *
   * Cost is derived evidence, never a stored fact: usage times a dated
   * schedule. Persisting only `cost = 0.037` makes it unexplainable the moment
   * pricing changes.
   */
  readonly pricingSnapshotId: string | undefined;
  readonly estimatedCostUsd: number | undefined;
}

export const IMPLEMENTATION_KINDS = ["deterministic", "model", "tool"] as const;
export type ImplementationKind = (typeof IMPLEMENTATION_KINDS)[number];

export const MEASURED_STAGES = [
  "planning",
  "analysis",
  "verification",
  "reconciliation",
  "policy",
  "publication",
] as const;
export type MeasuredStage = (typeof MEASURED_STAGES)[number];

/**
 * One execution of one procedure.
 *
 * `invocationId` is LOGICAL — the unit of semantic work — and `attempt`
 * distinguishes physical executions of it. Two attempts of one invocation are
 * one candidate verified and two provider requests paid for, and a report that
 * cannot say both will hide reliability regressions inside a flat cost number.
 */
/**
 * Durations come from a monotonic clock.
 *
 * `Date.now()` differences are wall-clock differences: an NTP correction or a
 * DST change during a long stage produces a negative or wildly inflated
 * duration. At the millisecond scale these stages currently occupy, that is not
 * a rounding concern — a single adjustment would dominate every percentile in
 * the report.
 *
 * Epoch timestamps are still recorded, because ordering and correlation across
 * processes need a shared reference that a monotonic clock cannot provide.
 * They are for placing an invocation in time, never for measuring it.
 */
export const monotonicNow = (): number => performance.now();

export interface InvocationMeasurement {
  readonly runId: string;
  readonly stage: MeasuredStage;
  readonly invocationId: string;
  readonly candidateId?: string | undefined;
  readonly clusterId?: string | undefined;

  readonly implementationKind: ImplementationKind;
  readonly procedureId: string;
  readonly procedureVersion: string;

  readonly startedAt: number;
  readonly completedAt: number;
  readonly wallMs: number;

  /** 1 for a first execution. Higher for a retry of the SAME invocation. */
  readonly attempt: number;
  readonly outcome: "succeeded" | "failed";

  readonly context?: ContextUsage | undefined;
  readonly inference?: InferenceUsage | undefined;
}
