import { describe, expect, it } from "vitest";
import { resolveDataConfig, resolveDataMode } from "../src/lib/api/config.js";

describe("Phase 4 production fixture firewall", () => {
  it("keeps dashboard/admin callers on the same fail-closed resolver", () => {
    const env = {
      PROD: true,
      VITE_ACALYS_DATA_MODE: "api",
      VITE_ACALYS_API_URL: "https://api.acalys.test",
    };
    expect(resolveDataConfig(env)).toEqual(resolveDataMode(env));
    expect(resolveDataConfig(env)).toEqual({ kind: "api", baseUrl: "https://api.acalys.test" });
  });

  it("cannot enter fixture mode in production without the independent demo authorization", () => {
    expect(resolveDataConfig({ PROD: true, VITE_ACALYS_DATA_MODE: "fixtures" })).toMatchObject({ kind: "misconfigured" });
    expect(resolveDataConfig({ PROD: true, VITE_ACALYS_DATA_MODE: "fixtures", VITE_ACALYS_ALLOW_DEMO_DATA: "true" })).toEqual({ kind: "fixtures" });
  });

  it("never treats a missing production data-mode declaration as demo data", () => {
    expect(resolveDataConfig({ PROD: true })).toEqual({
      kind: "misconfigured",
      detail: "VITE_ACALYS_DATA_MODE must be set explicitly in production",
    });
  });
});
