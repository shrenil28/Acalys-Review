import type { ReviewIngestionStore } from "@acalys/database";
import type {
  GithubBaseFile,
  GithubRepositoryReader,
  GithubRepositoryRevision,
} from "@acalys/provider-github";
import type { IndependentSourceReader } from "@acalys/review-engine";
import type { BaseRevisionResolution } from "@acalys/code-intelligence";

import type { AnalysisSource, AnalysisSourceSnapshot } from "./analysis.js";

export class AnalysisRevisionUnavailableError extends Error {
  public override readonly name = "AnalysisRevisionUnavailableError";

  public constructor(public readonly code: string) {
    super(`Analysis revision is unavailable: ${code}`);
  }
}

function positiveProviderId(value: string | null, code: string): number {
  if (value === null || !/^\d+$/.test(value)) {
    throw new AnalysisRevisionUnavailableError(`${code}-missing`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AnalysisRevisionUnavailableError(`${code}-invalid`);
  }
  return parsed;
}

function baseResolution(base: GithubBaseFile): BaseRevisionResolution {
  switch (base.kind) {
    case "present":
      return { kind: "present", content: base.content };
    case "absent":
      return { kind: "absent" };
    case "not_indexed":
      return { kind: "not_indexed" };
    case "unavailable":
      return { kind: "unavailable", because: base.reason };
  }
}

export interface GithubAnalysisSourceOptions {
  readonly ingestion: ReviewIngestionStore;
  readonly reader: GithubRepositoryReader;
}

async function locate(
  options: GithubAnalysisSourceOptions,
  input: {
    readonly repositoryId: string;
    readonly revisionId: string;
    readonly headSha?: string | undefined;
  },
): Promise<GithubRepositoryRevision> {
  const revision = await options.ingestion.findAnalysisRevision(input);
  if (revision === undefined) {
    throw new AnalysisRevisionUnavailableError("revision-not-found-or-stale");
  }
  if (revision.provider !== "github") {
    throw new AnalysisRevisionUnavailableError("provider-not-supported");
  }
  return {
    installationId: positiveProviderId(
      revision.installationId,
      "github-installation",
    ),
    repositoryId: positiveProviderId(
      revision.providerRepositoryId,
      "github-repository",
    ),
    owner: revision.owner,
    name: revision.name,
    headSha: revision.headSha,
    baseSha: revision.baseSha,
  };
}

/**
 * Production analyzer source backed by the GitHub adapter.
 *
 * It requires the immutable revision id. A repository/head pair alone is not a
 * sufficient key because one head can be reviewed against different bases.
 */
export function createGithubAnalysisSource(
  options: GithubAnalysisSourceOptions,
): AnalysisSource {
  return {
    async read(input): Promise<AnalysisSourceSnapshot> {
      if (input.revisionId === undefined) {
        throw new AnalysisRevisionUnavailableError("revision-id-required");
      }
      const revision = await locate(options, {
        repositoryId: input.repositoryId,
        revisionId: input.revisionId,
        headSha: input.headSha,
      });
      const snapshot = await options.reader.readRevision(revision);
      return {
        changed: snapshot.changed.map((file) => ({
          path: file.path,
          content: file.content,
          changedLines: file.changedLines,
          base: baseResolution(file.base),
        })),
        repository: snapshot.repository,
        baseSha: snapshot.baseSha,
        mergeBaseSha: snapshot.mergeBaseSha,
      };
    },
  };
}

/**
 * Independent verifier source. It intentionally performs a fresh provider read
 * for the exact revision instead of reusing the analyzer's assembled context.
 * Sharing source bytes is allowed; sharing the proposing inference is not.
 */
export function createGithubIndependentSource(options: {
  readonly ingestion: ReviewIngestionStore;
  readonly reader: GithubRepositoryReader;
  readonly repositoryId: string;
  readonly revisionId: string;
}): IndependentSourceReader {
  return {
    async readRange(input) {
      const revision = await locate(options, {
        repositoryId: options.repositoryId,
        revisionId: options.revisionId,
      });
      const content = await options.reader.readTextFile(revision, input.path);
      if (content === undefined) return undefined;
      const lines = content.split("\n");
      if (
        input.startLine < 1 ||
        input.endLine < input.startLine ||
        input.startLine > lines.length
      ) {
        return undefined;
      }
      return lines.slice(input.startLine - 1, input.endLine).join("\n");
    },
  };
}
