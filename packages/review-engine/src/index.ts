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
  wasDegraded,
  type AnalysisResult,
  type CandidateFinding,
  type CausalChain,
  type CorrectnessFamily,
  type Counterfactual,
  type Proposal,
  type ProposalOutcome,
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
