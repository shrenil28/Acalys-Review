/**
 * The repository index — canonical, provenance-bearing structural facts.
 *
 * What this is, stated once so the boundary stays legible:
 *
 * ```
 * a statement about ONE repository at ONE revision,
 * produced by ONE extractor under ONE schema,
 * describing WHAT EXISTS and HOW WE KNOW.
 * ```
 *
 * What it is deliberately not, at L.1: an incremental index, a persistent
 * cache, a call graph, a type graph, a test-association map, a semantic search
 * surface, a cross-language index, a cross-revision continuity model, or a
 * performance improvement. Each of those is a later checkpoint with its own
 * semantics, and claiming any of them here would make the phrase "the index
 * says" mean something different from what the code does.
 */

export {
  EXTRACTOR_VERSION,
  INDEX_SCHEMA_VERSION,
  SUPPORTED_EXTENSIONS,
  describeIdentity,
  describeTenant,
  indexIdentity,
  isPersistable,
  sameIndex,
  type RepositoryIndexIdentity,
  type RepositoryIndexIdentityInput,
  type TenantScope,
} from "./identity.js";

export {
  MODULE_COVERAGE,
  MODULE_ROLES,
  REFERENCE_KINDS,
  RESOLUTIONS,
  type BindingEdge,
  type BindingLookup,
  type DeclarationRecord,
  type FactProvenance,
  type IndexAvailability,
  type IndexCoverage,
  type ModuleCoverage,
  type ModuleRecord,
  type ModuleRole,
  type ReferenceKind,
  type ReferenceRecord,
  type RepositoryIndex,
  type Resolution,
  type SymbolLookup,
  type SymbolRecord,
} from "./records.js";

export {
  buildRepositoryIndex,
  classifyModule,
  unavailableIndex,
  type BuildOptions,
  type RevisionSnapshot,
} from "./build.js";

export { canonicalSerialization, indexDigest } from "./digest.js";

export {
  TEST_RELATIONSHIP_STRENGTHS,
  citeTestRelationship,
  testCoverageEvidence,
  testRelationships,
  testsForSymbol,
  type TestEvidence,
  type TestRelationship,
  type TestRelationshipStrength,
} from "./test-relationships.js";

export {
  CONSISTENCY_RULES,
  validateIndexConsistency,
  type ConsistencyRule,
  type ConsistencyViolation,
} from "./consistency.js";

export {
  RECOMPUTE_REASONS,
  deriveChangeManifest,
  planIncrementalUpdate,
  type ChangeManifest,
  type IncrementalIndexPlan,
  type ModuleDecision,
  type RecomputeReason,
} from "./incremental-plan.js";

export {
  FALLBACK_REASONS,
  updateFromSnapshot,
  updateRepositoryIndex,
  type FallbackReason,
  type IncrementalOutcome,
  type IncrementalStats,
} from "./incremental.js";

export { discoverProjects, type ProjectDiscovery } from "./config-discovery.js";

export {
  readProjectConfigs,
  type ProjectConfigFact,
} from "./config-projects.js";

export {
  INSTRUCTION_APPLICABILITY_REASONS,
  INSTRUCTION_CLASSES,
  INSTRUCTION_FAILURES,
  INSTRUCTION_TRUST,
  NO_INSTRUCTION_FACTS,
  instructionApplicabilityFor,
  isInstructionArtifact,
  isInstructionCoverageComplete,
  type AvailableInstructionArtifact,
  type InstructionApplicability,
  type InstructionApplicabilityReason,
  type InstructionApplicabilityResult,
  type InstructionArtifact,
  type InstructionClass,
  type InstructionCoverage,
  type InstructionFacts,
  type InstructionFailure,
  type InstructionPrecedence,
  type InstructionProvenance,
  type InstructionTrust,
  type NoApplicableInstructionEvidence,
  type UnavailableInstructionArtifact,
} from "./instruction-model.js";

export {
  classifyInstructionCandidate,
  discoverInstructionArtifacts,
  type DiscoveredInstructionArtifact,
  type DiscoveredUnavailableInstructionArtifact,
  type InstructionArtifactRead,
  type InstructionCandidateClassification,
  type InstructionDiscoveryResult,
  type InstructionEvaluationCoverage,
  type InstructionRevisionSnapshot,
  type InstructionTraversal,
} from "./instruction-discovery.js";

export {
  evaluateInstructionScopes,
  type InstructionScopeEvaluation,
} from "./instruction-applicability.js";

export {
  analyzeInstructionPrecedenceAndTrust,
  type ApplicableInstructionClass,
  type InstructionPrecedenceRelationship,
  type InstructionPrecedenceTrustAnalysis,
  type InstructionPrecedenceTrustFact,
  type InstructionTrustRelationship,
} from "./instruction-precedence.js";

export {
  governanceFor,
  optionInheritance,
  projectReferences,
  type ProjectDiscovery as ConfigGovernanceProjectDiscovery,
  type ProjectConfigFact as ConfigGovernanceProjectConfigFact,
} from "./config-governance.js";

export {
  bindingOf,
  citeBinding,
  citeDeclaration,
  declarationAt,
  declarationsIn,
  isUsable,
  moduleAt,
  modulesReferencing,
  referenceAt,
  referencesIn,
  resolvedDeclarations,
  symbolById,
  symbolNamed,
} from "./query.js";
