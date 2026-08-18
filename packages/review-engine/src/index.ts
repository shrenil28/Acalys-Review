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
] as const;
export * from "./verification/index.js";
export * from "./publication/index.js";
export * from "./premerge/index.js";
