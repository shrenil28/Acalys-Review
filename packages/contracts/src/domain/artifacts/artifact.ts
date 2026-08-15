/**
 * Out-of-band content, classification, and redaction (P0.txt §45, §121, §122).
 *
 * Findings and evidence routinely rest on things far too large to carry in a
 * queue message: a raw diff, an analyzer log, a SARIF document, a test run's
 * output, a sandbox trace. An {@link ArtifactReference} is a *pointer*. The
 * bytes live in object storage; the contract carries identity, size, and
 * integrity so a consumer can decide whether to fetch them at all (§45).
 *
 * **Classification and redaction are different questions** (§121, §122), and
 * collapsing them is the mistake this module is shaped to prevent:
 *
 *     classification  →  how sensitive is this, inherently?
 *     redaction       →  what have we already done about it?
 *
 * A tenant's source code is `tenant_private` and needs no redaction. An
 * analyzer log that printed an API key is `sensitive` *and* redacted. A public
 * advisory is `public` and untouched. Neither field implies the other, so both
 * are required and modelled independently.
 */

import { z } from "zod";
import { artifactIdSchema, type ArtifactId } from "../identity/ids.js";
import { checksumSchema, type Checksum } from "../primitives/checksum.js";
import { MAX_ARTIFACT_BYTES, TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * What an artifact holds.
 *
 * Drives retention, display, and whether a consumer can parse it — a `sarif`
 * artifact has known structure, a `log` does not.
 */
export const ARTIFACT_KINDS = [
  "diff",
  "patch",
  "log",
  "sarif",
  "test_output",
  "coverage",
  "stack_trace",
  "agent_output",
  "verification_trace",
  "source_snapshot",
  "report",
  "screenshot",
  "other",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

/**
 * How sensitive the content is, independent of what has been done about it
 * (§121).
 *
 * P0's three-value vocabulary, not a general enterprise taxonomy. The
 * distinctions the platform actually acts on are: may this leave the tenant
 * (`public`), does it belong to exactly one tenant (`tenant_private`), and
 * does it need special handling even inside that tenant (`sensitive` — a
 * detected secret, a credential in a log).
 */
export const DATA_CLASSIFICATIONS = [
  "public",
  "tenant_private",
  "sensitive",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const dataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

/**
 * What redaction has been applied (§122).
 *
 * Not a boolean, because three states are genuinely distinguishable and the
 * difference matters operationally:
 *
 * - `not_required` — inspected, nothing sensitive found.
 * - `redacted` — sensitive content was found and removed or masked.
 * - `pending` — **not yet inspected.** This is the state a boolean cannot
 *   express, and the dangerous one: `redacted: false` reads as "safe" when it
 *   may only mean "unchecked". A consumer must be able to refuse to display
 *   content that has not been through redaction yet.
 */
export const REDACTION_STATES = [
  "not_required",
  "redacted",
  "pending",
] as const;

export type RedactionState = (typeof REDACTION_STATES)[number];

export const redactionStateSchema = z.enum(REDACTION_STATES);

/**
 * Redaction outcome, with the reason kept structurally consistent.
 *
 * `reason` is required exactly when something was redacted and forbidden
 * otherwise — enforced below, so `{ state: "not_required", reason: "secret" }`
 * cannot be represented (§C18: no contradictory states).
 */
export interface Redaction {
  readonly state: RedactionState;
  /**
   * Why content was removed, e.g. `acalys.redaction.detected-secret`.
   * Present if and only if `state` is `redacted`.
   */
  readonly reason?: NamespacedId | undefined;
}

export const redactionSchema = z
  .strictObject({
    state: redactionStateSchema,
    reason: namespacedIdSchema.optional(),
  })
  .superRefine((redaction, ctx) => {
    if (redaction.state === "redacted" && redaction.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Redacted content must record why it was redacted",
      });
    }
    if (redaction.state !== "redacted" && redaction.reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: `A redaction reason is only meaningful when state is 'redacted', not '${redaction.state}'`,
      });
    }
  });

/** Nothing sensitive was present. The common case. */
export const NO_REDACTION: Redaction = { state: "not_required" };

/**
 * A pointer to stored content.
 *
 * There is deliberately no `content` field, and no way to add one without
 * changing this contract: an artifact that could inline its bytes would
 * eventually inline a 200 MB analyzer log into a queue message (§45, §65).
 *
 * `checksum` makes the reference verifiable — a consumer can confirm it
 * fetched what the producer stored, which matters once artifacts are cached
 * and re-served (§46).
 */
export interface ArtifactReference {
  readonly id: ArtifactId;
  readonly kind: ArtifactKind;
  /** IANA media type, e.g. `text/plain`, `application/sarif+json`. */
  readonly contentType: string;
  readonly sizeBytes?: number | undefined;
  readonly checksum?: Checksum | undefined;
  /** Opaque storage locator. Only the artifact store interprets it. */
  readonly storageReference: string;
  readonly classification: DataClassification;
  readonly redaction: Redaction;
  /** Human-facing label, e.g. `semgrep.log`. Display only. */
  readonly name?: string | undefined;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export const artifactReferenceSchema = z.strictObject({
  id: artifactIdSchema,
  kind: artifactKindSchema,
  contentType: z.string().max(TEXT_LIMITS.identifier).regex(MEDIA_TYPE, {
    error: "Expected an IANA media type, e.g. text/plain",
  }),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES).optional(),
  checksum: checksumSchema.optional(),
  storageReference: z.string().min(1).max(TEXT_LIMITS.url),
  classification: dataClassificationSchema,
  redaction: redactionSchema,
  name: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/**
 * Whether this artifact is safe to render to a user right now.
 *
 * `pending` fails: content that has not been through redaction may still
 * contain a secret, and "not yet checked" must never read as "clean" (§122).
 */
export function isDisplayable(artifact: ArtifactReference): boolean {
  if (artifact.redaction.state === "pending") return false;
  return (
    artifact.classification !== "sensitive" ||
    artifact.redaction.state === "redacted"
  );
}
