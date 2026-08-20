import { describe, expect, it } from "vitest";

import { resolveDataMode, type DataMode } from "../src/lib/api/config.js";

/**
 * Fixtures are a choice, never a default and never a fallback.
 *
 * The failure this prevents is silent and confident: a production deploy whose
 * API variable goes missing, entering fixture mode and rendering plausible,
 * well-formed, entirely fabricated security findings.
 *
 * That is worse than the outage-reads-as-clean bug this seam was built to
 * prevent. An outage looks like an outage; fabricated data looks like your
 * codebase.
 */
describe("The data source is selected, not inferred", () => {
  it("refuses to default to fixtures in production", () => {
    // The whole point. Nothing declared, production build — the app says the
    // configuration is wrong rather than choosing the option that looks like
    // working software.
    expect(resolveDataMode({ PROD: true })).toEqual({
      kind: "misconfigured",
      detail: "VITE_ACALYS_DATA_MODE must be set explicitly in production",
    });
  });

  it("allows fixtures in development without ceremony", () => {
    // A developer running the app with no backend is asking for the demo, and
    // refusing would be hostile. The default never applies to a production
    // bundle.
    expect(resolveDataMode({ PROD: false })).toEqual({ kind: "fixtures" });
  });

  it("requires a second authorization for fixtures in production", () => {
    // Choosing is not enough in production. A build serving fabricated
    // security findings because one variable said `fixtures` should be more
    // than a typo away, so it takes two — and the second exists for no other
    // purpose.
    expect(
      resolveDataMode({ PROD: true, VITE_ACALYS_DATA_MODE: "fixtures" }),
    ).toMatchObject({ kind: "misconfigured" });

    expect(
      resolveDataMode({
        PROD: true,
        VITE_ACALYS_DATA_MODE: "fixtures",
        VITE_ACALYS_ALLOW_DEMO_DATA: "true",
      }),
    ).toEqual({ kind: "fixtures" });
  });

  it("refuses to serve fixtures when a dev has configured an API", () => {
    // A developer who set an API URL meant to use it. Silently serving
    // fixtures costs an hour of wondering why backend changes do not appear,
    // and the answer would be that the UI never asked.
    expect(
      resolveDataMode({
        PROD: false,
        VITE_ACALYS_API_URL: "http://localhost:8080",
      }),
    ).toMatchObject({ kind: "misconfigured" });
  });

  it("matches the full configuration table", () => {
    // ── Every row, so a new branch has to be added here to pass ───────────
    const table: [Record<string, unknown>, DataMode["kind"]][] = [
      [{ PROD: true }, "misconfigured"],
      [{ PROD: true, VITE_ACALYS_DATA_MODE: "api" }, "misconfigured"],
      [
        {
          PROD: true,
          VITE_ACALYS_DATA_MODE: "api",
          VITE_ACALYS_API_URL: "https://a",
        },
        "api",
      ],
      [{ PROD: true, VITE_ACALYS_DATA_MODE: "fixtures" }, "misconfigured"],
      [
        {
          PROD: true,
          VITE_ACALYS_DATA_MODE: "fixtures",
          VITE_ACALYS_ALLOW_DEMO_DATA: "true",
        },
        "fixtures",
      ],
      [{ PROD: false }, "fixtures"],
      [
        { PROD: false, VITE_ACALYS_API_URL: "http://localhost:8080" },
        "misconfigured",
      ],
      [
        {
          PROD: false,
          VITE_ACALYS_DATA_MODE: "api",
          VITE_ACALYS_API_URL: "http://localhost:8080",
        },
        "api",
      ],
      [{ PROD: false, VITE_ACALYS_DATA_MODE: "api" }, "misconfigured"],
      [{ PROD: false, VITE_ACALYS_DATA_MODE: "fixtures" }, "fixtures"],
    ];

    for (const [env, expected] of table) {
      expect(resolveDataMode(env).kind, JSON.stringify(env)).toBe(expected);
    }
  });

  it("reports api mode without a URL as misconfigured, not as fixtures", () => {
    expect(
      resolveDataMode({ PROD: true, VITE_ACALYS_DATA_MODE: "api" }),
    ).toMatchObject({ kind: "misconfigured" });
  });

  it("uses the API when both are declared", () => {
    expect(
      resolveDataMode({
        PROD: true,
        VITE_ACALYS_DATA_MODE: "api",
        VITE_ACALYS_API_URL: "https://api.acalys.dev",
      }),
    ).toEqual({ kind: "api", baseUrl: "https://api.acalys.dev" });
  });

  it("refuses a mode it does not recognise", () => {
    // Not fixtures. A typo must not resolve to fabricated data.
    expect(
      resolveDataMode({ PROD: true, VITE_ACALYS_DATA_MODE: "demo" }),
    ).toMatchObject({ kind: "misconfigured" });
  });

  it("never returns fixtures from an incoherent configuration", () => {
    const incoherent = [
      { PROD: true },
      { PROD: true, VITE_ACALYS_DATA_MODE: "api" },
      { PROD: true, VITE_ACALYS_DATA_MODE: "typo" },
      { PROD: true, VITE_ACALYS_DATA_MODE: "api", VITE_ACALYS_API_URL: "" },
      { PROD: true, VITE_ACALYS_DATA_MODE: "fixtures" },
      { PROD: false, VITE_ACALYS_API_URL: "http://localhost:8080" },
    ];
    for (const env of incoherent) {
      expect(resolveDataMode(env).kind, JSON.stringify(env)).toBe(
        "misconfigured",
      );
    }
  });
});
