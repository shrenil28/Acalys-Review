import { beforeEach, describe, expect, it } from "vitest";

import {
  assertNoCredentials,
  clearRegisteredSecrets,
  redactSecrets,
  registerSecret,
  scrubSecrets,
} from "../scripts/probe-harness.js";

/**
 * The probe records raw provider responses on purpose — that is what makes the
 * E.3 design evidence-based rather than hopeful. It is also its biggest hazard:
 * the installation-token exchange returns a live credential **in its response
 * body**, so recording verbatim writes that token to a file and very likely
 * into a bug report.
 *
 * An unverified redaction is worse than no redaction, because it is trusted.
 */
describe("Probe transcript redaction", () => {
  const TOKEN = "ghs_TESTINSTALLATIONTOKENMARKER";

  it("redacts the installation token from a token-exchange response", () => {
    const response = {
      token: TOKEN,
      expires_at: "2026-08-16T11:00:00Z",
      permissions: { pull_requests: "write" },
    };

    const redacted = JSON.stringify(redactSecrets(response));
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain("[REDACTED]");
    // The useful evidence survives.
    expect(redacted).toContain("expires_at");
    expect(redacted).toContain("pull_requests");
  });

  it("redacts at any depth, including inside arrays", () => {
    const nested = {
      data: [{ inner: { access_token: TOKEN } }, { ok: true }],
    };
    expect(JSON.stringify(redactSecrets(nested))).not.toContain(TOKEN);
  });

  it("matches field names case-insensitively", () => {
    for (const field of ["Token", "ACCESS_TOKEN", "Authorization"]) {
      const redacted = JSON.stringify(redactSecrets({ [field]: TOKEN }));
      expect(redacted, field).not.toContain(TOKEN);
    }
  });

  it("leaves ordinary review data intact", () => {
    // Over-redacting would destroy the evidence the probe exists to collect.
    const review = {
      id: 12345,
      body: "<!-- acalys:publication:pub_abc -->",
      state: "PENDING",
      user: { login: "acalys-app" },
    };
    expect(redactSecrets(review)).toEqual(review);
  });

  it("survives null and primitive bodies", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
  });
});

/**
 * Field-name redaction only removes the values we predicted. These tests cover
 * the ones we did not: a token echoed inside an error message, a credential
 * shape nobody registered, a PEM serialized with escaped newlines. Those are
 * the cases that actually leak, because nobody wrote a rule for them.
 */
describe("Value scrubbing catches credentials in unpredicted places", () => {
  const TOKEN = "ghs_UNMISTAKABLEPROBEMARKER0123456789";
  const PEM = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAunmistakableprobekeymarker",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it("removes a registered token from a field no rule names", () => {
    registerSecret(TOKEN);

    // GitHub really does echo request material into error messages.
    const errorBody = {
      message: `Bad credentials for ${TOKEN}`,
      documentation_url: `https://docs.github.com/rest?t=${TOKEN}`,
      errors: [{ resource: "Review", detail: TOKEN }],
    };

    const scrubbed = JSON.stringify(scrubSecrets(errorBody));
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain("[REDACTED]");
    // The diagnostic value survives — that is the point of scrubbing rather
    // than dropping the field.
    expect(scrubbed).toContain("Bad credentials for");
    expect(scrubbed).toContain("resource");
  });

  it("removes a PEM both raw and with JSON-escaped newlines", () => {
    registerSecret(PEM);

    expect(JSON.stringify(scrubSecrets({ note: PEM }))).not.toContain(
      "unmistakableprobekeymarker",
    );
    // The shape a PEM takes once it has been through a JSON round trip.
    expect(
      JSON.stringify(scrubSecrets({ note: PEM.replaceAll("\n", "\\n") })),
    ).not.toContain("unmistakableprobekeymarker");
  });

  it("refuses to register a short value", () => {
    // Scrubbing "ok" would corrupt every transcript containing it, and no real
    // credential is that short.
    expect(() => {
      registerSecret("short");
    }).toThrow(/short/i);
  });
});

describe("Emission is refused when output looks like a credential", () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it("throws on a registered secret that survived redaction", () => {
    const token = "ghs_SURVIVEDREDACTION0123456789ABCD";
    registerSecret(token);
    expect(() => {
      assertNoCredentials(`{"body":"${token}"}`);
    }).toThrow(/redaction bug/i);
  });

  it.each([
    ["installation token", "ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["personal token", "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    ["PEM header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["JWT", "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhcHAifQ.c2lnbmF0dXJlc2lnbg"],
  ])("throws on an unregistered %s by shape alone", (_label, material) => {
    // The only defence that works for a credential minted by a code path added
    // after this file was written.
    expect(() => {
      assertNoCredentials(`{"transcript":"${material}"}`);
    }).toThrow(/refusing to emit/i);
  });

  it("permits an ordinary transcript", () => {
    const transcript = JSON.stringify([
      {
        step: "list-reviews",
        method: "GET",
        url: "https://api.github.com/repos/o/r/pulls/1/reviews",
        status: 200,
        body: [
          {
            id: 1,
            state: "PENDING",
            body: "<!-- acalys:publication:pub_abc123 -->",
          },
        ],
      },
    ]);

    expect(() => {
      assertNoCredentials(transcript);
    }).not.toThrow();
  });
});
