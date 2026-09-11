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
  analyzeInstructionPrecedenceAndTrust,
  classifyInstructionCandidate,
  discoverProjects,
  discoverInstructionArtifacts,
  evaluateInstructionScopes,
  extractFile,
  governanceFor,
  indexIdentity,
  instructionFactsDigest,
  isInstructionCoverageComplete,
  optionInheritance,
  projectReferences,
  readProjectConfigs,
  planContext,
  unavailableIndex,
  updateRepositoryIndex,
  type AssembledContext,
  type IncrementalStats,
  type InstructionApplicabilityResult,
  type InstructionArtifactRead,
  type InstructionDiscoveryResult,
  type InstructionPrecedenceTrustAnalysis,
  type InstructionTraversal,
  type PlannerInput,
  type RepositoryIndex,
  type BaseRevisionResolution,
  type PlannerBaseRevision,
} from "@acalys/code-intelligence";
import { canonicalJson, gitObjectId, isRepositoryPath, matchesGlob } from "@acalys/contracts/domain";
import type { CandidateFindingRow } from "@acalys/database";
import {
  ALL_ANALYZER_IDS,
  allocateBudget,
  buildClusters,
  runAnalysis,
  toFindingView,
  type AnalysisCache,
  type AnalysisResult,
  type CandidateFinding,
  type ExecutionLimits,
  type ExecutionReport,
  boundarySurface,
  declaredBoundaries,
  type PublicBoundarySurface,
  analyzeLlmCorrectness,
  LLM_CORRECTNESS_ANALYZER_ID,
  LLM_CORRECTNESS_ANALYZER_VERSION,
  LLM_CORRECTNESS_PROMPT_VERSION,
  type ExternalReviewDataBlock,
  type ModelCompleter,
  type LlmCorrectnessOutcome,
} from "@acalys/review-engine";

type ConfigGovernanceResult = ReturnType<typeof governanceFor>;
type ConfigFacts = NonNullable<
  Parameters<typeof planContext>[0]["configFacts"]
>;

import { analyzeAsyncCompletion } from "@acalys/review-engine";
import {
  analyzeExactOptionalWrite,
  analyzeDiscardedReplacement,
  analyzeBoundaryReachability,
  analyzeExportReachability,
  analyzeRequiredParameterAdded,
  analyzeSignatureCompatibility,
  analyzeSwallowedErrors,
} from "@acalys/review-engine";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One file as the analyzer needs to see it. */
export interface ChangedFileSource {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly number[];
  /**
   * This file at the base revision, in whichever of the four states applies.
   *
   * Omitted by sources that cannot resolve bases at all. Omission is not
   * `absent` — see {@link AnalysisSourceSnapshot.baseSha}, which is what says
   * whether base resolution was even attempted for this snapshot.
   */
  readonly base?: BaseRevisionResolution | undefined;
}

export interface AnalysisInstructionObservation {
  readonly listPaths: () => InstructionTraversal;
  readonly readArtifact: (path: string) => InstructionArtifactRead;
}

export interface AnalysisSourceSnapshot {
  readonly changed: readonly ChangedFileSource[];
  /** path -> content for every successfully observed repository file. */
  readonly repository: ReadonlyMap<string, string>;
  /** Optional failure-aware instruction observation for this same revision. */
  readonly instructionObservation?: AnalysisInstructionObservation | undefined;
  /**
   * The commit the base revisions were read from, when any were.
   *
   * Its presence is the switch: with it, base resolution was attempted and
   * every changed file gets a resolution — a supplied one, or `not_indexed`
   * for the paths the source did not speak to. Without it, no base context is
   * produced at all and comparison capabilities abstain.
   *
   * It is also an input to {@link analyzerCacheKey}, because the same head
   * against two bases is two different reviews.
   */
  readonly baseSha?: string | undefined;
  /** Distinct from the target branch/base ref when the provider exposes both. */
  readonly mergeBaseSha?: string | undefined;
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
    /** Immutable platform revision identity. Production sources require this. */
    readonly revisionId?: string | undefined;
  }): Promise<AnalysisSourceSnapshot>;
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
 * code identity        repository · head commit · comparison identity · lines
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
  /**
   * Identity of the revision this review *compared against*, when it did.
   *
   * Deliberately not named `baseSha`. The general invariant is
   *
   * ```
   * if analyzer semantics may observe a comparison revision,
   * that revision's identity participates directly in the cache key
   * ```
   *
   * and a commit name is the wrong shape for it. A pull-request base and a
   * merge base are different revisions that a future pipeline may want to
   * distinguish, and neither is "the" base. What this takes is the identity
   * of the comparison material actually supplied — see the digest built in
   * `resolveBaseRevisions`, which covers the commit, every path, its resolved
   * state, and the content itself.
   *
   * Not redundant with `contextDigest`. Comparison material is only *offered*
   * to the planner, and may be dropped under budget or ablation — so two
   * reviews of one head against different bases can assemble byte-identical
   * context and collide on every other entry in this key. The result they
   * would share is wrong for at least one of them: rebase a pull request, or
   * retarget a branch from `main` onto a release branch, and the findings
   * served are the previous base's.
   *
   * Present and explicitly null when nothing was compared against, for the
   * same reason `model` is: a head-only result and a comparison result must
   * never share a key.
   */
  readonly comparisonIdentity?: string | undefined;
  readonly contextDigest: string;
  readonly modelIdentity?: string | undefined;
}): string {
  return sha256(
    canonicalJson({
      repositoryId: input.repositoryId,
      headSha: input.headSha,
      comparisonIdentity: input.comparisonIdentity ?? null,
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
    readonly identity?: string | undefined;
  }[],
): string {
  return sha256(
    items
      .map(
        (item) =>
          `${item.path}:${item.reason}:${item.representation}:${item.identity ?? ""}:${sha256(item.suppliedContent)}`,
      )
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
export function modelAnalyzerInputDigest(input: {
  readonly repositoryId: string;
  readonly baseSha?: string | undefined;
  readonly mergeBaseSha?: string | undefined;
  readonly headSha: string;
  readonly changed: readonly ChangedFileSource[];
  readonly configFactsDigest: string;
  readonly instructionFactsDigest: string;
  readonly contextDigest: string;
  /** Untrusted provider context identity; excluded from deterministic analyzer cache keys. */
  readonly externalContextDigest?: string | undefined;
  /** Immutable admitted review-policy identity; model input only, never the deterministic cache key. */
  readonly reviewPolicyFingerprint?: string | undefined;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly tier: string;
    readonly routingPolicyVersion: string;
    readonly promptTemplateVersion: string;
  };
}): string {
  const changeManifest = [...input.changed]
    .map((file) => ({
      path: file.path,
      changedLines: [...file.changedLines].sort((a, b) => a - b),
      contentDigest: sha256(file.content),
      base:
        file.base === undefined
          ? null
          : file.base.kind === "present"
            ? { kind: "present", contentDigest: sha256(file.base.content) }
            : { kind: file.base.kind },
    }))
    .sort((left, right) => compare(left.path, right.path));

  return sha256(
    canonicalJson({
      code: {
        repositoryId: input.repositoryId,
        baseSha: input.baseSha ?? null,
        mergeBaseSha: input.mergeBaseSha ?? null,
        headSha: input.headSha,
        changeManifest,
      },
      resolvedConfiguration: input.configFactsDigest,
      resolvedInstructions: input.instructionFactsDigest,
      contextSnapshot: input.contextDigest,
      externalContext: input.externalContextDigest ?? null,
      reviewPolicy: input.reviewPolicyFingerprint ?? null,
      analyzer: { id: input.analyzerId, version: input.analyzerVersion },
      model: input.model,
    }),
  );
}

function llmCandidateFingerprint(
  repositoryId: string,
  finding: import("@acalys/review-engine").AnalyzerFinding,
): string {
  return sha256(
    canonicalJson({
      algorithm: "acalys.fingerprint.symbol-anchor",
      anchor: finding.identityHint,
      category: finding.category,
      issueKey: finding.ruleId,
      repositoryId,
    }),
  );
}

export function candidateFingerprint(
  repositoryId: string,
  finding: CandidateFinding,
): string {
  return sha256(
    canonicalJson({
      algorithm: "acalys.fingerprint.symbol-anchor",
      anchor: finding.identityHint,
      category: finding.category,
      family: finding.family,
      issueKey: finding.ruleId,
      repositoryId,
    }),
  );
}

/** Both revisions' boundary surfaces, and why any could not be built. */
export interface BoundaryFacts {
  readonly base: readonly PublicBoundarySurface[];
  readonly head: readonly PublicBoundarySurface[];
  readonly abstentions: readonly { path: string; because: string }[];
  readonly identity: string;
}

export interface RealAnalysisOptions {
  readonly repositoryId: string;
  readonly headSha: string;
  /**
   * Immutable revision identity used by production sources to disambiguate the
   * same head commit reviewed against different bases. Fixture sources may
   * omit it because their snapshot is already explicit.
   */
  readonly revisionId?: string | undefined;
  /**
   * Who this review belongs to, for the index identity.
   *
   * Optional only because no caller supplies one yet. Absence produces an
   * `unscoped` identity, not a placeholder tenant id — an index built that way
   * is usable in memory for this one analysis and is refused by
   * `isPersistable`, because its tenant component distinguishes nothing and it
   * must never become a cache key.
   */
  readonly tenantId?: string | undefined;
  readonly provider?: "github" | undefined;
  /**
   * The index from the previous revision of this pull request, if one is held.
   *
   * Optional, and its absence is not an error — a first review has no previous
   * revision. When present the index is built incrementally and falls back to
   * a full rebuild on any doubt, because incremental is an optimization and
   * the full rebuild is the authority.
   */
  readonly previousIndex?: RepositoryIndex | undefined;
  readonly source: AnalysisSource;
  /** Immutable execution policy captured when the ReviewRequest was admitted. */
  readonly reviewPolicy?:
    | {
        readonly fingerprint: string;
        readonly ignorePaths: readonly string[];
        readonly toneProfile: string;
        readonly toneInstructions: string;
        readonly repositoryInstructions: string;
      }
    | undefined;
  readonly contextTokenBudget?: number | undefined;
  readonly limits?: Partial<ExecutionLimits> | undefined;
  /** Optional deterministic cluster-result cache. Persisted adapters are assembled by the runtime. */
  readonly cache?: AnalysisCache | undefined;
  /**
   * Measurement-only planner seam. Omission uses the production planner
   * unchanged; L.5 supplies a traced planner with an explicit fact-family
   * availability input.
   */
  readonly contextPlanner?:
    | ((input: PlannerInput, budgetTokens: number) => AssembledContext)
    | undefined;
  /** Optional only so deterministic replay/crash suites remain network-free. */
  readonly llm?:
    | {
        readonly scope: {
          readonly organizationId: string;
          readonly reviewRunId: string;
        };
        readonly model: ModelCompleter;
        readonly timeoutMs?: number | undefined;
        readonly externalData?: readonly ExternalReviewDataBlock[] | undefined;
        readonly externalContextDigest?: string | undefined;
      }
    | undefined;
}

export class LlmAnalysisUnavailableError extends Error {
  public readonly reason: string;

  public constructor(reason: string) {
    super(`LLM correctness analysis is unavailable: ${reason}`);
    this.name = "LlmAnalysisUnavailableError";
    this.reason = reason;
  }
}

export interface RealAnalysisOutcome {
  readonly candidates: readonly CandidateFindingRow[];
  readonly report: ExecutionReport;
  readonly contextDigest: string;
  readonly cacheKey: string;
  /** Present exactly when the model-backed analyzer was requested. */
  readonly llm?: LlmCorrectnessOutcome | undefined;
  readonly llmInputDigest?: string | undefined;
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
  readonly configFacts: ConfigFacts;
  readonly configFactsDigest: string;
  readonly configGovernance: readonly ConfigGovernanceResult[];
  readonly instructionFacts: InstructionDiscoveryResult;
  readonly instructionFactsDigest: string;
  readonly instructionApplicability: readonly {
    readonly targetPath: string;
    readonly result: InstructionApplicabilityResult;
  }[];
  readonly instructionPrecedenceAndTrust: readonly {
    readonly targetPath: string;
    readonly analysis: InstructionPrecedenceTrustAnalysis;
  }[];
  /**
   * How the index was obtained.
   *
   * Absent when it was built from scratch. Present — and honest about
   * fallbacks — when an incremental update was attempted, so a later
   * economics report can ask whether incremental indexing actually saves work
   * rather than assuming it does.
   */
  readonly indexStats?: IncrementalStats | undefined;
}

/**
 * Plan → cluster → allocate → analyze, and project to persistable rows.
 *
 * The order is the architecture: nothing here reaches past the planner for a
 * file it wants, so a missed finding is attributable to the planner or to the
 * analyzer and never to an unrecorded shortcut between them.
 */
interface ResolvedBaseRevisions {
  readonly sha: string;
  readonly revisions: readonly PlannerBaseRevision[];
  readonly digest: string;
}

/**
 * Turns a snapshot's optional per-file bases into a total picture, or nothing.
 *
 * Total is the operative word. When a snapshot declares a `baseSha` it is
 * claiming base resolution was attempted for this revision, so every changed
 * path must come back with a state — including the ones the source never
 * mentioned, which become `not_indexed` rather than quietly vanishing. A path
 * that vanishes is a path a comparison capability will treat as "no base
 * item", and the only safe reading of that is abstention, so the difference
 * between "the source could not read this file" and "the source forgot this
 * file" would be lost along with the ability to fix the latter.
 *
 * Returns `undefined` when no base was declared at all. That is a different
 * statement — not "we looked and failed" but "we did not look" — and it is
 * what keeps a head-only pipeline honest instead of having it report bases it
 * never had.
 */
function resolveBaseRevisions(
  baseSha: string | undefined,
  changed: readonly ChangedFileSource[],
): ResolvedBaseRevisions | undefined {
  if (baseSha === undefined) return undefined;

  const revisions: PlannerBaseRevision[] = changed
    .map((file) => ({
      path: file.path,
      resolution: file.base ?? ({ kind: "not_indexed" } as const),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

  return {
    sha: baseSha,
    revisions,
    // Covers content AND the commit, and both belong.
    //
    // Content, because a port that hands back the wrong text for the right
    // sha must not share an identity with one that does not, or the mistake
    // becomes uninvestigable after the fact.
    //
    // The commit, because it is not merely a label here: it appears in the
    // citation every base item carries, so an analyzer reading that citation
    // genuinely receives different input when it changes. Excluding it would
    // be excluding something the analyzer can see.
    digest: sha256(
      canonicalJson({
        baseSha,
        revisions: revisions.map((entry) => ({
          path: entry.path,
          kind: entry.resolution.kind,
          content:
            entry.resolution.kind === "present"
              ? sha256(entry.resolution.content)
              : null,
        })),
      }),
    ),
  };
}

function isIgnoredByReviewPolicy(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}

function filterInstructionObservation(
  observation: AnalysisInstructionObservation,
  ignorePaths: readonly string[],
): AnalysisInstructionObservation {
  if (ignorePaths.length === 0) return observation;
  return {
    listPaths: () => {
      const traversal = observation.listPaths();
      return { ...traversal, paths: traversal.paths.filter((path) => !isIgnoredByReviewPolicy(path, ignorePaths)) };
    },
    readArtifact: (path) =>
      isIgnoredByReviewPolicy(path, ignorePaths)
        ? { status: "unsupported", detail: "artifact is excluded by the admitted repository review policy" }
        : observation.readArtifact(path),
  };
}

function trustedReviewPolicyText(policy: NonNullable<RealAnalysisOptions["reviewPolicy"]>): string {
  const lines = [
    `Tone profile: ${policy.toneProfile}`,
    ...(policy.toneInstructions.trim() === "" ? [] : [`Tone instructions:\n${policy.toneInstructions.trim()}`]),
    ...(policy.repositoryInstructions.trim() === ""
      ? []
      : [`Repository instructions:\n${policy.repositoryInstructions.trim()}`]),
  ];
  return lines.join("\n\n");
}

export async function runRealAnalysis(
  options: RealAnalysisOptions,
): Promise<RealAnalysisOutcome> {
  const snapshot = await options.source.read({
      repositoryId: options.repositoryId,
      headSha: options.headSha,
      ...(options.revisionId === undefined
        ? {}
        : { revisionId: options.revisionId }),
    });

  assertCanonicalChangedPaths(snapshot.changed);
  const ignorePaths = options.reviewPolicy?.ignorePaths ?? [];
  const changed = snapshot.changed.filter((file) => !isIgnoredByReviewPolicy(file.path, ignorePaths));
  const repository = new Map(
    [...snapshot.repository].filter(([path]) => !isIgnoredByReviewPolicy(path, ignorePaths)),
  );
  const instructionObservation = filterInstructionObservation(
    snapshot.instructionObservation ?? repositoryInstructionObservation(snapshot.repository),
    ignorePaths,
  );
  const { baseSha, mergeBaseSha } = snapshot;

  const instructionFacts = discoverInstructionArtifacts({
    revision: options.headSha,
    ...instructionObservation,
  });
  const instructionIdentity = instructionFactsDigest(instructionFacts);
  const instructionTargets = changed.map((file) => {
    const applicability = instructionApplicabilityResultFor(
      instructionFacts,
      file.path,
    );
    const precedenceAndTrust = analyzeInstructionPrecedenceAndTrust(
      applicability.status === "applicable" ? applicability.relationships : [],
    );
    return {
      targetPath: file.path,
      applicability,
      precedenceAndTrust,
    };
  });

  const base = resolveBaseRevisions(baseSha, changed);

  const boundaries = buildBoundaryFacts(repository, base);

  const config = buildConfigFacts(
    repository,
    changed.map((file) => file.path),
    options.headSha,
  );

  // The structural facts for this exact revision, built before anything is
  // planned. Built rather than fetched: L.1 has no cache, so there is no
  // question of an index from a different revision answering for this one.
  const { index, indexStats } = buildIndexFor(options, repository);

  const context = (options.contextPlanner ?? planContext)(
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
      configFacts: config.facts,
      configFactsIdentity: config.digest,
      ...(base === undefined
        ? {}
        : {
            baseRevisions: base.revisions,
            baseSha: base.sha,
            baseFactsIdentity: base.digest,
          }),
      ...(boundaries === undefined
        ? {}
        : {
            boundarySurfaces: {
              base: boundaries.base,
              head: boundaries.head,
              identity: boundaries.identity,
            },
          }),
      instructionFacts: {
        facts: instructionFacts,
        factIdentity: instructionIdentity,
        targets: instructionTargets,
      },
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
    ...(options.cache === undefined ? {} : { cache: options.cache }),
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
        analyzeExactOptionalWrite(input),
        analyzeExportReachability(input),
        analyzeBoundaryReachability(input),
        analyzeRequiredParameterAdded(input),
        analyzeDiscardedReplacement(input),
      ];

      return {
        findings: results.flatMap((result) => result.findings),
        suppressions: results.flatMap((result) => result.suppressions),
        // Carried, not dropped. An analyzer that abstained because it could
        // not establish an input has said something, and discarding it here
        // makes the review look complete when it was not.
        degradations: results.flatMap((result) => result.degradations),
      };
    },
  });

  const contextDigest = contextSnapshotDigest(
    context.items.map((item) => ({
      path: item.path,
      reason: item.reason,
      representation: item.representation,
      suppliedContent: item.suppliedContent,
      identity:
        item.provenance?.source === "configuration_facts"
          ? item.provenance.factIdentity
          : item.provenance?.source === "instruction_facts"
            ? item.provenance.factIdentity
            : item.provenance?.source === "instruction_coverage"
              ? item.provenance.factIdentity
              : item.provenance?.source === "repository_index"
                ? `${item.provenance.indexIdentity}:${item.provenance.recordId}`
                : undefined,
    })),
  );
  const cacheKey = analyzerCacheKey({
    repositoryId: options.repositoryId,
    headSha: options.headSha,
    ...(base === undefined ? {} : { comparisonIdentity: base.digest }),
    contextDigest,
  });

  const llm =
    options.llm === undefined
      ? undefined
      : await analyzeLlmCorrectness(
          context,
          options.llm.scope,
          options.llm.model,
          options.llm.timeoutMs,
          options.llm.externalData,
          options.reviewPolicy === undefined ? undefined : trustedReviewPolicyText(options.reviewPolicy),
        );
  if (llm?.kind === "unavailable") {
    // A requested model path that could not run is not equivalent to the model
    // finding nothing. Failing here prevents a deterministic-only result from
    // being rendered or measured as a complete Phase-2 review.
    throw new LlmAnalysisUnavailableError(llm.reason);
  }

  const llmInputDigest =
    llm?.kind === "completed"
      ? modelAnalyzerInputDigest({
          repositoryId: options.repositoryId,
          ...(baseSha === undefined ? {} : { baseSha }),
          ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }),
          headSha: options.headSha,
          changed,
          configFactsDigest: config.digest,
          instructionFactsDigest: instructionIdentity,
          contextDigest,
          ...(options.llm.externalContextDigest === undefined
            ? {}
            : { externalContextDigest: options.llm.externalContextDigest }),
          ...(options.reviewPolicy === undefined
            ? {}
            : { reviewPolicyFingerprint: options.reviewPolicy.fingerprint }),
          analyzerId: LLM_CORRECTNESS_ANALYZER_ID,
          analyzerVersion: LLM_CORRECTNESS_ANALYZER_VERSION,
          model: {
            provider: llm.modelIdentity.provider,
            modelId: llm.modelIdentity.modelId,
            tier: llm.modelIdentity.tier,
            routingPolicyVersion: llm.modelIdentity.routingPolicyVersion,
            promptTemplateVersion: LLM_CORRECTNESS_PROMPT_VERSION,
          },
        })
      : undefined;

  // Sorted so that two runs over the same change persist rows in the same
  // order. Insertion order is observable through `readOutputs`, and a
  // convergence test that compares histories would otherwise fail on ordering
  // that carries no meaning.
  const deterministicCandidates = [...report.findings]
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

  const conflictsWithDeterministic = (
    proposed: import("@acalys/review-engine").AnalyzerFinding,
  ): boolean =>
    report.findings.some(
      (deterministic) =>
        deterministic.location.path === proposed.location.path &&
        deterministic.category === proposed.category &&
        deterministic.location.startLine <= proposed.location.endLine &&
        proposed.location.startLine <= deterministic.location.endLine,
    );

  const llmCandidates: CandidateFindingRow[] =
    llm?.kind === "completed" && llmInputDigest !== undefined
      ? llm.candidates
          // The model's identityHint is not an authority. A deterministic
          // capability wins when both procedures point at the same semantic
          // region/category, even if the model invents a different hint.
          .filter((finding) => !conflictsWithDeterministic(finding))
          .map((finding) => ({
            producerId: LLM_CORRECTNESS_ANALYZER_ID,
            producerVersion: LLM_CORRECTNESS_ANALYZER_VERSION,
            inputDigest: llmInputDigest,
            title: finding.claim,
            claim: finding.claim,
            explanation: finding.rationale,
            category: finding.category,
            proposedSeverity: finding.proposedSeverity,
            path: finding.location.path,
            startLine: finding.location.startLine,
            endLine: finding.location.endLine,
            fingerprintValue: llmCandidateFingerprint(
              options.repositoryId,
              finding,
            ),
          }))
      : [];

  const candidates = [...deterministicCandidates, ...llmCandidates].sort(
    (left, right) => compare(left.fingerprintValue, right.fingerprintValue),
  );

  return {
    candidates,
    report,
    contextDigest,
    cacheKey,
    ...(llm === undefined ? {} : { llm }),
    ...(llmInputDigest === undefined ? {} : { llmInputDigest }),
    index,
    context,
    configFacts: config.facts,
    configFactsDigest: config.digest,
    configGovernance: config.governance,
    instructionFacts,
    instructionFactsDigest: instructionIdentity,
    instructionApplicability: instructionTargets.map((target) => ({
      targetPath: target.targetPath,
      result: target.applicability,
    })),
    instructionPrecedenceAndTrust: instructionTargets.map((target) => ({
      targetPath: target.targetPath,
      analysis: target.precedenceAndTrust,
    })),
    ...(indexStats === undefined ? {} : { indexStats }),
  };
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
): {
  readonly index: RepositoryIndex;
  readonly indexStats?: IncrementalStats | undefined;
} {
  const identity = indexIdentity({
    tenant:
      options.tenantId === undefined
        ? {
            kind: "unscoped",
            why: "the caller supplied no tenant; this index is single-analysis only",
          }
        : { kind: "tenant", tenantId: options.tenantId },
    provider: options.provider ?? "github",
    repositoryId: options.repositoryId,
    // A revision is not optional and not a branch name. If the head sha is not
    // a well-formed object id we do not have a revision, and an index without
    // one would be a statement about nothing.
    revision: gitObjectId(options.headSha),
  });

  try {
    // With a previous index, update rather than rebuild. `updateRepositoryIndex`
    // decides for itself whether that is safe and falls back to a full rebuild
    // otherwise — this call site does not get to choose, because a caller that
    // could insist on the incremental path could insist on a stale one.
    if (options.previousIndex !== undefined) {
      const outcome = updateRepositoryIndex({
        previous: options.previousIndex,
        nextIdentity: identity,
        snapshot: codeSnapshot(repository),
      });
      return { index: outcome.index, indexStats: outcome.stats };
    }

    return {
      index: buildRepositoryIndex({
        identity,
        snapshot: codeSnapshot(repository),
      }),
    };
  } catch (error) {
    return {
      index: unavailableIndex(identity, {
        kind: "unavailable",
        why: error instanceof Error ? error.message : "index build failed",
      }),
    };
  }
}

const TSCONFIG_PATH = /(^|\/)tsconfig(\.[\w.-]+)?\.json$/;

function codeSnapshot(
  repository: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(
    [...repository].filter(([path]) => {
      if (TSCONFIG_PATH.test(path)) return false;
      const instruction = classifyInstructionCandidate(path);
      return (
        instruction === undefined ||
        instruction.instructionClass === "documentation"
      );
    }),
  );
}

function assertCanonicalChangedPaths(
  changed: readonly ChangedFileSource[],
): void {
  for (const file of changed) {
    if (!isRepositoryPath(file.path)) {
      throw new Error(`Changed source path is not canonical: ${file.path}`);
    }
  }
}

function repositoryInstructionObservation(
  repository: ReadonlyMap<string, string>,
): AnalysisInstructionObservation {
  return {
    listPaths: () => ({
      status: "incomplete",
      paths: [...repository.keys()],
      why: "the repository map contains readable files but no explicit traversal-completeness evidence",
    }),
    readArtifact: (path) => {
      const content = repository.get(path);
      return content === undefined
        ? {
            status: "unreadable",
            detail: "artifact was listed but no readable content was observed",
          }
        : { status: "available", content };
    },
  };
}

function instructionApplicabilityResultFor(
  facts: InstructionDiscoveryResult,
  targetPath: string,
): InstructionApplicabilityResult {
  const scope = evaluateInstructionScopes(facts.artifacts, targetPath);
  const coverage = {
    discovery: facts.discovery,
    evaluated: scope.evaluated,
    unevaluable: scope.unevaluable,
  };

  if (scope.relationships.length > 0) {
    return {
      status: "applicable",
      relationships: scope.relationships,
      coverage,
    };
  }

  if (isInstructionCoverageComplete(coverage)) {
    return {
      status: "no_applicable_instructions",
      evidence: [
        {
          reason: "no_evaluated_artifact_applies",
          detail: `No evaluated instruction artifact applies to ${targetPath}.`,
        },
      ],
      coverage,
    };
  }

  const gaps: string[] = [];
  if (coverage.discovery.status === "incomplete") {
    gaps.push(`instruction discovery is incomplete: ${coverage.discovery.why}`);
  }
  if (coverage.unevaluable.length > 0) {
    gaps.push(
      `${String(coverage.unevaluable.length)} applicable instruction artifact${coverage.unevaluable.length === 1 ? "" : "s"} could not be evaluated`,
    );
  }
  return { status: "undetermined", coverage, why: gaps.join("; ") };
}

/**
 * The public boundary surfaces of both revisions, built from the snapshot.
 *
 * Built HERE and not inside the analyzer, for the reason `AnalyzerInput`
 * states about itself: an analyzer sees the assembled context and nothing
 * else, so an analyzer deriving this fact would derive it from whatever the
 * planner happened to select. A boundary whose `export *` target lost a budget
 * contest would report a smaller surface — and a smaller surface is
 * indistinguishable from a narrowed one.
 *
 * That is the mistake the verifier already made once, compiling
 * `context.items` instead of the revision. Construction takes the whole
 * snapshot; the planner still decides whether the resulting fact is *shown*.
 *
 * The base revision is the snapshot with each changed file's base text put
 * back and files new at head removed. An unchanged file is byte identical in
 * both, which is what makes a boundary-only edit observable at all: the
 * manifest differs and every source file is shared.
 */
function buildBoundaryFacts(
  repository: ReadonlyMap<string, string>,
  base: ResolvedBaseRevisions | undefined,
): BoundaryFacts | undefined {
  if (base === undefined) return undefined;

  const baseFiles = new Map(repository);
  const abstentions: { path: string; because: string }[] = [];

  for (const revision of base.revisions) {
    const resolution = revision.resolution;
    if (resolution.kind === "present") {
      baseFiles.set(revision.path, resolution.content);
    } else if (resolution.kind === "absent") {
      baseFiles.delete(revision.path);
    } else {
      abstentions.push({
        path: revision.path,
        because: `the base revision is ${resolution.kind}, so no boundary surface can be established from it`,
      });
    }
  }

  const surfacesFor = (
    files: ReadonlyMap<string, string>,
  ): readonly PublicBoundarySurface[] =>
    declaredBoundaries(files).map((boundary) =>
      boundarySurface(files, boundary),
    );

  const baseSurfaces = surfacesFor(baseFiles);
  const headSurfaces = surfacesFor(repository);

  return {
    base: baseSurfaces,
    head: headSurfaces,
    abstentions,
    identity: sha256(
      canonicalJson({ base: baseSurfaces, head: headSurfaces }),
    ),
  };
}

function buildConfigFacts(
  repository: ReadonlyMap<string, string>,
  changedPaths: readonly string[],
  revision: string,
): {
  readonly facts: ConfigFacts;
  readonly governance: readonly ConfigGovernanceResult[];
  readonly digest: string;
} {
  const discovery = discoverProjects(repository);
  const projects = readProjectConfigs(
    repository,
    discovery.discovered,
    revision,
  );
  const governance = changedPaths.map((path) =>
    governanceFor(discovery, projects, path),
  );
  const facts: ConfigFacts = {
    projects: discovery.discovered,
    governance: governance.flatMap((result) =>
      result.status === "governed" ? result.relationships : [],
    ),
    inheritance: optionInheritance(projects),
    references: projectReferences(projects),
    failures: governance.flatMap((result) =>
      "coverage" in result ? result.coverage.unevaluable : [],
    ),
  };
  const digest = sha256(
    canonicalJson({
      failures: [...facts.failures].sort((left, right) =>
        compare(
          `${left.configPath}:${left.failure}`,
          `${right.configPath}:${right.failure}`,
        ),
      ),
      governance: [...facts.governance].sort((left, right) =>
        compare(
          `${left.sourcePath}:${left.projectPath}`,
          `${right.sourcePath}:${right.projectPath}`,
        ),
      ),
      inheritance: [...facts.inheritance].sort((left, right) =>
        compare(
          `${left.projectPath}:${left.depth}`,
          `${right.projectPath}:${right.depth}`,
        ),
      ),
      projects: [...facts.projects].sort(),
      references: [...facts.references].sort((left, right) =>
        compare(
          `${left.projectPath}:${left.referencesProject}`,
          `${right.projectPath}:${right.referencesProject}`,
        ),
      ),
    }),
  );
  return { facts, governance, digest };
}
