import { describe, expect, it } from "vitest";
import {
  AcalysError,
  ConfigurationError,
  ConflictError,
  InternalError,
  NotFoundError,
  ProviderError,
  RepositoryError,
  ValidationError,
  isAcalysError,
  toSerializedError,
} from "../../src/domain/errors/errors.js";

describe("error taxonomy (P0.txt §50, §51, §63)", () => {
  describe("retryability is a property of the type, not a guess (§51)", () => {
    it.each([
      [
        "invalid config is never retryable",
        new ConfigurationError("bad"),
        false,
      ],
      ["validation is never retryable", new ValidationError("bad"), false],
      ["not-found is never retryable", new NotFoundError("gone"), false],
      ["conflict is never retryable", new ConflictError("dup"), false],
      ["internal is never retryable", new InternalError("bug"), false],
    ])("%s", (_label, error, expected) => {
      expect(error.retryable).toBe(expected);
    });

    it("conditional errors defer to the throw site", () => {
      // A provider 503 and a provider 422 are the same class with opposite
      // answers, and only the adapter knows which it saw.
      const transient = new ProviderError("503 from GitHub", {
        retryable: true,
      });
      const permanent = new ProviderError("422 unprocessable", {
        retryable: false,
      });

      expect(transient.retryable).toBe(true);
      expect(permanent.retryable).toBe(false);
      expect(transient.retryability).toBe("conditional");
    });

    it("an undecided conditional error defaults to NOT retrying", () => {
      // Safe default: a stalled job is recoverable, an infinite retry loop
      // burning quota or duplicating side effects is not.
      expect(new RepositoryError("unknown failure").retryable).toBe(false);
    });
  });

  describe("serialization never leaks internals (§63)", () => {
    it("omits stack, cause, and name", () => {
      const cause = new Error("connection refused to 10.0.0.5:5432");
      const error = new ProviderError("Upstream unavailable", {
        cause,
        retryable: true,
        details: { statusCode: 503 },
      });

      const serialized = error.toSerialized();

      expect(serialized).toEqual({
        code: "PROVIDER_ERROR",
        message: "Upstream unavailable",
        retryable: true,
        retryability: "conditional",
        details: { statusCode: 503 },
      });
      expect(Object.keys(serialized)).not.toContain("stack");
      expect(Object.keys(serialized)).not.toContain("cause");
      expect(Object.keys(serialized)).not.toContain("name");
      expect(JSON.stringify(serialized)).not.toContain("10.0.0.5");
    });

    it("keeps the cause in-process for logging", () => {
      const cause = new Error("root cause");
      const error = new ProviderError("wrapped", { cause });
      expect(error.cause).toBe(cause);
    });

    it("omits details entirely when there are none", () => {
      expect(Object.keys(new NotFoundError("nope").toSerialized())).toEqual([
        "code",
        "message",
        "retryable",
        "retryability",
      ]);
    });

    it("JSON.stringify uses the safe form automatically", () => {
      const error = new ValidationError("bad input");
      const parsed: unknown = JSON.parse(JSON.stringify(error));
      expect(parsed).toEqual({
        code: "VALIDATION_ERROR",
        message: "bad input",
        retryable: false,
        retryability: "non_retryable",
      });
    });
  });

  describe("toSerializedError funnels anything a catch block can receive", () => {
    it("passes an AcalysError through", () => {
      expect(toSerializedError(new NotFoundError("x")).code).toBe("NOT_FOUND");
    });

    it("keeps a native Error's message but reports it as internal", () => {
      // We cannot know a foreign error is safe to retry.
      expect(
        toSerializedError(new TypeError("undefined is not a function")),
      ).toEqual({
        code: "INTERNAL_ERROR",
        message: "undefined is not a function",
        retryable: false,
        retryability: "non_retryable",
      });
    });

    it.each([
      ["a string", "just a string"],
      ["a number", 42],
      ["undefined", undefined],
      ["null", null],
      ["a plain object", { secret: "sk-live-abc123" }],
    ])("describes %s without interpolating its content", (_label, thrown) => {
      const serialized = toSerializedError(thrown);
      expect(serialized.code).toBe("INTERNAL_ERROR");
      expect(serialized.retryable).toBe(false);
      // A caught provider response must never escape into an API reply.
      expect(serialized.message).not.toContain("sk-live-abc123");
      expect(serialized.message).toMatch(/^Non-Error value thrown/);
    });

    it("survives a hostile object whose getters throw", () => {
      const hostile = {
        get message(): string {
          throw new Error("gotcha");
        },
      };
      expect(() => toSerializedError(hostile)).not.toThrow();
    });
  });

  describe("hierarchy", () => {
    it("every class is an AcalysError and a real Error", () => {
      const errors = [
        new ValidationError("a"),
        new NotFoundError("b"),
        new ConflictError("c"),
        new ProviderError("d"),
        new ConfigurationError("e"),
        new InternalError("f"),
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(AcalysError);
        expect(error).toBeInstanceOf(Error);
        expect(isAcalysError(error)).toBe(true);
        // `name` is set from the constructor so logs stay readable.
        expect(error.name).toBe(error.constructor.name);
      }
    });

    it("instanceof discriminates between siblings", () => {
      const error: unknown = new NotFoundError("x");
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).not.toBeInstanceOf(ValidationError);
    });

    it("isAcalysError rejects foreign errors", () => {
      expect(isAcalysError(new Error("plain"))).toBe(false);
      expect(isAcalysError("not an error")).toBe(false);
    });

    it("codes are unique across the hierarchy", () => {
      const codes = [
        new ValidationError("").code,
        new NotFoundError("").code,
        new ConflictError("").code,
        new ProviderError("").code,
        new RepositoryError("").code,
        new ConfigurationError("").code,
        new InternalError("").code,
      ];
      expect(new Set(codes).size).toBe(codes.length);
    });
  });
});
