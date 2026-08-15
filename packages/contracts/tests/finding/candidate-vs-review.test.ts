import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  candidateFindingSchema,
  CANDIDATE_FINDING_SCHEMA_VERSION,
  type CandidateFinding,
  type CandidateFindingHasNoLifecycle,
} from "../../src/domain/finding/candidate-finding.js";
import {
  assertFindingStateMatchesHistory,
  isBlocking,
  isOpenFinding,
  reviewFindingSchema,
  REVIEW_FINDING_SCHEMA_VERSION,
} from "../../src/domain/finding/review-finding.js";
import { findingConfidence } from "../../src/domain/finding/taxonomy.js";
import { computeFindingFingerprint } from "../../src/domain/finding/fingerprint.js";
import {
  CandidateFindingIdOps,
  EvidenceIdOps,
  FindingIdOps,
  OrganizationIdOps,
  RepositoryIdOps,
  ReviewRunIdOps,
} from "../../src/domain/identity/ids.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import { ValidationError } from "../../src/domain/errors/errors.js";
import type { ContentHasher } from "../../src/domain/ports/content-hasher.js";

const sha256: ContentHasher = {
  algorithm: "sha256",
  hash: (data) => ({
    algorithm: "sha256",
    value: createHash("sha256").update(data).digest("hex"),
  }),
};

const ORG = OrganizationIdOps.parse("0192f8a1-0000-7000-8000-000000000001");
const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const OTHER_REPO = RepositoryIdOps.parse(
  "0192f8a1-0000-7000-8000-00000000000f",
);
const RUN = ReviewRunIdOps.parse("0192f8a1-0000-7000-8000-000000000007");
const CANDIDATE = CandidateFindingIdOps.parse(
  "0192f8a1-0000-7000-8000-00000000000c",
);
const FINDING = FindingIdOps.parse("0192f8a1-0000-7000-8000-00000000000d");
const REPLACEMENT = FindingIdOps.parse("0192f8a1-0000-7000-8000-00000000000e");
const EVIDENCE = EvidenceIdOps.parse("0192f8a1-0000-7000-8000-000000000011");

const at = (second: number) =>
  timestamp(`2026-08-16T10:00:${String(second).padStart(2, "0")}.000Z`);

const location = {
  repositoryId: REPO,
  path: repositoryPath("src/auth.ts"),
  side: "head" as const,
  lines: { start: 82, end: 84 },
  symbol: {
    name: "verify",
    kind: "method" as const,
    qualifiedName: "auth.Session.verify",
  },
};

const fingerprint = computeFindingFingerprint(
  {
    repositoryId: REPO,
    category: "security",
    issueKey: namespacedId("acalys.security.sql-injection"),
    path: repositoryPath("src/auth.ts"),
    anchor: {
      kind: "symbol",
      symbol: {
        name: "verify",
        kind: "method",
        qualifiedName: "auth.Session.verify",
      },
    },
  },
  sha256,
);

const candidate = {
  schemaVersion: CANDIDATE_FINDING_SCHEMA_VERSION,
  id: CANDIDATE,
  reviewRunId: RUN,
  title: "Possible SQL injection",
  claim: "User input reaches the query string without parameterization.",
  explanation: "The `id` parameter is interpolated directly into SQL.",
  category: "security" as const,
  proposedSeverity: "critical" as const,
  location,
  evidence: [{ evidenceId: EVIDENCE }],
  producedBy: { kind: "agent" as const, agentType: "reviewer" as const },
  createdAt: at(1),
};

const verification = {
  decision: "verified" as const,
  reasonCodes: ["confirmed_by_static_trace" as const],
  evidence: [{ evidenceId: EVIDENCE }],
  confidence: findingConfidence(0.95),
  verifiedBy: { kind: "agent" as const, agentType: "verifier" as const },
  verifiedAt: at(2),
};

const reviewFinding = {
  schemaVersion: REVIEW_FINDING_SCHEMA_VERSION,
  id: FINDING,
  organizationId: ORG,
  repositoryId: REPO,
  reviewRunId: RUN,
  candidateIds: [CANDIDATE],
  title: "SQL injection in Session.verify",
  explanation: "The `id` parameter is interpolated directly into SQL.",
  category: "security" as const,
  severity: "critical" as const,
  confidence: findingConfidence(0.95),
  location,
  evidence: [{ evidenceId: EVIDENCE }],
  fingerprint,
  verification,
  state: "verified" as const,
  history: [],
  createdAt: at(2),
  updatedAt: at(2),
};

describe("CandidateFinding vs ReviewFinding (P0.txt §23, §27)", () => {
  describe("a candidate owns no lifecycle — the architectural invariant", () => {
    it("is proven at compile time", () => {
      // Resolves to `true` only while every lifecycle-shaped key is absent
      // from CandidateFinding. Adding one makes this `false` and breaks
      // `npm run typecheck`, so the invariant is enforced by the compiler
      // rather than by review discipline.
      const proof: CandidateFindingHasNoLifecycle = true;
      expect(proof).toBe(true);
    });

    it("has no lifecycle key in its schema", () => {
      const keys = Object.keys(candidateFindingSchema.shape);
      for (const lifecycleField of [
        "state",
        "status",
        "lifecycle",
        "resolved",
        "dismissed",
        "published",
        "active",
        "history",
        "supersededBy",
      ]) {
        expect(keys).not.toContain(lifecycleField);
      }
    });

    it("rejects a lifecycle field at runtime too", () => {
      // Strict objects, so an analyzer cannot smuggle state in.
      expect(
        candidateFindingSchema.safeParse({ ...candidate, state: "published" })
          .success,
      ).toBe(false);
      expect(
        candidateFindingSchema.safeParse({ ...candidate, status: "open" })
          .success,
      ).toBe(false);
    });

    it("carries no verification — that has not happened yet", () => {
      expect(Object.keys(candidateFindingSchema.shape)).not.toContain(
        "verification",
      );
    });

    it("proposes a severity rather than settling one", () => {
      const keys = Object.keys(candidateFindingSchema.shape);
      expect(keys).toContain("proposedSeverity");
      // Naming carries the meaning: reconciliation may override it.
      expect(keys).not.toContain("severity");
    });

    it("parses a well-formed candidate", () => {
      const parsed = candidateFindingSchema.parse(candidate);
      expect(parsed.proposedSeverity).toBe("critical");
      expect(parsed.producedBy.kind).toBe("agent");
      // A fingerprint is optional at this stage; identity comes with promotion.
      expect(parsed.fingerprint).toBeUndefined();
    });
  });

  describe("a review finding owns the lifecycle", () => {
    it("requires state, history, fingerprint, and verification", () => {
      const keys = Object.keys(reviewFindingSchema.shape);
      for (const required of [
        "state",
        "history",
        "fingerprint",
        "verification",
      ]) {
        expect(keys).toContain(required);
      }
    });

    it("parses and starts at the initial lifecycle state", () => {
      const parsed = reviewFindingSchema.parse(reviewFinding);
      expect(parsed.state).toBe("verified");
      expect(isOpenFinding(parsed)).toBe(true);
    });

    it("cannot be built without a fingerprint", () => {
      const { fingerprint: _drop, ...withoutFingerprint } = reviewFinding;
      expect(reviewFindingSchema.safeParse(withoutFingerprint).success).toBe(
        false,
      );
    });

    it("cannot be built without a verification decision", () => {
      const { verification: _drop, ...withoutVerification } = reviewFinding;
      expect(reviewFindingSchema.safeParse(withoutVerification).success).toBe(
        false,
      );
    });

    it("must record which candidate(s) it came from", () => {
      expect(
        reviewFindingSchema.safeParse({ ...reviewFinding, candidateIds: [] })
          .success,
      ).toBe(false);
    });

    it("merges several candidates in a swarm review (§113)", () => {
      // Three reviewers raising one issue become one finding whose evidence
      // spans all three.
      const second = CandidateFindingIdOps.parse(
        "0192f8a1-0000-7000-8000-00000000001a",
      );
      const third = CandidateFindingIdOps.parse(
        "0192f8a1-0000-7000-8000-00000000001b",
      );
      const parsed = reviewFindingSchema.parse({
        ...reviewFinding,
        candidateIds: [CANDIDATE, second, third],
      });
      expect(parsed.candidateIds).toHaveLength(3);
    });

    it("rejects duplicate candidate ids", () => {
      expect(
        reviewFindingSchema.safeParse({
          ...reviewFinding,
          candidateIds: [CANDIDATE, CANDIDATE],
        }).success,
      ).toBe(false);
    });
  });

  describe("the two are not the same type with a flag", () => {
    it("differ in required fields, not just a status", () => {
      const candidateKeys = new Set(Object.keys(candidateFindingSchema.shape));
      const findingKeys = new Set(Object.keys(reviewFindingSchema.shape));

      // Only a ReviewFinding has these.
      for (const key of [
        "state",
        "history",
        "verification",
        "organizationId",
      ]) {
        expect(findingKeys.has(key)).toBe(true);
        expect(candidateKeys.has(key)).toBe(false);
      }
      // Only a CandidateFinding has these.
      for (const key of ["claim", "proposedSeverity", "producedBy"]) {
        expect(candidateKeys.has(key)).toBe(true);
        expect(findingKeys.has(key)).toBe(false);
      }
    });
  });

  describe("§107 invariants", () => {
    it("a finding cannot carry a rejected verification", () => {
      const result = reviewFindingSchema.safeParse({
        ...reviewFinding,
        verification: {
          ...verification,
          decision: "rejected",
          reasonCodes: ["false_positive"],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) =>
            issue.message.includes("cannot carry a rejected verification"),
          ),
        ).toBe(true);
      }
    });

    it("a finding's location must belong to its repository", () => {
      expect(
        reviewFindingSchema.safeParse({
          ...reviewFinding,
          location: { ...location, repositoryId: OTHER_REPO },
        }).success,
      ).toBe(false);
    });

    it("catches a state that disagrees with its history", () => {
      const drifted = reviewFindingSchema.parse({
        ...reviewFinding,
        state: "resolved",
        history: [{ from: "verified", to: "published", at: at(3) }],
      });
      expect(() => assertFindingStateMatchesHistory(drifted)).toThrow(
        ValidationError,
      );
      expect(() => assertFindingStateMatchesHistory(drifted)).toThrow(
        /'resolved' but its history ends in 'published'/,
      );
    });

    it("accepts a state that matches its history", () => {
      const consistent = reviewFindingSchema.parse({
        ...reviewFinding,
        state: "published",
        history: [{ from: "verified", to: "published", at: at(3) }],
      });
      expect(() => assertFindingStateMatchesHistory(consistent)).not.toThrow();
    });
  });

  describe("supersession bookkeeping", () => {
    const superseded = {
      ...reviewFinding,
      state: "superseded" as const,
      history: [
        { from: "verified" as const, to: "superseded" as const, at: at(3) },
      ],
      supersededBy: REPLACEMENT,
    };

    it("a superseded finding must name its replacement", () => {
      expect(reviewFindingSchema.safeParse(superseded).success).toBe(true);
      const { supersededBy: _drop, ...withoutReplacement } = superseded;
      expect(reviewFindingSchema.safeParse(withoutReplacement).success).toBe(
        false,
      );
    });

    it("a non-superseded finding must not name one", () => {
      expect(
        reviewFindingSchema.safeParse({
          ...reviewFinding,
          supersededBy: REPLACEMENT,
        }).success,
      ).toBe(false);
    });

    it("a finding cannot supersede itself", () => {
      expect(
        reviewFindingSchema.safeParse({ ...superseded, supersededBy: FINDING })
          .success,
      ).toBe(false);
    });
  });

  describe("blocking policy combines all three axes (§119)", () => {
    const build = (
      severity: "critical" | "low",
      score: number,
      state: "published" | "dismissed",
    ) =>
      reviewFindingSchema.parse({
        ...reviewFinding,
        severity,
        confidence: findingConfidence(score),
        verification: { ...verification, confidence: findingConfidence(score) },
        state,
        history:
          state === "published"
            ? [{ from: "verified", to: "published", at: at(3) }]
            : [
                { from: "verified", to: "published", at: at(3) },
                { from: "published", to: "dismissed", at: at(4) },
              ],
      });

    it("blocks a critical, very-high-confidence, open finding", () => {
      expect(isBlocking(build("critical", 0.95, "published"))).toBe(true);
    });

    it("does not block on severity alone", () => {
      // The failure the three-axis taxonomy exists to prevent: blocking merges
      // on an unverified guess.
      expect(isBlocking(build("critical", 0.5, "published"))).toBe(false);
    });

    it("does not block on confidence alone", () => {
      expect(isBlocking(build("low", 0.99, "published"))).toBe(false);
    });

    it("does not block a closed finding", () => {
      expect(isBlocking(build("critical", 0.95, "dismissed"))).toBe(false);
    });
  });

  it("both round-trip through JSON", () => {
    const parsedCandidate: CandidateFinding =
      candidateFindingSchema.parse(candidate);
    expect(
      candidateFindingSchema.parse(JSON.parse(JSON.stringify(parsedCandidate))),
    ).toEqual(parsedCandidate);

    const parsedFinding = reviewFindingSchema.parse(reviewFinding);
    expect(
      reviewFindingSchema.parse(JSON.parse(JSON.stringify(parsedFinding))),
    ).toEqual(parsedFinding);
  });
});
