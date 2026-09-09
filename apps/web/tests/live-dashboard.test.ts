import { describe, expect, it } from "vitest";
import type { KnowledgeItemDto, RepositoryDto } from "@acalys/contracts/api/v1";

import {
  failureSentence,
  knowledgeFromApi,
  repositoryFromApi,
} from "../src/lib/api/liveDashboard.js";

const repository: RepositoryDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "acalys/review",
  provider: "github",
  visibility: "private",
  defaultBranch: "main",
  reviewsEnabled: true,
  updatedAt: "2026-09-09T06:00:00.000Z",
};

describe("Phase-4 live dashboard adapters", () => {
  it("projects repository identity without inventing analytics", () => {
    expect(repositoryFromApi(repository)).toMatchObject({
      id: repository.id,
      name: repository.name,
      visibility: "Private",
      defaultBranch: "main",
      reviewsEnabled: true,
      language: null,
      openPrs: null,
      reviewsLast30d: null,
      commentsLast30d: null,
      lastReviewAt: null,
      security: {
        deepScan: null,
        dependencies: null,
        secrets: null,
        lastScanAt: null,
      },
    });
  });

  it("joins live knowledge to repository identity without fabricating usage", () => {
    const item: KnowledgeItemDto = {
      id: "22222222-2222-4222-8222-222222222222",
      sourceType: "learning",
      scope: "repository",
      repositoryId: repository.id,
      summary: "Keep provider adapters behind the canonical boundary.",
      authored: false,
      recordedAt: "2026-09-09T06:01:00.000Z",
    };

    const mappedRepository = repositoryFromApi(repository);
    expect(knowledgeFromApi(item, [mappedRepository])).toMatchObject({
      id: item.id,
      scope: "Repository",
      repositoryId: repository.id,
      repo: repository.name,
      content: item.summary,
      source: "learning",
      appliedCount: null,
      author: null,
    });
  });


  it("preserves path-scoped knowledge instead of flattening it to repository scope", () => {
    const item: KnowledgeItemDto = {
      id: "33333333-3333-4333-8333-333333333333",
      sourceType: "path_instruction",
      scope: "path",
      repositoryId: repository.id,
      path: "packages/database/**",
      summary: "Use tenant-qualified foreign keys in persistence code.",
      authored: true,
    };

    expect(knowledgeFromApi(item, [repositoryFromApi(repository)])).toMatchObject({
      scope: "Path",
      repo: repository.name,
      path: "packages/database/**",
    });
  });

  it("keeps transport, contract, authorization and throttling failures distinct", () => {
    expect(failureSentence({ kind: "transport", detail: "offline" })).toMatch(/reach/i);
    expect(failureSentence({ kind: "contract", detail: "bad dto" })).toMatch(/understand/i);
    expect(
      failureSentence({
        kind: "rejected",
        status: 401,
        category: "unauthorized",
        detail: "401",
      }),
    ).toMatch(/sign in/i);
    expect(
      failureSentence({
        kind: "rejected",
        status: 429,
        category: "throttled",
        detail: "429",
      }),
    ).toMatch(/too many requests/i);
  });

  it("does not turn an absent resource into an empty-success sentence", () => {
    expect(
      failureSentence({
        kind: "rejected",
        status: 404,
        category: "absent",
        detail: "404",
      }),
    ).toMatch(/no longer exists/i);
  });
});
