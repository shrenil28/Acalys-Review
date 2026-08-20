/**
 * The real analyzer, wired to the pipeline.
 *
 * `stages.ts` holds a deterministic stub, and that stub is not going away: the
 * crash-recovery proofs depend on the middle of the pipeline being a pure
 * function of the change, and mixing a real reviewer into a convergence test
 * would make a differing replay unattributable. This module is the production
 * path beside it.
 *
 * # What is deliberately absent
 *
 * Repository access. The analyzer needs file contents and changed lines, and
 * nothing in Phase 1 clones a repository yet — that is item 4 of the phase
 * order and it has not been built. Rather than invent it here, the source is a
 * **port**: the pipeline depends on the interface, the tests supply a fixture,
 * and the real implementation lands with the repository package.
 *
 * Writing a plausible-looking clone step to make this file feel finished would
 * produce code that has never fetched anything, tested against nothing, in the
 * one place where being wrong means reviewing the wrong revision.
 */

import { createHash } from "node:crypto";

import {
  buildRepositoryIndex,
  extractFile,
  indexIdentity,
  planContext,
  unavailableIndex,
  type AssembledContext,
  type RepositoryIndex,
} from "@acalys/code-intelligence";
import { gitObjectId } from "@acalys/contracts/domain";
import type { CandidateFindingRow } from "@acalys/database";
import {
  ALL_ANALYZER_IDS,
  allocateBudget,
  buildClusters,
  runAnalysis,
  toFindingView,
  type AnalysisResult,
  type CandidateFinding,
  type ExecutionLimits,
  type ExecutionReport,
} from "@acalys/review-engine";

import { analyzeAsyncCompletion } from "@acalys/review-engine";
import {
  analyzeSignatureCompatibility,
  analyzeSwallowedErrors,
} from "@acalys/review-engine";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One file as the analyzer needs to see it. */
export interface ChangedFileSource {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly number[];
}

/**
 * Where source comes from.
 *
 * A port rather than a call to a clone step that does not exist. Everything
 * below is testable today against a fixture, and stays unchanged when the real
 * implementation arrives.
 */
export interface AnalysisSource {
  /** The changed files, plus any file the planner may draw on for context. */
  read(input: {
    readonly repositoryId: string;
    readonly headSha: string;
  }): Promise<{
    readonly changed: readonly ChangedFileSource[];
    /** path → content, for everything the planner may consult. */
    readonly repository: ReadonlyMap<string, string>;
  }>;
}

export const REVIEW_PROCEDURE_VERSION = "1";

/**
 * The analyzer's cache key — and the reason it is not `inputDigest`.
 *
 * `stages.ts` documents that its digest covers repository and head commit, and
 * that a real analyzer's input is strictly larger. This is that larger key, and
 * the entry that matters most is the model identity:
 *
 * ```
 * code identity        repository · head commit · changed lines
 * context identity     the assembled context that was actually supplied
 * procedure identity   analyzer ids and versions · procedure version
 * execution identity   model and provider, once a model is involved
 * ```
 *
 * Omitting the last one is the trap. Change the model, serve a cached result,
 * and every quality number afterwards measures a model that never ran — the
 * evaluation is not merely stale, it is describing something that did not
 * happen.
 *
 * The context snapshot digest stays model-independent on purpose, so the same
 * context can be run against two models and the difference attributed to the
 * model rather than to a differing prompt.
 */
export function analyzerCacheKey(input: {
  readonly repositoryId: string;
  readonly headSha: string;
  readonly contextDigest: string;
  readonly modelIdentity?: string | undefined;
}): string {
  return sha256(
    JSON.stringify({
      repositoryId: input.repositoryId,
      headSha: input.headSha,
      contextDigest: input.contextDigest,
      analyzers: [...ALL_ANALYZER_IDS].sort(),
      procedure: REVIEW_PROCEDURE_VERSION,
      // Present and explicitly null when no model was involved, so a
      // deterministic result and a model result can never share a key.
      model: input.modelIdentity ?? null,
    }),
  );
}

/**
 * The context that was supplied, digested.
 *
 * Model-independent by construction: paths, reasons, representations and
 * content. Not the run, the revision or the delivery.
 */
export function contextSnapshotDigest(
  items: readonly {
    readonly path: string;
    readonly reason: string;
    readonly representation: string;
    readonly suppliedContent: string;
  }[],
): string {
  return sha256(
    items
      .map(
        (item) =>
          `${item.path}:${item.reason}:${item.representation}:${sha256(item.suppliedContent)}`,
      )
      .sort()
      .join("\n"),
  );
}

/**
 * The fingerprint a candidate carries into reconciliation.
 *
 * Anchored on the analyzer's identity hint rather than on a line number, so the
 * same defect moved down a file reconciles to the same finding instead of being
 * reported again on every push.
 */
export function candidateFingerprint(
  repositoryId: string,
  finding: CandidateFinding,
): string {
  return sha256(
    JSON.stringify({
      algorithm: "acalys.fingerprint.symbol-anchor",
      anchor: finding.identityHint,
      category: finding.category,
      family: finding.family,
      issueKey: finding.ruleId,
      repositoryId,
    }),
  );
}

export interface RealAnalysisOptions {
  readonly repositoryId: string;
  readonly headSha: string;
  /**
   * Who this review belongs to, for the index identity.
   *
   * Defaulted rather than required so existing callers keep working, but
   * present in the identity either way: an index is a statement about one
   * tenant's repository, and an identity missing the tenant would let two
   * tenants' indexes for the same public revision compare equal.
   */
  readonly tenantId?: string | undefined;
  readonly provider?: "github" | undefined;
  readonly source: AnalysisSource;
  readonly contextTokenBudget?: number | undefined;
  readonly limits?: Partial<ExecutionLimits> | undefined;
}

export interface RealAnalysisOutcome {
  readonly candidates: readonly CandidateFindingRow[];
  readonly report: ExecutionReport;
  readonly contextDigest: string;
  readonly cacheKey: string;
  /**
   * The index this run planned against.
   *
   * Returned rather than kept private so a caller — and a test — can check
   * that the facts in the context came from the revision under review. An
   * analysis that cannot show which index it used cannot be audited later.
   */
  readonly index: RepositoryIndex;
  /**
   * What the analyzer was actually given, after scoring and truncation.
   *
   * Returned because an analysis that cannot show what it saw cannot be
   * audited: "why did the reviewer miss this?" is answerable only against the
   * assembled snapshot, and the planner is built around the distinction
   * between what was intended and what was sent.
   */
  readonly context: AssembledContext;
}

/**
 * Plan → cluster → allocate → analyze, and project to persistable rows.
 *
 * The order is the architecture: nothing here reaches past the planner for a
 * file it wants, so a missed finding is attributable to the planner or to the
 * analyzer and never to an unrecorded shortcut between them.
 */
export async function runRealAnalysis(
  options: RealAnalysisOptions,
): Promise<RealAnalysisOutcome> {
  const { changed, repository } = await options.source.read({
    repositoryId: options.repositoryId,
    headSha: options.headSha,
  });

  // The structural facts for this exact revision, built before anything is
  // planned. Built rather than fetched: L.1 has no cache, so there is no
  // question of an index from a different revision answering for this one.
  const index = buildIndexFor(options, repository);

  const context = planContext(
    {
      changed: changed.map((file) => ({
        path: file.path,
        content: file.content,
        changedLines: file.changedLines,
      })),
      repository: [...repository].map(([path, source]) =>
        extractFile(path, source),
      ),
      sources: repository,
      index,
    },
    options.contextTokenBudget ?? 60_000,
  );

  const subject = changed.map((file) => ({
    path: file.path,
    changedLines: file.changedLines,
  }));

  const clusters = buildClusters(subject, context.items);
  const allocations = clusters.map((cluster) => allocateBudget(cluster));

  const report = await runAnalysis(clusters, allocations, {
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    analyzer: ({ cluster }) => {
      const input = {
        context: { ...context, items: cluster.context },
        subject: cluster.subject.map((entry) => ({
          path: entry.path,
          changedLines: entry.changedLines,
        })),
        clusterId: cluster.id,
      };

      const results: AnalysisResult[] = [
        analyzeAsyncCompletion(input),
        analyzeSwallowedErrors(input),
        analyzeSignatureCompatibility(input),
      ];

      return {
        findings: results.flatMap((result) => result.findings),
        suppressions: results.flatMap((result) => result.suppressions),
        degradations: [],
      };
    },
  });

  const contextDigest = contextSnapshotDigest(context.items);
  const cacheKey = analyzerCacheKey({
    repositoryId: options.repositoryId,
    headSha: options.headSha,
    contextDigest,
  });

  // Sorted so that two runs over the same change persist rows in the same
  // order. Insertion order is observable through `readOutputs`, and a
  // convergence test that compares histories would otherwise fail on ordering
  // that carries no meaning.
  const candidates = [...report.findings]
    .sort((left, right) =>
      candidateFingerprint(options.repositoryId, left) <
      candidateFingerprint(options.repositoryId, right)
        ? -1
        : 1,
    )
    .map((finding) => {
      const view = toFindingView(finding);
      return {
        producerId: finding.ruleId.split("/")[0] ?? finding.ruleId,
        producerVersion: REVIEW_PROCEDURE_VERSION,
        inputDigest: cacheKey,
        title: view.summary,
        claim: finding.claim,
        // The causal chain and the repair, as the reader will see them. The
        // row is what survives to publication, so anything omitted here is
        // work the reviewer did and nobody benefits from.
        explanation: `${view.detail}\n\nRemediation: ${view.remediation}`,
        category: finding.category,
        proposedSeverity: finding.proposedSeverity,
        path: finding.location.path,
        startLine: finding.location.startLine,
        endLine: finding.location.endLine,
        fingerprintValue: candidateFingerprint(options.repositoryId, finding),
      } satisfies CandidateFindingRow;
    });

  return { candidates, report, contextDigest, cacheKey, index, context };
}

/**
 * Builds the index for the revision under review, or says why it could not.
 *
 * `unavailableIndex` rather than an empty one when the head sha is not a
 * usable object id. The two are indistinguishable to any caller that only
 * counts records, and that indistinguishability is precisely how an outage
 * comes to read as "nothing found" — the failure P1-K caught rendering a
 * verifier outage as a clean scan.
 */
function buildIndexFor(
  options: RealAnalysisOptions,
  repository: ReadonlyMap<string, string>,
): RepositoryIndex {
  const identity = indexIdentity({
    tenantId: options.tenantId ?? "unknown",
    provider: options.provider ?? "github",
    repositoryId: options.repositoryId,
    // A revision is not optional and not a branch name. If the head sha is not
    // a well-formed object id we do not have a revision, and an index without
    // one would be a statement about nothing.
    revision: gitObjectId(options.headSha),
  });

  try {
    return buildRepositoryIndex({ identity, snapshot: repository });
  } catch (error) {
    return unavailableIndex(identity, {
      kind: "unavailable",
      why: error instanceof Error ? error.message : "index build failed",
    });
  }
}
