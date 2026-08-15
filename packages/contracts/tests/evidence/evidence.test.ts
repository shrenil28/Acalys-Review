import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_STRENGTHS,
  EVIDENCE_TYPES,
  compareEvidenceStrength,
  evidenceProvenanceSchema,
  evidenceSchema,
  isConclusive,
  strongestEvidence,
  type EvidenceProvenance,
} from "../../src/domain/evidence/evidence.js";
import {
  artifactReferenceSchema,
  canDisclose,
  dataClassificationSchema,
  DATA_CLASSIFICATIONS,
  DISCLOSURE_DESTINATIONS,
  effectiveClassification,
  isRedactionPending,
  redactionSchema,
  REDACTION_STATES,
  NO_REDACTION,
  type DataClassification,
  type DisclosureDestination,
  type RedactionState,
} from "../../src/domain/artifacts/artifact.js";
import {
  ciCheckReferenceSchema,
  isConclusiveCheck,
} from "../../src/domain/ci/ci-check.js";
import {
  producedTrustworthyCoverage,
  toolReferenceSchema,
  toolRunReferenceSchema,
} from "../../src/domain/tools/tool.js";
import {
  ArtifactIdOps,
  EvidenceIdOps,
  RepositoryIdOps,
  ReviewRunIdOps,
} from "../../src/domain/identity/ids.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";

const RUN = ReviewRunIdOps.parse("0192f8a1-0000-7000-8000-000000000007");
const EVIDENCE = EvidenceIdOps.parse("0192f8a1-0000-7000-8000-000000000011");
const ARTIFACT = ArtifactIdOps.parse("0192f8a1-0000-7000-8000-000000000012");
const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const SHA = "a".repeat(40);
const DIGEST = "9".repeat(64);

const base = {
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  id: EVIDENCE,
  reviewRunId: RUN,
  type: "static_analysis" as const,
  strength: "supporting" as const,
  summary: "Taint reaches the query builder without sanitization.",
  createdAt: timestamp("2026-08-16T10:00:00.000Z"),
};

describe("Evidence (P0.txt §29, §30, §31)", () => {
  describe("evidence is structured, never prose (§29)", () => {
    it("requires a type, a provenance, and a strength", () => {
      const keys = Object.keys(evidenceSchema.shape);
      for (const required of ["type", "provenance", "strength", "summary"]) {
        expect(keys).toContain(required);
      }
    });

    it("cannot be reduced to a bare string", () => {
      expect(evidenceSchema.safeParse("taint reaches the sink").success).toBe(
        false,
      );
    });

    it("bulk content goes to an artifact, never inline (§45)", () => {
      const keys = Object.keys(evidenceSchema.shape);
      expect(keys).toContain("artifact");
      for (const inline of ["content", "body", "output", "log", "raw"]) {
        expect(keys).not.toContain(inline);
      }
    });
  });

  describe("every provenance family (§30)", () => {
    const provenances: { label: string; value: EvidenceProvenance }[] = [
      {
        label: "tool",
        value: {
          kind: "tool",
          tool: { id: namespacedId("tool.semgrep"), version: "1.52.0" },
          ruleId: namespacedId("python.lang.security.audit"),
          runId: "run-7",
        },
      },
      {
        label: "agent",
        value: {
          kind: "agent",
          agentType: "reviewer",
          agentRunId: "reviewer-2",
          model: { provider: "anthropic", model: "claude-opus-5" },
        },
      },
      {
        label: "ci",
        value: {
          kind: "ci",
          check: {
            check: {
              kind: "check",
              provider: "github",
              externalId: "12345",
              name: "unit-tests",
            },
            status: "completed",
            conclusion: "failure",
            commit: { algorithm: "sha1", value: SHA },
          },
        },
      },
      {
        label: "repository",
        value: {
          kind: "repository",
          commit: { algorithm: "sha1", value: SHA },
        },
      },
      {
        label: "external",
        value: {
          kind: "external",
          sourceId: namespacedId("external.nvd"),
          uri: "https://nvd.nist.gov/vuln/detail/CVE-2024-0001",
        },
      },
    ];

    it.each(provenances)("parses $label provenance", ({ value }) => {
      const parsed = evidenceSchema.parse({ ...base, provenance: value });
      expect(parsed.provenance.kind).toBe(value.kind);
    });

    it("narrows correctly on the discriminant", () => {
      const parsed = evidenceProvenanceSchema.parse(provenances[0]?.value);
      if (parsed.kind === "tool") {
        // Only reachable — and only type-checks — inside the tool branch.
        expect(parsed.tool.id).toBe("tool.semgrep");
        expect(parsed.ruleId).toBe("python.lang.security.audit");
      } else {
        expect.unreachable("expected tool provenance");
      }
    });

    it("rejects a tool field on a CI branch (§C18)", () => {
      // Fields belong to exactly one branch; strict objects make a mixed
      // provenance unrepresentable.
      expect(
        evidenceProvenanceSchema.safeParse({
          kind: "ci",
          tool: { id: "tool.semgrep" },
        }).success,
      ).toBe(false);
    });

    it("rejects a CI branch missing its check reference", () => {
      expect(evidenceProvenanceSchema.safeParse({ kind: "ci" }).success).toBe(
        false,
      );
    });

    it("repository provenance needs neither a tool nor an agent (§30)", () => {
      // "This line is in the diff" is read directly from the repository;
      // fabricating a tool identity would make provenance meaningless.
      expect(
        evidenceProvenanceSchema.safeParse({ kind: "repository" }).success,
      ).toBe(true);
    });

    it("rejects an unknown provenance family", () => {
      expect(
        evidenceProvenanceSchema.safeParse({ kind: "telepathy" }).success,
      ).toBe(false);
    });

    describe("external URIs are references, not trusted content (§63)", () => {
      const external = (uri: string) => ({
        kind: "external" as const,
        sourceId: namespacedId("external.docs"),
        uri,
      });

      it.each([
        ["javascript:", "javascript:alert(1)"],
        ["file:", "file:///etc/passwd"],
        ["data:", "data:text/html,<script>alert(1)</script>"],
        ["relative", "/some/path"],
        ["not a url", "just text"],
      ])("rejects a %s URI", (_label, uri) => {
        expect(evidenceProvenanceSchema.safeParse(external(uri)).success).toBe(
          false,
        );
      });

      it("accepts https", () => {
        expect(
          evidenceProvenanceSchema.safeParse(external("https://example.com/a"))
            .success,
        ).toBe(true);
      });
    });
  });

  describe("strength is not confidence (§31 vs §26)", () => {
    it("orders weak < supporting < strong < deterministic", () => {
      const shuffled = [
        "strong",
        "weak",
        "deterministic",
        "supporting",
      ] as const;
      expect([...shuffled].sort(compareEvidenceStrength)).toEqual([
        "weak",
        "supporting",
        "strong",
        "deterministic",
      ]);
    });

    it("finds the strongest item in a set", () => {
      expect(strongestEvidence(["weak", "strong", "supporting"])).toBe(
        "strong",
      );
      expect(strongestEvidence([])).toBeUndefined();
    });

    it("only deterministic evidence is conclusive on its own", () => {
      for (const strength of EVIDENCE_STRENGTHS) {
        const parsed = evidenceSchema.parse({
          ...base,
          strength,
          provenance: { kind: "repository" },
        });
        expect(isConclusive(parsed)).toBe(strength === "deterministic");
      }
    });

    it("carries no confidence score — that belongs to the finding", () => {
      // Ten weak items must not be able to launder themselves into certainty.
      expect(Object.keys(evidenceSchema.shape)).not.toContain("confidence");
    });
  });

  it("has no duplicate values in either vocabulary", () => {
    expect(new Set(EVIDENCE_TYPES).size).toBe(EVIDENCE_TYPES.length);
    expect(new Set(EVIDENCE_STRENGTHS).size).toBe(EVIDENCE_STRENGTHS.length);
  });
});

describe("Artifacts, classification, and redaction (P0.txt §45, §121, §122)", () => {
  const artifact = {
    id: ARTIFACT,
    kind: "log" as const,
    contentType: "text/plain",
    sizeBytes: 4096,
    checksum: { algorithm: "sha256" as const, value: DIGEST },
    storageReference: "s3://acalys-artifacts/run-7/semgrep.log",
    classification: "tenant_private" as const,
    redaction: NO_REDACTION,
    name: "semgrep.log",
  };

  it("references content without embedding it", () => {
    const keys = Object.keys(artifactReferenceSchema.shape);
    expect(keys).toContain("storageReference");
    for (const inline of ["content", "body", "data", "bytes", "payload"]) {
      expect(keys).not.toContain(inline);
    }
  });

  it("rejects a non-media content type", () => {
    expect(
      artifactReferenceSchema.safeParse({
        ...artifact,
        contentType: "log file",
      }).success,
    ).toBe(false);
  });

  describe("classification and redaction are independent (§121, §122)", () => {
    it("tenant_private content commonly needs no redaction", () => {
      expect(
        artifactReferenceSchema.safeParse({
          ...artifact,
          classification: "tenant_private",
          redaction: { state: "not_required" },
        }).success,
      ).toBe(true);
    });

    it("sensitive content can be redacted", () => {
      expect(
        artifactReferenceSchema.safeParse({
          ...artifact,
          classification: "sensitive",
          redaction: {
            state: "redacted",
            reason: namespacedId("acalys.redaction.detected-secret"),
          },
        }).success,
      ).toBe(true);
    });

    it("a redacted artifact must record why", () => {
      expect(redactionSchema.safeParse({ state: "redacted" }).success).toBe(
        false,
      );
    });

    it("a reason without a redaction is a contradiction (§C18)", () => {
      expect(
        redactionSchema.safeParse({
          state: "not_required",
          reason: namespacedId("acalys.redaction.detected-secret"),
        }).success,
      ).toBe(false);
    });

    it("'pending' is the state a boolean could not express", () => {
      // `redacted: false` reads as "safe" when it may only mean "unchecked".
      const pending = artifactReferenceSchema.parse({
        ...artifact,
        classification: "sensitive",
        redaction: { state: "pending" },
      });
      expect(isRedactionPending(pending)).toBe(true);
      expect(canDisclose(pending, "tenant_surface")).toBe(false);
    });

    it("redaction demotes sensitive to tenant_private, never to public", () => {
      // Redaction removes the secret, but the rest is still the tenant's data.
      // Anything else would let redaction launder tenant data onto a public
      // surface.
      const redacted = artifactReferenceSchema.parse({
        ...artifact,
        classification: "sensitive",
        redaction: {
          state: "redacted",
          reason: namespacedId("acalys.redaction.detected-secret"),
        },
      });
      expect(effectiveClassification(redacted)).toBe("tenant_private");
      expect(canDisclose(redacted, "tenant_surface")).toBe(true);
      expect(canDisclose(redacted, "public_surface")).toBe(false);
    });

    it("not_required grants nothing on its own", () => {
      // The exact bug this replaced: a helper that returned true for any
      // non-sensitive artifact silently made every tenant-private artifact
      // world-disclosable.
      const tenantData = artifactReferenceSchema.parse({
        ...artifact,
        classification: "tenant_private",
        redaction: { state: "not_required" },
      });
      expect(canDisclose(tenantData, "tenant_surface")).toBe(true);
      expect(canDisclose(tenantData, "public_surface")).toBe(false);
    });

    describe("the full classification x redaction x destination matrix", () => {
      /**
       * Every combination asserted explicitly. This is the test that protects
       * the reason `pending` exists: a single row silently flipping to `true`
       * is a disclosure bug, and sampling would not catch it.
       */
      const EXPECTED: Readonly<
        Record<
          DataClassification,
          Readonly<Record<RedactionState, readonly DisclosureDestination[]>>
        >
      > = {
        public: {
          not_required: [
            "public_surface",
            "provider_comment",
            "tenant_surface",
          ],
          redacted: ["public_surface", "provider_comment", "tenant_surface"],
          pending: [],
        },
        tenant_private: {
          not_required: ["provider_comment", "tenant_surface"],
          redacted: ["provider_comment", "tenant_surface"],
          pending: [],
        },
        sensitive: {
          // Raw sensitive content goes nowhere, even though it was assessed:
          // `not_required` on sensitive content is a policy statement that no
          // redaction is needed, not permission to disclose it anywhere.
          not_required: [],
          // Once redacted it behaves as tenant_private.
          redacted: ["provider_comment", "tenant_surface"],
          pending: [],
        },
      };

      const cases: {
        classification: DataClassification;
        state: RedactionState;
        destination: DisclosureDestination;
        expected: boolean;
      }[] = [];

      for (const classification of DATA_CLASSIFICATIONS) {
        for (const state of REDACTION_STATES) {
          for (const destination of DISCLOSURE_DESTINATIONS) {
            cases.push({
              classification,
              state,
              destination,
              expected: EXPECTED[classification][state].includes(destination),
            });
          }
        }
      }

      it("covers all 27 combinations", () => {
        expect(cases).toHaveLength(
          DATA_CLASSIFICATIONS.length *
            REDACTION_STATES.length *
            DISCLOSURE_DESTINATIONS.length,
        );
        expect(cases).toHaveLength(27);
      });

      it.each(cases)(
        "$classification + $state -> $destination = $expected",
        ({ classification, state, destination, expected }) => {
          const parsed = artifactReferenceSchema.parse({
            ...artifact,
            classification,
            redaction:
              state === "redacted"
                ? {
                    state,
                    reason: namespacedId("acalys.redaction.detected-secret"),
                  }
                : { state },
          });
          expect(canDisclose(parsed, destination)).toBe(expected);
        },
      );

      it("INVARIANT: pending is never disclosable, anywhere", () => {
        // Stated on its own so a regression names the invariant rather than a
        // row number.
        for (const classification of DATA_CLASSIFICATIONS) {
          const parsed = artifactReferenceSchema.parse({
            ...artifact,
            classification,
            redaction: { state: "pending" },
          });
          for (const destination of DISCLOSURE_DESTINATIONS) {
            expect(canDisclose(parsed, destination)).toBe(false);
          }
        }
      });

      it("INVARIANT: redaction state alone never authorizes disclosure", () => {
        // For every non-pending redaction state, there exists a classification
        // that is still refused at a public surface — so no caller can treat
        // "redaction settled" as "safe to publish".
        for (const state of ["not_required", "redacted"] as const) {
          const parsed = artifactReferenceSchema.parse({
            ...artifact,
            classification: "tenant_private",
            redaction:
              state === "redacted"
                ? {
                    state,
                    reason: namespacedId("acalys.redaction.detected-secret"),
                  }
                : { state },
          });
          expect(canDisclose(parsed, "public_surface")).toBe(false);
        }
      });
    });

    it("uses P0's classification vocabulary", () => {
      for (const value of ["public", "tenant_private", "sensitive"]) {
        expect(dataClassificationSchema.safeParse(value).success).toBe(true);
      }
      expect(dataClassificationSchema.safeParse("confidential").success).toBe(
        false,
      );
    });
  });
});

describe("Tool and CI references (P0.txt §41, §42)", () => {
  it("a tool reference carries no command line or config", () => {
    const keys = Object.keys(toolReferenceSchema.shape);
    expect(keys).toEqual(["id", "version"]);
  });

  it("only a completed tool run makes 'no findings' meaningful", () => {
    const run = (state: string) =>
      toolRunReferenceSchema.parse({
        tool: { id: namespacedId("tool.semgrep") },
        runId: "r1",
        state,
      });

    expect(producedTrustworthyCoverage(run("completed"))).toBe(true);
    // A timeout leaves coverage unknown — reporting clean would be a lie.
    expect(producedTrustworthyCoverage(run("timed_out"))).toBe(false);
    expect(producedTrustworthyCoverage(run("skipped"))).toBe(false);
    expect(producedTrustworthyCoverage(run("failed"))).toBe(false);
  });

  describe("CI status and conclusion cannot contradict", () => {
    const check = {
      check: {
        kind: "check" as const,
        provider: "github" as const,
        externalId: "1",
        name: "tests",
      },
      commit: { algorithm: "sha1" as const, value: SHA },
    };

    it("a completed check must record a conclusion", () => {
      expect(
        ciCheckReferenceSchema.safeParse({ ...check, status: "completed" })
          .success,
      ).toBe(false);
    });

    it("an in-flight check must not", () => {
      expect(
        ciCheckReferenceSchema.safeParse({
          ...check,
          status: "in_progress",
          conclusion: "success",
        }).success,
      ).toBe(false);
    });

    it("only success and failure are conclusive evidence", () => {
      const build = (conclusion: string) =>
        ciCheckReferenceSchema.parse({
          ...check,
          status: "completed",
          conclusion,
        });

      expect(isConclusiveCheck(build("success"))).toBe(true);
      expect(isConclusiveCheck(build("failure"))).toBe(true);
      // A skipped suite must never read as a green one.
      expect(isConclusiveCheck(build("skipped"))).toBe(false);
      expect(isConclusiveCheck(build("neutral"))).toBe(false);
      expect(isConclusiveCheck(build("cancelled"))).toBe(false);
    });
  });
});

describe("evidence locations flow through path safety (§64)", () => {
  it("rejects a traversal path in an evidence location", () => {
    expect(
      evidenceSchema.safeParse({
        ...base,
        provenance: { kind: "repository" },
        location: {
          repositoryId: REPO,
          path: "../../etc/passwd",
          side: "head",
          lines: { start: 1, end: 1 },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a valid location", () => {
    const parsed = evidenceSchema.parse({
      ...base,
      provenance: { kind: "repository" },
      location: {
        repositoryId: REPO,
        path: repositoryPath("src/auth.ts"),
        side: "head",
        lines: { start: 82, end: 84 },
      },
    });
    expect(parsed.location?.path).toBe("src/auth.ts");
  });
});
