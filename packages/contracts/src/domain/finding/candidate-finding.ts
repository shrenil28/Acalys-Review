/**
 * An unverified claim produced by a reviewer (P0.txt §23, §113).
 *
 * A `CandidateFinding` is a **proposal**, not a finding. It says:
 *
 *   > The analysis machinery suspects this is a problem.
 *
 * It is not user-facing, not published, and not yet true. Between it and a
 * {@link ReviewFinding} sits verification (§32), which is the only thing that
 * can promote one.
 *
 * # The invariant: no lifecycle
 *
 * This type carries **no lifecycle state whatsoever** — no `state`, `status`,
 * `resolved`, `dismissed`, or `active`. That is enforced structurally rather
 * than by convention (see {@link CandidateFindingHasNoLifecycle} below), and it
 * matters because the alternative silently destroys the separation:
 *
 *     candidate.state = "published"
 *
 * would mean an analyzer's output could publish itself, bypassing verification
 * entirely. Since the field does not exist, that line cannot be written.
 *
 * # Why not `ReviewFinding` with a flag
 *
 * The two types differ in what they *know*, not just in a status:
 *
 * | | CandidateFinding | ReviewFinding |
 * | --- | --- | --- |
 * | severity | *proposed* by the producer | settled |
 * | confidence | producer's own estimate | derived from verification |
 * | verification | absent — has not happened | required |
 * | fingerprint | optional; may be derivable | required — identity |
 * | lifecycle | **none** | required |
 * | producer | required — who proposed it | recorded in provenance |
 *
 * `proposedSeverity` is named for exactly this reason: a generator's opinion,
 * which reconciliation may override. A shared type with optional fields would
 * make every one of these ambiguous.
 *
 * # Swarm compatibility
 *
 * `producedBy` is required so that in `/deep-review`, three reviewers
 * examining one change produce three attributable candidates, and aggregation
 * can merge them into one finding whose evidence spans all three (§113).
 * Attribution has to survive until that merge.
 */

import { z } from "zod";
import {
  candidateFindingIdSchema,
  reviewRunIdSchema,
  type CandidateFindingId,
  type ReviewRunId,
} from "../identity/ids.js";
import {
  sourceLocationSchema,
  type SourceLocation,
} from "../location/source-location.js";
import {
  evidenceReferenceListSchema,
  type EvidenceReference,
} from "../evidence/evidence.js";
import {
  findingCategorySchema,
  findingConfidenceSchema,
  findingSeveritySchema,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
} from "./taxonomy.js";
import {
  findingFingerprintSchema,
  type FindingFingerprint,
} from "./fingerprint.js";
import {
  AGENT_TYPES,
  modelReferenceSchema,
  type ModelReference,
} from "../actor/actor.js";
import { toolReferenceSchema, type ToolReference } from "../tools/tool.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/** Schema version for this durable contract (§7). */
export const CANDIDATE_FINDING_SCHEMA_VERSION = 1;

/**
 * What generated a candidate.
 *
 * A union so a model's suggestion and a compiler's diagnostic are structurally
 * distinguishable: they warrant very different default trust, and reducing
 * both to a name string would lose that at the point it matters most.
 */
export type CandidateProducer =
  | {
      readonly kind: "agent";
      readonly agentType: (typeof AGENT_TYPES)[number];
      /** Distinguishes concurrent reviewers in a swarm (§113). */
      readonly agentRunId?: string | undefined;
      readonly model?: ModelReference | undefined;
    }
  | {
      readonly kind: "tool";
      readonly tool: ToolReference;
      readonly ruleId?: NamespacedId | undefined;
    };

export const candidateProducerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    agentType: z.enum(AGENT_TYPES),
    agentRunId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
    model: modelReferenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: toolReferenceSchema,
    ruleId: namespacedIdSchema.optional(),
  }),
]);

/**
 * A proposed finding, awaiting verification.
 *
 * `claim` is the falsifiable assertion — "this query interpolates user input
 * into SQL" — kept separate from `explanation`, the prose a human reads. The
 * split exists because a verifier evaluates the *claim*; mixing the two would
 * mean verifying a paragraph.
 */
export interface CandidateFinding {
  readonly schemaVersion: number;
  readonly id: CandidateFindingId;
  readonly reviewRunId: ReviewRunId;
  readonly title: string;
  /** The falsifiable assertion a verifier evaluates. */
  readonly claim: string;
  /** Prose for a human. Never parsed, never verified directly. */
  readonly explanation: string;
  readonly category: FindingCategory;
  /** The producer's opinion. Reconciliation may override it. */
  readonly proposedSeverity: FindingSeverity;
  /** The producer's own estimate, before verification. */
  readonly proposedConfidence?: FindingConfidence | undefined;
  readonly location: SourceLocation;
  readonly evidence: readonly EvidenceReference[];
  /** Present when the producer could compute one. Not identity yet (§28). */
  readonly fingerprint?: FindingFingerprint | undefined;
  readonly producedBy: CandidateProducer;
  readonly createdAt: Timestamp;
}

export const candidateFindingSchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(CANDIDATE_FINDING_SCHEMA_VERSION, {
      error: `Unsupported CandidateFinding schemaVersion; this build understands up to ${String(CANDIDATE_FINDING_SCHEMA_VERSION)}`,
    }),
  id: candidateFindingIdSchema,
  reviewRunId: reviewRunIdSchema,
  title: z.string().min(1).max(TEXT_LIMITS.title),
  claim: z.string().min(1).max(TEXT_LIMITS.summary),
  explanation: z.string().min(1).max(TEXT_LIMITS.explanation),
  category: findingCategorySchema,
  proposedSeverity: findingSeveritySchema,
  proposedConfidence: findingConfidenceSchema.optional(),
  location: sourceLocationSchema,
  evidence: evidenceReferenceListSchema,
  fingerprint: findingFingerprintSchema.optional(),
  producedBy: candidateProducerSchema,
  createdAt: timestampSchema,
});

/**
 * Compile-time proof that no lifecycle field ever appears on this type.
 *
 * Resolves to `true` only while every lifecycle-shaped key is absent from
 * `CandidateFinding`. Adding `state`, `status`, `lifecycle`, `resolved`,
 * `dismissed`, `published`, or `active` makes this `false`, and the assertion
 * below then fails `npm run typecheck` — so the architectural invariant is
 * enforced by the compiler rather than by review discipline (§C15).
 */
export type CandidateFindingHasNoLifecycle =
  Extract<
    keyof CandidateFinding,
    | "state"
    | "status"
    | "lifecycle"
    | "resolved"
    | "dismissed"
    | "published"
    | "active"
  > extends never
    ? true
    : false;

// The assertion itself. A lifecycle field on CandidateFinding breaks the build.
const _candidateFindingHasNoLifecycle: CandidateFindingHasNoLifecycle = true;
void _candidateFindingHasNoLifecycle;
