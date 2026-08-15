import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  reviewTargetSchema,
  type ReviewTarget,
} from "../src/domain/review-target/review-target.js";
import {
  pullRequestSchema,
  pullRequestRevisionSchema,
  type PullRequest,
  type PullRequestRevision,
} from "../src/domain/pull-request/pull-request.js";
import {
  changeManifestSchema,
  changedFileSchema,
  type ChangeManifest,
  type ChangedFile,
} from "../src/domain/change/change-manifest.js";
import {
  reviewRequestSchema,
  type ReviewRequest,
} from "../src/domain/review/review-request.js";
import {
  reviewRunSchema,
  type ReviewRun,
} from "../src/domain/review/review-run.js";
import {
  repositorySchema,
  providerConnectionSchema,
  type ProviderConnection,
  type Repository,
} from "../src/domain/repository/repository.js";
import {
  organizationSchema,
  membershipSchema,
  userSchema,
  type Membership,
  type Organization,
  type User,
} from "../src/domain/tenancy/tenancy.js";
import { actorSchema, type Actor } from "../src/domain/actor/actor.js";
import {
  gitRefSchema,
  gitComparisonSchema,
  type GitComparison,
  type GitRef,
} from "../src/domain/git/git-refs.js";
import {
  lineRangeSchema,
  type LineRange,
} from "../src/domain/location/line-range.js";
import {
  symbolReferenceSchema,
  type SymbolReference,
} from "../src/domain/location/symbol-reference.js";
import {
  sourceLocationSchema,
  type SourceLocation,
} from "../src/domain/location/source-location.js";
import {
  artifactReferenceSchema,
  redactionSchema,
  type ArtifactReference,
  type Redaction,
} from "../src/domain/artifacts/artifact.js";
import {
  toolReferenceSchema,
  toolRunReferenceSchema,
  type ToolReference,
  type ToolRunReference,
} from "../src/domain/tools/tool.js";
import {
  ciCheckReferenceSchema,
  type CiCheckReference,
} from "../src/domain/ci/ci-check.js";
import {
  evidenceSchema,
  evidenceProvenanceSchema,
  type Evidence,
  type EvidenceProvenance,
} from "../src/domain/evidence/evidence.js";
import {
  findingConfidenceSchema,
  type FindingConfidence,
} from "../src/domain/finding/taxonomy.js";
import {
  findingFingerprintSchema,
  findingFingerprintInputSchema,
  type FindingFingerprint,
  type FindingFingerprintInput,
} from "../src/domain/finding/fingerprint.js";
import {
  verificationResultSchema,
  type VerificationResult,
} from "../src/domain/finding/verification.js";
import {
  findingTransitionSchema,
  type FindingTransition,
} from "../src/domain/finding/finding-lifecycle.js";
import {
  candidateFindingSchema,
  type CandidateFinding,
} from "../src/domain/finding/candidate-finding.js";
import {
  reviewFindingSchema,
  type ReviewFinding,
} from "../src/domain/finding/review-finding.js";
import {
  findingCountSummarySchema,
  reviewRiskAreaSchema,
  reviewSummaryAreaSchema,
  reviewSummarySchema,
  type FindingCountSummary,
  type ReviewRiskArea,
  type ReviewSummary,
  type ReviewSummaryArea,
} from "../src/domain/output/review-summary.js";
import {
  conversationMessageSchema,
  reviewCommentSchema,
  reviewConversationSchema,
  type ConversationMessage,
  type ReviewComment,
  type ReviewConversation,
} from "../src/domain/output/conversation.js";
import {
  editOperationSchema,
  fileEditSchema,
  suggestedFixSchema,
  suggestedFixValidationSchema,
  type EditOperation,
  type FileEdit,
  type SuggestedFix,
  type SuggestedFixValidation,
} from "../src/domain/output/suggested-fix.js";
import {
  knowledgeReferenceSchema,
  type KnowledgeReference,
} from "../src/domain/knowledge/knowledge.js";
import {
  preMergeCheckResultSchema,
  type PreMergeCheckResult,
} from "../src/domain/premerge/premerge.js";
import {
  knowledgeConfigSchema,
  preMergeConfigSchema,
  publicationConfigSchema,
  reviewBehaviorConfigSchema,
  reviewConfigSchema,
  toolConfigSchema,
  type KnowledgeConfig,
  type PreMergeConfig,
  type PublicationConfig,
  type ReviewBehaviorConfig,
  type ReviewConfig,
  type ToolConfig,
} from "../src/domain/configuration/review-config.js";
import {
  pathInstructionSchema,
  type PathInstruction,
} from "../src/domain/configuration/path-instruction.js";
import {
  configResolutionInputSchema,
  requestOverridesSchema,
  reviewConfigOverlaySchema,
  type ConfigResolutionInput,
  type RequestOverrides,
  type ReviewConfigOverlay,
} from "../src/domain/configuration/resolution.js";
import {
  reviewConfigSnapshotSchema,
  type ReviewConfigSnapshot,
} from "../src/domain/configuration/config-snapshot.js";

/**
 * Guards the one thing P0.txt §54 asks for and that nothing else checks: the
 * hand-written interface and the Zod schema that claims to validate it must
 * describe the same shape.
 *
 * This is not hypothetical. Building Checkpoint B, every optional field in the
 * package was declared `readonly x?: T` while Zod infers `x?: T | undefined`,
 * and under `exactOptionalPropertyTypes` those are different types. The result
 * was that `reviewRunSchema.parse(json)` did not produce a `ReviewRun` —
 * a validator that did not validate its own contract. It compiled everywhere
 * except one call site, purely by luck.
 *
 * The assertions below are compile-time. If a schema and its interface drift,
 * `npm run typecheck` fails here with the offending pair named, rather than
 * failing at some distant consumer months later.
 */

/**
 * Fails to compile unless `TSchemaOutput` is assignable to `TInterface`.
 *
 * One direction, deliberately: a parsed value must be usable as the contract.
 * The reverse (every hand-built object being valid) is not a type-level claim —
 * it is what runtime validation is for, since schemas encode refinements like
 * "a renamed file must record previousPath" that no type can express.
 */
function assertSchemaMatchesInterface<TInterface>() {
  return <TSchema extends z.ZodType<TInterface>>(schema: TSchema): TSchema =>
    schema;
}

describe("schema/type conformance (P0.txt §54)", () => {
  it("every parse boundary produces its declared contract type", () => {
    // Each line is the real assertion; a mismatch is a compile error, and the
    // runtime expect() below simply proves this test executed.
    assertSchemaMatchesInterface<ReviewTarget>()(reviewTargetSchema);
    assertSchemaMatchesInterface<PullRequest>()(pullRequestSchema);
    assertSchemaMatchesInterface<PullRequestRevision>()(
      pullRequestRevisionSchema,
    );
    assertSchemaMatchesInterface<ChangedFile>()(changedFileSchema);
    assertSchemaMatchesInterface<ChangeManifest>()(changeManifestSchema);
    assertSchemaMatchesInterface<ReviewRequest>()(reviewRequestSchema);
    assertSchemaMatchesInterface<ReviewRun>()(reviewRunSchema);
    assertSchemaMatchesInterface<Repository>()(repositorySchema);
    assertSchemaMatchesInterface<ProviderConnection>()(
      providerConnectionSchema,
    );
    assertSchemaMatchesInterface<Organization>()(organizationSchema);
    assertSchemaMatchesInterface<User>()(userSchema);
    assertSchemaMatchesInterface<Membership>()(membershipSchema);
    assertSchemaMatchesInterface<Actor>()(actorSchema);
    assertSchemaMatchesInterface<GitRef>()(gitRefSchema);
    assertSchemaMatchesInterface<GitComparison>()(gitComparisonSchema);

    // Checkpoint C
    assertSchemaMatchesInterface<LineRange>()(lineRangeSchema);
    assertSchemaMatchesInterface<SymbolReference>()(symbolReferenceSchema);
    assertSchemaMatchesInterface<SourceLocation>()(sourceLocationSchema);
    assertSchemaMatchesInterface<Redaction>()(redactionSchema);
    assertSchemaMatchesInterface<ArtifactReference>()(artifactReferenceSchema);
    assertSchemaMatchesInterface<ToolReference>()(toolReferenceSchema);
    assertSchemaMatchesInterface<ToolRunReference>()(toolRunReferenceSchema);
    assertSchemaMatchesInterface<CiCheckReference>()(ciCheckReferenceSchema);
    assertSchemaMatchesInterface<EvidenceProvenance>()(
      evidenceProvenanceSchema,
    );
    assertSchemaMatchesInterface<Evidence>()(evidenceSchema);
    assertSchemaMatchesInterface<FindingConfidence>()(findingConfidenceSchema);
    assertSchemaMatchesInterface<FindingFingerprint>()(
      findingFingerprintSchema,
    );
    assertSchemaMatchesInterface<FindingFingerprintInput>()(
      findingFingerprintInputSchema,
    );
    assertSchemaMatchesInterface<VerificationResult>()(
      verificationResultSchema,
    );
    assertSchemaMatchesInterface<FindingTransition>()(findingTransitionSchema);
    assertSchemaMatchesInterface<CandidateFinding>()(candidateFindingSchema);
    assertSchemaMatchesInterface<ReviewFinding>()(reviewFindingSchema);

    // Checkpoint D1
    assertSchemaMatchesInterface<FindingCountSummary>()(
      findingCountSummarySchema,
    );
    assertSchemaMatchesInterface<ReviewSummaryArea>()(reviewSummaryAreaSchema);
    assertSchemaMatchesInterface<ReviewRiskArea>()(reviewRiskAreaSchema);
    assertSchemaMatchesInterface<ReviewSummary>()(reviewSummarySchema);
    assertSchemaMatchesInterface<ReviewComment>()(reviewCommentSchema);
    assertSchemaMatchesInterface<ConversationMessage>()(
      conversationMessageSchema,
    );
    assertSchemaMatchesInterface<ReviewConversation>()(
      reviewConversationSchema,
    );
    assertSchemaMatchesInterface<EditOperation>()(editOperationSchema);
    assertSchemaMatchesInterface<FileEdit>()(fileEditSchema);
    assertSchemaMatchesInterface<SuggestedFixValidation>()(
      suggestedFixValidationSchema,
    );
    assertSchemaMatchesInterface<SuggestedFix>()(suggestedFixSchema);
    assertSchemaMatchesInterface<KnowledgeReference>()(
      knowledgeReferenceSchema,
    );
    assertSchemaMatchesInterface<PreMergeCheckResult>()(
      preMergeCheckResultSchema,
    );
    assertSchemaMatchesInterface<PathInstruction>()(pathInstructionSchema);
    assertSchemaMatchesInterface<ReviewBehaviorConfig>()(
      reviewBehaviorConfigSchema,
    );
    assertSchemaMatchesInterface<ToolConfig>()(toolConfigSchema);
    assertSchemaMatchesInterface<KnowledgeConfig>()(knowledgeConfigSchema);
    assertSchemaMatchesInterface<PreMergeConfig>()(preMergeConfigSchema);
    assertSchemaMatchesInterface<PublicationConfig>()(publicationConfigSchema);
    assertSchemaMatchesInterface<ReviewConfig>()(reviewConfigSchema);
    assertSchemaMatchesInterface<ReviewConfigOverlay>()(
      reviewConfigOverlaySchema,
    );
    assertSchemaMatchesInterface<RequestOverrides>()(requestOverridesSchema);
    assertSchemaMatchesInterface<ConfigResolutionInput>()(
      configResolutionInputSchema,
    );
    assertSchemaMatchesInterface<ReviewConfigSnapshot>()(
      reviewConfigSnapshotSchema,
    );

    expect(true).toBe(true);
  });

  it("a parsed value is directly assignable to its interface", () => {
    // The runtime half of the same claim, on the type that exposed the bug.
    const parsed: GitRef = gitRefSchema.parse({
      name: "main",
      objectId: { algorithm: "sha1", value: "a".repeat(40) },
    });

    expect(parsed.objectId.value).toBe("a".repeat(40));
    expect(parsed.name).toBe("main");
  });

  it("an absent optional stays absent rather than becoming null (§57)", () => {
    // §57's rule: `undefined`/absent means "no value"; `null` is never used to
    // mean that. A schema turning an omitted key into null would break it.
    const parsed = gitRefSchema.parse({
      objectId: { algorithm: "sha1", value: "b".repeat(40) },
    });

    expect(parsed.name).toBeUndefined();
    expect("name" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("null");
  });

  it("rejects null where a value is optional, not nullable", () => {
    // Optional means "may be absent", never "may be null".
    expect(
      gitRefSchema.safeParse({
        name: null,
        objectId: { algorithm: "sha1", value: "c".repeat(40) },
      }).success,
    ).toBe(false);
  });
});
