/**
 * @acalys/review-engine — analyzers.
 *
 * What turns supplied context into candidate findings. Two rules run through
 * everything here:
 *
 * 1. An analyzer sees the assembled context and nothing else, so a missed
 *    finding has an attributable cause.
 * 2. A finding must explain how the changed code produces the failure, or it is
 *    suppressed rather than emitted quietly.
 *
 * See `docs/review/phase-1/g-analyzer-architecture.md`.
 */
export {
  CONFIDENCE_FOR_STRENGTH,
  confidenceFromEvidence,
  type Analyzer,
  type AnalyzerEvidence,
  type AnalyzerFinding,
  type AnalyzerInput,
  type FindingLocation,
} from "./analyzer.js";
export {
  buildClusters,
  type AnalysisSubject,
  type RiskCluster,
} from "./cluster.js";
export {
  RISK_TIERS,
  allocateBudget,
  computeSignals,
  type BudgetAllocation,
  type RiskSignals,
  type RiskTier,
} from "./budget.js";
export {
  CONFIDENCE_FLOOR,
  CORRECTNESS_FAMILIES,
  SUPPRESSION_REASONS,
  propose,
  toFindingView,
  wasDegraded,
  type AnalysisResult,
  type CandidateFinding,
  type CausalChain,
  type CorrectnessFamily,
  type Counterfactual,
  type Proposal,
  type ProposalOutcome,
  type FindingView,
  type Suppression,
  type SuppressionReason,
} from "./finding.js";
export {
  CHANGE_TYPES,
  RISK_LEVELS,
  assessChange,
  classifyChangeType,
  type ChangeAssessment,
  type ChangeMetadata,
  type ChangeType,
  type RiskLevel,
} from "./assessment.js";
export {
  ANALYZER_ID,
  ANALYZER_VERSION,
  analyzeAsyncCompletion,
  asyncCompletionAnalyzer,
  collectAsyncDeclarations,
  type AsyncAnalyzerInput,
} from "./correctness/async-completion.js";
export {
  SWALLOWED_ERROR_ANALYZER_ID,
  SWALLOWED_ERROR_VERSION,
  analyzeSwallowedErrors,
  swallowedErrorAnalyzer,
} from "./correctness/swallowed-error.js";
export {
  SIGNATURE_ANALYZER_ID,
  SIGNATURE_ANALYZER_VERSION,
  analyzeSignatureCompatibility,
  signatureCompatibilityAnalyzer,
} from "./correctness/signature-compatibility.js";
export {
  EXACT_OPTIONAL_WRITE_RULE_ID,
  analyzeExactOptionalWrite,
} from "./correctness/exact-optional-write.js";
export {
  EXACT_OPTIONAL_DIAGNOSTIC_CODE,
  verifyExactOptionalWrite,
  type ExactOptionalOutcome,
  type ExactOptionalQuery,
} from "./verification/exact-optional.js";
export {
  DEFAULT_LIMITS,
  DEGRADATION_REASONS,
  createMemoryCache,
  fingerprintCluster,
  runAnalysis,
  type AnalysisCache,
  type ClusterAnalyzer,
  type ClusterAnalysisInput,
  type Degradation,
  type DegradationReason,
  type ExecutionLimits,
  type ExecutionOptions,
  type ExecutionReport,
} from "./execution.js";

/**
 * Every analyzer's identity, for the execution cache key.
 *
 * Exported as data rather than derived at the call site: an analyzer added
 * without appearing here would silently share a cache key with the previous
 * set, and the first symptom would be findings that stopped appearing.
 */
export const ALL_ANALYZER_IDS = [
  "acalys.correctness.async-completion",
  "acalys.correctness.swallowed-error",
  "acalys.correctness.signature-compatibility",
  // P1-M.2. The first analyzer that cannot decide anything from source alone —
  // the same line is correct in one project and wrong in another, so it reads
  // a demand-selected governing configuration.
  "acalys.correctness.exact-optional-property-write",
  // P1-M.3. The first analyzers that cannot decide anything from the head
  // revision alone: the same file is correct or broken depending only on what
  // it used to export.
  //
  // `removed-export` is retired here rather than kept alongside. It compared
  // syntactic export names, so it found renames and missed the removals it was
  // named for; running both would propose one logical break twice.
  "acalys.correctness.public-export-reachability-loss",
  "acalys.correctness.required-parameter-added",
  // P1-M.4. The first analyzer whose hypothesis is about a value that still
  // flows: the call happens, nothing looks unused, and what is lost is the
  // difference between what came back and what the caller keeps.
  "acalys.correctness.discarded-replacement-return",
] as const;

export {
  DISCARDED_REPLACEMENT_RULE_ID,
  analyzeDiscardedReplacement,
} from "./correctness/discarded-replacement.js";

export {
  REQUIRED_PARAMETER_RULE_ID,
  analyzeRequiredParameterAdded,
} from "./correctness/api-compatibility.js";

export {
  EXPORT_REACHABILITY_RULE_ID,
  analyzeExportReachability,
} from "./correctness/export-reachability.js";

export {
  boundarySurface,
  declaredBoundaries,
  type PublicBoundarySurface,
  type ReachableName,
  type SurfaceCompleteness,
} from "./correctness/boundary-surface.js";
export * from "./verification/index.js";
export * from "./publication/index.js";
export * from "./premerge/index.js";

/**
 * The measurement vocabulary, exported because evaluation harnesses need it.
 *
 * `Quantity` is the reason a report can say "undefined" instead of rendering a
 * favourable zero. P1-M's quality gate divides true positives by published
 * comments, and a checkpoint that published nothing has an UNDEFINED ratio,
 * not a perfect one — the distinction the gate turns on.
 */
export {
  add,
  measured,
  notApplicable,
  ratio,
  render,
  sum,
  unmeasured,
  type Quantity,
} from "./telemetry/measurement.js";
