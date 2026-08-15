/**
 * Stable finding identity across revisions (P0.txt §28).
 *
 * The hardest contract in Phase 0, and the one incremental review rests on.
 * Without it every push re-reports every finding, the same comment is posted
 * five times, and nobody can tell a fixed issue from a moved one.
 *
 * # The core invariant
 *
 * **Line numbers are not identity.** Adding an import at the top of a file
 * shifts every line below it. If a fingerprint included line numbers, that
 * one-line change would report every existing finding in the file as fixed and
 * immediately re-raise all of them as new:
 *
 *     revision 1   src/auth.ts:82   SQL injection in Session.verify
 *     revision 2   src/auth.ts:97   SQL injection in Session.verify   ← same issue
 *
 * Both must produce the same fingerprint.
 *
 * # What is excluded, and why
 *
 * | Excluded | Reason |
 * | --- | --- |
 * | start/end line | shifts on any edit above (the whole point) |
 * | columns | shifts on reformatting |
 * | finding title / explanation | model wording varies run to run for one issue |
 * | `FindingId`, `ReviewRunId` | new every run by construction |
 * | timestamps | never stable |
 * | evidence, and its order | the same issue can be found by different tools |
 * | severity, confidence | re-grading an issue does not make it a different issue |
 *
 * # What is included
 *
 * Repository, category, detector, path, a semantic {@link FindingAnchor}, and
 * an `issueKey`. Every one is stable under formatting and movement.
 *
 * `issueKey` is a **machine vocabulary term**, never prose: `acalys.security
 * .sql-injection`, or a tool's own rule id. Normalizing a model's sentence
 * into a key was considered and rejected — any normalization aggressive enough
 * to absorb rewording ("SQL injection" / "Possible SQL injection in query
 * construction") also merges genuinely different issues, and any normalization
 * conservative enough to keep them apart breaks on rewording.
 *
 * # Case is preserved
 *
 * Paths and symbols are **not** lowercased. `getUser` and `GetUser` are
 * different symbols in every language the platform reviews, and folding case
 * would merge two real findings into one. Determinism (§58) is achieved by
 * canonical serialization, not by destroying information.
 */

import { z } from "zod";
import { repositoryIdSchema, type RepositoryId } from "../identity/ids.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import { checksumSchema, type Checksum } from "../primitives/checksum.js";
import { canonicalJson } from "../primitives/canonical-json.js";
import { assertNever } from "../primitives/assert-never.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import {
  symbolIdentity,
  symbolReferenceSchema,
  type SymbolReference,
} from "../location/symbol-reference.js";
import { findingCategorySchema, type FindingCategory } from "./taxonomy.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * Identifies the derivation rule, so it can change without silently
 * invalidating stored fingerprints.
 *
 * A stored fingerprint records which algorithm produced it. When the algorithm
 * changes, old and new values are recognizably different rather than
 * accidentally compared — matching only ever happens within one version, and a
 * migration can recompute deliberately.
 */
export const FINDING_FINGERPRINT_ALGORITHM = "acalys.fingerprint.symbol-anchor";
export const FINDING_FINGERPRINT_VERSION = 1;

/**
 * Where a finding is anchored, strongest first.
 *
 * A degradation ladder, because analyzers differ enormously in what they can
 * report and the contract must serve all of them:
 *
 * - `symbol` — survives movement *and* edits elsewhere in the file. Preferred.
 * - `content` — a digest of the normalized code the finding is about. Survives
 *   movement but not edits to that code, which is usually correct: if the code
 *   changed, the finding genuinely may not hold.
 * - `path` — file-level. Survives everything except a rename, and is right for
 *   findings that really are file-scoped (a missing license header).
 *
 * Modelled as a union rather than optional fields so an anchor cannot be half
 * present — `{ symbol: undefined, digest: undefined }` is unrepresentable.
 */
export type FindingAnchor =
  | { readonly kind: "symbol"; readonly symbol: SymbolReference }
  | { readonly kind: "content"; readonly digest: Checksum }
  | { readonly kind: "path" };

export const findingAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("symbol"), symbol: symbolReferenceSchema }),
  z.strictObject({ kind: z.literal("content"), digest: checksumSchema }),
  z.strictObject({ kind: z.literal("path") }),
]);

/**
 * Everything that participates in identity — and nothing else.
 *
 * Deliberately a separate type from the finding itself. A caller must
 * *assemble* these inputs, which makes adding an unstable field to the
 * fingerprint a visible act rather than something that happens by accident
 * when a field is added to `CandidateFinding`.
 */
export interface FindingFingerprintInput {
  readonly repositoryId: RepositoryId;
  readonly category: FindingCategory;
  /**
   * Stable machine identity of the issue — a tool's rule id or a platform
   * issue key. Never model prose.
   */
  readonly issueKey: NamespacedId;
  /** Who raised it: `tool.semgrep`, `acalys.agent.reviewer`. */
  readonly detector?: NamespacedId | undefined;
  readonly path: RepositoryPath;
  readonly anchor: FindingAnchor;
}

export const findingFingerprintInputSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  category: findingCategorySchema,
  issueKey: namespacedIdSchema,
  detector: namespacedIdSchema.optional(),
  path: repositoryPathSchema,
  anchor: findingAnchorSchema,
});

/**
 * The identity of a finding, independent of where it currently sits.
 *
 * `value` is opaque — consumers compare it, never parse it.
 */
export interface FindingFingerprint {
  readonly algorithm: string;
  readonly algorithmVersion: number;
  readonly value: string;
}

export const findingFingerprintSchema = z.strictObject({
  algorithm: z.string().min(1).max(128),
  algorithmVersion: z.number().int().positive(),
  value: z.string().regex(/^[0-9a-f]{64}$/, {
    error: "Fingerprint value must be a lowercase sha256 hex digest",
  }),
});

/**
 * Reduces an anchor to its stable textual form.
 *
 * `symbolIdentity` returns the most specific *name* available and never a line
 * range — which is exactly why a symbol anchor survives movement.
 */
function anchorKey(anchor: FindingAnchor): string {
  switch (anchor.kind) {
    case "symbol":
      return `symbol:${anchor.symbol.kind}:${symbolIdentity(anchor.symbol)}`;
    case "content":
      return `content:${anchor.digest.algorithm}:${anchor.digest.value}`;
    case "path":
      return "path";
    default:
      return assertNever(anchor, "anchorKey");
  }
}

/**
 * The exact string that gets hashed.
 *
 * Exposed because it is far more useful than the digest when debugging why two
 * findings did or did not match — a hex string tells you nothing, this tells
 * you which component differed. Tests assert on it directly, with no hasher.
 *
 * Built with {@link canonicalJson}, so key order cannot affect the result
 * (§58), and an absent `detector` is genuinely absent rather than the string
 * `"undefined"`.
 */
export function fingerprintCanonicalInput(
  input: FindingFingerprintInput,
): string {
  return canonicalJson({
    algorithm: FINDING_FINGERPRINT_ALGORITHM,
    version: FINDING_FINGERPRINT_VERSION,
    repositoryId: input.repositoryId,
    category: input.category,
    issueKey: input.issueKey,
    ...(input.detector === undefined ? {} : { detector: input.detector }),
    path: input.path,
    anchor: anchorKey(input.anchor),
  });
}

/**
 * Computes a fingerprint.
 *
 * The hasher is **injected** rather than imported (§95). The contracts package
 * stays environment-neutral — `apps/web` imports from it, and a `node:crypto`
 * import here would break that bundle — while server-side callers supply a
 * real SHA-256 implementation. It also keeps the algorithm swappable without
 * touching this contract.
 *
 * @throws {ValidationError} if the hasher is not SHA-256, since the value's
 *   shape is part of the contract and a mismatched digest length would fail
 *   validation later, further from the cause
 */
export function computeFindingFingerprint(
  input: FindingFingerprintInput,
  hasher: ContentHasher,
): FindingFingerprint {
  const digest = hasher.hash(fingerprintCanonicalInput(input));

  return findingFingerprintSchema.parse({
    algorithm: FINDING_FINGERPRINT_ALGORITHM,
    algorithmVersion: FINDING_FINGERPRINT_VERSION,
    value: digest.value,
  });
}

/**
 * Whether two fingerprints denote the same finding.
 *
 * Compares the algorithm and version too: values from different algorithms are
 * incomparable, and treating them as unequal is correct — but treating them as
 * *equal* because the hex happened to match would be catastrophic.
 */
export function fingerprintsMatch(
  left: FindingFingerprint,
  right: FindingFingerprint,
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.algorithmVersion === right.algorithmVersion &&
    left.value === right.value
  );
}

/**
 * Whether a fingerprint was produced by the algorithm this build computes.
 *
 * A stored fingerprint from an older algorithm is not wrong — it is simply not
 * comparable with newly computed ones, and a reconciler must recompute rather
 * than assume a mismatch means "new finding".
 */
export function isCurrentAlgorithm(fingerprint: FindingFingerprint): boolean {
  return (
    fingerprint.algorithm === FINDING_FINGERPRINT_ALGORITHM &&
    fingerprint.algorithmVersion === FINDING_FINGERPRINT_VERSION
  );
}
