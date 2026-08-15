import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ReviewRunIdOps,
  RepositoryIdOps,
  findingId,
  isValidIdFormat,
  organizationId,
  repositoryId,
  repositoryIdSchema,
  reviewRunId,
} from "../../src/domain/identity/ids.js";
import { ValidationError } from "../../src/domain/errors/errors.js";
import { SequentialIdGenerator } from "../../src/domain/ports/id-generator.js";
import type { ReviewRunId } from "../../src/domain/identity/ids.js";

describe("identifiers (P0.txt §5, §99)", () => {
  const VALID = "0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5b";

  it("accepts a canonical lowercase UUID", () => {
    expect(repositoryId(VALID)).toBe(VALID);
    expect(isValidIdFormat(VALID)).toBe(true);
  });

  describe("rejects malformed ids", () => {
    it.each([
      ["uppercase", "0192F8A1-3C4D-7E5F-8A9B-0C1D2E3F4A5B"],
      ["no hyphens", "0192f8a13c4d7e5f8a9b0c1d2e3f4a5b"],
      ["too short", "0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5"],
      ["too long", "0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5bc"],
      ["non-hex", "0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4azz"],
      ["empty", ""],
      ["braced", "{0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5b}"],
      ["urn form", "urn:uuid:0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5b"],
      ["whitespace padded", ` ${VALID} `],
      ["sql injection attempt", "'; DROP TABLE reviews; --"],
    ])("%s", (_label, input) => {
      expect(() => repositoryId(input)).toThrow(ValidationError);
      expect(isValidIdFormat(input)).toBe(false);
    });
  });

  it("names the id type in the error, so failures are actionable (§96)", () => {
    expect(() => reviewRunId("nope")).toThrow(/Invalid ReviewRunId/);
    expect(() => organizationId("nope")).toThrow(/Invalid OrganizationId/);
    expect(() => findingId("nope")).toThrow(/Invalid FindingId/);

    try {
      reviewRunId("nope");
      expect.unreachable();
    } catch (error) {
      expect((error as ValidationError).details).toEqual({
        idType: "ReviewRunId",
        value: "nope",
      });
    }
  });

  describe("generation", () => {
    it("produces ids that pass their own validator", () => {
      for (let index = 0; index < 500; index += 1) {
        const generated = ReviewRunIdOps.generate();
        expect(() => reviewRunId(generated)).not.toThrow();
      }
    });

    it("never collides across 10k ids", () => {
      const seen = new Set<string>();
      for (let index = 0; index < 10_000; index += 1) {
        seen.add(RepositoryIdOps.generate());
      }
      expect(seen.size).toBe(10_000);
    });

    it("sorts chronologically as strings — the reason for UUIDv7 (§5)", () => {
      // Generated in order, so lexicographic order must match creation order.
      // This is what makes "most recent runs" an index range scan.
      const ids: string[] = [];
      for (let index = 0; index < 200; index += 1) {
        ids.push(ReviewRunIdOps.generate());
      }
      expect([...ids].sort()).toEqual(ids);
    });
  });

  describe("schema", () => {
    it("parses a valid id", () => {
      expect(repositoryIdSchema.parse(VALID)).toBe(VALID);
    });

    it("rejects invalid input with a named message", () => {
      const result = repositoryIdSchema.safeParse("nope");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Invalid RepositoryId",
        );
      }
    });

    it("rejects non-strings", () => {
      expect(repositoryIdSchema.safeParse(42).success).toBe(false);
      expect(repositoryIdSchema.safeParse(null).success).toBe(false);
      expect(repositoryIdSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe("SequentialIdGenerator (§94)", () => {
    it("is deterministic, so fixtures can assert exact ids", () => {
      const first = new SequentialIdGenerator<ReviewRunId>();
      const second = new SequentialIdGenerator<ReviewRunId>();

      expect(first.next()).toBe("00000000-0000-7000-8000-000000000001");
      expect(first.next()).toBe("00000000-0000-7000-8000-000000000002");
      // A second generator starts from the same point.
      expect(second.next()).toBe("00000000-0000-7000-8000-000000000001");
    });

    it("produces ids that pass real id validation", () => {
      const generator = new SequentialIdGenerator<ReviewRunId>();
      for (let index = 0; index < 100; index += 1) {
        expect(() => reviewRunId(generator.next())).not.toThrow();
      }
    });

    it("resets", () => {
      const generator = new SequentialIdGenerator<ReviewRunId>();
      generator.next();
      generator.next();
      generator.reset();
      expect(generator.next()).toBe("00000000-0000-7000-8000-000000000001");
    });
  });

  describe("property-based (§84)", () => {
    it("accepts exactly the canonical UUID shape and nothing else", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 50 }), (candidate) => {
          const shouldPass =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              candidate,
            );
          let didPass = true;
          try {
            repositoryId(candidate);
          } catch {
            didPass = false;
          }
          return didPass === shouldPass;
        }),
        { numRuns: 2_000 },
      );
    });
  });
});
