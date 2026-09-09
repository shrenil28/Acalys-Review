import { Buffer } from "node:buffer";

import { repositoryPath } from "@acalys/contracts/domain";
import { z } from "zod";

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const treeEntrySchema = z.object({
  path: z.string().min(1),
  type: z.enum(["blob", "tree", "commit"]),
  sha: gitShaSchema,
  size: z.number().int().nonnegative().optional(),
});
const treeSchema = z.object({
  sha: gitShaSchema.optional(),
  truncated: z.boolean().optional().default(false),
  tree: z.array(treeEntrySchema),
});
const blobSchema = z.object({
  sha: gitShaSchema,
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});
const contentFileSchema = z.object({
  type: z.literal("file"),
  sha: gitShaSchema,
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});
const compareFileSchema = z.object({
  filename: z.string().min(1),
  status: z.enum([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  previous_filename: z.string().min(1).optional(),
  patch: z.string().optional(),
});
const compareSchema = z.object({
  merge_base_commit: z.object({ sha: gitShaSchema }),
  files: z.array(compareFileSchema).optional(),
});

export interface GithubRepositoryResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Authenticated GitHub GET seam. The implementation owns installation-token
 * minting/refresh; repository reading never receives or logs a bearer token.
 */
export type GithubRepositoryRequest = (input: {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly path: string;
}) => Promise<GithubRepositoryResponse>;

export interface GithubRepositoryRevision {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly owner: string;
  readonly name: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export type GithubBaseFile =
  | { readonly kind: "present"; readonly content: string }
  | { readonly kind: "absent" }
  | { readonly kind: "not_indexed" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GithubChangedFile {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly number[];
  readonly base: GithubBaseFile;
}

export interface GithubRepositorySnapshot {
  readonly changed: readonly GithubChangedFile[];
  readonly repository: ReadonlyMap<string, string>;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
}

export interface GithubRepositoryReaderLimits {
  readonly maxFiles: number;
  readonly maxBlobBytes: number;
  readonly maxRepositoryBytes: number;
  readonly maxChangedFiles: number;
  readonly blobConcurrency: number;
}

export const DEFAULT_GITHUB_REPOSITORY_READER_LIMITS: GithubRepositoryReaderLimits = {
  maxFiles: 20_000,
  maxBlobBytes: 2 * 1024 * 1024,
  maxRepositoryBytes: 128 * 1024 * 1024,
  // GitHub's compare response is capped at 300 files. Refuse an exact cap rather
  // than risk treating a truncated response as a complete change manifest.
  maxChangedFiles: 299,
  blobConcurrency: 8,
};

export class GithubRepositoryReadError extends Error {
  public override readonly name = "GithubRepositoryReadError";

  public constructor(
    public readonly code:
      | "provider_failure"
      | "invalid_response"
      | "tree_truncated"
      | "repository_too_large"
      | "blob_too_large"
      | "changed_files_truncated"
      | "changed_patch_unavailable"
      | "binary_changed_file",
    detail: string,
  ) {
    super(`GitHub repository read failed: ${code}: ${detail}`);
  }
}

function assertLimits(limits: GithubRepositoryReaderLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function repoPrefix(owner: string, name: string): string {
  return `/repos/${encodeSegment(owner)}/${encodeSegment(name)}`;
}

function changedLinesFromPatch(patch: string): readonly number[] {
  const changed = new Set<number>();
  let nextHeadLine: number | undefined;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (match === null) {
        throw new GithubRepositoryReadError(
          "invalid_response",
          "compare patch contains an invalid hunk header",
        );
      }
      nextHeadLine = Number(match[1]);
      continue;
    }
    if (nextHeadLine === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(nextHeadLine);
      nextHeadLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // A deletion advances only the base side.
    } else if (line.startsWith("\\ No newline at end of file")) {
      // Metadata, not a source line.
    } else {
      nextHeadLine += 1;
    }
  }

  return [...changed].sort((left, right) => left - right);
}

function decodeTextBlob(body: z.infer<typeof blobSchema>): string | undefined {
  const bytes = Buffer.from(body.content.replace(/\s/g, ""), "base64");
  if (bytes.length !== body.size) {
    throw new GithubRepositoryReadError(
      "invalid_response",
      "blob decoded length does not match GitHub size",
    );
  }
  // NUL is a strong binary signal and avoids silently converting binary assets
  // into replacement-character text that the analyzer could mistake for code.
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) return undefined;
  return text;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value === undefined) return;
        result[index] = await fn(value);
      }
    },
  );
  await Promise.all(workers);
  return result;
}

export class GithubRepositoryReader {
  readonly #request: GithubRepositoryRequest;
  readonly #limits: GithubRepositoryReaderLimits;

  public constructor(options: {
    readonly request: GithubRepositoryRequest;
    readonly limits?: Partial<GithubRepositoryReaderLimits> | undefined;
  }) {
    this.#request = options.request;
    this.#limits = {
      ...DEFAULT_GITHUB_REPOSITORY_READER_LIMITS,
      ...options.limits,
    };
    assertLimits(this.#limits);
  }

  async #get<T>(
    installationId: number,
    repositoryId: number,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.#request({
      installationId,
      repositoryId,
      path,
    });
    if (response.status !== 200) {
      throw new GithubRepositoryReadError(
        "provider_failure",
        `GET ${path.split("?")[0] ?? path} returned status ${String(response.status)}`,
      );
    }
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) {
      throw new GithubRepositoryReadError(
        "invalid_response",
        `GET ${path.split("?")[0] ?? path} returned an unexpected shape`,
      );
    }
    return parsed.data;
  }

  async #tree(input: GithubRepositoryRevision, sha: string) {
    const tree = await this.#get(
      input.installationId,
      input.repositoryId,
      `${repoPrefix(input.owner, input.name)}/git/trees/${encodeSegment(sha)}?recursive=1`,
      treeSchema,
    );
    if (tree.truncated) {
      throw new GithubRepositoryReadError(
        "tree_truncated",
        "GitHub truncated the recursive tree; incomplete context is not reviewable",
      );
    }
    const blobs = tree.tree.filter((entry) => entry.type === "blob");
    if (blobs.length > this.#limits.maxFiles) {
      throw new GithubRepositoryReadError(
        "repository_too_large",
        `tree contains ${String(blobs.length)} blobs, limit ${String(this.#limits.maxFiles)}`,
      );
    }
    const declaredBytes = blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (declaredBytes > this.#limits.maxRepositoryBytes) {
      throw new GithubRepositoryReadError(
        "repository_too_large",
        `tree declares ${String(declaredBytes)} bytes, limit ${String(this.#limits.maxRepositoryBytes)}`,
      );
    }
    return blobs;
  }

  async #readBlob(
    input: GithubRepositoryRevision,
    sha: string,
    declaredSize: number | undefined,
  ): Promise<string | undefined> {
    if (declaredSize !== undefined && declaredSize > this.#limits.maxBlobBytes) {
      throw new GithubRepositoryReadError(
        "blob_too_large",
        `blob ${sha} declares ${String(declaredSize)} bytes`,
      );
    }
    const body = await this.#get(
      input.installationId,
      input.repositoryId,
      `${repoPrefix(input.owner, input.name)}/git/blobs/${encodeSegment(sha)}`,
      blobSchema,
    );
    if (body.size > this.#limits.maxBlobBytes) {
      throw new GithubRepositoryReadError(
        "blob_too_large",
        `blob ${sha} is ${String(body.size)} bytes`,
      );
    }
    return decodeTextBlob(body);
  }

  /** Fresh text read for the independent verifier. */
  public async readTextFile(
    input: GithubRepositoryRevision,
    path: string,
  ): Promise<string | undefined> {
    const canonical = repositoryPath(path);
    const encodedPath = canonical.split("/").map(encodeSegment).join("/");
    const response = await this.#request({
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      path: `${repoPrefix(input.owner, input.name)}/contents/${encodedPath}?ref=${encodeSegment(input.headSha)}`,
    });
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      throw new GithubRepositoryReadError(
        "provider_failure",
        `contents read for ${canonical} returned status ${String(response.status)}`,
      );
    }
    const parsed = contentFileSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new GithubRepositoryReadError(
        "invalid_response",
        `contents read for ${canonical} returned an unexpected shape`,
      );
    }
    if (parsed.data.size > this.#limits.maxBlobBytes) {
      throw new GithubRepositoryReadError(
        "blob_too_large",
        `contents read for ${canonical} exceeds configured blob limit`,
      );
    }
    return decodeTextBlob(parsed.data);
  }

  /**
   * Reads one immutable head/base pair. Every provider object is normalized
   * here; no GitHub response shape escapes this adapter.
   */
  public async readRevision(
    input: GithubRepositoryRevision,
  ): Promise<GithubRepositorySnapshot> {
    const compare = await this.#get(
      input.installationId,
      input.repositoryId,
      `${repoPrefix(input.owner, input.name)}/compare/${encodeSegment(input.baseSha)}...${encodeSegment(input.headSha)}`,
      compareSchema,
    );
    const compareFiles = compare.files ?? [];
    if (compareFiles.length > this.#limits.maxChangedFiles) {
      throw new GithubRepositoryReadError(
        "changed_files_truncated",
        "compare result reached the configured completeness ceiling",
      );
    }

    const [headTree, baseTree] = await Promise.all([
      this.#tree(input, input.headSha),
      this.#tree(input, input.baseSha),
    ]);
    const headByPath = new Map(headTree.map((entry) => [entry.path, entry] as const));
    const baseByPath = new Map(baseTree.map((entry) => [entry.path, entry] as const));

    const decodedHead = await mapConcurrent(
      headTree,
      this.#limits.blobConcurrency,
      async (entry) => ({
        entry,
        text: await this.#readBlob(input, entry.sha, entry.size),
      }),
    );
    const repository = new Map<string, string>();
    let observedBytes = 0;
    for (const { entry, text } of decodedHead) {
      if (text === undefined) continue;
      repositoryPath(entry.path);
      observedBytes += Buffer.byteLength(text, "utf8");
      if (observedBytes > this.#limits.maxRepositoryBytes) {
        throw new GithubRepositoryReadError(
          "repository_too_large",
          "decoded repository text exceeds configured byte limit",
        );
      }
      repository.set(entry.path, text);
    }

    const changed: GithubChangedFile[] = [];
    for (const file of compareFiles) {
      const path = repositoryPath(file.filename);
      const headEntry = headByPath.get(file.filename);
      const headContent = repository.get(file.filename);
      if (file.status !== "removed" && headEntry === undefined) {
        throw new GithubRepositoryReadError(
          "invalid_response",
          `changed path ${path} is absent from the head tree`,
        );
      }
      if (file.status !== "removed" && headContent === undefined) {
        throw new GithubRepositoryReadError(
          "binary_changed_file",
          `changed path ${path} is binary or not valid UTF-8`,
        );
      }
      if (file.status !== "removed" && file.patch === undefined) {
        throw new GithubRepositoryReadError(
          "changed_patch_unavailable",
          `GitHub omitted the patch for changed text path ${path}`,
        );
      }

      const basePath = file.status === "renamed" ? file.previous_filename : file.filename;
      let base: GithubBaseFile = { kind: "absent" };
      if (basePath !== undefined) {
        repositoryPath(basePath);
        const baseEntry = baseByPath.get(basePath);
        if (baseEntry !== undefined) {
          try {
            const baseText = await this.#readBlob(input, baseEntry.sha, baseEntry.size);
            base =
              baseText === undefined
                ? { kind: "unavailable", reason: "base file is binary or not valid UTF-8" }
                : { kind: "present", content: baseText };
          } catch (error) {
            base = {
              kind: "unavailable",
              reason:
                error instanceof GithubRepositoryReadError
                  ? error.code
                  : "provider read failed",
            };
          }
        }
      }

      changed.push({
        path,
        content: file.status === "removed" ? "" : (headContent ?? ""),
        changedLines: file.patch === undefined ? [] : changedLinesFromPatch(file.patch),
        base,
      });
    }

    return {
      changed,
      repository,
      baseSha: input.baseSha,
      mergeBaseSha: compare.merge_base_commit.sha,
    };
  }
}
