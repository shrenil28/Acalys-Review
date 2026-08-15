/**
 * Evidence and its provenance (P0.txt §29, §30, §31).
 *
 * Evidence is first-class because it is what separates a review platform from
 * a model that guesses. A finding must be able to answer:
 *
 *     What supports this claim?          →  type, summary, location, artifact
 *     Where did that support come from?  →  provenance
 *     How probative is it?               →  strength
 *
 * §29 is explicit that evidence must never be modelled as prose. A string
 * cannot be counted, filtered, deduplicated, traced to the tool version that
 * produced it, or re-verified later — and every one of those is needed to
 * answer the question the whole system exists to answer: *why did Acalys make
 * this comment?*
 *
 * **Strength is not confidence** (§31 vs §26). Strength grades one piece of
 * evidence — a failing test that reproduces the bug is `deterministic`
 * regardless of anything else. Confidence grades the finding as a whole and is
 * derived from the evidence set. Ten `weak` items do not make a finding
 * certain, and one `deterministic` item can. Conflating them would let a
 * verifier launder a pile of model suspicion into high confidence, which is
 * exactly the failure mode §31 warns about.
 */

import { z } from "zod";
import {
  evidenceIdSchema,
  reviewRunIdSchema,
  type EvidenceId,
  type ReviewRunId,
} from "../identity/ids.js";
import {
  sourceLocationSchema,
  type SourceLocation,
} from "../location/source-location.js";
import {
  artifactReferenceSchema,
  type ArtifactReference,
} from "../artifacts/artifact.js";
import { toolReferenceSchema, type ToolReference } from "../tools/tool.js";
import {
  ciCheckReferenceSchema,
  type CiCheckReference,
} from "../ci/ci-check.js";
import {
  AGENT_TYPES,
  modelReferenceSchema,
  type AgentType,
  type ModelReference,
} from "../actor/actor.js";
import { gitObjectIdSchema, type GitObjectId } from "../git/git-refs.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/** Schema version for this durable contract (§7). */
export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * What kind of support this is (§29).
 *
 * Orthogonal to {@link EvidenceProvenance}: type says *what the evidence is*,
 * provenance says *who produced it*. A `test` result can come from a tool run
 * or from CI, and both are useful to distinguish.
 */
export const EVIDENCE_TYPES = [
  "source",
  "static_analysis",
  "compiler",
  "test",
  "runtime",
  "ci",
  "git_history",
  "requirement",
  "knowledge",
  "agent_observation",
  "dependency",
  "external",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);

/**
 * How probative one item is (§31).
 *
 * An ordered vocabulary, and the ordering is the point:
 *
 * | Strength        | Example |
 * | --------------- | ------- |
 * | `weak`          | a model suspects a problem |
 * | `supporting`    | a static trace reaches the site |
 * | `strong`        | a test reproduces the failure |
 * | `deterministic` | the compiler proves the violation |
 *
 * Severity is **never** inferred from strength (§31). A `deterministic` proof
 * of a cosmetic issue is still cosmetic; a `weak` hint about credential
 * exposure is still critical if true.
 */
export const EVIDENCE_STRENGTHS = [
  "weak",
  "supporting",
  "strong",
  "deterministic",
] as const;

export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const evidenceStrengthSchema = z.enum(EVIDENCE_STRENGTHS);

/** Rank for comparison. Never exposed as a score — ordering only. */
const STRENGTH_RANK: Readonly<Record<EvidenceStrength, number>> = Object.freeze(
  {
    weak: 0,
    supporting: 1,
    strong: 2,
    deterministic: 3,
  },
);

export function compareEvidenceStrength(
  left: EvidenceStrength,
  right: EvidenceStrength,
): number {
  return STRENGTH_RANK[left] - STRENGTH_RANK[right];
}

/** The strongest item in a set, or `undefined` when the set is empty. */
export function strongestEvidence(
  strengths: readonly EvidenceStrength[],
): EvidenceStrength | undefined {
  let best: EvidenceStrength | undefined;
  for (const strength of strengths) {
    if (best === undefined || compareEvidenceStrength(strength, best) > 0) {
      best = strength;
    }
  }
  return best;
}

// -------------------------------------------------------------------------
// Provenance (§30) — a discriminated union, one branch per origin family
// -------------------------------------------------------------------------

/**
 * An analyzer produced this.
 *
 * `ruleId` is what makes a tool finding traceable to the specific check that
 * fired, and it is a stable fingerprint input (§28) in a way the tool's prose
 * message never is.
 */
export interface ToolEvidenceProvenance {
  readonly kind: "tool";
  readonly tool: ToolReference;
  /** The specific rule or check that fired, e.g. `python.lang.security.audit`. */
  readonly ruleId?: NamespacedId | undefined;
  /** The invocation that produced it, when the runner recorded one. */
  readonly runId?: string | undefined;
}

/**
 * A model-backed agent produced this.
 *
 * Carries {@link ModelReference} for provenance only — which model said this,
 * so a regression can be traced to a model change (§62). No vendor SDK type
 * appears anywhere in this union (§61).
 */
export interface AgentEvidenceProvenance {
  readonly kind: "agent";
  readonly agentType: AgentType;
  /** Distinguishes concurrent agents in a swarm (§113). */
  readonly agentRunId?: string | undefined;
  readonly model?: ModelReference | undefined;
}

/** A CI check the repository already ran. */
export interface CiEvidenceProvenance {
  readonly kind: "ci";
  readonly check: CiCheckReference;
}

/**
 * The repository itself — its contents, history, or configuration.
 *
 * Requires neither tool nor agent (§30): "this line is in the diff" and "this
 * function was last touched in commit abc123" are facts read directly from the
 * repository, and forcing a fabricated tool identity onto them would make
 * provenance meaningless.
 */
export interface RepositoryEvidenceProvenance {
  readonly kind: "repository";
  /** The commit the observation was read from. */
  readonly commit?: GitObjectId | undefined;
}

/**
 * Something outside the repository and the execution environment: an advisory,
 * a standards document, a linked issue, an API result.
 *
 * `uri` is a **reference, never trusted content** (§63). Nothing in the
 * platform fetches and believes it on the strength of appearing here; it is
 * recorded so a human can follow the citation. The scheme allowlist keeps a
 * `javascript:` or `file:` URI out of a field that will eventually be rendered
 * as a link.
 */
export interface ExternalEvidenceProvenance {
  readonly kind: "external";
  /** e.g. `external.nvd`, `external.owasp`, `external.jira`. */
  readonly sourceId: NamespacedId;
  readonly uri?: string | undefined;
}

export type EvidenceProvenance =
  | ToolEvidenceProvenance
  | AgentEvidenceProvenance
  | CiEvidenceProvenance
  | RepositoryEvidenceProvenance
  | ExternalEvidenceProvenance;

const externalUriSchema = z
  .string()
  .max(TEXT_LIMITS.url)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    },
    { error: "Expected an absolute http(s) URL" },
  );

export const toolEvidenceProvenanceSchema = z.strictObject({
  kind: z.literal("tool"),
  tool: toolReferenceSchema,
  ruleId: namespacedIdSchema.optional(),
  runId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

export const agentEvidenceProvenanceSchema = z.strictObject({
  kind: z.literal("agent"),
  agentType: z.enum(AGENT_TYPES),
  agentRunId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  model: modelReferenceSchema.optional(),
});

export const ciEvidenceProvenanceSchema = z.strictObject({
  kind: z.literal("ci"),
  check: ciCheckReferenceSchema,
});

export const repositoryEvidenceProvenanceSchema = z.strictObject({
  kind: z.literal("repository"),
  commit: gitObjectIdSchema.optional(),
});

export const externalEvidenceProvenanceSchema = z.strictObject({
  kind: z.literal("external"),
  sourceId: namespacedIdSchema,
  uri: externalUriSchema.optional(),
});

export const evidenceProvenanceSchema = z.discriminatedUnion("kind", [
  toolEvidenceProvenanceSchema,
  agentEvidenceProvenanceSchema,
  ciEvidenceProvenanceSchema,
  repositoryEvidenceProvenanceSchema,
  externalEvidenceProvenanceSchema,
]);

/**
 * One piece of support for a claim.
 *
 * `summary` is a short human-readable line — it explains, it does not identify.
 * Nothing machine-readable is ever parsed out of it (§32's rule applied here),
 * and secret values must never be placed in it (§122); bulk content belongs in
 * `artifact`.
 *
 * Evidence is **immutable** (§71). A verifier that disagrees adds new evidence
 * rather than editing existing evidence, so the record of what was known at
 * each point survives.
 */
export interface Evidence {
  readonly schemaVersion: number;
  readonly id: EvidenceId;
  /** The run that produced it. Evidence is scoped to an execution. */
  readonly reviewRunId: ReviewRunId;
  readonly type: EvidenceType;
  readonly provenance: EvidenceProvenance;
  readonly strength: EvidenceStrength;
  /** One line, human-facing. Never parsed. */
  readonly summary: string;
  /** Where in the repository it applies, when it is positional. */
  readonly location?: SourceLocation | undefined;
  /** Bulk content: the log, the SARIF, the trace (§45). */
  readonly artifact?: ArtifactReference | undefined;
  readonly createdAt: Timestamp;
}

export const evidenceSchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(EVIDENCE_SCHEMA_VERSION, {
      error: `Unsupported Evidence schemaVersion; this build understands up to ${String(EVIDENCE_SCHEMA_VERSION)}`,
    }),
  id: evidenceIdSchema,
  reviewRunId: reviewRunIdSchema,
  type: evidenceTypeSchema,
  provenance: evidenceProvenanceSchema,
  strength: evidenceStrengthSchema,
  summary: z.string().min(1).max(TEXT_LIMITS.summary),
  location: sourceLocationSchema.optional(),
  artifact: artifactReferenceSchema.optional(),
  createdAt: timestampSchema,
});

/**
 * A pointer to evidence.
 *
 * Findings cite evidence by id rather than embedding it, for two reasons: one
 * piece of evidence commonly supports several findings, and embedding would
 * duplicate an artifact reference and its summary into every one of them
 * (§45, §97).
 */
export interface EvidenceReference {
  readonly evidenceId: EvidenceId;
}

export const evidenceReferenceSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
});

export const evidenceReferenceListSchema = z
  .array(evidenceReferenceSchema)
  .max(COLLECTION_LIMITS.evidencePerFinding);

/** Whether this evidence is strong enough to stand on its own. */
export function isConclusive(evidence: Evidence): boolean {
  return evidence.strength === "deterministic";
}
