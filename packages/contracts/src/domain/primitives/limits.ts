/**
 * Maximum sizes for untrusted strings and collections (P0.txt §65, §97).
 *
 * Almost every string in these contracts originates outside the platform: a PR
 * description written by anyone with push access, a tool's error output, a
 * model-authored explanation. Without caps, one 4 MB PR body becomes a 4 MB
 * queue message, a 4 MB row, and a 4 MB payload re-validated on every worker
 * hop.
 *
 * The rule these numbers encode: **bounded text lives in the contract, unbounded
 * content lives in an artifact** (§45). A finding explanation is a paragraph;
 * a full analyzer log is an `ArtifactReference`.
 *
 * Limits are counted in UTF-16 code units (JavaScript's `String.length`), the
 * unit both Zod and Postgres `varchar` use, so a value that validates here also
 * fits its column.
 */

/** Bounds on human- or model-authored prose. */
export const TEXT_LIMITS = {
  /** Titles and one-line labels. */
  title: 512,
  /** A short paragraph: finding claims, summaries, verification reasons. */
  summary: 4_000,
  /**
   * Multi-paragraph prose: finding explanations, review overviews. Anything
   * longer is a document and belongs in an artifact.
   */
  explanation: 16_000,
  /**
   * PR/MR descriptions. Generous because providers allow long templates, but
   * still bounded — GitHub itself caps bodies at 65_536.
   */
  description: 65_536,
  /** Comment and conversation message bodies. */
  commentBody: 65_536,
  /** Natural-language path instructions from `.acalys.yaml`. */
  instructions: 8_000,
  /** Identifiers, names, refs, and other short opaque strings. */
  identifier: 256,
  /** Glob patterns. A pattern longer than this is a mistake, not a pattern. */
  glob: 1_024,
  /** URLs and storage references. */
  url: 2_048,
} as const;

/**
 * Bounds on array sizes.
 *
 * These protect the same budget from the other direction: 10_000 evidence
 * references of 4 KB each is a 40 MB message even though every individual
 * string was within limits.
 */
export const COLLECTION_LIMITS = {
  /** Evidence supporting one finding (§97). */
  evidencePerFinding: 100,
  /** Path instruction rules in one resolved config (§97). */
  pathInstructions: 500,
  /** Areas listed in a review summary (§97). */
  summaryAreas: 100,
  /**
   * Files in a single `ChangeManifest`. Beyond this the change is not
   * reviewable file-by-file and the pipeline must sample or split.
   */
  changedFiles: 5_000,
  /** Labels on a pull request. */
  labels: 100,
  /** Reviewers on a pull request. */
  reviewers: 100,
  /** Edits in one suggested fix. */
  fixEdits: 100,
  /** Findings referenced by one pre-merge check result. */
  checkEvidence: 100,
} as const;

/**
 * Byte ceiling for a single artifact reference's declared size.
 *
 * The reference is metadata — the bytes live in object storage — but a
 * declared size still bounds what a worker will attempt to download. 2 GiB is
 * the practical ceiling for a single analyzer log or repository snapshot.
 */
export const MAX_ARTIFACT_BYTES = 2_147_483_648;

export type TextLimitName = keyof typeof TEXT_LIMITS;
export type CollectionLimitName = keyof typeof COLLECTION_LIMITS;
