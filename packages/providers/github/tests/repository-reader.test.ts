import { describe, expect, it } from "vitest";

import {
  GithubRepositoryReadError,
  GithubRepositoryReader,
  type GithubRepositoryRequest,
  type GithubRepositoryRevision,
} from "../src/index.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const HEAD_BLOB = "d".repeat(40);
const BASE_BLOB = "e".repeat(40);

const revision: GithubRepositoryRevision = {
  installationId: 11,
  repositoryId: 22,
  owner: "acme",
  name: "repo",
  headSha: HEAD,
  baseSha: BASE,
};

function blob(sha: string, text: string) {
  return {
    sha,
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
    size: Buffer.byteLength(text, "utf8"),
  } as const;
}

function fixtureRequest(
  options: {
    readonly patch?: string | undefined;
    readonly headText?: string | undefined;
    readonly baseText?: string | undefined;
    readonly changedFiles?: number | undefined;
  } = {},
): GithubRepositoryRequest {
  const headText = options.headText ?? "one\ntwo\nthree\nfour\n";
  const baseText = options.baseText ?? "one\ntwo\nold\nfour\n";
  return async ({ path }) => {
    if (path.includes(`/compare/${BASE}...${HEAD}`)) {
      const count = options.changedFiles ?? 1;
      return {
        status: 200,
        body: {
          merge_base_commit: { sha: MERGE_BASE },
          files: Array.from({ length: count }, (_, index) => ({
            filename: index === 0 ? "src/a.ts" : `src/f-${String(index)}.ts`,
            status: "modified",
            patch:
              options.patch ??
              "@@ -1,4 +1,4 @@\n one\n two\n-old\n+three\n four",
          })),
        },
      };
    }
    if (path.includes(`/git/trees/${HEAD}?recursive=1`)) {
      return {
        status: 200,
        body: {
          sha: HEAD,
          truncated: false,
          tree: [
            {
              path: "src/a.ts",
              type: "blob",
              sha: HEAD_BLOB,
              size: Buffer.byteLength(headText),
            },
          ],
        },
      };
    }
    if (path.includes(`/git/trees/${BASE}?recursive=1`)) {
      return {
        status: 200,
        body: {
          sha: BASE,
          truncated: false,
          tree: [
            {
              path: "src/a.ts",
              type: "blob",
              sha: BASE_BLOB,
              size: Buffer.byteLength(baseText),
            },
          ],
        },
      };
    }
    if (path.includes(`/git/blobs/${HEAD_BLOB}`)) {
      return { status: 200, body: blob(HEAD_BLOB, headText) };
    }
    if (path.includes(`/git/blobs/${BASE_BLOB}`)) {
      return { status: 200, body: blob(BASE_BLOB, baseText) };
    }
    if (path.includes(`/contents/src/a.ts?ref=${HEAD}`)) {
      return {
        status: 200,
        body: { type: "file", ...blob(HEAD_BLOB, headText) },
      };
    }
    return { status: 404, body: undefined };
  };
}

describe("GitHub repository source adapter", () => {
  it("derives anchors from actual head-side diff lines and carries the merge base", async () => {
    const reader = new GithubRepositoryReader({ request: fixtureRequest() });
    const snapshot = await reader.readRevision(revision);

    expect(snapshot.baseSha).toBe(BASE);
    expect(snapshot.mergeBaseSha).toBe(MERGE_BASE);
    expect(snapshot.changed).toEqual([
      {
        path: "src/a.ts",
        content: "one\ntwo\nthree\nfour\n",
        changedLines: [3],
        base: { kind: "present", content: "one\ntwo\nold\nfour\n" },
      },
    ]);
    expect(snapshot.repository.get("src/a.ts")).toBe("one\ntwo\nthree\nfour\n");
  });

  it("refuses GitHub's compare-file completeness boundary rather than reviewing a truncated manifest", async () => {
    const reader = new GithubRepositoryReader({
      request: fixtureRequest({ changedFiles: 300 }),
    });
    await expect(reader.readRevision(revision)).rejects.toMatchObject({
      name: "GithubRepositoryReadError",
      code: "changed_files_truncated",
    });
  });

  it("refuses a binary changed file instead of treating missing text as clean", async () => {
    const binary = Buffer.from([0x61, 0x00, 0x62]);
    const request: GithubRepositoryRequest = async ({ path }) => {
      if (path.includes(`/compare/${BASE}...${HEAD}`)) {
        return {
          status: 200,
          body: {
            merge_base_commit: { sha: MERGE_BASE },
            files: [
              {
                filename: "src/a.ts",
                status: "modified",
                patch: "@@ -1 +1 @@\n-a\n+b",
              },
            ],
          },
        };
      }
      if (path.includes(`/git/trees/${HEAD}`)) {
        return {
          status: 200,
          body: {
            truncated: false,
            tree: [
              {
                path: "src/a.ts",
                type: "blob",
                sha: HEAD_BLOB,
                size: binary.length,
              },
            ],
          },
        };
      }
      if (path.includes(`/git/trees/${BASE}`)) {
        return { status: 200, body: { truncated: false, tree: [] } };
      }
      if (path.includes(`/git/blobs/${HEAD_BLOB}`)) {
        return {
          status: 200,
          body: {
            sha: HEAD_BLOB,
            encoding: "base64",
            content: binary.toString("base64"),
            size: binary.length,
          },
        };
      }
      return { status: 404, body: undefined };
    };

    const reader = new GithubRepositoryReader({ request });
    await expect(reader.readRevision(revision)).rejects.toBeInstanceOf(
      GithubRepositoryReadError,
    );
    await expect(reader.readRevision(revision)).rejects.toMatchObject({
      code: "binary_changed_file",
    });
  });

  it("performs an independent immutable head-file read for verification", async () => {
    const reader = new GithubRepositoryReader({ request: fixtureRequest() });
    expect(await reader.readTextFile(revision, "src/a.ts")).toBe(
      "one\ntwo\nthree\nfour\n",
    );
    expect(
      await reader.readTextFile(revision, "src/missing.ts"),
    ).toBeUndefined();
  });
});
