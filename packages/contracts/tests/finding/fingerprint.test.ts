import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FINDING_FINGERPRINT_ALGORITHM,
  FINDING_FINGERPRINT_VERSION,
  computeFindingFingerprint,
  findingFingerprintInputSchema,
  fingerprintCanonicalInput,
  fingerprintsMatch,
  isCurrentAlgorithm,
  type FindingFingerprintInput,
} from "../../src/domain/finding/fingerprint.js";
import { RepositoryIdOps } from "../../src/domain/identity/ids.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import type { ContentHasher } from "../../src/domain/ports/content-hasher.js";
import type { Checksum } from "../../src/domain/primitives/checksum.js";

/**
 * A real SHA-256 hasher, supplied by the test.
 *
 * `node:crypto` lives here rather than in the contracts package on purpose:
 * the package must stay environment-neutral because `apps/web` imports from
 * it, so hashing is an injected port (§95). This is the server-side
 * implementation a worker would provide.
 */
const sha256: ContentHasher = {
  algorithm: "sha256",
  hash(data: string | Uint8Array): Checksum {
    return {
      algorithm: "sha256",
      value: createHash("sha256").update(data).digest("hex"),
    };
  },
};

const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const OTHER_REPO = RepositoryIdOps.parse(
  "0192f8a1-0000-7000-8000-00000000000f",
);

/**
 * The same semantic finding: SQL injection in `Session.verify`, in
 * `src/auth.ts`. Nothing here mentions a line number — which is the point.
 */
function baseInput(
  overrides: Partial<FindingFingerprintInput> = {},
): FindingFingerprintInput {
  return {
    repositoryId: REPO,
    category: "security",
    issueKey: namespacedId("acalys.security.sql-injection"),
    detector: namespacedId("acalys.agent.reviewer"),
    path: repositoryPath("src/auth.ts"),
    anchor: {
      kind: "symbol",
      symbol: {
        name: "verify",
        kind: "method",
        qualifiedName: "auth.Session.verify",
        container: "Session",
        // Present, and deliberately different between the two revisions below.
        range: { start: 10, end: 15 },
      },
    },
    ...overrides,
  };
}

describe("FindingFingerprint (P0.txt §28)", () => {
  describe("HARD GATE: line movement must not change identity", () => {
    it("survives the same code moving down the file", () => {
      // revision 1: the method sits at lines 10-15
      const before = baseInput();

      // revision 2: someone added 100 lines of imports above it. Same file,
      // same symbol, same issue — only the line numbers moved.
      const after = baseInput({
        anchor: {
          kind: "symbol",
          symbol: {
            name: "verify",
            kind: "method",
            qualifiedName: "auth.Session.verify",
            container: "Session",
            range: { start: 110, end: 115 },
          },
        },
      });

      const first = computeFindingFingerprint(before, sha256);
      const second = computeFindingFingerprint(after, sha256);

      expect(second.value).toBe(first.value);
      expect(fingerprintsMatch(first, second)).toBe(true);
    });

    it("proves line numbers never reach the hashed input at all", () => {
      // Stronger than comparing digests: the canonical input string — the
      // exact bytes that get hashed — contains no line information.
      const canonical = fingerprintCanonicalInput(baseInput());

      expect(canonical).not.toContain("10");
      expect(canonical).not.toContain("115");
      expect(canonical).not.toContain("range");
      expect(canonical).not.toContain("start");
      expect(canonical).not.toContain("end");
    });

    it("survives a symbol moving with no range recorded at all", () => {
      const withRange = baseInput();
      const withoutRange = baseInput({
        anchor: {
          kind: "symbol",
          symbol: {
            name: "verify",
            kind: "method",
            qualifiedName: "auth.Session.verify",
            container: "Session",
          },
        },
      });

      expect(computeFindingFingerprint(withoutRange, sha256).value).toBe(
        computeFindingFingerprint(withRange, sha256).value,
      );
    });
  });

  describe("semantic change DOES change identity", () => {
    const reference = computeFindingFingerprint(baseInput(), sha256);

    it("a different symbol", () => {
      const other = baseInput({
        anchor: {
          kind: "symbol",
          symbol: {
            name: "authorize",
            kind: "method",
            qualifiedName: "auth.Session.authorize",
            container: "Session",
          },
        },
      });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different issue in the same symbol", () => {
      const other = baseInput({
        issueKey: namespacedId("acalys.security.missing-authz"),
      });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different file", () => {
      const other = baseInput({ path: repositoryPath("src/session.ts") });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different category", () => {
      const other = baseInput({ category: "correctness" });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different repository", () => {
      const other = baseInput({ repositoryId: OTHER_REPO });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different detector", () => {
      // The same issue found by semgrep and by the agent are separate records
      // until reconciliation merges them deliberately.
      const other = baseInput({ detector: namespacedId("tool.semgrep") });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("a different symbol kind at the same name", () => {
      const other = baseInput({
        anchor: {
          kind: "symbol",
          symbol: {
            name: "verify",
            kind: "function",
            qualifiedName: "auth.Session.verify",
            container: "Session",
          },
        },
      });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });

    it("case differences in a symbol are NOT folded away", () => {
      // getUser and GetUser are different symbols in every language the
      // platform reviews; lowercasing would merge two real findings into one.
      const other = baseInput({
        anchor: {
          kind: "symbol",
          symbol: {
            name: "Verify",
            kind: "method",
            qualifiedName: "auth.Session.Verify",
            container: "Session",
          },
        },
      });
      expect(computeFindingFingerprint(other, sha256).value).not.toBe(
        reference.value,
      );
    });
  });

  describe("presentation is excluded from identity", () => {
    it("has no field for a title or explanation to enter through", () => {
      // Model wording varies run to run for one issue, so prose can never
      // participate. The input type is the enforcement: there is nowhere to
      // put it.
      const keys = Object.keys(findingFingerprintInputSchema.shape);
      expect(keys).toEqual([
        "repositoryId",
        "category",
        "issueKey",
        "detector",
        "path",
        "anchor",
      ]);
      for (const excluded of [
        "title",
        "explanation",
        "claim",
        "summary",
        "severity",
        "confidence",
        "createdAt",
        "reviewRunId",
        "evidence",
      ]) {
        expect(keys).not.toContain(excluded);
      }
    });

    it("rejects an unknown field rather than silently ignoring it", () => {
      expect(
        findingFingerprintInputSchema.safeParse({
          ...baseInput(),
          title: "Possible SQL injection",
        }).success,
      ).toBe(false);
    });
  });

  describe("determinism (§58)", () => {
    it("is stable across 1000 repeated computations", () => {
      const expected = computeFindingFingerprint(baseInput(), sha256).value;
      for (let index = 0; index < 1_000; index += 1) {
        expect(computeFindingFingerprint(baseInput(), sha256).value).toBe(
          expected,
        );
      }
    });

    it("is unaffected by property insertion order", () => {
      const forward = baseInput();
      const reordered: FindingFingerprintInput = {
        anchor: forward.anchor,
        path: forward.path,
        detector: forward.detector,
        issueKey: forward.issueKey,
        category: forward.category,
        repositoryId: forward.repositoryId,
      };
      expect(fingerprintCanonicalInput(reordered)).toBe(
        fingerprintCanonicalInput(forward),
      );
    });

    it("distinguishes an absent detector from any present one", () => {
      // canonicalJson omits absent keys rather than writing "undefined", so
      // this is a real structural difference, not a string coincidence.
      const { detector: _drop, ...withoutDetector } = baseInput();
      const canonical = fingerprintCanonicalInput(withoutDetector);
      expect(canonical).not.toContain("detector");
      expect(canonical).not.toContain("undefined");
      expect(canonical).not.toBe(fingerprintCanonicalInput(baseInput()));
    });
  });

  describe("anchor degradation ladder", () => {
    it("a content anchor survives movement but not content change", () => {
      const digest = (value: string): Checksum => sha256.hash(value);

      const original = baseInput({
        anchor: {
          kind: "content",
          digest: digest("SELECT * WHERE id=" + "$x"),
        },
      });
      const moved = baseInput({
        anchor: {
          kind: "content",
          digest: digest("SELECT * WHERE id=" + "$x"),
        },
      });
      const edited = baseInput({
        anchor: { kind: "content", digest: digest("SELECT * WHERE id = ?") },
      });

      // Movement does not touch content, so identity holds.
      expect(computeFindingFingerprint(moved, sha256).value).toBe(
        computeFindingFingerprint(original, sha256).value,
      );
      // Editing the code does change it — usually correct, because the finding
      // may genuinely no longer hold.
      expect(computeFindingFingerprint(edited, sha256).value).not.toBe(
        computeFindingFingerprint(original, sha256).value,
      );
    });

    it("a path anchor is file-scoped and survives everything but a rename", () => {
      const first = baseInput({ anchor: { kind: "path" } });
      const second = baseInput({ anchor: { kind: "path" } });
      const renamed = baseInput({
        anchor: { kind: "path" },
        path: repositoryPath("src/authentication.ts"),
      });

      expect(computeFindingFingerprint(second, sha256).value).toBe(
        computeFindingFingerprint(first, sha256).value,
      );
      expect(computeFindingFingerprint(renamed, sha256).value).not.toBe(
        computeFindingFingerprint(first, sha256).value,
      );
    });

    it("the three anchor kinds never collide with each other", () => {
      const values = new Set([
        computeFindingFingerprint(baseInput(), sha256).value,
        computeFindingFingerprint(
          baseInput({ anchor: { kind: "content", digest: sha256.hash("x") } }),
          sha256,
        ).value,
        computeFindingFingerprint(
          baseInput({ anchor: { kind: "path" } }),
          sha256,
        ).value,
      ]);
      expect(values.size).toBe(3);
    });

    it("rejects a half-formed anchor", () => {
      // The union makes { symbol: undefined, digest: undefined } unrepresentable.
      expect(
        findingFingerprintInputSchema.safeParse({
          ...baseInput(),
          anchor: { kind: "symbol" },
        }).success,
      ).toBe(false);
    });
  });

  describe("algorithm versioning", () => {
    it("records the algorithm and version alongside the value", () => {
      const fingerprint = computeFindingFingerprint(baseInput(), sha256);
      expect(fingerprint.algorithm).toBe(FINDING_FINGERPRINT_ALGORITHM);
      expect(fingerprint.algorithmVersion).toBe(FINDING_FINGERPRINT_VERSION);
      expect(fingerprint.value).toMatch(/^[0-9a-f]{64}$/);
      expect(isCurrentAlgorithm(fingerprint)).toBe(true);
    });

    it("does not match a value from a different algorithm", () => {
      // Comparing across algorithms must never report equality, even if the
      // hex happened to coincide.
      const current = computeFindingFingerprint(baseInput(), sha256);
      const legacy = { ...current, algorithmVersion: 0 };

      expect(fingerprintsMatch(current, legacy)).toBe(false);
      expect(isCurrentAlgorithm(legacy)).toBe(false);
    });

    it("bakes the algorithm identity into the hashed input", () => {
      // So a future algorithm cannot produce the same digest from the same
      // semantic inputs and be mistaken for this one.
      const canonical = fingerprintCanonicalInput(baseInput());
      expect(canonical).toContain(FINDING_FINGERPRINT_ALGORITHM);
    });
  });

  it("the canonical input is readable, which is why it is exposed", () => {
    // A hex digest tells you nothing when two findings fail to match; this
    // shows exactly which component differed.
    expect(fingerprintCanonicalInput(baseInput())).toBe(
      '{"algorithm":"acalys.fingerprint.symbol-anchor",' +
        '"anchor":"symbol:method:auth.Session.verify",' +
        '"category":"security",' +
        '"detector":"acalys.agent.reviewer",' +
        '"issueKey":"acalys.security.sql-injection",' +
        '"path":"src/auth.ts",' +
        `"repositoryId":"${REPO}",` +
        '"version":1}',
    );
  });
});
