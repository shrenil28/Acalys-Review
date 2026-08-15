import { describe, expect, it } from "vitest";
import {
  repositoryId,
  reviewRunId,
  type RepositoryId,
  type ReviewRunId,
} from "../../src/domain/identity/ids.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import {
  timestamp,
  type Timestamp,
} from "../../src/domain/primitives/timestamp.js";

/**
 * Branding is a compile-time guarantee, so most of its value cannot be
 * asserted at runtime. `@ts-expect-error` is the assertion: the test only
 * compiles if the error it claims is actually there, which means `npm run
 * typecheck` fails the moment branding stops working.
 */
describe("branded identifiers (P0.txt §5)", () => {
  const REPO = "0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5b";

  it("rejects assigning one id type to another", () => {
    const repo: RepositoryId = repositoryId(REPO);

    // @ts-expect-error a RepositoryId is not a ReviewRunId (§5)
    const wrong: ReviewRunId = repo;

    // The values are structurally identical at runtime — which is precisely
    // why the compile-time distinction has to carry the weight.
    expect(typeof wrong).toBe("string");
  });

  it("rejects a raw string where a branded id is required", () => {
    // @ts-expect-error an unvalidated string cannot become a RepositoryId
    const wrong: RepositoryId = REPO;

    expect(wrong).toBe(REPO);
  });

  it("allows a branded id to be read as its underlying primitive", () => {
    // The inverse direction is intentionally permitted: a branded string IS a
    // string, so no `unbrand` helper is needed to hand one to plain code.
    const asString: string = repositoryId(REPO);
    expect(asString).toBe(REPO);
  });

  it("keeps distinct brands distinct across primitive families", () => {
    const path = repositoryPath("src/index.ts");

    // @ts-expect-error a RepositoryPath is not a Timestamp
    const wrong: Timestamp = path;
    expect(typeof wrong).toBe("string");
    expect(timestamp("2026-08-15T15:30:12.421Z")).not.toBe(path);
  });

  it("does not expose the brand carrier at runtime", () => {
    const repo = repositoryId(REPO);

    // The brand is a phantom: at runtime the value is exactly its string.
    // If the carrier were a real property it would appear in JSON output and
    // in canonicalJson, changing every hash that touched an id.
    expect(typeof repo).toBe("string");
    expect(Object.getOwnPropertySymbols(Object(repo))).toHaveLength(0);
    expect(JSON.parse(JSON.stringify({ id: repo }))).toEqual({ id: REPO });
    expect(`${repo}`).toBe(REPO);
  });

  it("generates ids that validate and are unique", () => {
    const generated = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      generated.add(reviewRunId(crypto.randomUUID()));
    }
    expect(generated.size).toBe(1_000);
  });
});
