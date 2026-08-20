/**
 * Frozen P1-L.5 evaluation inputs and human-authored gold labels.
 *
 * This module intentionally has no dependency on the planner, analyzers, or
 * experiment runner. Gold labels must remain independent of current output.
 */

export const L5_EXPERIMENT_SCHEMA_VERSION = "p1-l5-experiment/v1" as const;
export const L5_CORPUS_VERSION = "p1-l5-corpus/2026-08-21.v1" as const;

export const L5_CONTEXT_FAMILIES = [
  "structural_index",
  "binding",
  "test_relationship",
  "config_governance",
  "instruction_governance",
] as const;

export type L5ContextFamily = (typeof L5_CONTEXT_FAMILIES)[number];

export const L5_CONTEXT_REASONS = [
  "declaration",
  "caller",
  "test",
  "config",
  "instruction",
  "coverage",
  "changed_source",
  "other",
] as const;

export type L5ContextReason = (typeof L5_CONTEXT_REASONS)[number];

export const L5_CASE_CATEGORIES = [
  "structural_index_positive",
  "binding_only_positive",
  "test_relationship_positive",
  "config_governance_positive",
  "instruction_governance_positive",
  "multiple_family_interaction",
  "clean_control",
] as const;

export type L5CaseCategory = (typeof L5_CASE_CATEGORIES)[number];

export interface L5ChangedPath {
  readonly path: string;
  readonly baseContent: string;
  readonly headContent: string;
  readonly changedLines: readonly number[];
}

export interface L5RevisionFixture {
  readonly syntheticRevision: string;
  /** Complete path-to-content manifest for this synthetic repository. */
  readonly files: Readonly<Record<string, string>>;
  readonly changeManifest: readonly L5ChangedPath[];
  readonly contextSelection: {
    readonly budgetTokens: number;
    readonly enabledFamilies: readonly L5ContextFamily[];
  };
  readonly coverage:
    | { readonly status: "complete" }
    | {
        readonly status: "incomplete";
        readonly outages: readonly {
          readonly path: string;
          readonly operation: "discovery" | "read" | "parse";
          readonly because: string;
        }[];
      };
}

export interface L5ExpectedFinding {
  /** Stable authored identity for one distinct defect opportunity. */
  readonly goldId: string;
  readonly ruleId: string;
  readonly family: L5ContextFamily;
  readonly path: string;
  readonly allowedAnchor: {
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly summary: string;
  /** Human-authored justification; never populated from analyzer output. */
  readonly because: string;
}

export interface L5ContextLabel {
  readonly id: string;
  readonly family: L5ContextFamily;
  readonly reason: L5ContextReason;
  readonly path: string;
  readonly selector:
    | { readonly kind: "artifact" }
    | {
        readonly kind: "span";
        readonly startLine: number;
        readonly endLine: number;
      }
    | { readonly kind: "content"; readonly contains: string };
  readonly because: string;
  /** Present only for required exposure labels. */
  readonly requiredExposure?: {
    readonly disappearsUnderAblation: L5ContextFamily;
    readonly because: string;
  };
}

export interface L5CorpusCase extends L5RevisionFixture {
  readonly id: string;
  readonly category: L5CaseCategory;
  readonly summary: string;
  readonly families: readonly L5ContextFamily[];
  readonly eligibility: {
    readonly witness:
      | "positive_gold_and_ablatable_exposure"
      | "multiple_ablatable_exposures"
      | "authored_no_finding";
    readonly because: string;
  };
  readonly gold: {
    readonly expectedFindings: readonly L5ExpectedFinding[];
    readonly noFindingBecause?: string;
    readonly requiredContext: readonly L5ContextLabel[];
    readonly forbiddenContext: readonly L5ContextLabel[];
  };
  readonly outageWitness?: {
    readonly knownPositiveFindingId: string;
    readonly because: string;
  };
}

export interface L5IncrementalPair {
  readonly id: string;
  readonly baseCaseId: string;
  readonly to: L5RevisionFixture;
  readonly because: string;
}

export type L5CachePairCategory =
  | "unchanged_input"
  | "config_only"
  | "instruction_only"
  | "context_selection_only";

export interface L5CacheIdentityPair {
  readonly id: string;
  readonly baseCaseId: string;
  readonly category: L5CachePairCategory;
  readonly expectation: "reuse_expected" | "invalidation_expected";
  readonly to: L5RevisionFixture;
  /** Authored from fixture semantics, never from a produced cache key or digest. */
  readonly expectationBecause: string;
}

export interface L5Corpus {
  readonly experimentSchemaVersion: typeof L5_EXPERIMENT_SCHEMA_VERSION;
  readonly corpusVersion: typeof L5_CORPUS_VERSION;
  readonly cases: readonly L5CorpusCase[];
  readonly incrementalPairs: readonly L5IncrementalPair[];
  readonly cacheIdentityPairs: readonly L5CacheIdentityPair[];
}

export const L5_MINIMUM_COMPOSITION = {
  structural_index_positive: 2,
  binding_only_positive: 2,
  test_relationship_positive: 2,
  config_governance_positive: 2,
  instruction_governance_positive: 2,
  multiple_family_interaction: 2,
  clean_control: 4,
  incrementalPairs: 4,
  cacheIdentityPairs: 8,
  cacheReuseExpected: 2,
  cacheConfigOnlyInvalidation: 2,
  cacheInstructionOnlyInvalidation: 2,
  cacheContextSelectionInvalidation: 2,
  goldFindingsPerFamily: 2,
} as const;

const lines = (...source: readonly string[]) => source.join("\n");

const allFamilies = [...L5_CONTEXT_FAMILIES];

const completeSelection = {
  budgetTokens: 1_200,
  enabledFamilies: allFamilies,
} as const;

const caseRevision = (
  syntheticRevision: string,
  files: Readonly<Record<string, string>>,
  changed: L5ChangedPath,
  coverage: L5RevisionFixture["coverage"] = { status: "complete" },
): L5RevisionFixture => ({
  syntheticRevision,
  files,
  changeManifest: [changed],
  contextSelection: completeSelection,
  coverage,
});

const bindingPromiseFiles = {
  "src/checkout.ts": lines(
    'import { reserve } from "./inventory.js";',
    "export function checkout(sku: string): boolean {",
    "  reserve(sku);",
    "  return true;",
    "}",
  ),
  "src/inventory.ts": lines(
    "export async function reserve(sku: string): Promise<void> {",
    "  await Promise.resolve(sku);",
    "}",
  ),
  "src/unrelated.ts": "export const reserve = 1;",
};

const instructionAuditFiles = {
  "AGENTS.md":
    "Authentication denials must always be recorded with the account id.",
  "src/auth/login.ts": lines(
    "export async function login(accountId: string): Promise<boolean> {",
    "  try {",
    "    await Promise.reject(new Error(accountId));",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
  ),
  "vendor/AGENTS.md": "Vendor-specific review instructions.",
};

const rawCases: readonly L5CorpusCase[] = [
  {
    id: "structural-index-required-parameter-caller",
    category: "structural_index_positive",
    summary:
      "A changed declaration adds a required parameter used by an indexed caller.",
    families: ["structural_index"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the signature break is one distinct gold opportunity with a structural caller witness",
    },
    ...caseRevision(
      "l5/structural-index-required-parameter-caller/h1",
      {
        "src/format.ts": lines(
          "export function format(id: string, region: string): string {",
          "  return `${region}:${id}`;",
          "}",
        ),
        "src/profile.ts": lines(
          'import { format } from "./format.js";',
          "export const profileKey = (id: string): string => format(id);",
        ),
        "generated/client.ts":
          "export const format = (...values: string[]): string => values.join(':');",
      },
      {
        path: "src/format.ts",
        baseContent: lines(
          "export function format(id: string): string {",
          "  return id;",
          "}",
        ),
        headContent: lines(
          "export function format(id: string, region: string): string {",
          "  return `${region}:${id}`;",
          "}",
        ),
        changedLines: [1, 2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "required-region-breaks-profile-caller",
          ruleId: "structural-api-compatibility/v1",
          family: "structural_index",
          path: "src/format.ts",
          allowedAnchor: { startLine: 1, endLine: 1 },
          summary:
            "The required region parameter breaks an existing one-argument caller.",
          because:
            "the indexed profile caller still supplies only id, so the changed required parameter creates a concrete compile-time break",
        },
      ],
      requiredContext: [
        {
          id: "profile-format-caller",
          family: "structural_index",
          reason: "caller",
          path: "src/profile.ts",
          selector: { kind: "span", startLine: 1, endLine: 2 },
          because:
            "this indexed caller demonstrates the exact arity broken by the declaration change",
          requiredExposure: {
            disappearsUnderAblation: "structural_index",
            because:
              "reverse caller discovery is offered only by the structural repository index",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "generated-format-lookalike",
          family: "structural_index",
          reason: "other",
          path: "generated/client.ts",
          selector: { kind: "artifact" },
          because:
            "this generated same-name declaration is not a caller of the changed format export",
        },
      ],
    },
  },
  {
    id: "structural-index-export-removal-caller",
    category: "structural_index_positive",
    summary:
      "Removing an export breaks an indexed importer outside the changed file.",
    families: ["structural_index"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the removed export is one distinct gold opportunity with a known structural importer",
    },
    ...caseRevision(
      "l5/structural-index-export-removal-caller/h1",
      {
        "src/parser.ts": lines(
          "function parse(raw: string): number {",
          "  return Number(raw);",
          "}",
          "export { parse as parseInternal };",
        ),
        "src/cli.ts": lines(
          'import { parse } from "./parser.js";',
          "export const run = (raw: string): number => parse(raw);",
        ),
        "docs/parser.md": "The command line accepts numeric input.",
      },
      {
        path: "src/parser.ts",
        baseContent: lines(
          "export function parse(raw: string): number {",
          "  return Number(raw);",
          "}",
        ),
        headContent: lines(
          "function parse(raw: string): number {",
          "  return Number(raw);",
          "}",
          "export { parse as parseInternal };",
        ),
        changedLines: [1, 4],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "parse-export-removal-breaks-cli",
          ruleId: "structural-api-compatibility/v1",
          family: "structural_index",
          path: "src/parser.ts",
          allowedAnchor: { startLine: 1, endLine: 4 },
          summary: "Renaming the parse export breaks the existing CLI import.",
          because:
            "the indexed CLI imports the exact parse export, which no longer exists after the changed alias",
        },
      ],
      requiredContext: [
        {
          id: "cli-parse-importer",
          family: "structural_index",
          reason: "caller",
          path: "src/cli.ts",
          selector: { kind: "span", startLine: 1, endLine: 2 },
          because:
            "the importer proves that parse is a consumed public name rather than dead local surface",
          requiredExposure: {
            disappearsUnderAblation: "structural_index",
            because:
              "the reverse importer relationship is available only from the structural index",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "parser-product-prose",
          family: "structural_index",
          reason: "other",
          path: "docs/parser.md",
          selector: { kind: "artifact" },
          because:
            "product prose neither imports parse nor establishes a structural consumer",
        },
      ],
    },
  },
  {
    id: "binding-floating-reservation",
    category: "binding_only_positive",
    summary: "A changed caller drops the Promise returned by its exact callee.",
    families: ["binding"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "one distinct dropped-Promise opportunity requires the exact binding exposure",
    },
    ...caseRevision("l5/binding-floating-reservation/h1", bindingPromiseFiles, {
      path: "src/checkout.ts",
      baseContent: lines(
        'import { reserve } from "./inventory.js";',
        "export async function checkout(sku: string): Promise<boolean> {",
        "  await reserve(sku);",
        "  return true;",
        "}",
      ),
      headContent: bindingPromiseFiles["src/checkout.ts"],
      changedLines: [2, 3],
    }),
    gold: {
      expectedFindings: [
        {
          goldId: "reservation-completes-after-success",
          ruleId: "async-completion/v1",
          family: "binding",
          path: "src/checkout.ts",
          allowedAnchor: { startLine: 3, endLine: 3 },
          summary: "Checkout reports success before the reservation settles.",
          because:
            "the imported reserve declaration returns Promise<void>, and the changed synchronous caller neither awaits nor returns that Promise",
        },
      ],
      requiredContext: [
        {
          id: "exact-reserve-declaration",
          family: "binding",
          reason: "declaration",
          path: "src/inventory.ts",
          selector: { kind: "span", startLine: 1, endLine: 3 },
          because:
            "only the bound declaration establishes that reserve is asynchronous",
          requiredExposure: {
            disappearsUnderAblation: "binding",
            because:
              "the declaration is offered through the exact binding edge and no other family",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "same-name-unrelated-reserve",
          family: "binding",
          reason: "other",
          path: "src/unrelated.ts",
          selector: { kind: "content", contains: "export const reserve" },
          because:
            "this same-name constant is not the imported binding and can only mislead review",
        },
      ],
    },
  },
  {
    id: "binding-shadowed-validator-contract",
    category: "binding_only_positive",
    summary:
      "Exact binding identifies the validator contract violated by a caller.",
    families: ["binding"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the discarded normalized value is a distinct opportunity grounded in one exact binding",
    },
    ...caseRevision(
      "l5/binding-shadowed-validator-contract/h1",
      {
        "src/route.ts": lines(
          'import { validate } from "./validator.js";',
          "export function route(raw: string): string {",
          "  validate(raw);",
          "  return raw;",
          "}",
        ),
        "src/validator.ts": lines(
          "export function validate(raw: string): string {",
          '  if (raw === "") throw new Error("empty");',
          "  return raw.trim();",
          "}",
        ),
        "src/test-helper.ts":
          "export function validate(): boolean { return true; }",
      },
      {
        path: "src/route.ts",
        baseContent: lines(
          'import { validate } from "./validator.js";',
          "export function route(raw: string): string {",
          "  return validate(raw);",
          "}",
        ),
        headContent: lines(
          'import { validate } from "./validator.js";',
          "export function route(raw: string): string {",
          "  validate(raw);",
          "  return raw;",
          "}",
        ),
        changedLines: [3, 4],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "validated-value-discarded",
          ruleId: "signature-compatibility/v1",
          family: "binding",
          path: "src/route.ts",
          allowedAnchor: { startLine: 3, endLine: 4 },
          summary:
            "The caller discards the validator's normalized return value.",
          because:
            "the exact imported validator returns the trimmed value, while the changed caller returns the untrimmed input",
        },
      ],
      requiredContext: [
        {
          id: "bound-validator-declaration",
          family: "binding",
          reason: "declaration",
          path: "src/validator.ts",
          selector: { kind: "span", startLine: 1, endLine: 4 },
          because:
            "the return-value contract and normalization are visible only in the bound declaration",
          requiredExposure: {
            disappearsUnderAblation: "binding",
            because:
              "the exact declaration is binding-derived rather than selected by name",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "unbound-validator-helper",
          family: "binding",
          reason: "other",
          path: "src/test-helper.ts",
          selector: { kind: "content", contains: "function validate" },
          because:
            "the helper has the same name but is not referenced by the changed module",
        },
      ],
    },
  },
  {
    id: "test-relationship-stable-serialization",
    category: "test_relationship_positive",
    summary:
      "A binding-derived test states the required deterministic ordering.",
    families: ["test_relationship"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the ordering regression is one distinct opportunity whose contract is in an associated test",
    },
    ...caseRevision(
      "l5/test-relationship-stable-serialization/h1",
      {
        "src/serialize.ts": lines(
          "export function serialize(value: object): string {",
          "  return JSON.stringify(value);",
          "}",
        ),
        "test/serialize.spec.ts": lines(
          'import { serialize } from "../src/serialize.js";',
          'it("sorts object keys", () => {',
          '  expect(serialize({ b: 1, a: 2 })).toBe(\'{"a":2,"b":1}\');',
          "});",
        ),
        "test/parser.spec.ts": 'it("parses", () => expect(true).toBe(true));',
      },
      {
        path: "src/serialize.ts",
        baseContent: lines(
          "export function serialize(value: object): string {",
          "  return stableStringify(value);",
          "}",
        ),
        headContent: lines(
          "export function serialize(value: object): string {",
          "  return JSON.stringify(value);",
          "}",
        ),
        changedLines: [2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "serialization-order-regression",
          ruleId: "behavior-contract/v1",
          family: "test_relationship",
          path: "src/serialize.ts",
          allowedAnchor: { startLine: 2, endLine: 2 },
          summary: "Serialization no longer guarantees sorted object keys.",
          because:
            "JSON.stringify preserves insertion order for these keys, while the bound test explicitly requires alphabetical output",
        },
      ],
      requiredContext: [
        {
          id: "serialize-behavior-test",
          family: "test_relationship",
          reason: "test",
          path: "test/serialize.spec.ts",
          selector: { kind: "span", startLine: 1, endLine: 4 },
          because:
            "the sorted-key requirement is authored only in the test that imports serialize",
          requiredExposure: {
            disappearsUnderAblation: "test_relationship",
            because:
              "the non-co-located test is offered only by its binding-derived test relationship",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "unrelated-parser-test",
          family: "test_relationship",
          reason: "test",
          path: "test/parser.spec.ts",
          selector: { kind: "artifact" },
          because:
            "this test has no binding to serialize and contributes no relevant contract",
        },
      ],
    },
  },
  {
    id: "test-relationship-expiry-boundary",
    category: "test_relationship_positive",
    summary: "A non-co-located test fixes the inclusive expiry boundary.",
    families: ["test_relationship"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the boundary regression is a distinct opportunity with an authored associated-test witness",
    },
    ...caseRevision(
      "l5/test-relationship-expiry-boundary/h1",
      {
        "src/token.ts": lines(
          "export function isExpired(expiresAt: number, now: number): boolean {",
          "  return expiresAt < now;",
          "}",
        ),
        "spec/security/token-boundary.ts": lines(
          'import { isExpired } from "../../src/token.js";',
          'it("expires at the boundary", () => expect(isExpired(10, 10)).toBe(true));',
        ),
        "spec/security/password.ts":
          'it("accepts strong passwords", () => expect(true).toBe(true));',
      },
      {
        path: "src/token.ts",
        baseContent: lines(
          "export function isExpired(expiresAt: number, now: number): boolean {",
          "  return expiresAt <= now;",
          "}",
        ),
        headContent: lines(
          "export function isExpired(expiresAt: number, now: number): boolean {",
          "  return expiresAt < now;",
          "}",
        ),
        changedLines: [2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "expiry-allows-boundary-token",
          ruleId: "behavior-contract/v1",
          family: "test_relationship",
          path: "src/token.ts",
          allowedAnchor: { startLine: 2, endLine: 2 },
          summary: "A token remains accepted at its exact expiry instant.",
          because:
            "the bound boundary test establishes that expiresAt equal to now is already expired",
        },
      ],
      requiredContext: [
        {
          id: "token-boundary-test",
          family: "test_relationship",
          reason: "test",
          path: "spec/security/token-boundary.ts",
          selector: { kind: "content", contains: "isExpired(10, 10)" },
          because:
            "its import binding associates a test outside filename conventions with the changed symbol",
          requiredExposure: {
            disappearsUnderAblation: "test_relationship",
            because:
              "the test is selected through the test relationship rather than path proximity",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "nearby-password-test",
          family: "test_relationship",
          reason: "test",
          path: "spec/security/password.ts",
          selector: { kind: "artifact" },
          because:
            "directory proximity does not make this password test relevant to token expiry",
        },
      ],
    },
  },
  {
    id: "config-exact-optional-assignment",
    category: "config_governance_positive",
    summary:
      "The governing project forbids assigning undefined to an optional field.",
    families: ["config_governance"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the option-dependent assignment is a distinct gold opportunity under one governing project",
    },
    ...caseRevision(
      "l5/config-exact-optional-assignment/h1",
      {
        "packages/api/tsconfig.json": lines(
          "{",
          '  "compilerOptions": { "strict": true, "exactOptionalPropertyTypes": true },',
          '  "include": ["src/**/*.ts"]',
          "}",
        ),
        "packages/api/src/options.ts": lines(
          "interface Options { label?: string }",
          "export function clear(options: Options): void {",
          "  options.label = undefined;",
          "}",
        ),
        "tsconfig.json": '{ "compilerOptions": { "strict": false } }',
      },
      {
        path: "packages/api/src/options.ts",
        baseContent: lines(
          "interface Options { label?: string }",
          "export function clear(options: Options): void {",
          "  delete options.label;",
          "}",
        ),
        headContent: lines(
          "interface Options { label?: string }",
          "export function clear(options: Options): void {",
          "  options.label = undefined;",
          "}",
        ),
        changedLines: [3],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "exact-optional-undefined-assignment",
          ruleId: "config-semantics/v1",
          family: "config_governance",
          path: "packages/api/src/options.ts",
          allowedAnchor: { startLine: 3, endLine: 3 },
          summary: "The assignment violates exact optional property semantics.",
          because:
            "the governing package config enables exactOptionalPropertyTypes, under which absence must be represented by deletion rather than explicit undefined",
        },
      ],
      requiredContext: [
        {
          id: "api-governing-config",
          family: "config_governance",
          reason: "config",
          path: "packages/api/tsconfig.json",
          selector: {
            kind: "content",
            contains: '"exactOptionalPropertyTypes": true',
          },
          because:
            "this project admits the changed file and enables the option that makes the assignment invalid",
          requiredExposure: {
            disappearsUnderAblation: "config_governance",
            because:
              "governing-project resolution is the only family that offers this config option",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "non-governing-root-config",
          family: "config_governance",
          reason: "config",
          path: "tsconfig.json",
          selector: { kind: "content", contains: '"strict": false' },
          because:
            "the root config does not admit this package source and its strict=false setting is not governing evidence",
        },
      ],
    },
  },
  {
    id: "config-unchecked-index-access",
    category: "config_governance_positive",
    summary: "The governing project makes indexed reads possibly undefined.",
    families: ["config_governance"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the unchecked indexed read is a distinct option-dependent gold opportunity",
    },
    ...caseRevision(
      "l5/config-unchecked-index-access/h1",
      {
        "services/report/tsconfig.json": lines(
          "{",
          '  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true },',
          '  "files": ["src/first.ts"]',
          "}",
        ),
        "services/report/src/first.ts": lines(
          "export function firstUpper(values: string[]): string {",
          "  return values[0].toUpperCase();",
          "}",
        ),
        "services/legacy/tsconfig.json":
          '{ "compilerOptions": { "noUncheckedIndexedAccess": false } }',
      },
      {
        path: "services/report/src/first.ts",
        baseContent: lines(
          "export function firstUpper(values: string[]): string | undefined {",
          "  return values[0]?.toUpperCase();",
          "}",
        ),
        headContent: lines(
          "export function firstUpper(values: string[]): string {",
          "  return values[0].toUpperCase();",
          "}",
        ),
        changedLines: [1, 2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "unchecked-first-element",
          ruleId: "config-semantics/v1",
          family: "config_governance",
          path: "services/report/src/first.ts",
          allowedAnchor: { startLine: 2, endLine: 2 },
          summary: "An empty array causes an unchecked undefined dereference.",
          because:
            "the file's project enables noUncheckedIndexedAccess, so values[0] is string | undefined and requires a guard",
        },
      ],
      requiredContext: [
        {
          id: "report-governing-config",
          family: "config_governance",
          reason: "config",
          path: "services/report/tsconfig.json",
          selector: {
            kind: "content",
            contains: '"noUncheckedIndexedAccess": true',
          },
          because:
            "the files list proves governance and the compiler option supplies the relevant semantics",
          requiredExposure: {
            disappearsUnderAblation: "config_governance",
            because:
              "only config governance identifies this file's project and effective option",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "legacy-sibling-config",
          family: "config_governance",
          reason: "config",
          path: "services/legacy/tsconfig.json",
          selector: {
            kind: "content",
            contains: '"noUncheckedIndexedAccess": false',
          },
          because:
            "a sibling project's relaxed setting does not govern the report source",
        },
      ],
    },
  },
  {
    id: "instruction-auth-denial-audit",
    category: "instruction_governance_positive",
    summary: "A trusted repository instruction requires denial auditing.",
    families: ["instruction_governance"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the missing denial audit is one distinct policy opportunity with trusted applicable exposure",
    },
    ...caseRevision(
      "l5/instruction-auth-denial-audit/h1",
      instructionAuditFiles,
      {
        path: "src/auth/login.ts",
        baseContent: lines(
          "export async function login(accountId: string): Promise<boolean> {",
          "  try {",
          "    await Promise.reject(new Error(accountId));",
          "    return true;",
          "  } catch {",
          "    console.info(accountId);",
          "    return false;",
          "  }",
          "}",
        ),
        headContent: instructionAuditFiles["src/auth/login.ts"],
        changedLines: [6],
      },
      {
        status: "incomplete",
        outages: [
          {
            path: "vendor/AGENTS.md",
            operation: "read",
            because:
              "the fixture simulates an unavailable unrelated vendor instruction while retaining the known root instruction",
          },
        ],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "auth-denial-not-audited",
          ruleId: "instruction-policy/v1",
          family: "instruction_governance",
          path: "src/auth/login.ts",
          allowedAnchor: { startLine: 5, endLine: 6 },
          summary: "The denial path no longer records the account id.",
          because:
            "the trusted root instruction explicitly requires every authentication denial to be recorded with the account id",
        },
      ],
      requiredContext: [
        {
          id: "root-auth-audit-instruction",
          family: "instruction_governance",
          reason: "instruction",
          path: "AGENTS.md",
          selector: {
            kind: "content",
            contains: "denials must always be recorded",
          },
          because:
            "this available trusted instruction applies repository-wide and directly defines the missing behavior",
          requiredExposure: {
            disappearsUnderAblation: "instruction_governance",
            because:
              "applicability and trust are offered only by instruction governance",
          },
        },
        {
          id: "instruction-coverage-gap",
          family: "instruction_governance",
          reason: "coverage",
          path: "vendor/AGENTS.md",
          selector: { kind: "artifact" },
          because:
            "the read outage must remain visible so the retained positive is not mistaken for complete instruction coverage",
          requiredExposure: {
            disappearsUnderAblation: "instruction_governance",
            because:
              "instruction coverage provenance is removed with the instruction-governance family",
          },
        },
      ],
      forbiddenContext: [],
    },
    outageWitness: {
      knownPositiveFindingId: "auth-denial-not-audited",
      because:
        "the available root policy conclusively establishes this finding even though an unrelated vendor instruction is unreadable",
    },
  },
  {
    id: "instruction-payment-token-logging",
    category: "instruction_governance_positive",
    summary: "A path-scoped instruction prohibits logging payment tokens.",
    families: ["instruction_governance"],
    eligibility: {
      witness: "positive_gold_and_ablatable_exposure",
      because:
        "the token log is a distinct policy opportunity with a path-scoped trusted rule",
    },
    ...caseRevision(
      "l5/instruction-payment-token-logging/h1",
      {
        "AGENTS.md":
          "Follow the nearest trusted AGENTS.md for path-specific security rules.",
        "src/payments/AGENTS.md":
          "Never write a payment token to logs, including debug logs.",
        "src/payments/charge.ts": lines(
          "export function charge(token: string): boolean {",
          "  console.debug(token);",
          "  return token.length > 0;",
          "}",
        ),
        "docs/payments.md": "Tokens are opaque strings.",
      },
      {
        path: "src/payments/charge.ts",
        baseContent: lines(
          "export function charge(token: string): boolean {",
          "  return token.length > 0;",
          "}",
        ),
        headContent: lines(
          "export function charge(token: string): boolean {",
          "  console.debug(token);",
          "  return token.length > 0;",
          "}",
        ),
        changedLines: [2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "payment-token-debug-log",
          ruleId: "instruction-policy/v1",
          family: "instruction_governance",
          path: "src/payments/charge.ts",
          allowedAnchor: { startLine: 2, endLine: 2 },
          summary: "The changed debug statement exposes a payment token.",
          because:
            "the nearest trusted instruction explicitly prohibits payment tokens in every log level",
        },
      ],
      requiredContext: [
        {
          id: "payment-path-instruction",
          family: "instruction_governance",
          reason: "instruction",
          path: "src/payments/AGENTS.md",
          selector: {
            kind: "content",
            contains: "Never write a payment token to logs",
          },
          because:
            "its directory scope includes charge.ts and its prohibition exactly covers the changed log",
          requiredExposure: {
            disappearsUnderAblation: "instruction_governance",
            because:
              "only instruction governance applies the nearest trusted path rule",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "payment-prose-not-instruction",
          family: "instruction_governance",
          reason: "other",
          path: "docs/payments.md",
          selector: { kind: "artifact" },
          because:
            "ordinary product prose has neither instruction provenance nor a rule about logging",
        },
      ],
    },
  },
  {
    id: "interaction-binding-and-test-delivery",
    category: "multiple_family_interaction",
    summary:
      "Binding proves async behavior while its test proves completion timing matters.",
    families: ["binding", "test_relationship"],
    eligibility: {
      witness: "multiple_ablatable_exposures",
      because:
        "one timing opportunity requires independently ablatable binding and associated-test exposures",
    },
    ...caseRevision(
      "l5/interaction-binding-and-test-delivery/h1",
      {
        "src/notify.ts": lines(
          'import { deliver } from "./transport.js";',
          "export function notify(message: string): void {",
          "  deliver(message);",
          "}",
        ),
        "src/transport.ts": lines(
          "export async function deliver(message: string): Promise<void> {",
          "  await Promise.resolve(message);",
          "}",
        ),
        "test/notify.integration.ts": lines(
          'import { notify } from "../src/notify.js";',
          'it("finishes delivery before resolving", async () => { await notify("hi"); });',
        ),
        "test/format.ts": 'it("formats", () => expect(true).toBe(true));',
      },
      {
        path: "src/notify.ts",
        baseContent: lines(
          'import { deliver } from "./transport.js";',
          "export async function notify(message: string): Promise<void> {",
          "  await deliver(message);",
          "}",
        ),
        headContent: lines(
          'import { deliver } from "./transport.js";',
          "export function notify(message: string): void {",
          "  deliver(message);",
          "}",
        ),
        changedLines: [2, 3],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "notify-returns-before-delivery",
          ruleId: "async-completion/v1",
          family: "binding",
          path: "src/notify.ts",
          allowedAnchor: { startLine: 2, endLine: 3 },
          summary: "Notify returns before delivery completes.",
          because:
            "the exact callee returns a Promise and the associated integration test establishes completion-before-return as required behavior",
        },
      ],
      requiredContext: [
        {
          id: "deliver-async-declaration",
          family: "binding",
          reason: "declaration",
          path: "src/transport.ts",
          selector: { kind: "span", startLine: 1, endLine: 3 },
          because:
            "the declaration proves that the changed call starts asynchronous work",
          requiredExposure: {
            disappearsUnderAblation: "binding",
            because:
              "the exact deliver declaration is exposed only through binding",
          },
        },
        {
          id: "notify-completion-test",
          family: "test_relationship",
          reason: "test",
          path: "test/notify.integration.ts",
          selector: { kind: "span", startLine: 1, endLine: 2 },
          because:
            "the bound test proves callers rely on delivery completing before notify resolves",
          requiredExposure: {
            disappearsUnderAblation: "test_relationship",
            because:
              "the integration test is exposed only through its derived test relationship",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "unrelated-format-test",
          family: "test_relationship",
          reason: "test",
          path: "test/format.ts",
          selector: { kind: "artifact" },
          because:
            "this test imports neither notify nor deliver and has no timing contract",
        },
      ],
    },
  },
  {
    id: "interaction-config-and-instruction-fail-closed",
    category: "multiple_family_interaction",
    summary:
      "Compiler governance and a security instruction jointly require a guard.",
    families: ["config_governance", "instruction_governance"],
    eligibility: {
      witness: "multiple_ablatable_exposures",
      because:
        "one fail-closed opportunity requires independently ablatable config and instruction facts",
    },
    ...caseRevision(
      "l5/interaction-config-and-instruction-fail-closed/h1",
      {
        "services/policy/tsconfig.json": lines(
          "{",
          '  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true },',
          '  "include": ["src/**/*.ts"]',
          "}",
        ),
        "services/policy/AGENTS.md":
          "Authorization lookups must fail closed when a role is absent.",
        "services/policy/src/access.ts": lines(
          "export function canAccess(roles: Record<string, boolean>, id: string): boolean {",
          "  return roles[id];",
          "}",
        ),
        "services/public/AGENTS.md": "Public routes may default to allow.",
      },
      {
        path: "services/policy/src/access.ts",
        baseContent: lines(
          "export function canAccess(roles: Record<string, boolean>, id: string): boolean {",
          "  return roles[id] ?? false;",
          "}",
        ),
        headContent: lines(
          "export function canAccess(roles: Record<string, boolean>, id: string): boolean {",
          "  return roles[id];",
          "}",
        ),
        changedLines: [2],
      },
    ),
    gold: {
      expectedFindings: [
        {
          goldId: "absent-role-not-fail-closed",
          ruleId: "governed-policy/v1",
          family: "instruction_governance",
          path: "services/policy/src/access.ts",
          allowedAnchor: { startLine: 2, endLine: 2 },
          summary: "An absent role no longer has an explicit deny fallback.",
          because:
            "the governing config proves the indexed lookup may be undefined and the applicable instruction requires that absence to become false",
        },
      ],
      requiredContext: [
        {
          id: "policy-governing-config",
          family: "config_governance",
          reason: "config",
          path: "services/policy/tsconfig.json",
          selector: {
            kind: "content",
            contains: '"noUncheckedIndexedAccess": true',
          },
          because:
            "noUncheckedIndexedAccess makes the absent-role state explicit in the type",
          requiredExposure: {
            disappearsUnderAblation: "config_governance",
            because:
              "the effective option is offered only by config governance",
          },
        },
        {
          id: "policy-fail-closed-instruction",
          family: "instruction_governance",
          reason: "instruction",
          path: "services/policy/AGENTS.md",
          selector: { kind: "content", contains: "fail closed" },
          because:
            "the nearest trusted instruction defines false as the required absent-role result",
          requiredExposure: {
            disappearsUnderAblation: "instruction_governance",
            because:
              "the applicable fail-closed policy is offered only by instruction governance",
          },
        },
      ],
      forbiddenContext: [
        {
          id: "public-route-instruction",
          family: "instruction_governance",
          reason: "instruction",
          path: "services/public/AGENTS.md",
          selector: { kind: "artifact" },
          because:
            "this sibling instruction does not apply to the policy service",
        },
      ],
    },
  },
  {
    id: "clean-shadowed-async-name",
    category: "clean_control",
    summary: "A synchronous parameter shadows an unrelated async import.",
    families: [],
    eligibility: {
      witness: "authored_no_finding",
      because:
        "exact lexical binding proves this tempting async-name lookalike is a clean control",
    },
    ...caseRevision(
      "l5/clean-shadowed-async-name/h1",
      {
        "src/run.ts": lines(
          'import { save } from "./store.js";',
          "export function run(save: (value: number) => void): void {",
          "  save(1);",
          "}",
        ),
        "src/store.ts": "export async function save(): Promise<void> {}",
      },
      {
        path: "src/run.ts",
        baseContent: lines(
          'import { save } from "./store.js";',
          "export function run(save: (value: number) => void): void {}",
        ),
        headContent: lines(
          'import { save } from "./store.js";',
          "export function run(save: (value: number) => void): void {",
          "  save(1);",
          "}",
        ),
        changedLines: [2, 3, 4],
      },
    ),
    gold: {
      expectedFindings: [],
      noFindingBecause:
        "the invoked save is a synchronous parameter, so no Promise is created or dropped",
      requiredContext: [],
      forbiddenContext: [
        {
          id: "shadowed-import-declaration",
          family: "binding",
          reason: "declaration",
          path: "src/store.ts",
          selector: { kind: "span", startLine: 1, endLine: 1 },
          because:
            "the imported declaration is shadowed and must not be presented as the call target",
        },
      ],
    },
  },
  {
    id: "clean-unrelated-nearby-test",
    category: "clean_control",
    summary:
      "A correct formatter has a nearby but unbound failing-looking test.",
    families: [],
    eligibility: {
      witness: "authored_no_finding",
      because:
        "the nearby test has no relationship to the changed symbol, leaving a distinct clean premise",
    },
    ...caseRevision(
      "l5/clean-unrelated-nearby-test/h1",
      {
        "src/format.ts":
          "export const format = (value: string): string => value.trim();",
        "src/format-number.test.ts": 'it("rounds", () => expect(1.4).toBe(1));',
      },
      {
        path: "src/format.ts",
        baseContent: "export const format = (value: string): string => value;",
        headContent:
          "export const format = (value: string): string => value.trim();",
        changedLines: [1],
      },
    ),
    gold: {
      expectedFindings: [],
      noFindingBecause:
        "trimming is the intended safe behavior and no associated test contradicts it",
      requiredContext: [],
      forbiddenContext: [
        {
          id: "filename-nearby-number-test",
          family: "test_relationship",
          reason: "test",
          path: "src/format-number.test.ts",
          selector: { kind: "artifact" },
          because:
            "the test does not import or reference the changed string formatter",
        },
      ],
    },
  },
  {
    id: "clean-non-governing-strict-config",
    category: "clean_control",
    summary:
      "A strict config exists but does not govern the changed JavaScript file.",
    families: [],
    eligibility: {
      witness: "authored_no_finding",
      because:
        "project membership proves the strict config is ineligible for this JavaScript change",
    },
    ...caseRevision(
      "l5/clean-non-governing-strict-config/h1",
      {
        "packages/typed/tsconfig.json":
          '{ "compilerOptions": { "strict": true }, "include": ["src/**/*.ts"] }',
        "scripts/report.js": "export const first = (values) => values[0];",
      },
      {
        path: "scripts/report.js",
        baseContent: "export const first = (values) => undefined;",
        headContent: "export const first = (values) => values[0];",
        changedLines: [1],
      },
    ),
    gold: {
      expectedFindings: [],
      noFindingBecause:
        "the JavaScript helper intentionally returns undefined for an empty array and is outside the typed project",
      requiredContext: [],
      forbiddenContext: [
        {
          id: "typed-package-config",
          family: "config_governance",
          reason: "config",
          path: "packages/typed/tsconfig.json",
          selector: { kind: "content", contains: '"include": ["src/**/*.ts"]' },
          because:
            "this config admits only TypeScript under packages/typed/src and cannot govern scripts/report.js",
        },
      ],
    },
  },
  {
    id: "clean-sibling-instruction-scope",
    category: "clean_control",
    summary:
      "A restrictive sibling instruction does not apply to the changed path.",
    families: [],
    eligibility: {
      witness: "authored_no_finding",
      because:
        "directory applicability proves the sibling instruction is ineligible for this health change",
    },
    ...caseRevision(
      "l5/clean-sibling-instruction-scope/h1",
      {
        "src/admin/AGENTS.md": "Every admin action must emit an audit event.",
        "src/public/health.ts":
          'export function health(): string { return "ok"; }',
      },
      {
        path: "src/public/health.ts",
        baseContent: 'export function health(): string { return "up"; }',
        headContent: 'export function health(): string { return "ok"; }',
        changedLines: [1],
      },
    ),
    gold: {
      expectedFindings: [],
      noFindingBecause:
        "the health response is correct and the only instruction is scoped to the sibling admin directory",
      requiredContext: [],
      forbiddenContext: [
        {
          id: "admin-only-instruction",
          family: "instruction_governance",
          reason: "instruction",
          path: "src/admin/AGENTS.md",
          selector: { kind: "artifact" },
          because:
            "directory scope prevents this admin rule from applying to src/public/health.ts",
        },
      ],
    },
  },
];

const caseById = (id: string): L5CorpusCase => {
  const found = rawCases.find((entry) => entry.id === id);
  if (found === undefined)
    throw new Error(`L5 corpus construction error: missing case ${id}`);
  return found;
};

const nextRevision = (
  baseCaseId: string,
  syntheticRevision: string,
  patch: Partial<Omit<L5RevisionFixture, "syntheticRevision">>,
): L5RevisionFixture => {
  const base = caseById(baseCaseId);
  return {
    syntheticRevision,
    files: patch.files ?? base.files,
    changeManifest: patch.changeManifest ?? base.changeManifest,
    contextSelection: patch.contextSelection ?? base.contextSelection,
    coverage: patch.coverage ?? base.coverage,
  };
};

const rawIncrementalPairs: readonly L5IncrementalPair[] = [
  {
    id: "incremental-binding-caller-edit",
    baseCaseId: "binding-floating-reservation",
    to: nextRevision(
      "binding-floating-reservation",
      "l5/binding-floating-reservation/h2",
      {
        files: {
          ...bindingPromiseFiles,
          "src/checkout.ts": lines(
            'import { reserve } from "./inventory.js";',
            "",
            "export function checkout(sku: string): boolean {",
            "  reserve(sku);",
            "  return true;",
            "}",
          ),
        },
        changeManifest: [
          {
            path: "src/checkout.ts",
            baseContent: lines(
              'import { reserve } from "./inventory.js";',
              "",
              "export async function checkout(sku: string): Promise<boolean> {",
              "  await reserve(sku);",
              "  return true;",
              "}",
            ),
            headContent: lines(
              'import { reserve } from "./inventory.js";',
              "",
              "export function checkout(sku: string): boolean {",
              "  reserve(sku);",
              "  return true;",
              "}",
            ),
            changedLines: [3, 4],
          },
        ],
      },
    ),
    because:
      "an inserted blank line moves the same defect while preserving the bound inventory dependency",
  },
  {
    id: "incremental-test-contract-edit",
    baseCaseId: "test-relationship-expiry-boundary",
    to: nextRevision(
      "test-relationship-expiry-boundary",
      "l5/test-relationship-expiry-boundary/h2",
      {
        files: {
          ...caseById("test-relationship-expiry-boundary").files,
          "src/token.ts": lines(
            "// Security boundary uses epoch milliseconds.",
            "export function isExpired(expiresAt: number, now: number): boolean {",
            "  return expiresAt < now;",
            "}",
          ),
        },
        changeManifest: [
          {
            path: "src/token.ts",
            baseContent: lines(
              "// Security boundary uses epoch milliseconds.",
              "export function isExpired(expiresAt: number, now: number): boolean {",
              "  return expiresAt <= now;",
              "}",
            ),
            headContent: lines(
              "// Security boundary uses epoch milliseconds.",
              "export function isExpired(expiresAt: number, now: number): boolean {",
              "  return expiresAt < now;",
              "}",
            ),
            changedLines: [3],
          },
        ],
      },
    ),
    because:
      "an unrelated source comment widens the incremental update without changing the test premise",
  },
  {
    id: "incremental-config-source-edit",
    baseCaseId: "config-unchecked-index-access",
    to: nextRevision(
      "config-unchecked-index-access",
      "l5/config-unchecked-index-access/h2",
      {
        files: {
          ...caseById("config-unchecked-index-access").files,
          "services/report/src/first.ts": lines(
            "export function firstUpper(values: readonly string[]): string {",
            "  return values[0].toUpperCase();",
            "}",
          ),
        },
        changeManifest: [
          {
            path: "services/report/src/first.ts",
            baseContent: lines(
              "export function firstUpper(values: readonly string[]): string | undefined {",
              "  return values[0]?.toUpperCase();",
              "}",
            ),
            headContent: lines(
              "export function firstUpper(values: readonly string[]): string {",
              "  return values[0].toUpperCase();",
              "}",
            ),
            changedLines: [1, 2],
          },
        ],
      },
    ),
    because:
      "a type-only source edit exercises retained config governance across H1 and H2",
  },
  {
    id: "incremental-instruction-source-edit",
    baseCaseId: "instruction-payment-token-logging",
    to: nextRevision(
      "instruction-payment-token-logging",
      "l5/instruction-payment-token-logging/h2",
      {
        files: {
          ...caseById("instruction-payment-token-logging").files,
          "src/payments/charge.ts": lines(
            "export function charge(token: string): boolean {",
            '  console.debug("charge token", token);',
            "  return token.length > 0;",
            "}",
          ),
        },
        changeManifest: [
          {
            path: "src/payments/charge.ts",
            baseContent: lines(
              "export function charge(token: string): boolean {",
              "  return token.length > 0;",
              "}",
            ),
            headContent: lines(
              "export function charge(token: string): boolean {",
              '  console.debug("charge token", token);',
              "  return token.length > 0;",
              "}",
            ),
            changedLines: [2],
          },
        ],
      },
    ),
    because:
      "a revised log message retains the same applicable path instruction across revisions",
  },
];

const configOptional = caseById("config-exact-optional-assignment");
const configIndex = caseById("config-unchecked-index-access");
const instructionAudit = caseById("instruction-auth-denial-audit");
const instructionPayment = caseById("instruction-payment-token-logging");

const rawCachePairs: readonly L5CacheIdentityPair[] = [
  {
    id: "cache-reuse-identical-binding-input",
    baseCaseId: "binding-floating-reservation",
    category: "unchanged_input",
    expectation: "reuse_expected",
    to: nextRevision(
      "binding-floating-reservation",
      "l5/cache/reuse-binding/h2",
      {},
    ),
    expectationBecause:
      "the authored source, change, context, and policy inputs are byte-identical; the expectation is independent of observed cache behavior",
  },
  {
    id: "cache-reuse-identical-test-input",
    baseCaseId: "test-relationship-stable-serialization",
    category: "unchanged_input",
    expectation: "reuse_expected",
    to: nextRevision(
      "test-relationship-stable-serialization",
      "l5/cache/reuse-test/h2",
      {},
    ),
    expectationBecause:
      "the authored source, relationships, selection, and policy inputs are unchanged, independently requiring reuse",
  },
  {
    id: "cache-invalidate-config-option",
    baseCaseId: configOptional.id,
    category: "config_only",
    expectation: "invalidation_expected",
    to: nextRevision(configOptional.id, "l5/cache/config-option/h2", {
      files: {
        ...configOptional.files,
        "packages/api/tsconfig.json": lines(
          "{",
          '  "compilerOptions": { "strict": true, "exactOptionalPropertyTypes": false },',
          '  "include": ["src/**/*.ts"]',
          "}",
        ),
      },
    }),
    expectationBecause:
      "the authored governing compiler option changes while reviewed source bytes stay fixed, independently requiring invalidation",
  },
  {
    id: "cache-invalidate-config-membership",
    baseCaseId: configIndex.id,
    category: "config_only",
    expectation: "invalidation_expected",
    to: nextRevision(configIndex.id, "l5/cache/config-membership/h2", {
      files: {
        ...configIndex.files,
        "services/report/tsconfig.json": lines(
          "{",
          '  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true },',
          '  "files": ["src/other.ts"]',
          "}",
        ),
      },
    }),
    expectationBecause:
      "the authored project membership changes while reviewed source remains byte-identical, independently requiring invalidation",
  },
  {
    id: "cache-invalidate-instruction-deletion",
    baseCaseId: instructionAudit.id,
    category: "instruction_only",
    expectation: "invalidation_expected",
    to: nextRevision(instructionAudit.id, "l5/cache/instruction-deletion/h2", {
      files: Object.fromEntries(
        Object.entries(instructionAudit.files).filter(
          ([path]) => path !== "AGENTS.md",
        ),
      ),
    }),
    expectationBecause:
      "the authored deletion removes an applicable root instruction while reviewed source stays fixed, independently requiring invalidation",
  },
  {
    id: "cache-invalidate-instruction-content",
    baseCaseId: instructionPayment.id,
    category: "instruction_only",
    expectation: "invalidation_expected",
    to: nextRevision(instructionPayment.id, "l5/cache/instruction-content/h2", {
      files: {
        ...instructionPayment.files,
        "src/payments/AGENTS.md":
          "Payment tokens may be logged only after irreversible redaction.",
      },
    }),
    expectationBecause:
      "the authored applicable instruction content changes while charge.ts remains fixed, independently requiring invalidation",
  },
  {
    id: "cache-invalidate-selection-budget",
    baseCaseId: "interaction-binding-and-test-delivery",
    category: "context_selection_only",
    expectation: "invalidation_expected",
    to: nextRevision(
      "interaction-binding-and-test-delivery",
      "l5/cache/selection-budget/h2",
      {
        contextSelection: {
          budgetTokens: 600,
          enabledFamilies: allFamilies,
        },
      },
    ),
    expectationBecause:
      "the authored token budget changes which context may be selected, independently requiring invalidation",
  },
  {
    id: "cache-invalidate-selection-family",
    baseCaseId: "interaction-config-and-instruction-fail-closed",
    category: "context_selection_only",
    expectation: "invalidation_expected",
    to: nextRevision(
      "interaction-config-and-instruction-fail-closed",
      "l5/cache/selection-family/h2",
      {
        contextSelection: {
          budgetTokens: completeSelection.budgetTokens,
          enabledFamilies: [
            "structural_index",
            "binding",
            "test_relationship",
            "config_governance",
          ],
        },
      },
    ),
    expectationBecause:
      "the authored family-selection policy removes instruction exposure without repository changes, independently requiring invalidation",
  },
];

const rawCorpus: L5Corpus = {
  experimentSchemaVersion: L5_EXPERIMENT_SCHEMA_VERSION,
  corpusVersion: L5_CORPUS_VERSION,
  cases: rawCases,
  incrementalPairs: rawIncrementalPairs,
  cacheIdentityPairs: rawCachePairs,
};

const isNonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const changedFilePaths = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): readonly string[] =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((path) => left[path] !== right[path])
    .sort();

const isConfigPath = (path: string): boolean =>
  /(^|\/)(?:tsconfig(?:\.[^/]*)?\.json|jsconfig(?:\.[^/]*)?\.json)$/.test(path);

const isInstructionPath = (path: string): boolean =>
  /(^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path);

const validateRevision = (
  revision: L5RevisionFixture,
  owner: string,
  issues: string[],
): void => {
  if (!isNonEmpty(revision.syntheticRevision))
    issues.push(`${owner}: missing synthetic revision`);
  if (Object.keys(revision.files).length === 0)
    issues.push(`${owner}: repository manifest is empty`);
  if (revision.changeManifest.length === 0)
    issues.push(`${owner}: change manifest is empty`);
  if (revision.contextSelection.budgetTokens <= 0)
    issues.push(`${owner}: token budget must be positive`);
  if (
    new Set(revision.contextSelection.enabledFamilies).size !==
    revision.contextSelection.enabledFamilies.length
  ) {
    issues.push(`${owner}: duplicate enabled context family`);
  }

  const changedPaths = new Set<string>();
  for (const changed of revision.changeManifest) {
    if (changedPaths.has(changed.path))
      issues.push(`${owner}: duplicate changed path ${changed.path}`);
    changedPaths.add(changed.path);
    if (!(changed.path in revision.files))
      issues.push(`${owner}: changed path missing from files: ${changed.path}`);
    if (revision.files[changed.path] !== changed.headContent) {
      issues.push(
        `${owner}: head content does not match files manifest: ${changed.path}`,
      );
    }
    if (changed.baseContent === changed.headContent)
      issues.push(`${owner}: vacuous unchanged content: ${changed.path}`);
    const headLines = Math.max(1, changed.headContent.split("\n").length);
    if (
      changed.changedLines.length === 0 ||
      changed.changedLines.some(
        (line) => !Number.isInteger(line) || line < 1 || line > headLines,
      )
    ) {
      issues.push(`${owner}: invalid changed lines for ${changed.path}`);
    }
    if (new Set(changed.changedLines).size !== changed.changedLines.length) {
      issues.push(`${owner}: duplicate changed line for ${changed.path}`);
    }
  }

  if (revision.coverage.status === "incomplete") {
    if (revision.coverage.outages.length === 0)
      issues.push(`${owner}: incomplete coverage is vacuous`);
    for (const outage of revision.coverage.outages) {
      if (!(outage.path in revision.files))
        issues.push(`${owner}: outage path missing from files: ${outage.path}`);
      if (!isNonEmpty(outage.because))
        issues.push(`${owner}: outage lacks because: ${outage.path}`);
    }
  }
};

/** Returns every frozen-corpus premise violation without running an experiment. */
export function validateL5Corpus(corpus: L5Corpus): readonly string[] {
  const issues: string[] = [];
  if (corpus.experimentSchemaVersion !== L5_EXPERIMENT_SCHEMA_VERSION) {
    issues.push("experiment schema version is not canonical");
  }
  if (corpus.corpusVersion !== L5_CORPUS_VERSION)
    issues.push("corpus version is not canonical");

  const globalIds = new Set<string>();
  const takeId = (id: string, owner: string): void => {
    if (!isNonEmpty(id)) issues.push(`${owner}: missing id`);
    else if (globalIds.has(id)) issues.push(`${owner}: duplicate id ${id}`);
    else globalIds.add(id);
  };

  const cases = new Map<string, L5CorpusCase>();
  const categoryCases = new Map<L5CaseCategory, Set<string>>();
  const goldByFamily = new Map<L5ContextFamily, Set<string>>();
  const goldOpportunities = new Set<string>();
  let hasOutagePositive = false;

  for (const corpusCase of corpus.cases) {
    takeId(corpusCase.id, `case ${corpusCase.id || "<missing>"}`);
    cases.set(corpusCase.id, corpusCase);
    const categorySet =
      categoryCases.get(corpusCase.category) ?? new Set<string>();
    categorySet.add(corpusCase.id);
    categoryCases.set(corpusCase.category, categorySet);
    validateRevision(corpusCase, `case ${corpusCase.id}`, issues);
    if (!isNonEmpty(corpusCase.summary))
      issues.push(`case ${corpusCase.id}: missing summary`);
    if (!isNonEmpty(corpusCase.eligibility.because)) {
      issues.push(`case ${corpusCase.id}: eligibility witness lacks because`);
    }
    if (new Set(corpusCase.families).size !== corpusCase.families.length) {
      issues.push(`case ${corpusCase.id}: duplicate family`);
    }

    const clean = corpusCase.category === "clean_control";
    if (clean && corpusCase.gold.expectedFindings.length > 0) {
      issues.push(
        `case ${corpusCase.id}: clean control has an expected finding`,
      );
    }
    if (clean && !isNonEmpty(corpusCase.gold.noFindingBecause)) {
      issues.push(
        `case ${corpusCase.id}: clean control lacks no-finding because`,
      );
    }
    if (!clean && corpusCase.gold.expectedFindings.length === 0) {
      issues.push(`case ${corpusCase.id}: positive category is vacuous`);
    }
    if (!clean && corpusCase.gold.requiredContext.length === 0) {
      issues.push(
        `case ${corpusCase.id}: positive category has no required context`,
      );
    }
    if (clean && corpusCase.families.length !== 0)
      issues.push(`case ${corpusCase.id}: clean family list is not empty`);
    if (clean && corpusCase.eligibility.witness !== "authored_no_finding") {
      issues.push(`case ${corpusCase.id}: clean eligibility witness is wrong`);
    }
    if (
      !clean &&
      corpusCase.category !== "multiple_family_interaction" &&
      corpusCase.eligibility.witness !== "positive_gold_and_ablatable_exposure"
    ) {
      issues.push(
        `case ${corpusCase.id}: positive eligibility witness is wrong`,
      );
    }
    if (
      corpusCase.category === "multiple_family_interaction" &&
      corpusCase.eligibility.witness !== "multiple_ablatable_exposures"
    ) {
      issues.push(
        `case ${corpusCase.id}: interaction eligibility witness is wrong`,
      );
    }
    if (
      corpusCase.category === "multiple_family_interaction" &&
      corpusCase.families.length < 2
    ) {
      issues.push(
        `case ${corpusCase.id}: interaction does not name multiple families`,
      );
    }
    if (
      corpusCase.category !== "multiple_family_interaction" &&
      !clean &&
      corpusCase.families.length !== 1
    ) {
      issues.push(
        `case ${corpusCase.id}: single-family category is vacuous or plural`,
      );
    }

    for (const finding of corpusCase.gold.expectedFindings) {
      takeId(finding.goldId, `finding in ${corpusCase.id}`);
      if (!(finding.path in corpusCase.files))
        issues.push(`finding ${finding.goldId}: missing path ${finding.path}`);
      if (
        !isNonEmpty(finding.ruleId) ||
        !isNonEmpty(finding.summary) ||
        !isNonEmpty(finding.because)
      ) {
        issues.push(`finding ${finding.goldId}: missing authored label fields`);
      }
      if (!corpusCase.families.includes(finding.family)) {
        issues.push(
          `finding ${finding.goldId}: family is not declared by case ${corpusCase.id}`,
        );
      }
      const lineCount = corpusCase.files[finding.path]?.split("\n").length ?? 0;
      if (
        !Number.isInteger(finding.allowedAnchor.startLine) ||
        !Number.isInteger(finding.allowedAnchor.endLine) ||
        finding.allowedAnchor.startLine < 1 ||
        finding.allowedAnchor.endLine < finding.allowedAnchor.startLine ||
        finding.allowedAnchor.endLine > lineCount
      ) {
        issues.push(
          `finding ${finding.goldId}: invalid allowed anchor interval`,
        );
      }
      const opportunity = [
        finding.ruleId,
        finding.family,
        finding.path,
        finding.allowedAnchor.startLine,
        finding.allowedAnchor.endLine,
      ].join("|");
      if (goldOpportunities.has(opportunity)) {
        issues.push(
          `finding ${finding.goldId}: duplicate semantic gold opportunity`,
        );
      }
      goldOpportunities.add(opportunity);
      const familyGold = goldByFamily.get(finding.family) ?? new Set<string>();
      familyGold.add(finding.goldId);
      goldByFamily.set(finding.family, familyGold);
    }

    const ablationExposure = new Set<L5ContextFamily>();
    for (const [labelKind, labels] of [
      ["required", corpusCase.gold.requiredContext],
      ["forbidden", corpusCase.gold.forbiddenContext],
    ] as const) {
      for (const label of labels) {
        takeId(label.id, `${labelKind} context in ${corpusCase.id}`);
        if (!(label.path in corpusCase.files))
          issues.push(
            `${labelKind} context ${label.id}: missing path ${label.path}`,
          );
        if (!isNonEmpty(label.because))
          issues.push(`${labelKind} context ${label.id}: missing because`);
        if (!corpusCase.families.includes(label.family) && !clean) {
          issues.push(
            `${labelKind} context ${label.id}: family is not declared by case ${corpusCase.id}`,
          );
        }
        const content = corpusCase.files[label.path];
        if (label.selector.kind === "span") {
          const lineCount = content?.split("\n").length ?? 0;
          if (
            !Number.isInteger(label.selector.startLine) ||
            !Number.isInteger(label.selector.endLine) ||
            label.selector.startLine < 1 ||
            label.selector.endLine < label.selector.startLine ||
            label.selector.endLine > lineCount
          ) {
            issues.push(
              `${labelKind} context ${label.id}: invalid span selector`,
            );
          }
        }
        if (
          label.selector.kind === "content" &&
          (!isNonEmpty(label.selector.contains) ||
            content?.includes(label.selector.contains) !== true)
        ) {
          issues.push(
            `${labelKind} context ${label.id}: content selector does not match artifact`,
          );
        }
        if (labelKind === "required") {
          if (
            label.requiredExposure === undefined ||
            label.requiredExposure.disappearsUnderAblation !== label.family ||
            !isNonEmpty(label.requiredExposure.because)
          ) {
            issues.push(
              `required context ${label.id}: missing family-only ablation witness`,
            );
          } else {
            ablationExposure.add(label.family);
          }
        } else if (label.requiredExposure !== undefined) {
          issues.push(
            `forbidden context ${label.id}: must not declare required exposure`,
          );
        }
      }
    }
    if (!clean) {
      for (const family of corpusCase.families) {
        if (!ablationExposure.has(family)) {
          issues.push(
            `case ${corpusCase.id}: missing required exposure for ${family} ablation`,
          );
        }
      }
    }

    if (corpusCase.outageWitness !== undefined) {
      const findingExists = corpusCase.gold.expectedFindings.some(
        (finding) =>
          finding.goldId === corpusCase.outageWitness?.knownPositiveFindingId,
      );
      if (corpusCase.coverage.status !== "incomplete" || !findingExists) {
        issues.push(
          `case ${corpusCase.id}: outage witness does not retain a known positive`,
        );
      } else {
        hasOutagePositive = true;
      }
      if (!isNonEmpty(corpusCase.outageWitness.because)) {
        issues.push(`case ${corpusCase.id}: outage witness lacks because`);
      }
    }
  }

  for (const category of L5_CASE_CATEGORIES) {
    const minimum = L5_MINIMUM_COMPOSITION[category];
    if ((categoryCases.get(category)?.size ?? 0) < minimum) {
      issues.push(
        `minimum-count failure: ${category} requires ${String(minimum)}`,
      );
    }
  }
  for (const family of L5_CONTEXT_FAMILIES) {
    if (
      (goldByFamily.get(family)?.size ?? 0) <
      L5_MINIMUM_COMPOSITION.goldFindingsPerFamily
    ) {
      issues.push(
        `minimum-count failure: ${family} requires ${String(L5_MINIMUM_COMPOSITION.goldFindingsPerFamily)} distinct gold findings`,
      );
    }
  }
  if (!hasOutagePositive)
    issues.push("missing incomplete-coverage known-positive witness");

  for (const pair of corpus.incrementalPairs) {
    takeId(pair.id, `incremental pair ${pair.id || "<missing>"}`);
    const base = cases.get(pair.baseCaseId);
    if (base === undefined)
      issues.push(
        `incremental pair ${pair.id}: missing base case ${pair.baseCaseId}`,
      );
    validateRevision(pair.to, `incremental pair ${pair.id}`, issues);
    if (!isNonEmpty(pair.because))
      issues.push(`incremental pair ${pair.id}: missing because`);
    if (
      base !== undefined &&
      changedFilePaths(base.files, pair.to.files).length === 0
    ) {
      issues.push(`incremental pair ${pair.id}: revisions are byte-identical`);
    }
  }
  if (
    corpus.incrementalPairs.length < L5_MINIMUM_COMPOSITION.incrementalPairs
  ) {
    issues.push(
      `minimum-count failure: incremental pairs require ${String(L5_MINIMUM_COMPOSITION.incrementalPairs)}`,
    );
  }

  const cacheCategoryCounts = new Map<L5CachePairCategory, number>();
  let cacheReuse = 0;
  let stableConfigSource = false;
  let stableInstructionSource = false;
  let instructionDeletion = false;

  for (const pair of corpus.cacheIdentityPairs) {
    takeId(pair.id, `cache pair ${pair.id || "<missing>"}`);
    const base = cases.get(pair.baseCaseId);
    cacheCategoryCounts.set(
      pair.category,
      (cacheCategoryCounts.get(pair.category) ?? 0) + 1,
    );
    if (pair.expectation === "reuse_expected") cacheReuse += 1;
    if (!isNonEmpty(pair.expectationBecause)) {
      issues.push(
        `cache pair ${pair.id}: missing authored expectation rationale`,
      );
    }
    validateRevision(pair.to, `cache pair ${pair.id}`, issues);
    if (base === undefined) {
      issues.push(
        `cache pair ${pair.id}: missing base case ${pair.baseCaseId}`,
      );
      continue;
    }

    const fileDiff = changedFilePaths(base.files, pair.to.files);
    const reviewedSourceStable = same(
      base.changeManifest,
      pair.to.changeManifest,
    );
    const selectionStable = same(
      base.contextSelection,
      pair.to.contextSelection,
    );
    const coverageStable = same(base.coverage, pair.to.coverage);
    if (pair.category === "unchanged_input") {
      if (
        pair.expectation !== "reuse_expected" ||
        fileDiff.length > 0 ||
        !reviewedSourceStable ||
        !selectionStable ||
        !coverageStable
      ) {
        issues.push(`cache pair ${pair.id}: unchanged-input premise is false`);
      }
    } else {
      if (pair.expectation !== "invalidation_expected") {
        issues.push(
          `cache pair ${pair.id}: invalidation category has reuse expectation`,
        );
      }
      if (!reviewedSourceStable)
        issues.push(`cache pair ${pair.id}: reviewed source bytes changed`);
    }
    if (pair.category === "config_only") {
      if (
        fileDiff.length === 0 ||
        fileDiff.some((path) => !isConfigPath(path)) ||
        !selectionStable ||
        !coverageStable
      ) {
        issues.push(`cache pair ${pair.id}: config-only premise is false`);
      } else {
        stableConfigSource = true;
      }
    }
    if (pair.category === "instruction_only") {
      if (
        fileDiff.length === 0 ||
        fileDiff.some((path) => !isInstructionPath(path)) ||
        !selectionStable ||
        !coverageStable
      ) {
        issues.push(`cache pair ${pair.id}: instruction-only premise is false`);
      } else {
        stableInstructionSource = true;
        instructionDeletion ||= fileDiff.some(
          (path) =>
            isInstructionPath(path) &&
            path in base.files &&
            !(path in pair.to.files),
        );
      }
    }
    if (pair.category === "context_selection_only") {
      if (
        fileDiff.length > 0 ||
        !reviewedSourceStable ||
        selectionStable ||
        !coverageStable
      ) {
        issues.push(
          `cache pair ${pair.id}: context-selection-only premise is false`,
        );
      }
    }
  }

  if (
    corpus.cacheIdentityPairs.length < L5_MINIMUM_COMPOSITION.cacheIdentityPairs
  ) {
    issues.push(
      `minimum-count failure: cache identity pairs require ${String(L5_MINIMUM_COMPOSITION.cacheIdentityPairs)}`,
    );
  }
  if (cacheReuse < L5_MINIMUM_COMPOSITION.cacheReuseExpected) {
    issues.push(
      `minimum-count failure: expected reuse pairs require ${String(L5_MINIMUM_COMPOSITION.cacheReuseExpected)}`,
    );
  }
  const cacheMinimums: readonly [L5CachePairCategory, number][] = [
    ["config_only", L5_MINIMUM_COMPOSITION.cacheConfigOnlyInvalidation],
    [
      "instruction_only",
      L5_MINIMUM_COMPOSITION.cacheInstructionOnlyInvalidation,
    ],
    [
      "context_selection_only",
      L5_MINIMUM_COMPOSITION.cacheContextSelectionInvalidation,
    ],
  ];
  for (const [category, minimum] of cacheMinimums) {
    if ((cacheCategoryCounts.get(category) ?? 0) < minimum) {
      issues.push(
        `minimum-count failure: ${category} cache pairs require ${String(minimum)}`,
      );
    }
  }
  if (!stableConfigSource)
    issues.push("missing stable-reviewed-source config identity witness");
  if (!stableInstructionSource)
    issues.push("missing stable-reviewed-source instruction identity witness");
  if (!instructionDeletion)
    issues.push("missing instruction deletion identity witness");

  return issues;
}

export function assertValidL5Corpus(corpus: L5Corpus): void {
  const issues = validateL5Corpus(corpus);
  if (issues.length > 0)
    throw new Error(`Invalid L.5 corpus:\n- ${issues.join("\n- ")}`);
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

assertValidL5Corpus(rawCorpus);

export const L5_CORPUS: L5Corpus = deepFreeze(rawCorpus);
