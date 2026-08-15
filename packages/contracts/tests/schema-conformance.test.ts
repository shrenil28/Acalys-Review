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
