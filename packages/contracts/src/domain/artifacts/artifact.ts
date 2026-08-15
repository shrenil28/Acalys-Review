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
 * Whether redaction has reached a safe terminal determination (§122).
 *
 * Read the vocabulary as a **readiness/safety status**, not as a log of
 * transformations performed:
 *
 * - `not_required` — assessed, and no redaction is needed for this content.
 * - `redacted` — assessed, sensitive content found, and removal completed.
 * - `pending` — **has not reached a safe terminal determination.**
 *
 * `pending` deliberately covers two operational situations that a boolean
 * cannot distinguish from safety, and that this layer deliberately does not
 * distinguish from each other:
 *
 *     not yet assessed
 *     assessed, but redaction work is still outstanding
 *
 * Both yield the identical conservative answer — not safe to disclose — so
 * splitting them here would add a state with no consumer and invite the two
 * meanings to drift apart. If an operational pipeline later needs to tell them
 * apart for scheduling, that belongs to the redaction service's own job state,
 * not to this contract.
 *
 * The invariant that gives `pending` real security meaning rather than making
 * it a workflow label:
 *
 *     redaction.state === "pending"  ⇒  canDisclose(...) === false
 *
 * for **every** classification and **every** destination. `redacted: false`
 * reads as "safe" when it may only mean "unchecked"; this state makes the
 * difference expressible and fail-closed.
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
 * Where content is about to go.
 *
 * Disclosure is a question about a *pair* — content and destination — so any
 * helper that answers it without a destination is answering a different,
 * weaker question and inviting the caller to mistake it for this one.
 *
 * - `public_surface` — anything world-readable: a public repository comment, a
 *   status badge, an unauthenticated page.
 * - `provider_comment` — a comment on the change under review. Visible to
 *   everyone with access to that repository, which is the tenant's own
 *   audience but not the tenant's staff list.
 * - `tenant_surface` — the dashboard and API, behind tenant authentication.
 */
export const DISCLOSURE_DESTINATIONS = [
  "public_surface",
  "provider_comment",
  "tenant_surface",
] as const;

export type DisclosureDestination = (typeof DISCLOSURE_DESTINATIONS)[number];

export const disclosureDestinationSchema = z.enum(DISCLOSURE_DESTINATIONS);

/** The most sensitive classification each destination may receive. */
const DESTINATION_ACCEPTS: Readonly<
  Record<DisclosureDestination, ReadonlySet<DataClassification>>
> = Object.freeze({
  public_surface: new Set<DataClassification>(["public"]),
  provider_comment: new Set<DataClassification>(["public", "tenant_private"]),
  tenant_surface: new Set<DataClassification>(["public", "tenant_private"]),
});

/**
 * Whether redaction has reached a safe terminal determination.
 *
 * The fail-closed gate, named for what it checks. Kept separate from
 * {@link canDisclose} so a caller can report *why* something is withheld —
 * "still being processed" and "too sensitive for this destination" need
 * different messages and different remedies.
 */
export function isRedactionPending(artifact: ArtifactReference): boolean {
  return artifact.redaction.state === "pending";
}

/**
 * The classification that applies *after* redaction has been carried out.
 *
 * Redaction removes the sensitive material, so redacted `sensitive` content is
 * no longer sensitive — but it is still the tenant's data, and drops to
 * `tenant_private` rather than to `public`. Anything else would let redaction
 * launder tenant data into a world-readable surface.
 */
export function effectiveClassification(
  artifact: ArtifactReference,
): DataClassification {
  if (
    artifact.classification === "sensitive" &&
    artifact.redaction.state === "redacted"
  ) {
    return "tenant_private";
  }
  return artifact.classification;
}

/**
 * Whether this artifact may be disclosed to a given destination.
 *
 * Two independent gates, in this order:
 *
 * 1. **Readiness.** `pending` is refused for every classification and every
 *    destination, without exception. Content that has not reached a safe
 *    terminal determination may still contain a secret, and "not yet checked"
 *    must never read as "clean" (§122).
 * 2. **Policy.** The *effective* classification must be one the destination
 *    accepts.
 *
 * Note what the second gate deliberately does **not** do: `not_required` grants
 * nothing on its own. `tenant_private` + `not_required` is perfectly safe on
 * the dashboard and forbidden on a public surface — the decision comes from
 * classification and destination together, never from the redaction state
 * alone. An earlier version of this function returned `true` for any
 * non-`sensitive` artifact, which silently made every tenant-private artifact
 * world-disclosable.
 */
export function canDisclose(
  artifact: ArtifactReference,
  destination: DisclosureDestination,
): boolean {
  if (isRedactionPending(artifact)) return false;
  return DESTINATION_ACCEPTS[destination].has(
    effectiveClassification(artifact),
  );
}
