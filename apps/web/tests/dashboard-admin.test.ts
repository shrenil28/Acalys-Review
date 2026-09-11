import { describe, expect, it } from "vitest";
import { dashboardScopeOptions, githubLoginStartUrl } from "../src/lib/api/dashboardAdmin.js";

describe("Phase 4 dashboard administration adapter", () => {
  it("builds a GitHub login start URL without placing a session credential in it", () => {
    const url = githubLoginStartUrl("https://api.acalys.test", "/review/triage?repo=42");
    expect(url).toBe("https://api.acalys.test/dashboard/v1/auth/github/start?returnTo=%2Freview%2Ftriage%3Frepo%3D42");
    expect(url).not.toContain("acalys_session_");
  });

  it("exposes exactly the Phase-3 public scopes rather than fixture-only report scopes", () => {
    expect(dashboardScopeOptions).toEqual([
      "repositories:read", "reviews:read", "reviews:write", "findings:read",
      "findings:write", "conversations:read", "conversations:write", "knowledge:read",
    ]);
    expect(dashboardScopeOptions).not.toContain("reports:read");
  });
});
