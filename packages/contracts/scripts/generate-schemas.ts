/**
 * Generates JSON Schema artifacts (P0.txt §54, §101).
 *
 * §54 makes the Zod schema the single source of truth and JSON Schema a
 * *derivative*. That direction matters: a hand-maintained JSON Schema beside a
 * Zod schema is two definitions of one contract, and the pair drifts silently
 * until something outside TypeScript — a Python worker, a partner integration,
 * an OpenAPI document — starts trusting the wrong one.
 *
 * §101 requires the output be reproducible, stably named, drift-checked, and
 * to carry version information. Each is a deliberate property here:
 *
 * - **Reproducible.** Output is serialized through `canonicalJson`, so key
 *   order cannot vary between machines or Node versions. Without it,
 *   `schemas:check` would fail on a reordering that changed nothing.
 * - **Stably named.** One file per contract, named for the contract. A single
 *   bundled file would make every diff touch every contract.
 * - **Drift-checked.** `--check` compares instead of writing, and CI runs it.
 * - **Versioned.** The manifest records each contract's `schemaVersion`, so a
 *   consumer reading a generated file knows which revision it describes.
 *
 * Run: `npm run schemas:generate` — or `npm run schemas:check` in CI.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { canonicalJson } from "../src/domain/primitives/canonical-json.js";
import * as domain from "../src/domain/index.js";
import * as api from "../src/api/v1/index.js";
import * as internal from "../src/internal/index.js";

const OUTPUT_DIR = fileURLToPath(
  new URL("../generated/schemas", import.meta.url),
);

/**
 * The contracts that get a generated schema.
 *
 * An explicit list, not "every exported schema". Two reasons: a derived list
 * would silently grow with every internal helper schema, filling the directory
 * with noise nobody consumes; and it would silently *shrink* if an export were
 * renamed, quietly dropping a contract from the generated set while CI stayed
 * green.
 *
 * `version` is the contract's own `schemaVersion` where it has one, and `null`
 * where it does not — nested value objects version with their parent (§7), and
 * claiming a version for them would imply they can evolve independently.
 */
interface SchemaEntry {
  readonly name: string;
  readonly layer: "domain" | "api" | "internal";
  readonly schema: z.ZodType;
  readonly version: number | null;
}

const ENTRIES: readonly SchemaEntry[] = [
  // Domain — value objects
  {
    name: "timestamp",
    layer: "domain",
    schema: domain.timestampSchema,
    version: null,
  },
  {
    name: "checksum",
    layer: "domain",
    schema: domain.checksumSchema,
    version: null,
  },
  {
    name: "repository-path",
    layer: "domain",
    schema: domain.repositoryPathSchema,
    version: null,
  },
  {
    name: "namespaced-id",
    layer: "domain",
    schema: domain.namespacedIdSchema,
    version: null,
  },
  {
    name: "line-range",
    layer: "domain",
    schema: domain.lineRangeSchema,
    version: null,
  },
  {
    name: "symbol-reference",
    layer: "domain",
    schema: domain.symbolReferenceSchema,
    version: null,
  },
  {
    name: "source-location",
    layer: "domain",
    schema: domain.sourceLocationSchema,
    version: null,
  },
  { name: "actor", layer: "domain", schema: domain.actorSchema, version: null },
  {
    name: "git-ref",
    layer: "domain",
    schema: domain.gitRefSchema,
    version: null,
  },
  {
    name: "git-comparison",
    layer: "domain",
    schema: domain.gitComparisonSchema,
    version: null,
  },

  // Domain — tenancy and repository
  {
    name: "organization",
    layer: "domain",
    schema: domain.organizationSchema,
    version: null,
  },
  { name: "user", layer: "domain", schema: domain.userSchema, version: null },
  {
    name: "membership",
    layer: "domain",
    schema: domain.membershipSchema,
    version: null,
  },
  {
    name: "repository",
    layer: "domain",
    schema: domain.repositorySchema,
    version: null,
  },
  {
    name: "provider-connection",
    layer: "domain",
    schema: domain.providerConnectionSchema,
    version: null,
  },

  // Domain — review lifecycle
  {
    name: "review-target",
    layer: "domain",
    schema: domain.reviewTargetSchema,
    version: domain.REVIEW_TARGET_SCHEMA_VERSION,
  },
  {
    name: "pull-request",
    layer: "domain",
    schema: domain.pullRequestSchema,
    version: null,
  },
  {
    name: "pull-request-revision",
    layer: "domain",
    schema: domain.pullRequestRevisionSchema,
    version: null,
  },
  {
    name: "review-request",
    layer: "domain",
    schema: domain.reviewRequestSchema,
    version: domain.REVIEW_REQUEST_SCHEMA_VERSION,
  },
  {
    name: "review-run",
    layer: "domain",
    schema: domain.reviewRunSchema,
    version: domain.REVIEW_RUN_SCHEMA_VERSION,
  },
  {
    name: "change-manifest",
    layer: "domain",
    schema: domain.changeManifestSchema,
    version: domain.CHANGE_MANIFEST_SCHEMA_VERSION,
  },

  // Domain — evidence and findings
  {
    name: "evidence",
    layer: "domain",
    schema: domain.evidenceSchema,
    version: domain.EVIDENCE_SCHEMA_VERSION,
  },
  {
    name: "candidate-finding",
    layer: "domain",
    schema: domain.candidateFindingSchema,
    version: domain.CANDIDATE_FINDING_SCHEMA_VERSION,
  },
  {
    name: "review-finding",
    layer: "domain",
    schema: domain.reviewFindingSchema,
    version: domain.REVIEW_FINDING_SCHEMA_VERSION,
  },
  {
    name: "finding-fingerprint",
    layer: "domain",
    schema: domain.findingFingerprintSchema,
    version: null,
  },
  {
    name: "verification-result",
    layer: "domain",
    schema: domain.verificationResultSchema,
    version: null,
  },

  // Domain — output
  {
    name: "review-summary",
    layer: "domain",
    schema: domain.reviewSummarySchema,
    version: domain.REVIEW_SUMMARY_SCHEMA_VERSION,
  },
  {
    name: "review-comment",
    layer: "domain",
    schema: domain.reviewCommentSchema,
    version: null,
  },
  {
    name: "review-conversation",
    layer: "domain",
    schema: domain.reviewConversationSchema,
    version: null,
  },
  {
    name: "suggested-fix",
    layer: "domain",
    schema: domain.suggestedFixSchema,
    version: null,
  },

  // Domain — knowledge, pre-merge, artifacts, configuration
  {
    name: "knowledge-reference",
    layer: "domain",
    schema: domain.knowledgeReferenceSchema,
    version: null,
  },
  {
    name: "pre-merge-check-result",
    layer: "domain",
    schema: domain.preMergeCheckResultSchema,
    version: null,
  },
  {
    name: "artifact-reference",
    layer: "domain",
    schema: domain.artifactReferenceSchema,
    version: null,
  },
  {
    name: "path-instruction",
    layer: "domain",
    schema: domain.pathInstructionSchema,
    version: null,
  },
  {
    name: "review-config",
    layer: "domain",
    schema: domain.reviewConfigSchema,
    version: domain.REVIEW_CONFIG_SCHEMA_VERSION,
  },
  {
    name: "review-config-snapshot",
    layer: "domain",
    schema: domain.reviewConfigSnapshotSchema,
    version: domain.REVIEW_CONFIG_SNAPSHOT_SCHEMA_VERSION,
  },

  // Internal — events and commands
  {
    name: "domain-event",
    layer: "internal",
    schema: internal.anyDomainEventSchema,
    version: internal.DOMAIN_EVENT_SCHEMA_VERSION,
  },
  {
    name: "command",
    layer: "internal",
    schema: internal.anyCommandSchema,
    version: internal.COMMAND_SCHEMA_VERSION,
  },

  // API — the public surface
  {
    name: "repository-dto",
    layer: "api",
    schema: api.repositoryDtoSchema,
    version: null,
  },
  {
    name: "pull-request-summary-dto",
    layer: "api",
    schema: api.pullRequestSummaryDtoSchema,
    version: null,
  },
  {
    name: "review-run-dto",
    layer: "api",
    schema: api.reviewRunDtoSchema,
    version: null,
  },
  {
    name: "review-summary-dto",
    layer: "api",
    schema: api.reviewSummaryDtoSchema,
    version: null,
  },
  {
    name: "finding-dto",
    layer: "api",
    schema: api.findingDtoSchema,
    version: null,
  },
  {
    name: "conversation-dto",
    layer: "api",
    schema: api.conversationDtoSchema,
    version: null,
  },
  {
    name: "pre-merge-check-dto",
    layer: "api",
    schema: api.preMergeCheckDtoSchema,
    version: null,
  },
  {
    name: "knowledge-item-dto",
    layer: "api",
    schema: api.knowledgeItemDtoSchema,
    version: null,
  },
  {
    name: "review-progress-event",
    layer: "api",
    schema: api.reviewProgressEventSchema,
    version: null,
  },
  {
    name: "api-error-dto",
    layer: "api",
    schema: api.apiErrorDtoSchema,
    version: null,
  },
];

/** Where a generated file lives. Layer subdirectories mirror the source. */
function outputPath(entry: SchemaEntry): string {
  return path.join(OUTPUT_DIR, entry.layer, `${entry.name}.schema.json`);
}

/**
 * Renders one schema.
 *
 * `io: "input"` rather than `"output"`, and the reason is worth recording
 * because the intuitive choice is wrong. Every branded id and timestamp ends
 * in a `.transform()`; branding is a TypeScript-only device with no JSON
 * counterpart, so on the *output* side Zod has nothing representable to emit
 * and renders `{}` — a schema that accepts `42` where a UUID belongs:
 *
 *     io: "output"   "userId": {}
 *     io: "input"    "userId": { "type": "string", "pattern": "^[0-9a-f]{8}-…" }
 *
 * An artifact whose whole purpose is letting a non-TypeScript consumer
 * validate a payload must not be the permissive one. And nothing is lost by
 * taking the input side: every transform in these contracts either brands or
 * normalizes a string, so input and output describe the same JSON. A
 * generated file with no constraint would be caught by the test that walks
 * these artifacts for unconstrained properties.
 *
 * `unrepresentable: "any"` keeps generation total. A few refinements have no
 * JSON Schema equivalent — a cross-field rule, a custom check — and the
 * alternative is throwing, which would mean one un-expressible constraint
 * blocks the entire artifact set. The generated schema is a *description* for
 * consumers, never the platform's own validator: Zod remains the authority,
 * and the header below says so in the artifact itself.
 */
function render(entry: SchemaEntry): string {
  const schema = z.toJSONSchema(entry.schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });

  return `${canonicalJson({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://contracts.acalys.dev/${entry.layer}/${entry.name}.schema.json`,
    title: entry.name,
    "x-acalys-layer": entry.layer,
    "x-acalys-schema-version": entry.version,
    "x-acalys-generated-by": "npm run schemas:generate",
    "x-acalys-source-of-truth":
      "packages/contracts/src — the Zod schema is authoritative",
    ...schema,
  })}\n`;
}

/** The index, so a consumer can enumerate the set without walking the tree. */
function renderManifest(): string {
  return `${canonicalJson({
    generatedBy: "npm run schemas:generate",
    sourceOfTruth: "packages/contracts/src",
    contracts: ENTRIES.map((entry) => ({
      name: entry.name,
      layer: entry.layer,
      schemaVersion: entry.version,
      file: `${entry.layer}/${entry.name}.schema.json`,
    })),
  })}\n`;
}

/** Every file the generator produces, as path → contents. */
function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of ENTRIES) {
    files.set(outputPath(entry), render(entry));
  }
  files.set(path.join(OUTPUT_DIR, "manifest.json"), renderManifest());
  return files;
}

async function write(): Promise<void> {
  // Removed and rebuilt rather than overwritten: an incremental write leaves
  // the artifact of a deleted contract behind, and a stale schema is worse
  // than a missing one because a consumer keeps trusting it.
  if (existsSync(OUTPUT_DIR)) {
    await rm(OUTPUT_DIR, { recursive: true });
  }

  for (const [file, contents] of renderAll()) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }

  process.stdout.write(
    `Generated ${String(ENTRIES.length)} schemas in generated/schemas\n`,
  );
}

/** Recursively lists every generated file, so extras are detected too. */
async function listExisting(dir: string): Promise<readonly string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listExisting(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * Compares without writing.
 *
 * Reports missing, changed, **and extra** files. The last matters: deleting a
 * contract without regenerating leaves an orphan artifact that describes
 * something the platform no longer produces, and a check that only compared
 * known files would never notice.
 */
async function check(): Promise<void> {
  const expected = renderAll();
  const actual = new Set(await listExisting(OUTPUT_DIR));
  const problems: string[] = [];

  for (const [file, contents] of expected) {
    const relative = path.relative(OUTPUT_DIR, file);
    if (!actual.has(file)) {
      problems.push(`missing: ${relative}`);
      continue;
    }
    const onDisk = await readFile(file, "utf8");
    if (onDisk !== contents) {
      problems.push(`changed: ${relative}`);
    }
  }

  for (const file of actual) {
    if (!expected.has(file)) {
      problems.push(`unexpected: ${path.relative(OUTPUT_DIR, file)}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `Generated schemas are out of date:\n${problems
        .map((problem) => `  ${problem}`)
        .join("\n")}\n\nRun: npm run schemas:generate\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Generated schemas match the source (${String(expected.size)} files)\n`,
  );
}

await (process.argv.includes("--check") ? check() : write());
