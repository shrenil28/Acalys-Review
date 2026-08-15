import { describe, expect, it } from "vitest";
import {
  CONFIG_LAYERS,
  configSourceHash,
  resolveReviewConfig,
  type ConfigResolutionInput,
  type ReviewConfigOverlay,
} from "../../src/domain/configuration/resolution.js";
import {
  PLATFORM_DEFAULT_REVIEW_CONFIG,
  reviewConfigSchema,
} from "../../src/domain/configuration/review-config.js";
import {
  createConfigSnapshot,
  snapshotsShareSource,
  type ConfigSnapshotDependencies,
} from "../../src/domain/configuration/config-snapshot.js";
import type { PathInstruction } from "../../src/domain/configuration/path-instruction.js";
import type { GlobPattern } from "../../src/domain/configuration/glob.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import { canonicalJson } from "../../src/domain/primitives/canonical-json.js";
import type {
  RepositoryId,
  ReviewConfigSnapshotId,
} from "../../src/domain/identity/ids.js";
import type { ContentHasher } from "../../src/domain/ports/content-hasher.js";
import type { Clock } from "../../src/domain/ports/clock.js";
import type { IdGenerator } from "../../src/domain/ports/id-generator.js";
import type { Checksum } from "../../src/domain/primitives/checksum.js";

const repositoryId = unsafeBrand<RepositoryId>(
  "0192f8a1-0000-7000-8000-000000000001",
);

/**
 * A deterministic stand-in for a real digest.
 *
 * Not a cryptographic hash and not pretending to be one — these tests are
 * about *what gets hashed*, and a real SHA-256 would only obscure whether two
 * inputs canonicalized to the same bytes.
 */
const testHasher: ContentHasher = {
  algorithm: "sha256",
  hash(data): Checksum {
    const text =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    let accumulator = 0n;
    for (const codeUnit of text) {
      accumulator =
        (accumulator * 31n + BigInt(codeUnit.codePointAt(0) ?? 0)) %
        (1n << 256n);
    }
    return {
      algorithm: "sha256",
      value: accumulator.toString(16).padStart(64, "0").slice(0, 64),
    };
  },
};

const fixedClock: Clock = { now: () => timestamp("2026-08-16T10:00:00.000Z") };

const stubIds: IdGenerator<ReviewConfigSnapshotId> = {
  next: () =>
    unsafeBrand<ReviewConfigSnapshotId>("0192f8a1-0000-7000-8000-0000000000c7"),
};

const dependencies: ConfigSnapshotDependencies = {
  clock: fixedClock,
  ids: stubIds,
  hasher: testHasher,
};

const base = (
  overrides: Partial<ConfigResolutionInput> = {},
): ConfigResolutionInput => ({
  allowRequestOverrides: false,
  ...overrides,
});

describe("ReviewConfig resolution (P0.txt §109)", () => {
  it("applies the layers in the documented order", () => {
    expect([...CONFIG_LAYERS]).toEqual([
      "platform_default",
      "organization",
      "repository",
      "request_override",
    ]);
  });

  it("returns the platform defaults when nothing is configured", () => {
    const { config, layers } = resolveReviewConfig(base());

    expect(config).toEqual(PLATFORM_DEFAULT_REVIEW_CONFIG);
    expect(layers).toEqual(["platform_default"]);
  });

  it("produces a config that validates against its own schema", () => {
    // A resolver that emits something its schema rejects is the same class of
    // defect as a schema that does not match its interface.
    expect(
      reviewConfigSchema.safeParse(resolveReviewConfig(base()).config).success,
    ).toBe(true);
  });

  it("has no optional fields: every value comes from some layer", () => {
    const { config } = resolveReviewConfig(base());
    const flatten = (value: unknown): readonly unknown[] =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.values(value).flatMap(flatten)
        : [value];

    expect(flatten(config)).not.toContain(undefined);
  });

  describe("scalars replace, narrowest layer winning", () => {
    it("lets a repository override its organization", () => {
      const organization: ReviewConfigOverlay = {
        review: { depth: "minimal" },
      };
      const repository: ReviewConfigOverlay = { review: { depth: "thorough" } };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.review
          .depth,
      ).toBe("thorough");
    });

    it("falls through to the organization when the repository is silent", () => {
      const organization: ReviewConfigOverlay = {
        review: { depth: "minimal" },
      };
      const repository: ReviewConfigOverlay = {
        review: { reviewDrafts: true },
      };

      const { config } = resolveReviewConfig(
        base({ organization, repository }),
      );
      expect(config.review.depth).toBe("minimal");
      expect(config.review.reviewDrafts).toBe(true);
    });

    it("treats an explicit false as a value, not as absence", () => {
      // The bug `??` and truthiness checks both produce: a repository turning
      // something off would be read as not having said anything.
      const repository: ReviewConfigOverlay = {
        publication: { postSummary: false },
      };

      expect(
        resolveReviewConfig(base({ repository })).config.publication
          .postSummary,
      ).toBe(false);
    });
  });

  describe("tool policy: a ban only ever grows", () => {
    const semgrep = namespacedId("tool.semgrep");
    const eslint = namespacedId("tool.eslint");

    it("unions denied across layers", () => {
      const organization: ReviewConfigOverlay = {
        tools: { denied: [semgrep] },
      };
      const repository: ReviewConfigOverlay = { tools: { denied: [eslint] } };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.tools
          .denied,
      ).toEqual([eslint, semgrep]);
    });

    it("does not let a repository un-deny what its organization forbade", () => {
      // The escalation the union rule exists to prevent: under "replace", a
      // repository could re-enable a forbidden tool by simply not listing it.
      const organization: ReviewConfigOverlay = {
        tools: { denied: [semgrep] },
      };
      const repository: ReviewConfigOverlay = { tools: { denied: [] } };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.tools
          .denied,
      ).toContain(semgrep);
    });

    it("replaces allowed, because a repository picks from what it is offered", () => {
      const organization: ReviewConfigOverlay = {
        tools: { allowed: [semgrep, eslint] },
      };
      const repository: ReviewConfigOverlay = { tools: { allowed: [eslint] } };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.tools
          .allowed,
      ).toEqual([eslint]);
    });

    it("sorts id sets, so the canonical form does not depend on who spoke first", () => {
      const forward = resolveReviewConfig(
        base({
          organization: { tools: { denied: [semgrep] } },
          repository: { tools: { denied: [eslint] } },
        }),
      );
      const reverse = resolveReviewConfig(
        base({
          organization: { tools: { denied: [eslint] } },
          repository: { tools: { denied: [semgrep] } },
        }),
      );

      expect(forward.config.tools.denied).toEqual(reverse.config.tools.denied);
    });
  });

  describe("data egress tightens, never widens", () => {
    it("lets a repository turn external sources off", () => {
      const organization: ReviewConfigOverlay = {
        knowledge: { useExternalSources: true },
      };
      const repository: ReviewConfigOverlay = {
        knowledge: { useExternalSources: false },
      };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.knowledge
          .useExternalSources,
      ).toBe(false);
    });

    it("does not let a repository turn them on against its organization", () => {
      // §26: sending a change's context outside the tenant is an
      // organization's decision, and a repository must not make it.
      const organization: ReviewConfigOverlay = {
        knowledge: { useExternalSources: false },
      };
      const repository: ReviewConfigOverlay = {
        knowledge: { useExternalSources: true },
      };

      expect(
        resolveReviewConfig(base({ organization, repository })).config.knowledge
          .useExternalSources,
      ).toBe(false);
    });

    it("is off by default", () => {
      expect(
        resolveReviewConfig(base()).config.knowledge.useExternalSources,
      ).toBe(false);
    });
  });

  describe("pre-merge policy accumulates", () => {
    const title = namespacedId("acalys.premerge.title");
    const description = namespacedId("acalys.premerge.description");

    it("unions checks and blocking checks", () => {
      const { config } = resolveReviewConfig(
        base({
          organization: {
            premerge: { checks: [title], blockingChecks: [title] },
          },
          repository: { premerge: { checks: [description] } },
        }),
      );

      expect(config.premerge.checks).toEqual([description, title]);
      expect(config.premerge.blockingChecks).toEqual([title]);
    });
  });

  describe("path instructions concatenate", () => {
    const instruction = (id: string, glob: string): PathInstruction => ({
      id: namespacedId(id),
      glob: unsafeBrand<GlobPattern>(glob),
      instructions: "…",
      priority: 0,
    });

    it("keeps both levels, organization first", () => {
      const { config } = resolveReviewConfig(
        base({
          organization: { paths: [instruction("org.a", "**")] },
          repository: { paths: [instruction("repo.a", "src/*.ts")] },
        }),
      );

      expect(config.paths.map((path) => path.id)).toEqual(["org.a", "repo.a"]);
    });
  });

  describe("request overrides", () => {
    it("are ignored unless explicitly allowed", () => {
      const { config, layers, requestOverridesRejected } = resolveReviewConfig({
        allowRequestOverrides: false,
        requestOverrides: { depth: "thorough" },
      });

      expect(config.review.depth).toBe("standard");
      expect(layers).not.toContain("request_override");
      expect(requestOverridesRejected).toBe(true);
    });

    it("distinguish 'suppressed by policy' from 'none supplied'", () => {
      // A requester who asked for a thorough review and did not get one should
      // be told why, rather than filing a bug against the reviewer.
      expect(resolveReviewConfig(base()).requestOverridesRejected).toBe(false);
      expect(
        resolveReviewConfig({
          allowRequestOverrides: true,
          requestOverrides: { depth: "thorough" },
        }).requestOverridesRejected,
      ).toBe(false);
    });

    it("apply when allowed", () => {
      const { config, layers } = resolveReviewConfig({
        allowRequestOverrides: true,
        requestOverrides: { depth: "thorough", reviewDrafts: true },
      });

      expect(config.review.depth).toBe("thorough");
      expect(config.review.reviewDrafts).toBe(true);
      expect(layers).toEqual(["platform_default", "request_override"]);
    });

    it("narrow categories but cannot widen them", () => {
      // A request asking for a category the organization disabled must not
      // re-enable it — the allow-list is a boundary, not a suggestion.
      const { config } = resolveReviewConfig({
        allowRequestOverrides: true,
        organization: { review: { categories: ["maintainability"] } },
        requestOverrides: { categories: ["security", "maintainability"] },
      });

      expect(config.review.categories).toEqual(["maintainability"]);
    });

    it("emit categories in canonical order regardless of how they were listed", () => {
      const forward = resolveReviewConfig({
        allowRequestOverrides: true,
        requestOverrides: { categories: ["maintainability", "security"] },
      });
      const reverse = resolveReviewConfig({
        allowRequestOverrides: true,
        requestOverrides: { categories: ["security", "maintainability"] },
      });

      expect(forward.config.review.categories).toEqual(
        reverse.config.review.categories,
      );
    });
  });

  describe("determinism (§58)", () => {
    const input = base({
      organization: {
        review: { depth: "thorough", categories: ["security", "performance"] },
        tools: { denied: [namespacedId("tool.semgrep")] },
      },
      repository: {
        publication: { minSeverityToPublish: "high" },
        premerge: { checks: [namespacedId("acalys.premerge.title")] },
      },
    });

    it("produces a byte-identical config 1000 times", () => {
      const expected = canonicalJson(resolveReviewConfig(input).config);

      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        expect(canonicalJson(resolveReviewConfig(input).config)).toBe(expected);
      }
    });

    it("produces the same digest regardless of key order in the source", () => {
      // The reason `canonicalJson` exists: a YAML or JSON parser is free to
      // emit keys in any order, and two workers must still agree.
      const forward = configSourceHash(
        base({
          organization: { review: { depth: "thorough", reviewDrafts: true } },
        }),
        testHasher,
      );
      const reverse = configSourceHash(
        base({
          organization: { review: { reviewDrafts: true, depth: "thorough" } },
        }),
        testHasher,
      );

      expect(forward).toEqual(reverse);
    });

    it("changes the digest when an input changes", () => {
      const before = configSourceHash(input, testHasher);
      const after = configSourceHash(
        base({
          ...input,
          repository: { publication: { minSeverityToPublish: "low" } },
        }),
        testHasher,
      );

      expect(after).not.toEqual(before);
    });

    it("ignores overrides in the digest when they were not applied", () => {
      // The digest describes what actually resolved. A suppressed override did
      // not contribute to the config, so it must not change its identity.
      const withSuppressed = configSourceHash(
        {
          allowRequestOverrides: false,
          requestOverrides: { depth: "thorough" },
        },
        testHasher,
      );
      const without = configSourceHash(
        { allowRequestOverrides: false },
        testHasher,
      );

      expect(withSuppressed).toEqual(without);
    });
  });

  describe("platform defaults are immutable", () => {
    it("cannot be widened at runtime", () => {
      // A module-level singleton every resolution starts from: one mutation
      // would change the defaults for every tenant in the process, and the
      // symptom would surface somewhere else entirely.
      expect(Object.isFrozen(PLATFORM_DEFAULT_REVIEW_CONFIG)).toBe(true);
      expect(Object.isFrozen(PLATFORM_DEFAULT_REVIEW_CONFIG.review)).toBe(true);
      expect(
        Object.isFrozen(PLATFORM_DEFAULT_REVIEW_CONFIG.review.categories),
      ).toBe(true);
      expect(() => {
        (PLATFORM_DEFAULT_REVIEW_CONFIG.review.categories as string[]).push(
          "x",
        );
      }).toThrow(TypeError);
    });
  });
});

describe("ReviewConfigSnapshot (P0.txt §39)", () => {
  it("pins the resolved config by value", () => {
    const snapshot = createConfigSnapshot(
      repositoryId,
      base({ organization: { review: { depth: "thorough" } } }),
      dependencies,
    );

    expect(snapshot.config.review.depth).toBe("thorough");
    expect(snapshot.repositoryId).toBe(repositoryId);
    expect(snapshot.layers).toEqual(["platform_default", "organization"]);
  });

  it("cannot be mutated after a run starts (§109)", () => {
    const snapshot = createConfigSnapshot(repositoryId, base(), dependencies);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(() => {
      (snapshot.config.review as { depth: string }).depth = "minimal";
    }).toThrow(TypeError);
  });

  it("carries the algorithm with the digest", () => {
    // §39 types `sourceHash` as a bare string; a Checksum keeps the digest
    // interpretable the day the platform changes hashers.
    const snapshot = createConfigSnapshot(repositoryId, base(), dependencies);
    expect(snapshot.sourceHash.algorithm).toBe("sha256");
  });

  it("gives two snapshots of the same inputs the same source hash", () => {
    const input = base({ repository: { review: { depth: "minimal" } } });
    const left = createConfigSnapshot(repositoryId, input, dependencies);
    const right = createConfigSnapshot(repositoryId, input, dependencies);

    expect(snapshotsShareSource(left, right)).toBe(true);
  });

  it("distinguishes different inputs that happen to resolve alike", () => {
    // An organization setting a value the repository would have defaulted to
    // anyway: equal configs, different documents. Reproducibility asks about
    // the inputs.
    const explicit = createConfigSnapshot(
      repositoryId,
      base({ organization: { review: { depth: "standard" } } }),
      dependencies,
    );
    const implicit = createConfigSnapshot(repositoryId, base(), dependencies);

    expect(explicit.config).toEqual(implicit.config);
    expect(snapshotsShareSource(explicit, implicit)).toBe(false);
  });
});
