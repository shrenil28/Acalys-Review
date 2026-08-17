import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  pullRequestRevisionSchema,
  pullRequestSchema,
  reviewTargetSchema,
  unsafeBrand,
  type OrganizationId,
  type PullRequestId,
  type PullRequestRevisionId,
  type RepositoryId,
} from "@acalys/contracts/domain";
import { timestamp } from "@acalys/contracts/domain";

import {
  NormalizationError,
  githubPullRequestEventSchema,
  isHandledAction,
  revisionTriggerFor,
  toActor,
  toPullRequest,
  toReviewTarget,
  toRevision,
  type GithubPullRequestEvent,
  type ResolvedIdentity,
} from "../src/index.js";

const raw = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/pull-request-opened.json", import.meta.url),
    ),
    "utf8",
  ),
) as unknown;

const identity: ResolvedIdentity = {
  organizationId: unsafeBrand<OrganizationId>(
    "0192f8a1-0000-7000-8000-000000000001",
  ),
  repositoryId: unsafeBrand<RepositoryId>(
    "0192f8a1-0000-7000-8000-000000000002",
  ),
};
const pullRequestId = unsafeBrand<PullRequestId>(
  "0192f8a1-0000-7000-8000-000000000004",
);
const revisionId = unsafeBrand<PullRequestRevisionId>(
  "0192f8a1-0000-7000-8000-000000000006",
);
const at = timestamp("2026-08-16T10:00:00.000Z");

/** Parses the fixture, optionally with an override applied first. */
function event(
  mutate?: (payload: Record<string, unknown>) => void,
): GithubPullRequestEvent {
  const clone = structuredClone(raw) as Record<string, unknown>;
  mutate?.(clone);
  return githubPullRequestEventSchema.parse(clone);
}

describe("Payload validation (§129: external data enters through unknown)", () => {
  it("accepts a real GitHub delivery", () => {
    expect(githubPullRequestEventSchema.safeParse(raw).success).toBe(true);
  });

  it("keeps only the fields Acalys reads", () => {
    // The fixture's pull_request has 28 fields; the schema strips it to the
    // handful the platform consumes. Everything dropped here is a field that
    // can never leak into the domain.
    const parsed = event();
    const source = (raw as { pull_request: Record<string, unknown> })
      .pull_request;

    expect(Object.keys(source).length).toBeGreaterThan(20);
    expect(Object.keys(parsed.pull_request).length).toBeLessThan(
      Object.keys(source).length,
    );
    for (const dropped of [
      "node_id",
      "html_url",
      "diff_url",
      "mergeable_state",
    ]) {
      expect(Object.keys(parsed.pull_request)).not.toContain(dropped);
    }
  });

  it("tolerates GitHub adding fields", () => {
    // Rejecting unknown keys here would take the platform down whenever GitHub
    // ships a feature. This is the deliberate inversion of the domain layer's
    // strictness.
    expect(
      githubPullRequestEventSchema.safeParse({
        ...(raw as object),
        brand_new_field_2027: { nested: true },
      }).success,
    ).toBe(true);
  });

  describe("rejects malformed input that a type alone would admit", () => {
    it("a truncated commit sha", () => {
      expect(() =>
        event((payload) => {
          (payload["pull_request"] as { head: { sha: string } }).head.sha =
            "9f8e7d6";
        }),
      ).toThrow();
    });

    it("a non-hex commit sha", () => {
      expect(() =>
        event((payload) => {
          (payload["pull_request"] as { head: { sha: string } }).head.sha =
            "z".repeat(40);
        }),
      ).toThrow();
    });

    it("an id beyond safe integer precision", () => {
      // Past 2^53 the JSON parse silently rounds, and two distinct GitHub
      // objects collapse to one id.
      expect(() =>
        event((payload) => {
          (payload["pull_request"] as { id: number }).id = 2 ** 53 + 1;
        }),
      ).toThrow();
    });

    it("a missing base ref", () => {
      expect(() =>
        event((payload) => {
          delete (payload["pull_request"] as Record<string, unknown>)["base"];
        }),
      ).toThrow();
    });

    it("an unbounded body", () => {
      expect(() =>
        event((payload) => {
          (payload["pull_request"] as { body: string }).body = "x".repeat(
            300_000,
          );
        }),
      ).toThrow();
    });
  });

  it("accepts a fork whose source repository was deleted", () => {
    // head.repo is null on those, and the PR is still open and reviewable.
    // Code assuming head.repo.id crashes on a delivery that arrives rarely
    // enough to reach production.
    const parsed = event((payload) => {
      (payload["pull_request"] as { head: { repo: unknown } }).head.repo = null;
    });
    expect(parsed.pull_request.head.sha).toHaveLength(40);
  });

  it("accepts a pull request whose author deleted their account", () => {
    const parsed = event((payload) => {
      (payload["pull_request"] as { user: unknown }).user = null;
    });
    expect(parsed.pull_request.user).toBeNull();
  });
});

describe("Normalization to canonical contracts (§1, §133)", () => {
  it("produces a ReviewTarget that validates against the domain schema", () => {
    // The §133 definition of done, executed: GitHub payload → ReviewTarget
    // with no contract change.
    const target = toReviewTarget(event(), identity);
    expect(reviewTargetSchema.safeParse(target).success).toBe(true);
  });

  it("produces a PullRequest that validates", () => {
    const pull = toPullRequest(event(), identity, pullRequestId);
    expect(pullRequestSchema.safeParse(pull).success).toBe(true);
  });

  it("produces a Revision that validates", () => {
    const revision = toRevision(
      event(),
      identity,
      pullRequestId,
      revisionId,
      1,
      at,
    );
    expect(pullRequestRevisionSchema.safeParse(revision).success).toBe(true);
  });

  it("carries no GitHub-specific field into the domain", () => {
    const target = toReviewTarget(event(), identity);
    const serialized = JSON.stringify(target);

    for (const leak of [
      "node_id",
      "html_url",
      "diff_url",
      "mergeable_state",
      "merge_commit_sha",
      "author_association",
      "requested_reviewers",
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  it("keys on the immutable id, never the number or the path", () => {
    // `#412` is unique per repository at best; `acalys/acalys` changes on
    // rename or transfer. Neither is identity.
    const target = toReviewTarget(event(), identity);

    expect(target.changeRequest.externalId).toBe("2145998877");
    expect(target.changeRequest.number).toBe(412);
    expect(JSON.stringify(target)).not.toContain("acalys/acalys");
  });

  it("normalizes GitHub's second-precision timestamps", () => {
    // GitHub sends `2026-08-16T09:58:11Z`; Timestamp requires exactly three
    // fractional digits (§6).
    const pull = toPullRequest(event(), identity, pullRequestId);
    expect(pull.createdAt).toBe("2026-08-16T09:58:11.000Z");
  });

  describe("rejects a timestamp that is well-formed and does not exist", () => {
    // `new Date()` range-checks the day syntactically but not against the
    // month's length, so these silently roll over into the next month rather
    // than failing — recording an instant GitHub never sent, in a field that
    // orders revisions.
    const rollovers = [
      "2026-02-30T10:00:00Z",
      "2026-02-29T10:00:00Z",
      "2026-04-31T10:00:00Z",
      "2026-06-31T10:00:00Z",
      "2026-09-31T10:00:00Z",
      "2026-11-31T10:00:00Z",
    ];

    it.each(rollovers)("%s", (created) => {
      // Proves the danger is real before proving we catch it: bare parsing
      // yields a *different, valid* date rather than an error.
      const rolled = new Date(created);
      expect(Number.isNaN(rolled.getTime())).toBe(false);
      expect(rolled.toISOString().slice(0, 10)).not.toBe(created.slice(0, 10));

      expect(() =>
        toPullRequest(
          event((payload) => {
            (payload["pull_request"] as { created_at: string }).created_at =
              created;
          }),
          identity,
          pullRequestId,
        ),
      ).toThrow(NormalizationError);
    });

    it("accepts a real leap day", () => {
      // The check must reject impossible dates without rejecting rare ones.
      const pull = toPullRequest(
        event((payload) => {
          (payload["pull_request"] as { created_at: string }).created_at =
            "2028-02-29T10:00:00Z";
        }),
        identity,
        pullRequestId,
      );
      expect(pull.createdAt).toBe("2028-02-29T10:00:00.000Z");
    });

    it("rejects a non-UTC or malformed timestamp", () => {
      // GitHub always sends UTC on these fields. An offset would parse to a
      // correct instant but a different wall-clock reading, and accepting one
      // invites a provider that sends local time to be silently mis-recorded.
      for (const bad of [
        "2026-08-16T09:58:11+05:30",
        "2026-08-16 09:58:11Z",
        "16/08/2026",
      ]) {
        expect(
          () =>
            toPullRequest(
              event((payload) => {
                (payload["pull_request"] as { created_at: string }).created_at =
                  bad;
              }),
              identity,
              pullRequestId,
            ),
          bad,
        ).toThrow(NormalizationError);
      }
    });

    it("rejects an empty timestamp one layer earlier, at the payload schema", () => {
      // Defence in depth: normalization never sees it, because the payload
      // schema requires a non-empty string. Asserted so a future loosening of
      // the schema does not silently move the only guard.
      expect(() =>
        event((payload) => {
          (payload["pull_request"] as { created_at: string }).created_at = "";
        }),
      ).toThrow();
    });

    it("accepts milliseconds when GitHub sends them", () => {
      const pull = toPullRequest(
        event((payload) => {
          (payload["pull_request"] as { created_at: string }).created_at =
            "2026-08-16T09:58:11.250Z";
        }),
        identity,
        pullRequestId,
      );
      expect(pull.createdAt).toBe("2026-08-16T09:58:11.250Z");
    });
  });

  it("detects the object id algorithm from its length", () => {
    const sha1 = toReviewTarget(event(), identity);
    expect(sha1.head.objectId.algorithm).toBe("sha1");

    const sha256 = toReviewTarget(
      event((payload) => {
        (payload["pull_request"] as { head: { sha: string } }).head.sha =
          "a".repeat(64);
      }),
      identity,
    );
    expect(sha256.head.objectId.algorithm).toBe("sha256");
  });

  it("omits mergeBase rather than using GitHub's test merge commit", () => {
    // `merge_commit_sha` is a commit that exists in neither branch and is null
    // while GitHub computes it. Using it as the diff base attributes the base
    // branch's own commits to this change's author.
    const target = toReviewTarget(event(), identity);
    const revision = toRevision(
      event(),
      identity,
      pullRequestId,
      revisionId,
      1,
      at,
    );

    expect(target.mergeBase).toBeUndefined();
    expect(revision.mergeBase).toBeUndefined();
    expect(JSON.stringify(revision)).not.toContain("cafebabe");
  });

  describe("state", () => {
    it("distinguishes merged from closed, which GitHub's own state does not", () => {
      const closed = toPullRequest(
        event((payload) => {
          (payload["pull_request"] as { state: string }).state = "closed";
        }),
        identity,
        pullRequestId,
      );
      const merged = toPullRequest(
        event((payload) => {
          const pull = payload["pull_request"] as Record<string, unknown>;
          pull["state"] = "closed";
          pull["merged"] = true;
          pull["merged_at"] = "2026-08-16T11:00:00Z";
        }),
        identity,
        pullRequestId,
      );

      expect(closed.state).toBe("closed");
      expect(merged.state).toBe("merged");
    });
  });

  describe("actors", () => {
    it("maps a GitHub account to a human actor with a provider reference", () => {
      const actor = toActor({ id: 58412990, login: "shrenil28", type: "User" });
      expect(actor).toEqual({
        kind: "human",
        provider: {
          kind: "user",
          provider: "github",
          externalId: "58412990",
          handle: "shrenil28",
        },
        displayName: "shrenil28",
      });
    });

    it("treats a bot as human, not system", () => {
      // `system` means an Acalys component acted. Marking Dependabot as system
      // would make its pull requests look like the platform opened them.
      const actor = toActor({
        id: 49699333,
        login: "dependabot[bot]",
        type: "Bot",
      });
      expect(actor.kind).toBe("human");
    });

    it("records a deleted account without fabricating identity", () => {
      expect(toActor(null)).toEqual({ kind: "human" });
      expect(toActor(undefined)).toEqual({ kind: "human" });
    });

    it("handles an account with no login", () => {
      const actor = toActor({ id: 1, login: null });
      expect(actor).toEqual({
        kind: "human",
        provider: { kind: "user", provider: "github", externalId: "1" },
      });
    });
  });

  describe("revision triggers", () => {
    const cases: readonly (readonly [string, string | undefined])[] = [
      ["opened", "opened"],
      ["synchronize", "push"],
      ["reopened", "reopened"],
      ["ready_for_review", "manual_refresh"],
      ["closed", undefined],
      ["labeled", undefined],
      ["assigned", undefined],
      ["review_requested", undefined],
      ["some_action_github_adds_in_2027", undefined],
    ];

    it.each(cases)("%s → %s", (action, expected) => {
      const trigger = revisionTriggerFor(
        event((payload) => {
          payload["action"] = action;
        }),
      );
      expect(trigger).toBe(expected);
    });

    it("treats an edited base branch as a revision", () => {
      const trigger = revisionTriggerFor(
        event((payload) => {
          payload["action"] = "edited";
          payload["changes"] = { base: { ref: { from: "develop" } } };
        }),
      );
      expect(trigger).toBe("base_changed");
    });

    it("does not treat a retitle as a revision", () => {
      // Otherwise every typo fix in the description triggers a full re-review:
      // real cost, real noise, and a reviewer users learn to ignore.
      const trigger = revisionTriggerFor(
        event((payload) => {
          payload["action"] = "edited";
          payload["changes"] = { title: { from: "Old title" } };
        }),
      );
      expect(trigger).toBeUndefined();
    });

    it("refuses to build a revision for an action that changes no code", () => {
      expect(() =>
        toRevision(
          event((payload) => {
            payload["action"] = "closed";
          }),
          identity,
          pullRequestId,
          revisionId,
          1,
          at,
        ),
      ).toThrow(NormalizationError);
    });

    it("rejects a non-positive sequence", () => {
      // Sequence is 1-based and dense; 0 would break `unique (pull_request_id,
      // sequence)` semantics on the first insert.
      for (const sequence of [0, -1, 1.5]) {
        expect(() =>
          toRevision(
            event(),
            identity,
            pullRequestId,
            revisionId,
            sequence,
            at,
          ),
        ).toThrow(NormalizationError);
      }
    });
  });

  it("recognizes exactly the handled actions", () => {
    expect(isHandledAction("opened")).toBe(true);
    expect(isHandledAction("synchronize")).toBe(true);
    expect(isHandledAction("labeled")).toBe(false);
    expect(isHandledAction("")).toBe(false);
  });

  it("is a pure function: the same payload normalizes identically every time", () => {
    // No clock, no store, no I/O. This is what makes the adapter exhaustively
    // testable from fixtures and safe to run on any worker.
    const first = JSON.stringify(toReviewTarget(event(), identity));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(JSON.stringify(toReviewTarget(event(), identity))).toBe(first);
    }
  });
});
