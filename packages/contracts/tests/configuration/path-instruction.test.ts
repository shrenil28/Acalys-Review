import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  comparePathInstructions,
  instructionsForPath,
  pathInstructionSchema,
  sortPathInstructions,
  winningInstructionForPath,
  withDeclarationOrder,
  type OrderedPathInstruction,
  type PathInstruction,
} from "../../src/domain/configuration/path-instruction.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import type { GlobPattern } from "../../src/domain/configuration/glob.js";

const rule = (id: string, glob: string, priority = 0): PathInstruction => ({
  id: namespacedId(id),
  glob: unsafeBrand<GlobPattern>(glob),
  instructions: `rules for ${glob}`,
  priority,
});

const ids = (ordered: readonly PathInstruction[]): readonly string[] =>
  ordered.map((instruction) => instruction.id);

describe("Path instruction precedence (P0.txt §40)", () => {
  it("orders by specificity first", () => {
    const declared = withDeclarationOrder([
      rule("r.broad", "**"),
      rule("r.dir", "src/auth/*.ts"),
      rule("r.exact", "src/auth/session.ts"),
      rule("r.recursive", "src/**/*.ts"),
    ]);

    expect(
      ids(instructionsForPath(declared, repositoryPath("src/auth/session.ts"))),
    ).toEqual(["r.exact", "r.dir", "r.recursive", "r.broad"]);
  });

  it("breaks a specificity tie by priority", () => {
    const declared = withDeclarationOrder([
      rule("r.low", "src/*.ts", 0),
      rule("r.high", "src/*.ts", 10),
      rule("r.negative", "src/*.ts", -5),
    ]);

    expect(
      ids(instructionsForPath(declared, repositoryPath("src/a.ts"))),
    ).toEqual(["r.high", "r.low", "r.negative"]);
  });

  it("breaks a remaining tie by declaration order, last declared winning", () => {
    // The convention `.gitignore`, `CODEOWNERS`, and CSS all use: appending a
    // rule to the bottom of a file overrides what is above it.
    const declared = withDeclarationOrder([
      rule("r.first", "src/*.ts"),
      rule("r.second", "src/*.ts"),
      rule("r.third", "src/*.ts"),
    ]);

    expect(
      ids(instructionsForPath(declared, repositoryPath("src/a.ts"))),
    ).toEqual(["r.third", "r.second", "r.first"]);
  });

  it("lets a repository rule outrank its organization at equal specificity", () => {
    // The property that makes §109's concatenation work with no extra
    // precedence key: organization instructions are declared first, so the
    // repository's identical-strength rule wins by declaration order alone.
    const organization = [rule("org.style", "src/*.ts")];
    const repository = [rule("repo.style", "src/*.ts")];
    const declared = withDeclarationOrder([...organization, ...repository]);

    expect(
      winningInstructionForPath(declared, repositoryPath("src/a.ts"))?.id,
    ).toBe("repo.style");
  });

  it("returns every match, not only the winner", () => {
    // Instructions are additive prose: a file under `src/auth/` should receive
    // both the repository-wide convention and the auth-specific rule.
    const declared = withDeclarationOrder([
      rule("r.all", "**"),
      rule("r.auth", "src/auth/*.ts"),
    ]);

    expect(
      instructionsForPath(declared, repositoryPath("src/auth/a.ts")),
    ).toHaveLength(2);
    expect(
      instructionsForPath(declared, repositoryPath("lib/a.ts")),
    ).toHaveLength(1);
  });

  it("returns nothing when no rule matches", () => {
    const declared = withDeclarationOrder([rule("r.auth", "src/auth/*.ts")]);
    expect(
      winningInstructionForPath(declared, repositoryPath("lib/a.ts")),
    ).toBeUndefined();
  });

  it("does not mutate its input, because declaration order is an input", () => {
    const instructions = [rule("r.a", "**"), rule("r.b", "src/a.ts")];
    const declared = withDeclarationOrder(instructions);
    const before = declared.map((entry) => entry.instruction.id);

    sortPathInstructions(declared);

    expect(declared.map((entry) => entry.instruction.id)).toEqual(before);
  });

  describe("determinism", () => {
    /**
     * The property the whole module exists for. A config snapshot is hashed
     * and pinned to a run (§39), so if precedence depended on the order a YAML
     * parser happened to emit, two workers would resolve different rules for
     * the same commit and nothing would reveal it.
     */
    it("produces one order regardless of how the input was shuffled", () => {
      const pool: PathInstruction[] = [
        rule("r.broad", "**"),
        rule("r.recursive", "src/**/*.ts"),
        rule("r.dir", "src/auth/*.ts"),
        rule("r.exact", "src/auth/session.ts"),
        rule("r.priority", "src/auth/*.ts", 10),
        rule("r.negative", "src/**/*.ts", -3),
      ];

      fc.assert(
        fc.property(
          fc.shuffledSubarray(pool, { minLength: pool.length }),
          (shuffled) => {
            // Declaration order follows the shuffled document, exactly as it
            // would if a user had written the rules in that order.
            const declared = withDeclarationOrder(shuffled);
            const sorted = sortPathInstructions(declared);

            // The comparator is total: no adjacent pair may compare equal, or
            // the result would depend on the engine's sort stability.
            for (let index = 1; index < sorted.length; index += 1) {
              const previous = sorted[index - 1];
              const current = sorted[index];
              if (previous === undefined || current === undefined) continue;
              expect(comparePathInstructions(previous, current)).toBeLessThan(
                0,
              );
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    it("gives the same winner 1000 times", () => {
      const declared = withDeclarationOrder([
        rule("r.broad", "**"),
        rule("r.exact", "src/auth/session.ts"),
        rule("r.dir", "src/auth/*.ts", 100),
      ]);
      const path = repositoryPath("src/auth/session.ts");

      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        expect(winningInstructionForPath(declared, path)?.id).toBe("r.exact");
      }
    });

    it("beats priority with specificity, never the reverse", () => {
      // Priority is a tiebreak, not an escape hatch: a `**` rule with the
      // maximum priority must still lose to an exact path.
      const declared = withDeclarationOrder([
        rule("r.shout", "**", 1_000),
        rule("r.exact", "src/a.ts", -1_000),
      ]);

      expect(
        winningInstructionForPath(declared, repositoryPath("src/a.ts"))?.id,
      ).toBe("r.exact");
    });
  });

  describe("validation", () => {
    it("accepts a well-formed instruction", () => {
      expect(
        pathInstructionSchema.safeParse({
          id: "org.acme.migrations",
          glob: "db/migrations/*.sql",
          instructions: "Flag destructive DDL without a rollback.",
          priority: 5,
        }).success,
      ).toBe(true);
    });

    it("rejects an unsupported glob at authoring time", () => {
      // The point of rejecting rather than approximating: this document is
      // caught when it is written, not when it silently mis-matches.
      const result = pathInstructionSchema.safeParse({
        id: "org.acme.migrations",
        glob: "db/[0-9]*.sql",
        instructions: "…",
        priority: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects an out-of-range priority", () => {
      expect(
        pathInstructionSchema.safeParse({
          id: "org.acme.x",
          glob: "**",
          instructions: "…",
          priority: 10_000,
        }).success,
      ).toBe(false);
    });

    it("rejects unknown keys", () => {
      expect(
        pathInstructionSchema.safeParse({
          id: "org.acme.x",
          glob: "**",
          instructions: "…",
          priority: 0,
          severity: "high",
        }).success,
      ).toBe(false);
    });
  });
});

describe("OrderedPathInstruction", () => {
  it("carries declaration order explicitly, not as an array index", () => {
    // The array gets sorted; an index would move with it, and the tiebreak
    // would silently become "wherever this ended up".
    const declared: readonly OrderedPathInstruction[] = withDeclarationOrder([
      rule("r.a", "src/*.ts"),
      rule("r.b", "src/*.ts"),
    ]);
    const sorted = sortPathInstructions(declared);

    expect(sorted[0]?.declarationOrder).toBe(1);
    expect(sorted[1]?.declarationOrder).toBe(0);
  });
});
