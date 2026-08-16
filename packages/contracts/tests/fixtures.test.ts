import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  candidateFindingSchema,
  changeManifestSchema,
  evidenceSchema,
  reviewConfigSnapshotSchema,
  reviewFindingSchema,
  reviewRequestSchema,
  reviewRunSchema,
  reviewTargetSchema,
  canonicalJson,
  type PullRequestReviewTarget,
  type ReviewTarget,
} from "../src/domain/index.js";
import { anyDomainEventSchema } from "../src/internal/index.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(
    new URL(`./fixtures/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Every fixture §83 asks for, with the schema that must accept it.
 *
 * The list is what makes this test meaningful: a fixture directory nobody
 * validates is documentation that quietly goes stale, and §83's requirement is
 * specifically that "fixtures must be validated in tests".
 */
const FIXTURES: readonly (readonly [string, z.ZodType])[] = [
  ["github-pr-review-target", reviewTargetSchema],
  ["gitlab-mr-review-target", reviewTargetSchema],
  ["local-working-tree-target", reviewTargetSchema],
  ["review-request", reviewRequestSchema],
  ["review-run", reviewRunSchema],
  ["change-manifest", changeManifestSchema],
  ["candidate-finding", candidateFindingSchema],
  ["verified-finding", reviewFindingSchema],
  ["static-analysis-evidence", evidenceSchema],
  ["runtime-evidence", evidenceSchema],
  ["config-snapshot", reviewConfigSnapshotSchema],
  ["domain-event", anyDomainEventSchema],
];

describe("Canonical fixtures (P0.txt §83)", () => {
  it.each(FIXTURES)("%s validates", (name, schema) => {
    const result = schema.safeParse(fixture(name));
    if (!result.success) {
      throw new Error(
        `${name}.json does not validate:\n${result.error.issues
          .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
          .join("\n")}`,
      );
    }
  });

  it.each(FIXTURES)(
    "%s round-trips through JSON without loss",
    (name, schema) => {
      // The property every durable contract needs and none of the schema tests
      // prove on their own: a value that survives parse → serialize → parse is
      // one that can be stored, queued, and replayed. A transform that dropped a
      // field, or a schema that accepted something it could not re-emit, would
      // show up here and nowhere else.
      const first = schema.parse(fixture(name));
      const second = schema.parse(JSON.parse(JSON.stringify(first)) as unknown);

      expect(second).toEqual(first);
      expect(canonicalJson(second)).toBe(canonicalJson(first));
    },
  );

  it.each(FIXTURES)(
    "%s is rejected once a required field is removed",
    (name, schema) => {
      // Guards against a schema so permissive that validation proves nothing.
      // Without it, replacing every field with `z.unknown()` would keep this
      // whole suite green.
      const value = fixture(name) as Record<string, unknown>;
      const keys = Object.keys(value);
      const failures = keys.filter((key) => {
        const withoutKey = { ...value };
        delete withoutKey[key];
        return !schema.safeParse(withoutKey).success;
      });

      expect(
        failures.length,
        `${name} has no required top-level field`,
      ).toBeGreaterThan(0);
    },
  );
});

/**
 * The proof that §1's boundary holds.
 *
 * §1 requires provider-specific structure to terminate at the adapter. The
 * only convincing demonstration is two genuinely different providers producing
 * the *same* domain object — so these two fixtures describe one change, on one
 * repository, at one pair of commits, as GitHub and GitLab each report it.
 *
 * They differ only where they must:
 *
 *     GitHub   externalId "2145998877"
 *     GitLab   externalId "gid://gitlab/MergeRequest/774411"
 *
 * Everything else — base, head, mergeBase, title, draft, the shape itself — is
 * identical. If a provider concept had leaked into the canonical type, these
 * two would not be able to agree, and the assertion below would be impossible
 * to write.
 */
describe("Provider normalization (P0.txt §1)", () => {
  /** Narrows a parsed target, so a wrong fixture fails here rather than later. */
  function asPullRequestTarget(target: ReviewTarget): PullRequestReviewTarget {
    if (target.kind !== "pull_request") {
      throw new Error(`expected a pull-request target, got '${target.kind}'`);
    }
    return target;
  }

  /** Fields that legitimately identify the provider, and nothing else. */
  function stripProviderIdentity(parsed: ReviewTarget): unknown {
    const target = asPullRequestTarget(parsed);
    // Destructured out, not read: removing the two provider-identity fields is
    // the point of this function.
    const { provider: _provider, changeRequest, author, ...rest } = target;
    return {
      ...rest,
      // The provider's own id and numbering scheme are the two things that
      // cannot be shared; `number` survives because it is the same human-facing
      // 412 on both.
      changeRequest: { kind: changeRequest.kind, number: changeRequest.number },
      // Only the human-facing name survives: the provider's user id and handle
      // are provider identity, exactly like the change request's externalId.
      author: {
        kind: author.kind,
        displayName: author.kind === "human" ? author.displayName : undefined,
      },
    };
  }

  it("normalizes a GitHub PR and a GitLab MR to the same domain structure", () => {
    const github = reviewTargetSchema.parse(fixture("github-pr-review-target"));
    const gitlab = reviewTargetSchema.parse(fixture("gitlab-mr-review-target"));

    expect(stripProviderIdentity(gitlab)).toEqual(
      stripProviderIdentity(github),
    );
  });

  it("keeps the provider distinguishable where it must be", () => {
    // The complement of the assertion above: normalization must not erase
    // *which* provider a target came from, or publication could not route.
    const github = reviewTargetSchema.parse(fixture("github-pr-review-target"));
    const gitlab = reviewTargetSchema.parse(fixture("gitlab-mr-review-target"));

    expect(asPullRequestTarget(github).provider).toBe("github");
    expect(asPullRequestTarget(gitlab).provider).toBe("gitlab");
    expect(github).not.toEqual(gitlab);
  });

  it("carries no provider-specific field on the canonical type", () => {
    // A `merge_request_iid`, a `node_id`, or a `pull_request` sub-object would
    // all pass a looser schema. `strictObject` rejects them, and this states
    // which names were considered.
    const github = fixture("github-pr-review-target") as Record<
      string,
      unknown
    >;

    for (const leak of [
      { node_id: "PR_kwDOABCD" },
      { merge_request_iid: 412 },
      { html_url: "https://github.com/acalys/acalys/pull/412" },
      { squash: true },
    ]) {
      expect(
        reviewTargetSchema.safeParse({ ...github, ...leak }).success,
        Object.keys(leak)[0],
      ).toBe(false);
    }
  });

  it("represents a local working tree with no provider at all (§112)", () => {
    // The other half of provider neutrality: a target that has no provider,
    // no change request, and nowhere to post a comment must still be a
    // first-class review target.
    const local = reviewTargetSchema.parse(
      fixture("local-working-tree-target"),
    );

    expect(local.kind).toBe("working_tree");
    expect(Object.keys(local)).not.toContain("provider");
    expect(Object.keys(local)).not.toContain("changeRequest");
  });
});
