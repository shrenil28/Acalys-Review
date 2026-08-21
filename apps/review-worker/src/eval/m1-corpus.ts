import { createHash } from "node:crypto";

import type { CorrectnessFamily } from "@acalys/review-engine";

export const M1_CORPUS_VERSION = "p1-m1-corpus/2026-08-21.v1" as const;
export const M1_L5_BASELINE_COMMIT =
  "f7b49af1224a0942db6884e2a9939e60b364ac5b" as const;

export const M1_CAPABILITY_FAMILIES = [
  "configuration_sensitive_type_safety",
  "public_api_compatibility",
  "returned_value_usage",
  "boundary_comparison",
  "fail_closed_authorization",
  "sensitive_data_exposure",
  "required_failure_observability",
  "deterministic_serialization",
] as const;

export type M1CapabilityFamily = (typeof M1_CAPABILITY_FAMILIES)[number];
export type M1CorpusSplit = "development" | "holdout";

export interface M1ExpectedFinding {
  readonly id: string;
  readonly correctnessFamily: CorrectnessFamily;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly summary: string;
}

export interface M1CapabilityCase {
  readonly id: string;
  readonly split: M1CorpusSplit;
  readonly capabilityFamily: M1CapabilityFamily;
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly headFiles: Readonly<Record<string, string>>;
  readonly changed: readonly {
    readonly path: string;
    readonly changedLines: readonly number[];
  }[];
  readonly expectedFindings: readonly M1ExpectedFinding[];
  readonly because: string;
}

export interface M1MissAttribution {
  readonly caseId: string;
  readonly goldId: string;
  readonly capabilityFamily: M1CapabilityFamily;
  readonly correctnessFamily: CorrectnessFamily;
  readonly analyzer: "absent";
  readonly verifier: "not_run";
  readonly policy: "not_run";
  readonly rootCause: "analyzer_capability";
  readonly requiredEvidenceAvailable: true;
  readonly selectedFactFamilies: readonly string[];
  readonly repositoryIntelligenceRelevance: "necessary" | "supporting";
}

export interface M1TaxonomyRow {
  readonly rank: number;
  readonly family: M1CapabilityFamily;
  readonly historicalMisses: number;
  readonly historicalCaseIds: readonly string[];
  readonly frequency: 1 | 2;
  readonly severity: 1 | 2 | 3 | 4 | 5;
  readonly deterministicDetectability: 1 | 2 | 3 | 4 | 5;
  readonly verificationFeasibility: 1 | 2 | 3 | 4 | 5;
  readonly falsePositiveRisk: 1 | 2 | 3 | 4 | 5;
  readonly cost: 1 | 2 | 3 | 4 | 5;
  readonly rationale: string;
}

export interface M1NaturalFalsePositive {
  readonly id: string;
  readonly observedAt: "P1-J.2";
  readonly replayChallengeId: string;
  readonly analyzerBehavior: "historically_produced_candidate";
  readonly gold: "must_not_publish";
  readonly because: string;
}

export const M1_HISTORICAL_BASELINE = {
  sourceCommit: M1_L5_BASELINE_COMMIT,
  sourceCorpusVersion: "p1-l5-corpus/2026-08-21.v2",
  planted: 12,
  candidates: 2,
  publishedTruePositives: 2,
  publishedFalsePositives: 0,
  publishedFalseNegatives: 10,
  publishedPrecision: 1,
  publishedRecall: 2 / 12,
  caseIds: [
    "structural-index-public-signature-declaration",
    "structural-index-export-declaration-drift",
    "binding-floating-reservation",
    "binding-shadowed-validator-contract",
    "test-relationship-stable-serialization",
    "test-relationship-expiry-boundary",
    "config-exact-optional-assignment",
    "config-unchecked-index-access",
    "instruction-auth-denial-audit",
    "instruction-payment-token-logging",
    "interaction-binding-and-test-delivery",
    "interaction-config-and-instruction-fail-closed",
  ],
} as const;

export const M1_MISS_ATTRIBUTIONS: readonly M1MissAttribution[] = [
  {
    caseId: "config-exact-optional-assignment",
    goldId: "exact-optional-undefined-assignment",
    capabilityFamily: "configuration_sensitive_type_safety",
    correctnessFamily: "nullability",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["config_governance", "structural_index"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "config-unchecked-index-access",
    goldId: "unchecked-first-element",
    capabilityFamily: "configuration_sensitive_type_safety",
    correctnessFamily: "boundary",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["config_governance", "structural_index"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "structural-index-public-signature-declaration",
    goldId: "format-implementation-diverges-from-public-declaration",
    capabilityFamily: "public_api_compatibility",
    correctnessFamily: "api_contract",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["structural_index"],
    repositoryIntelligenceRelevance: "supporting",
  },
  {
    caseId: "structural-index-export-declaration-drift",
    goldId: "parse-export-diverges-from-indexed-declaration",
    capabilityFamily: "public_api_compatibility",
    correctnessFamily: "compatibility",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["structural_index"],
    repositoryIntelligenceRelevance: "supporting",
  },
  {
    caseId: "binding-shadowed-validator-contract",
    goldId: "validated-value-discarded",
    capabilityFamily: "returned_value_usage",
    correctnessFamily: "data_flow",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["binding", "structural_index"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "test-relationship-stable-serialization",
    goldId: "serialization-order-regression",
    capabilityFamily: "deterministic_serialization",
    correctnessFamily: "data_flow",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["structural_index", "test_relationship"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "test-relationship-expiry-boundary",
    goldId: "expiry-allows-boundary-token",
    capabilityFamily: "boundary_comparison",
    correctnessFamily: "boundary",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["structural_index", "test_relationship"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "instruction-auth-denial-audit",
    goldId: "auth-denial-not-audited",
    capabilityFamily: "required_failure_observability",
    correctnessFamily: "error_handling",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["instruction_governance", "structural_index"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "instruction-payment-token-logging",
    goldId: "payment-token-debug-log",
    capabilityFamily: "sensitive_data_exposure",
    correctnessFamily: "data_flow",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: ["instruction_governance", "structural_index"],
    repositoryIntelligenceRelevance: "necessary",
  },
  {
    caseId: "interaction-config-and-instruction-fail-closed",
    goldId: "absent-role-not-fail-closed",
    capabilityFamily: "fail_closed_authorization",
    correctnessFamily: "control_flow",
    analyzer: "absent",
    verifier: "not_run",
    policy: "not_run",
    rootCause: "analyzer_capability",
    requiredEvidenceAvailable: true,
    selectedFactFamilies: [
      "config_governance",
      "instruction_governance",
      "structural_index",
    ],
    repositoryIntelligenceRelevance: "necessary",
  },
];

export const M1_CAPABILITY_TAXONOMY: readonly M1TaxonomyRow[] = [
  {
    rank: 1,
    family: "configuration_sensitive_type_safety",
    historicalMisses: 2,
    historicalCaseIds: [
      "config-exact-optional-assignment",
      "config-unchecked-index-access",
    ],
    frequency: 2,
    severity: 4,
    deterministicDetectability: 5,
    verificationFeasibility: 5,
    falsePositiveRisk: 1,
    cost: 2,
    rationale:
      "Two misses are governed by authoritative compiler options and admit independent compiler-diagnostic verification.",
  },
  {
    rank: 2,
    family: "public_api_compatibility",
    historicalMisses: 2,
    historicalCaseIds: [
      "structural-index-public-signature-declaration",
      "structural-index-export-declaration-drift",
    ],
    frequency: 2,
    severity: 4,
    deterministicDetectability: 4,
    verificationFeasibility: 4,
    falsePositiveRisk: 2,
    cost: 3,
    rationale:
      "Two misses are deterministic base-to-head public-surface changes, but compatibility intent needs stronger evidence than syntax alone.",
  },
  {
    rank: 3,
    family: "returned_value_usage",
    historicalMisses: 1,
    historicalCaseIds: ["binding-shadowed-validator-contract"],
    frequency: 1,
    severity: 4,
    deterministicDetectability: 4,
    verificationFeasibility: 4,
    falsePositiveRisk: 2,
    cost: 3,
    rationale:
      "The exact binding and changed data flow are available; independent type/value-flow evidence can distinguish normalizers from validation-only calls.",
  },
  {
    rank: 4,
    family: "boundary_comparison",
    historicalMisses: 1,
    historicalCaseIds: ["test-relationship-expiry-boundary"],
    frequency: 1,
    severity: 4,
    deterministicDetectability: 3,
    verificationFeasibility: 4,
    falsePositiveRisk: 2,
    cost: 3,
    rationale:
      "A bound executable boundary example supplies a strong counterexample, but arbitrary comparison changes are not defects without that contract.",
  },
  {
    rank: 5,
    family: "fail_closed_authorization",
    historicalMisses: 1,
    historicalCaseIds: ["interaction-config-and-instruction-fail-closed"],
    frequency: 1,
    severity: 5,
    deterministicDetectability: 3,
    verificationFeasibility: 3,
    falsePositiveRisk: 3,
    cost: 3,
    rationale:
      "The security consequence is high and governing evidence is explicit, but detection must combine absence semantics with policy rather than key on syntax.",
  },
  {
    rank: 6,
    family: "sensitive_data_exposure",
    historicalMisses: 1,
    historicalCaseIds: ["instruction-payment-token-logging"],
    frequency: 1,
    severity: 5,
    deterministicDetectability: 3,
    verificationFeasibility: 3,
    falsePositiveRisk: 3,
    cost: 4,
    rationale:
      "The applicable policy is exact, but general detection requires trustworthy source-to-sink flow rather than matching variable names or log calls.",
  },
  {
    rank: 7,
    family: "required_failure_observability",
    historicalMisses: 1,
    historicalCaseIds: ["instruction-auth-denial-audit"],
    frequency: 1,
    severity: 3,
    deterministicDetectability: 2,
    verificationFeasibility: 3,
    falsePositiveRisk: 3,
    cost: 4,
    rationale:
      "The instruction defines a required side effect, but proving its absence across exception paths needs more than empty-catch recognition.",
  },
  {
    rank: 8,
    family: "deterministic_serialization",
    historicalMisses: 1,
    historicalCaseIds: ["test-relationship-stable-serialization"],
    frequency: 1,
    severity: 3,
    deterministicDetectability: 2,
    verificationFeasibility: 3,
    falsePositiveRisk: 4,
    cost: 4,
    rationale:
      "The test establishes the contract, but generalizing from arbitrary implementation swaps without executing authored examples has substantial noise risk.",
  },
];

const developmentCases: readonly M1CapabilityCase[] = [
  {
    id: "dev-config-optional-cache-entry",
    split: "development",
    capabilityFamily: "configuration_sensitive_type_safety",
    baseFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}',
      "src/cache.ts":
        "interface Entry { tag?: string }\nexport function clear(entry: Entry): void {\n  delete entry.tag;\n}",
    },
    headFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}',
      "src/cache.ts":
        "interface Entry { tag?: string }\nexport function clear(entry: Entry): void {\n  entry.tag = undefined;\n}",
    },
    changed: [{ path: "src/cache.ts", changedLines: [3] }],
    expectedFindings: [
      {
        id: "optional-cache-entry-assigned-undefined",
        correctnessFamily: "nullability",
        path: "src/cache.ts",
        startLine: 3,
        endLine: 3,
        summary: "The assignment violates exact optional property semantics.",
      },
    ],
    because:
      "the governing project enables exactOptionalPropertyTypes and the change replaces absence with an explicit undefined value",
  },
  {
    id: "dev-api-required-locale-parameter",
    split: "development",
    capabilityFamily: "public_api_compatibility",
    baseFiles: {
      "src/title.ts":
        "export function title(id: string): string {\n  return id;\n}",
    },
    headFiles: {
      "src/title.ts":
        "export function title(id: string, locale: string): string {\n  return `${locale}:${id}`;\n}",
    },
    changed: [{ path: "src/title.ts", changedLines: [1, 2] }],
    expectedFindings: [
      {
        id: "public-title-adds-required-parameter",
        correctnessFamily: "api_contract",
        path: "src/title.ts",
        startLine: 1,
        endLine: 1,
        summary: "The exported function adds a required parameter.",
      },
    ],
    because:
      "the base-to-head public signature adds a required argument without a compatibility default",
  },
  {
    id: "dev-returned-sanitized-value-discarded",
    split: "development",
    capabilityFamily: "returned_value_usage",
    baseFiles: {
      "src/route.ts":
        'import { sanitize } from "./sanitize.js";\nexport function route(raw: string): string {\n  return sanitize(raw);\n}',
      "src/sanitize.ts":
        "export function sanitize(raw: string): string { return raw.trim(); }",
    },
    headFiles: {
      "src/route.ts":
        'import { sanitize } from "./sanitize.js";\nexport function route(raw: string): string {\n  sanitize(raw);\n  return raw;\n}',
      "src/sanitize.ts":
        "export function sanitize(raw: string): string { return raw.trim(); }",
    },
    changed: [{ path: "src/route.ts", changedLines: [3, 4] }],
    expectedFindings: [
      {
        id: "sanitized-return-value-discarded",
        correctnessFamily: "data_flow",
        path: "src/route.ts",
        startLine: 3,
        endLine: 4,
        summary: "The route returns the unsanitized input.",
      },
    ],
    because:
      "the exact imported function transforms its input and the changed caller discards that returned value",
  },
  {
    id: "dev-serialization-sorted-query-contract",
    split: "development",
    capabilityFamily: "deterministic_serialization",
    baseFiles: {
      "src/query.ts":
        "export function encode(values: Record<string, string>): string {\n  return Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('&');\n}",
      "test/query.test.ts":
        "import { encode } from '../src/query.js';\nit('sorts keys', () => expect(encode({ z: '1', a: '2' })).toBe('a=2&z=1'));",
    },
    headFiles: {
      "src/query.ts":
        "export function encode(values: Record<string, string>): string {\n  return new URLSearchParams(values).toString();\n}",
      "test/query.test.ts":
        "import { encode } from '../src/query.js';\nit('sorts keys', () => expect(encode({ z: '1', a: '2' })).toBe('a=2&z=1'));",
    },
    changed: [{ path: "src/query.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "query-key-order-no-longer-stable",
        correctnessFamily: "data_flow",
        path: "src/query.ts",
        startLine: 2,
        endLine: 2,
        summary: "Query serialization no longer sorts keys.",
      },
    ],
    because:
      "the bound test defines key ordering while the replacement preserves insertion order",
  },
  {
    id: "dev-boundary-retry-deadline",
    split: "development",
    capabilityFamily: "boundary_comparison",
    baseFiles: {
      "src/retry.ts":
        "export function expired(deadline: number, now: number): boolean {\n  return now >= deadline;\n}",
      "test/retry.test.ts":
        "import { expired } from '../src/retry.js';\nit('expires on deadline', () => expect(expired(5, 5)).toBe(true));",
    },
    headFiles: {
      "src/retry.ts":
        "export function expired(deadline: number, now: number): boolean {\n  return now > deadline;\n}",
      "test/retry.test.ts":
        "import { expired } from '../src/retry.js';\nit('expires on deadline', () => expect(expired(5, 5)).toBe(true));",
    },
    changed: [{ path: "src/retry.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "retry-remains-live-at-deadline",
        correctnessFamily: "boundary",
        path: "src/retry.ts",
        startLine: 2,
        endLine: 2,
        summary: "The retry remains live at the exact deadline.",
      },
    ],
    because:
      "the bound test supplies the equality counterexample that distinguishes the changed comparison",
  },
  {
    id: "dev-failure-observability-session-denial",
    split: "development",
    capabilityFamily: "required_failure_observability",
    baseFiles: {
      "AGENTS.md": "Rejected sessions must increment the denial metric.",
      "src/session.ts":
        "export function open(ok: boolean): boolean {\n  if (!ok) { metrics.increment('denied'); return false; }\n  return true;\n}",
    },
    headFiles: {
      "AGENTS.md": "Rejected sessions must increment the denial metric.",
      "src/session.ts":
        "export function open(ok: boolean): boolean {\n  if (!ok) return false;\n  return true;\n}",
    },
    changed: [{ path: "src/session.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "session-denial-metric-removed",
        correctnessFamily: "error_handling",
        path: "src/session.ts",
        startLine: 2,
        endLine: 2,
        summary: "Rejected sessions are no longer observable.",
      },
    ],
    because:
      "the trusted governing instruction requires an explicit side effect on the changed denial path",
  },
  {
    id: "dev-sensitive-session-secret-log",
    split: "development",
    capabilityFamily: "sensitive_data_exposure",
    baseFiles: {
      "src/auth/AGENTS.md": "Never write session secrets to logs.",
      "src/auth/session.ts":
        "export function accept(secret: string): boolean {\n  return secret.length > 0;\n}",
    },
    headFiles: {
      "src/auth/AGENTS.md": "Never write session secrets to logs.",
      "src/auth/session.ts":
        "export function accept(secret: string): boolean {\n  console.info(secret);\n  return secret.length > 0;\n}",
    },
    changed: [{ path: "src/auth/session.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "session-secret-written-to-log",
        correctnessFamily: "data_flow",
        path: "src/auth/session.ts",
        startLine: 2,
        endLine: 2,
        summary: "The changed log exposes a session secret.",
      },
    ],
    because:
      "the nearest trusted instruction names the source value and forbids the changed sink",
  },
  {
    id: "dev-fail-closed-feature-permission",
    split: "development",
    capabilityFamily: "fail_closed_authorization",
    baseFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "AGENTS.md": "Missing feature permissions must deny access.",
      "src/access.ts":
        "export function allowed(grants: Record<string, boolean>, key: string): boolean {\n  return grants[key] ?? false;\n}",
    },
    headFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "AGENTS.md": "Missing feature permissions must deny access.",
      "src/access.ts":
        "export function allowed(grants: Record<string, boolean>, key: string): boolean {\n  return grants[key];\n}",
    },
    changed: [{ path: "src/access.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "missing-feature-permission-not-denied",
        correctnessFamily: "control_flow",
        path: "src/access.ts",
        startLine: 2,
        endLine: 2,
        summary: "Missing permissions no longer fail closed.",
      },
    ],
    because:
      "the compiler exposes absence and the trusted policy defines the required false fallback",
  },
];

const holdoutCases: readonly M1CapabilityCase[] = [
  {
    id: "holdout-config-indexed-header",
    split: "holdout",
    capabilityFamily: "configuration_sensitive_type_safety",
    baseFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "src/header.ts":
        "export function first(headers: string[]): string | undefined {\n  return headers[0]?.trim();\n}",
    },
    headFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "src/header.ts":
        "export function first(headers: string[]): string {\n  return headers[0].trim();\n}",
    },
    changed: [{ path: "src/header.ts", changedLines: [1, 2] }],
    expectedFindings: [
      {
        id: "empty-header-list-dereferenced",
        correctnessFamily: "boundary",
        path: "src/header.ts",
        startLine: 2,
        endLine: 2,
        summary: "An empty header list causes an undefined dereference.",
      },
    ],
    because: "the governing compiler option makes indexed absence explicit",
  },
  {
    id: "holdout-api-export-alias-removal",
    split: "holdout",
    capabilityFamily: "public_api_compatibility",
    baseFiles: {
      "src/codec.ts":
        "function decode(raw: string): string { return raw; }\nexport { decode };",
    },
    headFiles: {
      "src/codec.ts":
        "function decode(raw: string): string { return raw; }\nexport { decode as decodeInternal };",
    },
    changed: [{ path: "src/codec.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "public-decode-export-removed",
        correctnessFamily: "compatibility",
        path: "src/codec.ts",
        startLine: 2,
        endLine: 2,
        summary: "The public decode export was removed.",
      },
    ],
    because:
      "the base public name disappears even though the declaration remains",
  },
  {
    id: "holdout-returned-decoded-value-discarded",
    split: "holdout",
    capabilityFamily: "returned_value_usage",
    baseFiles: {
      "src/read.ts":
        'import { decode } from "./codec.js";\nexport function read(raw: string): string {\n  return decode(raw);\n}',
      "src/codec.ts":
        "export function decode(raw: string): string { return raw.replaceAll('%20', ' '); }",
    },
    headFiles: {
      "src/read.ts":
        'import { decode } from "./codec.js";\nexport function read(raw: string): string {\n  decode(raw);\n  return raw;\n}',
      "src/codec.ts":
        "export function decode(raw: string): string { return raw.replaceAll('%20', ' '); }",
    },
    changed: [{ path: "src/read.ts", changedLines: [3, 4] }],
    expectedFindings: [
      {
        id: "decoded-return-value-discarded",
        correctnessFamily: "data_flow",
        path: "src/read.ts",
        startLine: 3,
        endLine: 4,
        summary: "The reader returns the encoded input.",
      },
    ],
    because:
      "the bound decoder transforms its return value and the caller discards it",
  },
  {
    id: "holdout-serialization-stable-header-order",
    split: "holdout",
    capabilityFamily: "deterministic_serialization",
    baseFiles: {
      "src/headers.ts":
        "export function encode(values: Record<string, string>): string {\n  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('\\n');\n}",
      "test/headers.test.ts":
        "import { encode } from '../src/headers.js';\nit('sorts headers', () => expect(encode({ z: '1', a: '2' })).toBe('a:2\\nz:1'));",
    },
    headFiles: {
      "src/headers.ts":
        "export function encode(values: Record<string, string>): string {\n  return Object.entries(values).map(([k, v]) => `${k}:${v}`).join('\\n');\n}",
      "test/headers.test.ts":
        "import { encode } from '../src/headers.js';\nit('sorts headers', () => expect(encode({ z: '1', a: '2' })).toBe('a:2\\nz:1'));",
    },
    changed: [{ path: "src/headers.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "header-order-no-longer-stable",
        correctnessFamily: "data_flow",
        path: "src/headers.ts",
        startLine: 2,
        endLine: 2,
        summary: "Header serialization no longer sorts keys.",
      },
    ],
    because:
      "the associated test fixes order independently of the implementation",
  },
  {
    id: "holdout-boundary-quota-limit",
    split: "holdout",
    capabilityFamily: "boundary_comparison",
    baseFiles: {
      "src/quota.ts":
        "export function exceeded(used: number, limit: number): boolean {\n  return used >= limit;\n}",
      "test/quota.test.ts":
        "import { exceeded } from '../src/quota.js';\nit('blocks at quota', () => expect(exceeded(10, 10)).toBe(true));",
    },
    headFiles: {
      "src/quota.ts":
        "export function exceeded(used: number, limit: number): boolean {\n  return used > limit;\n}",
      "test/quota.test.ts":
        "import { exceeded } from '../src/quota.js';\nit('blocks at quota', () => expect(exceeded(10, 10)).toBe(true));",
    },
    changed: [{ path: "src/quota.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "quota-allows-exact-limit",
        correctnessFamily: "boundary",
        path: "src/quota.ts",
        startLine: 2,
        endLine: 2,
        summary: "The exact quota limit is no longer blocked.",
      },
    ],
    because: "the bound equality example fixes the intended inclusive boundary",
  },
  {
    id: "holdout-failure-observability-lockout",
    split: "holdout",
    capabilityFamily: "required_failure_observability",
    baseFiles: {
      "AGENTS.md": "Account lockouts must emit an audit event.",
      "src/lockout.ts":
        "export function lock(account: string): boolean {\n  audit(account);\n  return false;\n}",
    },
    headFiles: {
      "AGENTS.md": "Account lockouts must emit an audit event.",
      "src/lockout.ts":
        "export function lock(account: string): boolean {\n  return false;\n}",
    },
    changed: [{ path: "src/lockout.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "lockout-audit-event-removed",
        correctnessFamily: "error_handling",
        path: "src/lockout.ts",
        startLine: 2,
        endLine: 2,
        summary: "Account lockouts are no longer audited.",
      },
    ],
    because:
      "the governing instruction requires the removed failure-path event",
  },
  {
    id: "holdout-sensitive-api-key-log",
    split: "holdout",
    capabilityFamily: "sensitive_data_exposure",
    baseFiles: {
      "services/client/AGENTS.md": "API keys must never be included in logs.",
      "services/client/src/connect.ts":
        "export function connect(apiKey: string): boolean {\n  return apiKey.length > 0;\n}",
    },
    headFiles: {
      "services/client/AGENTS.md": "API keys must never be included in logs.",
      "services/client/src/connect.ts":
        "export function connect(apiKey: string): boolean {\n  console.warn('connect', apiKey);\n  return apiKey.length > 0;\n}",
    },
    changed: [{ path: "services/client/src/connect.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "api-key-written-to-log",
        correctnessFamily: "data_flow",
        path: "services/client/src/connect.ts",
        startLine: 2,
        endLine: 2,
        summary: "The changed log exposes an API key.",
      },
    ],
    because:
      "the nearest trusted instruction names the sensitive source and forbidden sink",
  },
  {
    id: "holdout-fail-closed-tenant-role",
    split: "holdout",
    capabilityFamily: "fail_closed_authorization",
    baseFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "AGENTS.md": "Unknown tenant roles must be denied.",
      "src/tenant.ts":
        "export function canRead(roles: Record<string, boolean>, tenant: string): boolean {\n  return roles[tenant] ?? false;\n}",
    },
    headFiles: {
      "tsconfig.json":
        '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
      "AGENTS.md": "Unknown tenant roles must be denied.",
      "src/tenant.ts":
        "export function canRead(roles: Record<string, boolean>, tenant: string): boolean {\n  return roles[tenant];\n}",
    },
    changed: [{ path: "src/tenant.ts", changedLines: [2] }],
    expectedFindings: [
      {
        id: "unknown-tenant-role-not-denied",
        correctnessFamily: "control_flow",
        path: "src/tenant.ts",
        startLine: 2,
        endLine: 2,
        summary: "Unknown tenant roles no longer fail closed.",
      },
    ],
    because:
      "type-level absence and the governing security policy agree on a false fallback",
  },
];

export const M1_NATURAL_FALSE_POSITIVES: readonly M1NaturalFalsePositive[] = [
  {
    id: "natural-shadowed-parameter-async-name",
    observedAt: "P1-J.2",
    replayChallengeId: "historical-shadowed-parameter",
    analyzerBehavior: "historically_produced_candidate",
    gold: "must_not_publish",
    because:
      "the analyzer resolved a synchronous shadowing parameter as an imported async function; this is the only naturally observed analyzer false positive and remains an append-only replay",
  },
];

export const M1_DEVELOPMENT_CASES = deepFreeze(developmentCases);
export const M1_HOLDOUT_CASES = deepFreeze(holdoutCases);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Codepoint order, not `localeCompare`: a seal whose key ordering
        // depends on ICU data is a seal that can differ between two correct
        // machines. Same rule as the canonical index digest in L.1.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function corpusDigest(cases: readonly M1CapabilityCase[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(cases)), "utf8")
    .digest("hex");
}

export const M1_HOLDOUT_DIGEST =
  "277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012" as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
