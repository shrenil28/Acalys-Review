/**
 * What the Triage screen renders, derived from the analysis that already ran.
 *
 * `apps/web/src/pages/review/Triage.tsx` shows a reviewer a queue of pull
 * requests and asks them to decide what to open first. To do that it renders
 * `risk`, `blastRadius`, `reviewEffort`, `changeType` and a one-line
 * `reviewGuidance`. Today those are fixtures. This is the backend that has to
 * replace them.
 *
 * The design decision worth stating: **these are a projection of the signals
 * the analyzer already computed, not a second risk model.** Two independent
 * risk assessments over the same change would disagree in front of a user, and
 * the one they would trust is the one on screen — which would be the one with
 * no evidence behind it.
 *
 * ```
 * RiskSignals (per cluster, budget.ts)
 *        │
 *        ├──▶ BudgetAllocation      what to spend        internal only
 *        └──▶ ChangeAssessment      what to review first  → Triage page
 * ```
 *
 * The arrow only points this way. If the UI's priority ever fed back into
 * budget, an author could make their own pull request cheap to review by
 * labelling it, and the review would get worse exactly where someone wanted it
 * to.
 *
 * # Honesty about estimates
 *
 * Two fields on that screen are estimates, and both are presented as numbers,
 * which invites more trust than they have earned. So each carries its basis:
 *
 * - `blastRadius` is computed over **supplied context**, not the repository. A
 *   repository-wide figure needs the full dependency graph, which is Phase 2.
 *   Reporting a context-local number as if it were repository-wide would be
 *   confidently wrong on exactly the large repositories where it matters.
 * - `reviewEffort` is a heuristic in minutes. It is derived from volume,
 *   branching and cluster count, and it says so.
 */

import type { RiskCluster } from "./cluster.js";
import type { BudgetAllocation, RiskTier } from "./budget.js";

/** The vocabulary the Triage screen already uses. */
export const CHANGE_TYPES = [
  "Feature",
  "Fix",
  "Refactor",
  "Chore",
  "Docs",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const RISK_LEVELS = ["High", "Medium", "Low"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface ChangeAssessment {
  readonly risk: RiskLevel;
  /**
   * Share of supplied non-subject modules that reference the change, 0–100.
   *
   * Named for what it measures. See the module note: this is context-local.
   */
  readonly blastRadius: number;
  /** Minutes a careful human review is expected to take. A heuristic. */
  readonly reviewEffort: number;
  readonly changeType: ChangeType;
  /**
   * One line telling the reviewer where to look first.
   *
   * Generated from the highest-tier clusters, naming the actual symbols. A
   * generic sentence here ("review carefully") is worse than an empty string,
   * because it occupies the slot a useful sentence would have used.
   */
  readonly reviewGuidance: string;
  /** How the numbers were reached, for a UI that wants to explain itself. */
  readonly basis: {
    readonly clusters: number;
    readonly deeplyAnalyzed: number;
    readonly changedLines: number;
    readonly highestTier: RiskTier;
    readonly contextLocalBlastRadius: true;
    readonly effortIsHeuristic: true;
  };
}

/** Metadata the pipeline knows and the analyzer deliberately does not. */
export interface ChangeMetadata {
  readonly title?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  /** Paths touched, including ones no analyzer looked at. */
  readonly changedPaths: readonly string[];
}

const TIER_TO_RISK: Readonly<Record<RiskTier, RiskLevel>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "High",
};

/**
 * Classifies the kind of change, most reliable signal first.
 *
 * Structure alone cannot distinguish a fix from a feature — both add code and
 * touch tests — so an explicit human signal wins when there is one. Guessing
 * where no signal exists produces a label that is wrong often enough to be
 * noticed and never wrong enough to be fixed.
 */
export function classifyChangeType(metadata: ChangeMetadata): ChangeType {
  const labels = (metadata.labels ?? []).map((label) => label.toLowerCase());
  for (const [label, type] of [
    ["bug", "Fix"],
    ["fix", "Fix"],
    ["feature", "Feature"],
    ["enhancement", "Feature"],
    ["refactor", "Refactor"],
    ["chore", "Chore"],
    ["docs", "Docs"],
    ["documentation", "Docs"],
  ] as const) {
    if (labels.includes(label)) return type;
  }

  // Conventional-commit prefixes, which authors write deliberately.
  const title = (metadata.title ?? "").toLowerCase();
  const prefix = /^(feat|fix|refactor|chore|docs|perf|test|build|ci)\b/.exec(
    title,
  );
  if (prefix !== null) {
    return (
      {
        feat: "Feature",
        fix: "Fix",
        refactor: "Refactor",
        chore: "Chore",
        docs: "Docs",
        perf: "Refactor",
        test: "Chore",
        build: "Chore",
        ci: "Chore",
      } as const
    )[prefix[1] as "feat"];
  }

  // Structure, which can only support the unambiguous cases.
  const paths = metadata.changedPaths;
  const every = (predicate: (path: string) => boolean) =>
    paths.length > 0 && paths.every(predicate);

  if (every((path) => /\.(md|mdx|txt|rst)$/i.test(path))) return "Docs";
  if (
    every((path) =>
      /(^|\/)(package(-lock)?\.json|tsconfig.*\.json|\.github\/|\.gitignore|\w+\.ya?ml)$/i.test(
        path,
      ),
    )
  ) {
    return "Chore";
  }

  // No reliable signal. "Feature" is the neutral default the UI already treats
  // as unremarkable, and it is stated here rather than dressed up as inference.
  return "Feature";
}

export function assessChange(
  clusters: readonly RiskCluster[],
  allocations: readonly BudgetAllocation[],
  metadata: ChangeMetadata,
): ChangeAssessment {
  const byId = new Map(
    allocations.map((allocation) => [allocation.clusterId, allocation]),
  );

  const order: readonly RiskTier[] = ["low", "medium", "high", "critical"];
  const highestTier = allocations.reduce<RiskTier>(
    (highest, allocation) =>
      order.indexOf(allocation.tier) > order.indexOf(highest)
        ? allocation.tier
        : highest,
    "low",
  );

  const changedLines = clusters.reduce(
    (total, cluster) =>
      total +
      cluster.subject.reduce(
        (sum, entry) => sum + entry.changedLines.length,
        0,
      ),
    0,
  );

  const subjectPaths = new Set(
    clusters.flatMap((cluster) => cluster.subject.map((entry) => entry.path)),
  );
  const suppliedOther = new Set(
    clusters
      .flatMap((cluster) => cluster.context.map((item) => item.path))
      .filter((path) => !subjectPaths.has(path)),
  );
  const referencing = new Set(
    clusters
      .flatMap((cluster) => cluster.context)
      .filter(
        (item) =>
          !subjectPaths.has(item.path) &&
          (item.reason === "caller" || item.reason === "associated_test"),
      )
      .map((item) => item.path),
  );
  const blastRadius =
    suppliedOther.size === 0
      ? 0
      : Math.round((referencing.size / suppliedOther.size) * 100);

  // Minutes. Reading rate plus a penalty for branching and for every extra
  // semantic unit a reviewer has to hold in their head at once.
  const complexity = allocations.reduce(
    (total, allocation) => total + allocation.signals.complexity,
    0,
  );
  const reviewEffort = Math.max(
    5,
    Math.round(changedLines / 12 + complexity * 0.5 + clusters.length * 4),
  );

  const risky = [...clusters]
    .filter((cluster) => {
      const tier = byId.get(cluster.id)?.tier;
      return tier === "high" || tier === "critical";
    })
    .slice(0, 2);

  const reviewGuidance =
    risky.length === 0
      ? ""
      : `Focus on ${risky
          .map((cluster) => {
            const symbols = cluster.changedSymbols.slice(0, 2);
            const named =
              symbols.length > 0
                ? symbols.join(" and ")
                : (cluster.subject[0]?.path ?? cluster.id);
            const why = byId.get(cluster.id)?.rationale ?? "";
            return why === "" ? named : `${named} — ${why}`;
          })
          .join("; ")}.`;

  return {
    risk: TIER_TO_RISK[highestTier],
    blastRadius,
    reviewEffort,
    changeType: classifyChangeType(metadata),
    reviewGuidance,
    basis: {
      clusters: clusters.length,
      deeplyAnalyzed: allocations.filter((allocation) => allocation.deepPass)
        .length,
      changedLines,
      highestTier,
      contextLocalBlastRadius: true,
      effortIsHeuristic: true,
    },
  };
}
