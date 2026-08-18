import { describe, expect, it } from "vitest";

import { redactSecrets } from "../scripts/pending-review-probe.js";

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
