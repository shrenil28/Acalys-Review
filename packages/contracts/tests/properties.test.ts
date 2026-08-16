import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  FINDING_LIFECYCLE_STATES,
  allowedFindingTransitionsFrom,
  assertValidFindingTransition,
  canTransitionFinding,
  isTerminalFindingLifecycleState,
  type FindingLifecycleState,
} from "../src/domain/finding/finding-lifecycle.js";
import {
  REVIEW_RUN_STATES,
  allowedTransitionsFrom,
  assertValidReviewRunTransition,
  canTransition,
  isTerminalReviewRunState,
  type ReviewRunState,
} from "../src/domain/review/review-run-state.js";
import {
  FINDING_SEVERITIES,
  compareSeverity,
  confidenceLevelForScore,
  findingConfidence,
  highestSeverity,
} from "../src/domain/finding/taxonomy.js";
import {
  EVIDENCE_STRENGTHS,
  compareEvidenceStrength,
  strongestEvidence,
} from "../src/domain/evidence/evidence.js";
import {
  FINDING_FINGERPRINT_VERSION,
  fingerprintCanonicalInput,
} from "../src/domain/finding/fingerprint.js";
import { canonicalJson } from "../src/domain/primitives/canonical-json.js";
import { unsafeBrand } from "../src/domain/primitives/brand.js";
import { namespacedId } from "../src/domain/primitives/namespaced-id.js";
import { repositoryPath } from "../src/domain/primitives/repository-path.js";
import { matchesGlob } from "../src/domain/configuration/glob.js";
import type { RepositoryId } from "../src/domain/identity/ids.js";

const runState = fc.constantFrom(...REVIEW_RUN_STATES);
const findingState = fc.constantFrom(...FINDING_LIFECYCLE_STATES);
const severity = fc.constantFrom(...FINDING_SEVERITIES);
const strength = fc.constantFrom(...EVIDENCE_STRENGTHS);

/**
 * Properties that must hold across *every* input, not only the ones a
 * table-driven test happened to enumerate.
 *
 * The existing suites check specific transitions and specific values; these
 * check the structural claims those tables rest on. A state machine can have
 * every listed transition correct and still be broken — a terminal state with
 * an outgoing edge, or a comparator that is not a total order — and only a
 * property test finds that.
 */
describe("State machines are structurally sound", () => {
  it("agrees with itself: canTransition matches the allowed set", () => {
    // Two ways to ask the same question. If they can disagree, one of them is
    // lying to whichever caller happens to use it.
    fc.assert(
      fc.property(runState, runState, (from, to) => {
        expect(canTransition(from, to)).toBe(
          allowedTransitionsFrom(from).includes(to),
        );
      }),
    );
    fc.assert(
      fc.property(findingState, findingState, (from, to) => {
        expect(canTransitionFinding(from, to)).toBe(
          allowedFindingTransitionsFrom(from).includes(to),
        );
      }),
    );
  });

  it("never leaves a terminal state", () => {
    // The property that makes "terminal" mean anything. A single stray edge
    // out of `completed` would let a finished run silently resume.
    for (const state of REVIEW_RUN_STATES) {
      if (isTerminalReviewRunState(state)) {
        expect(allowedTransitionsFrom(state), state).toEqual([]);
      } else {
        expect(allowedTransitionsFrom(state).length, state).toBeGreaterThan(0);
      }
    }
    for (const state of FINDING_LIFECYCLE_STATES) {
      if (isTerminalFindingLifecycleState(state)) {
        expect(allowedFindingTransitionsFrom(state), state).toEqual([]);
      } else {
        expect(
          allowedFindingTransitionsFrom(state).length,
          state,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("has no self-transition", () => {
    // Re-entering a state is a no-op dressed as progress, and it would let a
    // stuck worker emit `analyzing → analyzing` forever while looking healthy.
    for (const state of REVIEW_RUN_STATES) {
      expect(canTransition(state, state), state).toBe(false);
    }
    for (const state of FINDING_LIFECYCLE_STATES) {
      expect(canTransitionFinding(state, state), state).toBe(false);
    }
  });

  it("throws exactly when the transition is disallowed", () => {
    // The assert and the predicate must not diverge: a transition the
    // predicate permits but the assert rejects would fail at runtime in the
    // one place nobody guards.
    fc.assert(
      fc.property(runState, runState, (from, to) => {
        const allowed = canTransition(from, to);
        const threw = (() => {
          try {
            assertValidReviewRunTransition(from, to);
            return false;
          } catch {
            return true;
          }
        })();
        expect(threw).toBe(!allowed);
      }),
    );
    fc.assert(
      fc.property(findingState, findingState, (from, to) => {
        const allowed = canTransitionFinding(from, to);
        const threw = (() => {
          try {
            assertValidFindingTransition(from, to);
            return false;
          } catch {
            return true;
          }
        })();
        expect(threw).toBe(!allowed);
      }),
    );
  });

  it("reaches every non-initial state from the initial one", () => {
    // A state nothing can reach is dead vocabulary: it would appear in every
    // exhaustive switch, in the generated schema, and in the UI, while never
    // occurring. Breadth-first from `queued`.
    const reached = new Set<ReviewRunState>(["queued"]);
    const queue: ReviewRunState[] = ["queued"];
    while (queue.length > 0) {
      const state = queue.shift();
      if (state === undefined) break;
      for (const next of allowedTransitionsFrom(state)) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect([...reached].sort()).toEqual([...REVIEW_RUN_STATES].sort());
  });

  it("reaches every finding state from the initial one", () => {
    const reached = new Set<FindingLifecycleState>(["verified"]);
    const queue: FindingLifecycleState[] = ["verified"];
    while (queue.length > 0) {
      const state = queue.shift();
      if (state === undefined) break;
      for (const next of allowedFindingTransitionsFrom(state)) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect([...reached].sort()).toEqual([...FINDING_LIFECYCLE_STATES].sort());
  });
});

describe("Orderings are total orders", () => {
  /**
   * A comparator that is not a total order makes `sort` non-deterministic and
   * `highestSeverity` wrong on some inputs — both silently, and both only for
   * particular arrangements a hand-written test is unlikely to pick.
   */
  it("severity comparison is antisymmetric and transitive", () => {
    fc.assert(
      fc.property(severity, severity, (left, right) => {
        // `|| 0` normalizes -0 to +0: `Math.sign(0)` is +0 and `-Math.sign(0)`
        // is -0, and `toBe` uses Object.is, which tells them apart.
        expect(Math.sign(compareSeverity(left, right)) || 0).toBe(
          -Math.sign(compareSeverity(right, left)) || 0,
        );
      }),
    );
    fc.assert(
      fc.property(severity, severity, severity, (a, b, c) => {
        if (compareSeverity(a, b) <= 0 && compareSeverity(b, c) <= 0) {
          expect(compareSeverity(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("highestSeverity is independent of input order", () => {
    fc.assert(
      fc.property(
        fc.array(severity, { minLength: 1, maxLength: 8 }),
        (values) => {
          const shuffled = [...values].reverse();
          expect(highestSeverity(shuffled)).toBe(highestSeverity(values));
        },
      ),
    );
  });

  it("evidence strength comparison is antisymmetric", () => {
    fc.assert(
      fc.property(strength, strength, (left, right) => {
        expect(Math.sign(compareEvidenceStrength(left, right)) || 0).toBe(
          -Math.sign(compareEvidenceStrength(right, left)) || 0,
        );
      }),
    );
  });

  it("strongestEvidence is independent of input order", () => {
    fc.assert(
      fc.property(
        fc.array(strength, { minLength: 1, maxLength: 8 }),
        (values) => {
          expect(strongestEvidence([...values].reverse())).toBe(
            strongestEvidence(values),
          );
        },
      ),
    );
  });
});

describe("Confidence bands", () => {
  it("never contradicts the level it derives", () => {
    // The invariant the schema enforces, checked against the function that is
    // supposed to satisfy it. A band boundary off by one would make
    // `findingConfidence` produce values its own schema rejects.
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (score) => {
        const confidence = findingConfidence(score);
        expect(confidence.level).toBe(confidenceLevelForScore(score));
      }),
    );
  });

  it("is monotonic: a higher score never yields a lower level", () => {
    const rank = ["low", "medium", "high", "very_high"] as const;
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a];
          expect(
            rank.indexOf(confidenceLevelForScore(higher)),
          ).toBeGreaterThanOrEqual(
            rank.indexOf(confidenceLevelForScore(lower)),
          );
        },
      ),
    );
  });
});

describe("Fingerprint stability (§28)", () => {
  const repositoryId = unsafeBrand<RepositoryId>(
    "0192f8a1-0000-7000-8000-000000000002",
  );

  const input = (line: number) => ({
    repositoryId,
    category: "security" as const,
    issueKey: namespacedId("acalys.security.sql-injection"),
    detector: namespacedId("acalys.agent.reviewer"),
    path: repositoryPath("src/auth.ts"),
    anchor: {
      kind: "symbol" as const,
      symbol: {
        name: "verify",
        kind: "method" as const,
        qualifiedName: "auth.Session.verify",
        container: "Session",
        // A symbol's *current* range is display-only, never identity — so
        // moving it must not move the fingerprint. That is what this varies.
        range: { start: line, end: line + 12 },
      },
    },
    // Not a fingerprint input; present to prove it is ignored.
    line,
  });

  it("survives arbitrary line movement", () => {
    // The property incremental review rests on: adding an import at the top of
    // a file shifts every line below it, and a fingerprint that moved with
    // them would report every existing finding as fixed and re-raise all of
    // them as new.
    const baseline = fingerprintCanonicalInput(input(1));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (line) => {
        expect(fingerprintCanonicalInput(input(line))).toBe(baseline);
      }),
    );
  });

  it("carries its algorithm version, so a change is detectable", () => {
    expect(fingerprintCanonicalInput(input(1))).toContain(
      `"version":${String(FINDING_FINGERPRINT_VERSION)}`,
    );
  });
});

describe("Canonical JSON determinism (§58)", () => {
  it("is invariant under key reordering, at any depth", () => {
    // The single property every hash in the platform depends on. If key order
    // could change the bytes, two workers would compute different fingerprints
    // and different config hashes for identical input.
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (value !== null && typeof value === "object") {
        const entries = Object.entries(
          value as Record<string, unknown>,
        ).reverse();
        return Object.fromEntries(entries.map(([k, v]) => [k, shuffle(v)]));
      }
      return value;
    };

    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.array(fc.integer(), { maxLength: 5 }),
            fc.dictionary(
              fc.string({ minLength: 1, maxLength: 6 }),
              fc.integer(),
              {
                maxKeys: 4,
              },
            ),
          ),
          { maxKeys: 8 },
        ),
        (value) => {
          expect(canonicalJson(shuffle(value))).toBe(canonicalJson(value));
        },
      ),
    );
  });

  it("is idempotent under a JSON round-trip", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.integer(), {
          maxKeys: 6,
        }),
        (value) => {
          const once = canonicalJson(value);
          expect(canonicalJson(JSON.parse(once) as unknown)).toBe(once);
        },
      ),
    );
  });
});

describe("Glob matching (§40, §64)", () => {
  it("never matches a path outside the pattern's literal prefix", () => {
    // A rule scoped to `src/` must never reach `lib/`, whatever the rest of
    // the pattern says — the containment property that makes path
    // instructions safe to scope.
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        (directory, file) => {
          const matched = matchesGlob("src/**", `${directory}/${file}.ts`);
          expect(matched).toBe(directory === "src");
        },
      ),
    );
  });

  it("matches a literal pattern only against itself", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (name) => {
        expect(matchesGlob("src/auth.ts", `src/${name}.ts`)).toBe(
          name === "auth",
        );
      }),
    );
  });
});
