import type { FindingDto } from "@acalys/contracts/api/v1";

/**
 * A published finding, with the fields a test cares about overridable.
 *
 * Lives here rather than in a test file because importing one test module from
 * another re-runs it: `api-client.test.ts` pulled `dto` from
 * `findings.test.ts` and reported fourteen tests where six were written.
 */
export const dto = (overrides: Partial<FindingDto> = {}): FindingDto => ({
  id: "f1",
  repositoryId: "r1",
  reviewRunId: "run1",
  severity: "high",
  category: "correctness",
  confidence: "high",
  lifecycle: "published",
  title: "t",
  explanation: "e",
  path: "src/a.ts",
  startLine: 1,
  endLine: 2,
  evidenceCount: 1,
  hasSuggestedFix: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
