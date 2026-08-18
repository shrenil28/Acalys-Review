import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  timestamp,
  type Clock,
  type Timestamp,
} from "@acalys/contracts/domain";

import {
  AppJwtSigner,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_EXPIRY_MARGIN_SECONDS,
  GithubAppPrivateKey,
  InstallationTokenProvider,
  JwtSigningError,
  MAX_JWT_LIFETIME_SECONDS,
  PrivateKeyError,
  REDACTED,
  cacheKeyFor,
  decodeUnverifiedJwtAlgorithm,
  decodeUnverifiedJwtClaims,
  isAuthenticationFailure,
  redactToken,
  withInstallationAuth,
  type InstallationToken,
  type InstallationTokenRequest,
} from "../src/index.js";

/** Markers planted so a leak is unambiguous wherever it surfaces. */
const PRIVATE_KEY_MARKER = "TEST_PRIVATE_KEY_MARKER";
const TOKEN_MARKER = "TEST_INSTALLATION_TOKEN_MARKER";

const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** A clock the test drives, so expiry is exercised without waiting. */
class TestClock implements Clock {
  #millis: number;

  public constructor(iso: string) {
    this.#millis = Date.parse(iso);
  }

  public now(): Timestamp {
    return timestamp(new Date(this.#millis).toISOString());
  }

  public advanceSeconds(seconds: number): void {
    this.#millis += seconds * 1000;
  }
}

const START = "2026-08-16T10:00:00.000Z";
const key = GithubAppPrivateKey.fromPem(rsa.privateKey);

describe("GithubAppPrivateKey", () => {
  it("accepts PKCS#8, which secret managers commonly re-encode to", () => {
    expect(GithubAppPrivateKey.fromPem(rsa.privateKey).modulusBits).toBe(2048);
  });

  it("accepts PKCS#1, which is what GitHub downloads", () => {
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    expect(() => GithubAppPrivateKey.fromPem(pkcs1.privateKey)).not.toThrow();
  });

  describe("fails at construction, not at first request", () => {
    // A process that starts happily and then fails every delivery is far harder
    // to diagnose than one that refuses to start.
    it("rejects an empty key", () => {
      expect(() => GithubAppPrivateKey.fromPem("")).toThrow(PrivateKeyError);
      expect(() => GithubAppPrivateKey.fromPem("   \n ")).toThrow(
        PrivateKeyError,
      );
    });

    it("rejects a malformed PEM", () => {
      expect(() =>
        GithubAppPrivateKey.fromPem("-----BEGIN RSA PRIVATE KEY-----\nnope\n"),
      ).toThrow(PrivateKeyError);
    });

    it("rejects a public key", () => {
      expect(() => GithubAppPrivateKey.fromPem(rsa.publicKey)).toThrow(
        PrivateKeyError,
      );
    });

    it("rejects a non-RSA key, which would sign with the wrong algorithm", () => {
      // An EC key parses and signs; GitHub then rejects every request, and the
      // error points at authentication rather than at key type.
      const ec = generateKeyPairSync("ec", {
        namedCurve: "P-256",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      expect(() => GithubAppPrivateKey.fromPem(ec.privateKey)).toThrow(
        /RSA key for RS256/,
      );
    });

    it("rejects an RSA key below 2048 bits", () => {
      // Signs successfully and is weak — the worst combination.
      const weak = generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      expect(() => GithubAppPrivateKey.fromPem(weak.privateKey)).toThrow(
        /2048 is the minimum/,
      );
    });
  });

  describe("is unprintable by every path that leaks secrets", () => {
    // The leak is never deliberate. It is logger.error({ config }),
    // JSON.stringify(options) in a telemetry attribute, and a thrown error
    // whose message interpolated the object.
    it("String()", () => {
      expect(String(key)).toBe(REDACTED);
    });

    it("template interpolation", () => {
      // Interpolating an object is exactly what the lint rule forbids, and
      // exactly the accident this class defends against. Asserting the defence
      // requires committing the sin once, deliberately.
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      expect(`${key}`).toBe(REDACTED);
    });

    it("JSON.stringify, nested inside a config object", () => {
      const serialized = JSON.stringify({
        github: { privateKey: key, appId: "x" },
      });
      expect(serialized).toContain(REDACTED);
      expect(serialized).not.toContain("PRIVATE KEY");
    });

    it("util.inspect / console.log", async () => {
      const { inspect } = await import("node:util");
      expect(inspect({ key })).toContain(REDACTED);
      expect(inspect({ key })).not.toContain("PRIVATE KEY");
    });

    it("Object.keys and spread expose nothing", () => {
      // A private field is not enumerable, so loggers that walk properties
      // find nothing to print.
      expect(Object.keys(key)).toEqual([]);
      expect(JSON.stringify({ ...key })).toBe("{}");
    });

    it("its error messages never quote the input", () => {
      const poisoned = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_MARKER}\n-----END RSA PRIVATE KEY-----`;
      try {
        GithubAppPrivateKey.fromPem(poisoned);
        throw new Error("expected a rejection");
      } catch (error) {
        expect((error as Error).message).not.toContain(PRIVATE_KEY_MARKER);
      }
    });
  });
});

describe("AppJwtSigner", () => {
  const signer = (
    overrides: Partial<{
      lifetimeSeconds: number;
      clockSkewSeconds: number;
    }> = {},
  ) =>
    new AppJwtSigner({
      appClientId: "Iv23liABCDEFGHIJKLMN",
      privateKey: key,
      clock: new TestClock(START),
      ...overrides,
    });

  it("emits a compact JWT with three segments", () => {
    expect(signer().sign().token.split(".")).toHaveLength(3);
  });

  it("declares RS256 — the only algorithm GitHub accepts", () => {
    expect(decodeUnverifiedJwtAlgorithm(signer().sign().token)).toBe("RS256");
  });

  it("back-dates iat, so a slightly fast host does not fail every request", () => {
    const now = Math.floor(Date.parse(START) / 1000);
    const { claims } = signer().sign();

    expect(claims.iat).toBe(now - DEFAULT_CLOCK_SKEW_SECONDS);
    expect(claims.iat).toBeLessThan(now);
  });

  it("uses the client id as iss", () => {
    expect(signer().sign().claims.iss).toBe("Iv23liABCDEFGHIJKLMN");
  });

  it("defaults below GitHub's maximum, not at it", () => {
    // GitHub validates exp against *their* clock. A token minted at exactly the
    // maximum is rejected whenever this host runs slightly fast — an outage
    // visible only on drifted machines.
    const now = Math.floor(Date.parse(START) / 1000);
    expect(signer().sign().claims.exp - now).toBeLessThan(
      MAX_JWT_LIFETIME_SECONDS,
    );
  });

  describe("refuses misconfiguration at construction", () => {
    it("a lifetime beyond GitHub's maximum", () => {
      expect(() =>
        signer({ lifetimeSeconds: MAX_JWT_LIFETIME_SECONDS + 1 }),
      ).toThrow(JwtSigningError);
    });

    it("a non-positive lifetime", () => {
      expect(() => signer({ lifetimeSeconds: 0 })).toThrow(JwtSigningError);
      expect(() => signer({ lifetimeSeconds: -1 })).toThrow(JwtSigningError);
    });

    it("a negative skew", () => {
      expect(() => signer({ clockSkewSeconds: -1 })).toThrow(JwtSigningError);
    });

    it("an empty client id", () => {
      expect(
        () =>
          new AppJwtSigner({
            appClientId: "",
            privateKey: key,
            clock: new TestClock(START),
          }),
      ).toThrow(JwtSigningError);
    });
  });

  it("tracks the clock rather than caching", () => {
    // The JWT is a bearer credential. Caching one to save a millisecond of RSA
    // trades a real security property — short exposure — for nothing.
    const clock = new TestClock(START);
    const jwt = new AppJwtSigner({
      appClientId: "Iv23li",
      privateKey: key,
      clock,
    });

    const first = jwt.sign();
    clock.advanceSeconds(120);
    const second = jwt.sign();

    expect(second.claims.iat).toBe(first.claims.iat + 120);
    expect(second.token).not.toBe(first.token);
  });

  describe("properties (hold for every configuration, not one example)", () => {
    it("exp > iat, exp within GitHub's window, alg is RS256", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: MAX_JWT_LIFETIME_SECONDS }),
          fc.integer({ min: 0, max: 600 }),
          fc.integer({ min: 0, max: 4_102_444_800 }),
          (lifetimeSeconds, clockSkewSeconds, epoch) => {
            const clock = new TestClock(new Date(epoch * 1000).toISOString());
            const signed = new AppJwtSigner({
              appClientId: "Iv23li",
              privateKey: key,
              clock,
              lifetimeSeconds,
              clockSkewSeconds,
            }).sign();

            const now = epoch;
            expect(signed.claims.exp).toBeGreaterThan(signed.claims.iat);
            expect(signed.claims.iat).toBeLessThanOrEqual(now);
            expect(signed.claims.exp - now).toBeLessThanOrEqual(
              MAX_JWT_LIFETIME_SECONDS,
            );
            expect(decodeUnverifiedJwtAlgorithm(signed.token)).toBe("RS256");

            const decoded = decodeUnverifiedJwtClaims(signed.token);
            expect(decoded).toEqual(signed.claims);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe("InstallationTokenProvider", () => {
  const INSTALLATION = 44556677;

  /** An exchange that counts calls and can be made to fail or stall. */
  function exchange(
    options: { expiresInSeconds?: number; token?: string } = {},
  ) {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;

    const clockBase = Date.parse(START);
    const fn = async (
      request: InstallationTokenRequest,
    ): Promise<InstallationToken> => {
      calls += 1;
      if (gated) await gate;
      return {
        token: `${options.token ?? TOKEN_MARKER}-${String(request.installationId)}-${String(calls)}`,
        expiresAt: new Date(
          clockBase + (options.expiresInSeconds ?? 3600) * 1000,
        ).toISOString(),
        permissions: { pull_requests: "write", contents: "read" },
        repositorySelection: "all",
      };
    };

    return {
      fn,
      get calls() {
        return calls;
      },
      stall() {
        gated = true;
      },
      resume() {
        release?.();
      },
    };
  }

  const request: InstallationTokenRequest = { installationId: INSTALLATION };

  it("mints once and serves the cache afterwards", async () => {
    const ex = exchange();
    const provider = new InstallationTokenProvider({
      exchange: ex.fn,
      clock: new TestClock(START),
    });

    const first = await provider.get(request);
    const second = await provider.get(request);

    expect(ex.calls).toBe(1);
    expect(second.token).toBe(first.token);
  });

  it("expires earlier than GitHub does", async () => {
    // A token handed out with two seconds left expires mid-clone, and the
    // failure has no local explanation.
    const ex = exchange({ expiresInSeconds: 3600 });
    const clock = new TestClock(START);
    const provider = new InstallationTokenProvider({ exchange: ex.fn, clock });

    await provider.get(request);
    clock.advanceSeconds(3600 - DEFAULT_EXPIRY_MARGIN_SECONDS - 1);
    await provider.get(request);
    expect(ex.calls).toBe(1);

    // One second past the margin: still valid to GitHub, refreshed here.
    clock.advanceSeconds(2);
    await provider.get(request);
    expect(ex.calls).toBe(2);
  });

  it("uses GitHub's expiry, not now + 3600", async () => {
    // The documented hour is current behaviour, not a contract.
    const ex = exchange({ expiresInSeconds: 600 });
    const clock = new TestClock(START);
    const provider = new InstallationTokenProvider({ exchange: ex.fn, clock });

    await provider.get(request);
    clock.advanceSeconds(600 - DEFAULT_EXPIRY_MARGIN_SECONDS + 1);
    await provider.get(request);

    expect(ex.calls).toBe(2);
  });

  it("does not cache a token already inside the margin", async () => {
    // Storing it guarantees a miss on the next call while occupying the entry.
    const ex = exchange({ expiresInSeconds: 60 });
    const provider = new InstallationTokenProvider({
      exchange: ex.fn,
      clock: new TestClock(START),
    });

    await provider.get(request);
    expect(provider.size).toBe(0);
  });

  describe("single-flight", () => {
    it("collapses N concurrent misses into one exchange", async () => {
      // Forty workers hitting an expired entry must not send forty exchanges.
      const ex = exchange();
      ex.stall();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      const inFlight = Array.from({ length: 40 }, () => provider.get(request));
      ex.resume();
      const tokens = await Promise.all(inFlight);

      expect(ex.calls).toBe(1);
      expect(new Set(tokens.map((t) => t.token)).size).toBe(1);
    });

    it("holds for any concurrency", async () => {
      // `fc.assert` on an asyncProperty returns a Promise. Not awaiting it
      // lets the test finish before the property runs — a test that cannot
      // fail. Verified by mutation: removing single-flight must break this.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 200 }),
          async (concurrency) => {
            const ex = exchange();
            ex.stall();
            const provider = new InstallationTokenProvider({
              exchange: ex.fn,
              clock: new TestClock(START),
            });

            const all = Array.from({ length: concurrency }, () =>
              provider.get(request),
            );
            ex.resume();
            await Promise.all(all);

            expect(ex.calls).toBe(1);
          },
        ),
        { numRuns: 25 },
      );
    });

    it("does not wedge the installation after a failed mint", async () => {
      // A rejected promise left in the in-flight table would make every later
      // caller join the same failure — one transient error breaking an
      // installation permanently.
      let attempt = 0;
      const provider = new InstallationTokenProvider({
        exchange: () => {
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("GitHub 500"));
          return Promise.resolve({
            token: "recovered",
            expiresAt: new Date(Date.parse(START) + 3_600_000).toISOString(),
            permissions: {},
          });
        },
        clock: new TestClock(START),
      });

      await expect(provider.get(request)).rejects.toThrow("GitHub 500");
      await expect(provider.get(request)).resolves.toMatchObject({
        token: "recovered",
      });
    });

    it("keeps separate scopes separate under concurrency", async () => {
      const ex = exchange();
      ex.stall();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      const broad = provider.get(request);
      const narrow = provider.get({ ...request, repositoryIds: [7] });
      ex.resume();
      await Promise.all([broad, narrow]);

      // Two distinct scopes: two exchanges, never one shared token.
      expect(ex.calls).toBe(2);
    });
  });

  describe("cache identity", () => {
    it("never serves one installation's token to another", async () => {
      const ex = exchange();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      const a = await provider.get({ installationId: 111 });
      const b = await provider.get({ installationId: 222 });

      expect(a.token).not.toBe(b.token);
      expect(ex.calls).toBe(2);
    });

    it("distinguishes repository and permission scope", () => {
      // A caller asking for `contents: read` on repository 7 must not receive a
      // token granting `contents: write` installation-wide — it would silently
      // widen every operation performed with it.
      const base = cacheKeyFor({ installationId: 1 });
      expect(cacheKeyFor({ installationId: 1, repositoryIds: [7] })).not.toBe(
        base,
      );
      expect(
        cacheKeyFor({ installationId: 1, permissions: { contents: "read" } }),
      ).not.toBe(base);
      expect(
        cacheKeyFor({ installationId: 1, permissions: { contents: "read" } }),
      ).not.toBe(
        cacheKeyFor({ installationId: 1, permissions: { contents: "write" } }),
      );
    });

    it("is order-independent, so one scope cannot occupy two entries", () => {
      expect(cacheKeyFor({ installationId: 1, repositoryIds: [7, 3] })).toBe(
        cacheKeyFor({ installationId: 1, repositoryIds: [3, 7] }),
      );
      expect(
        cacheKeyFor({
          installationId: 1,
          permissions: { b: "read", a: "write" },
        }),
      ).toBe(
        cacheKeyFor({
          installationId: 1,
          permissions: { a: "write", b: "read" },
        }),
      );
    });

    it("is prefixed by the installation, so invalidation can find every scope", () => {
      expect(cacheKeyFor({ installationId: 42 }).startsWith("42|")).toBe(true);
    });
  });

  describe("revocation", () => {
    it("drops every cached scope for the installation", async () => {
      const ex = exchange();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      await provider.get(request);
      await provider.get({ ...request, repositoryIds: [7] });
      expect(ex.calls).toBe(2);

      provider.invalidate(INSTALLATION);

      await provider.get(request);
      await provider.get({ ...request, repositoryIds: [7] });
      expect(ex.calls).toBe(4);
    });

    it("leaves other installations alone", async () => {
      const ex = exchange();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      await provider.get({ installationId: 111 });
      await provider.get({ installationId: 222 });
      provider.invalidate(111);
      await provider.get({ installationId: 222 });

      expect(ex.calls).toBe(2);
    });

    it("does not cache a token whose mint was in flight when revocation arrived", async () => {
      // The race a cache-entry map alone cannot handle: there is no entry to
      // delete, so the token lands *after* the revocation and would be stored
      // as fresh — serving a revoked installation for up to an hour.
      const ex = exchange();
      ex.stall();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      const pending = provider.get(request);
      provider.invalidate(INSTALLATION);
      ex.resume();
      await pending;

      expect(provider.size).toBe(0);
      await provider.get(request);
      expect(ex.calls).toBe(2);
    });

    it("invalidateAll clears everything", async () => {
      const ex = exchange();
      const provider = new InstallationTokenProvider({
        exchange: ex.fn,
        clock: new TestClock(START),
      });

      await provider.get({ installationId: 111 });
      await provider.get({ installationId: 222 });
      provider.invalidateAll();

      expect(provider.size).toBe(0);
      await provider.get({ installationId: 111 });
      expect(ex.calls).toBe(3);
    });

    it("property: after revocation, no cached credential remains usable", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 5 }), {
            minLength: 1,
            maxLength: 6,
          }),
          async (repositoryIds) => {
            const ex = exchange();
            const provider = new InstallationTokenProvider({
              exchange: ex.fn,
              clock: new TestClock(START),
            });

            for (const id of repositoryIds) {
              await provider.get({
                installationId: INSTALLATION,
                repositoryIds: [id],
              });
            }
            provider.invalidate(INSTALLATION);

            expect(provider.size).toBe(0);
          },
        ),
        { numRuns: 40 },
      );
    });
  });

  describe("rejects a malformed expiry rather than caching forever", () => {
    it("throws when GitHub's expiry does not parse", async () => {
      const provider = new InstallationTokenProvider({
        exchange: () =>
          Promise.resolve({
            token: "t",
            expiresAt: "not-a-date",
            permissions: {},
          }),
        clock: new TestClock(START),
      });

      await expect(provider.get(request)).rejects.toThrow(/unparseable expiry/);
    });
  });

  it("carries the permissions GitHub granted, which may differ from requested", async () => {
    // An owner can remove pull_requests:write after installation. Code assuming
    // "we are installed, therefore we may comment" fails at publication — after
    // a full review has been paid for.
    const ex = exchange();
    const provider = new InstallationTokenProvider({
      exchange: ex.fn,
      clock: new TestClock(START),
    });

    const token = await provider.get(request);
    expect(token.permissions).toEqual({
      pull_requests: "write",
      contents: "read",
    });
  });
});

describe("Bounded authentication retry", () => {
  const request: InstallationTokenRequest = { installationId: 99 };

  function provider(onMint: () => void = () => undefined) {
    let minted = 0;
    return new InstallationTokenProvider({
      exchange: () => {
        minted += 1;
        onMint();
        return Promise.resolve({
          token: `token-${String(minted)}`,
          expiresAt: new Date(Date.parse(START) + 3_600_000).toISOString(),
          permissions: {},
        });
      },
      clock: new TestClock(START),
    });
  }

  const authFailure = (error: unknown) =>
    error instanceof Error && error.message === "401";

  it("retries exactly once after a 401, then succeeds", async () => {
    let calls = 0;
    const { result, attempts } = await withInstallationAuth(
      provider(),
      request,
      () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("401"));
        return Promise.resolve("ok");
      },
      authFailure,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("surfaces a second 401 instead of looping", async () => {
    // `while (status === 401) refresh()` spins forever when the credential is
    // structurally wrong — a revoked installation, a rotated key, a badly
    // drifted clock — burning rate limit and hiding the cause.
    let calls = 0;
    await expect(
      withInstallationAuth(
        provider(),
        request,
        () => {
          calls += 1;
          return Promise.reject(new Error("401"));
        },
        authFailure,
      ),
    ).rejects.toThrow("401");

    expect(calls).toBe(2);
  });

  it("property: the operation never runs more than twice", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (failuresInARow) => {
          let calls = 0;
          await withInstallationAuth(
            provider(),
            request,
            () => {
              calls += 1;
              if (calls <= failuresInARow)
                return Promise.reject(new Error("401"));
              return Promise.resolve("ok");
            },
            authFailure,
          ).catch(() => undefined);

          expect(calls).toBeLessThanOrEqual(2);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("invalidates the cache before retrying, so the retry uses a new token", async () => {
    let mints = 0;
    const tokenProvider = provider(() => {
      mints += 1;
    });
    const seen: string[] = [];

    await withInstallationAuth(
      tokenProvider,
      request,
      (token) => {
        seen.push(token.token);
        return seen.length === 1
          ? Promise.reject(new Error("401"))
          : Promise.resolve("ok");
      },
      authFailure,
    );

    expect(mints).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("does not retry a non-authentication failure", async () => {
    let calls = 0;
    await expect(
      withInstallationAuth(
        provider(),
        request,
        () => {
          calls += 1;
          return Promise.reject(new Error("500"));
        },
        authFailure,
      ),
    ).rejects.toThrow("500");

    expect(calls).toBe(1);
  });

  it("treats 403 as a permissions problem, not a credential one", () => {
    // A 403 means the token is valid and the operation is not allowed.
    // Refreshing produces an identical token and an identical 403 — that is how
    // a permission removal becomes an infinite loop.
    expect(isAuthenticationFailure(401)).toBe(true);
    expect(isAuthenticationFailure(403)).toBe(false);
    expect(isAuthenticationFailure(429)).toBe(false);
    expect(isAuthenticationFailure(500)).toBe(false);
  });
});

describe("Secret material never reaches an observable surface", () => {
  const request: InstallationTokenRequest = { installationId: 7 };

  it("redacts a token, keeping only a correlatable suffix", () => {
    const redacted = redactToken(`${TOKEN_MARKER}-abcd`);
    expect(redacted).not.toContain(TOKEN_MARKER);
    expect(redacted).toContain("abcd");
    expect(redactToken("abc")).toBe("[REDACTED]");
  });

  it("keeps the marker out of every error path", async () => {
    const failures: readonly (readonly [string, () => Promise<unknown>])[] = [
      [
        "unparseable expiry",
        () =>
          new InstallationTokenProvider({
            exchange: () =>
              Promise.resolve({
                token: TOKEN_MARKER,
                expiresAt: "nope",
                permissions: {},
              }),
            clock: new TestClock(START),
          }).get(request),
      ],
      [
        "exchange rejection",
        () =>
          new InstallationTokenProvider({
            exchange: () => Promise.reject(new Error("GitHub 500")),
            clock: new TestClock(START),
          }).get(request),
      ],
    ];

    for (const [label, run] of failures) {
      const error = (await run().catch((caught: unknown) => caught)) as Error;
      const observable = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;

      expect(observable, label).not.toContain(TOKEN_MARKER);
      expect(observable, label).not.toContain(PRIVATE_KEY_MARKER);
    }
  });

  it("keeps the private key out of a JWT signing failure", () => {
    // Signing must abort, never degrade to an unsigned or differently-signed
    // token — and the failure must not carry the key that failed.
    const clock = new TestClock(START);
    const signer = new AppJwtSigner({
      appClientId: "Iv23li",
      privateKey: key,
      clock: {
        now: () => "not-a-timestamp" as Timestamp,
      },
    });

    const error = (() => {
      try {
        signer.sign();
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error).toBeInstanceOf(JwtSigningError);
    expect(`${error?.message ?? ""}${error?.stack ?? ""}`).not.toContain(
      PRIVATE_KEY_MARKER,
    );
    void clock;
  });

  it("does not put the key into a serialized signer", () => {
    const signer = new AppJwtSigner({
      appClientId: "Iv23li",
      privateKey: key,
      clock: new TestClock(START),
    });

    expect(JSON.stringify(signer)).toBe("{}");
    expect(Object.keys(signer)).toEqual([]);
  });
});
