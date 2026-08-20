import {
  INCLUSION_REASONS,
  estimateTokens,
  type InclusionReason,
  type ItemProvenance,
} from "../planner.js";

export const L5_CONTEXT_SCHEMA_VERSION = 1 as const;

export const L5_REPORT_REASONS = [
  "declaration",
  "caller",
  "test",
  "config",
  "instruction",
  "coverage",
  "changed_source",
  "other",
] as const;

export type L5ReportReason = (typeof L5_REPORT_REASONS)[number];

export const L5_FACT_FAMILIES = [
  "structural_index",
  "binding",
  "test_relationship",
  "config_governance",
  "instruction_governance",
  "none",
] as const;

export type L5FactFamily = (typeof L5_FACT_FAMILIES)[number];

export const UNDEFINED_RATIO = "undefinedRatio" as const;
export type L5Ratio = number | typeof UNDEFINED_RATIO;

const REPORT_REASON_BY_PRODUCTION_REASON = {
  changed_hunk: "changed_source",
  containing_symbol: "declaration",
  indexed_declaration: "declaration",
  referenced_symbol: "declaration",
  caller: "caller",
  associated_test: "test",
  configuration: "config",
  repository_instruction: "instruction",
  path_instruction: "instruction",
  instruction_coverage: "coverage",
  prior_finding: "other",
  git_history: "other",
} as const satisfies Readonly<Record<InclusionReason, L5ReportReason>>;

const PRODUCTION_REASON_SET = new Set<string>(INCLUSION_REASONS);
const PROVENANCE_SOURCE_MEMBERS = {
  direct_source: true,
  repository_index: true,
  configuration_facts: true,
  instruction_facts: true,
  instruction_coverage: true,
} as const satisfies Readonly<Record<ItemProvenance["source"], true>>;

const PROVENANCE_SOURCES = new Set<string>(
  Object.keys(PROVENANCE_SOURCE_MEMBERS),
);

const DIRECT_SOURCE_REASONS = new Set<InclusionReason>([
  "changed_hunk",
  "containing_symbol",
  "referenced_symbol",
  "caller",
  "associated_test",
  "repository_instruction",
  "path_instruction",
  "prior_finding",
  "git_history",
]);

export class InvalidL5ContextObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidL5ContextObservationError";
  }
}

function productionReason(reason: string): InclusionReason {
  if (!PRODUCTION_REASON_SET.has(reason)) {
    throw new InvalidL5ContextObservationError(
      `Unknown production inclusion reason: ${reason}`,
    );
  }
  return reason as InclusionReason;
}

export function reportReasonFor(reason: string): L5ReportReason {
  return REPORT_REASON_BY_PRODUCTION_REASON[productionReason(reason)];
}

export function factFamilyFor(
  reasonValue: string,
  provenanceSourceValue?: string,
): L5FactFamily {
  const reason = productionReason(reasonValue);
  const provenanceSource = provenanceSourceValue ?? "direct_source";

  if (!PROVENANCE_SOURCES.has(provenanceSource)) {
    throw new InvalidL5ContextObservationError(
      `Unknown production provenance source: ${provenanceSource}`,
    );
  }

  if (provenanceSource === "direct_source") {
    if (DIRECT_SOURCE_REASONS.has(reason)) return "none";
  } else if (provenanceSource === "repository_index") {
    if (reason === "indexed_declaration") return "structural_index";
    if (reason === "referenced_symbol" || reason === "caller") {
      return "binding";
    }
    if (reason === "associated_test") return "test_relationship";
  } else if (
    provenanceSource === "configuration_facts" &&
    reason === "configuration"
  ) {
    return "config_governance";
  } else if (
    provenanceSource === "instruction_facts" &&
    (reason === "repository_instruction" || reason === "path_instruction")
  ) {
    return "instruction_governance";
  } else if (
    provenanceSource === "instruction_coverage" &&
    reason === "instruction_coverage"
  ) {
    return "instruction_governance";
  }

  throw new InvalidL5ContextObservationError(
    `Unrecognized production reason/provenance combination: ${reason}/${provenanceSource}`,
  );
}

export interface L5ContextCandidateObservation {
  readonly candidateId: string;
  readonly path: string;
  readonly reason: string;
  readonly provenanceSource?: string | undefined;
  /** The original candidate text used for offered/scored size estimates. */
  readonly originalContent: string;
  /** Repository line represented by the first line of originalContent. */
  readonly originalStartLine?: number | undefined;
}

export interface L5SuppliedSourceSlice {
  readonly originalStartByte: number;
  readonly suppliedStartByte: number;
  readonly byteLength: number;
}

export interface L5SelectedContextObservation {
  readonly candidateId: string;
  readonly suppliedContent: string;
  readonly truncated: boolean;
  /**
   * One-to-one byte mappings from originalContent into suppliedContent.
   * Synthetic headers and summaries are intentionally left unmapped.
   */
  readonly sourceSlices?: readonly L5SuppliedSourceSlice[] | undefined;
}

export type L5ContextSelector =
  | { readonly kind: "whole_artifact"; readonly path: string }
  | {
      readonly kind: "line_range";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    }
  | {
      readonly kind: "content";
      readonly path: string;
      readonly content: string;
    };

export interface L5ContextLabel {
  readonly labelId: string;
  readonly classification: "required" | "forbidden";
  readonly selector: L5ContextSelector;
}

export interface L5ContextAccountingInput {
  readonly offered: readonly L5ContextCandidateObservation[];
  /** Candidate ids surviving scoring and deterministic candidate deduplication. */
  readonly scoredCandidateIds: readonly string[];
  readonly selected: readonly L5SelectedContextObservation[];
  /** Scored candidates not selected for the assembled context. */
  readonly omittedCandidateIds: readonly string[];
  readonly labels: readonly L5ContextLabel[];
}

export interface L5StageTotals {
  readonly items: number;
  readonly estimatedTokens: number;
}

export interface L5TruncationTotals {
  readonly items: number;
  readonly originalEstimatedTokens: number;
  readonly suppliedEstimatedTokens: number;
  readonly droppedEstimatedTokens: number;
}

export interface L5ContextBucket {
  readonly offered: L5StageTotals;
  readonly scored: L5StageTotals;
  readonly selected: L5StageTotals;
  readonly omitted: L5StageTotals;
  readonly truncated: L5TruncationTotals;
}

export interface L5ContextDetailRow {
  readonly candidateId: string;
  readonly path: string;
  readonly productionReason: InclusionReason;
  readonly reportReason: L5ReportReason;
  readonly factFamily: L5FactFamily;
  readonly offeredEstimatedTokens: number;
  readonly scored: boolean;
  readonly selected: boolean;
  readonly omitted: boolean;
  readonly selectedEstimatedTokens: number;
  readonly truncated: boolean;
}

export interface L5SelectedClassification {
  readonly all: L5StageTotals;
  readonly usefulBytes: number;
  readonly usefulEstimatedTokens: number;
  readonly irrelevantBytes: number;
  readonly irrelevantEstimatedTokens: number;
  readonly unlabelledBytes: number;
  readonly unlabelledEstimatedTokens: number;
  readonly contextEfficiency: L5Ratio;
}

export interface L5ContextAccounting {
  readonly schemaVersion: typeof L5_CONTEXT_SCHEMA_VERSION;
  readonly totals: L5ContextBucket;
  readonly byReason: Readonly<Record<L5ReportReason, L5ContextBucket>>;
  readonly byFamily: Readonly<Record<L5FactFamily, L5ContextBucket>>;
  readonly details: readonly L5ContextDetailRow[];
  readonly duplicatesSuppressed: number;
  readonly selectedClassification: L5SelectedClassification;
  readonly reconciliation: {
    readonly scoredPartition: true;
    readonly reasonRows: true;
    readonly familyRows: true;
    readonly selectedBytes: true;
  };
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

interface NormalizedSelected {
  readonly observation: L5SelectedContextObservation;
  readonly slices: readonly L5SuppliedSourceSlice[];
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidL5ContextObservationError(
      `${name} must be a non-negative integer`,
    );
  }
}

function uniqueIds(ids: readonly string[], stage: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const id of ids) {
    if (id.length === 0) {
      throw new InvalidL5ContextObservationError(
        `${stage} contains an empty id`,
      );
    }
    result.add(id);
  }
  return result;
}

function sameSelection(
  left: L5SelectedContextObservation,
  right: L5SelectedContextObservation,
): boolean {
  if (
    left.candidateId !== right.candidateId ||
    left.suppliedContent !== right.suppliedContent ||
    left.truncated !== right.truncated
  ) {
    return false;
  }
  const sortSlices = (
    slices: readonly L5SuppliedSourceSlice[] | undefined,
  ): readonly L5SuppliedSourceSlice[] =>
    [...(slices ?? [])].sort(
      (a, b) =>
        a.suppliedStartByte - b.suppliedStartByte ||
        a.originalStartByte - b.originalStartByte ||
        a.byteLength - b.byteLength,
    );
  const leftSlices = sortSlices(left.sourceSlices);
  const rightSlices = sortSlices(right.sourceSlices);
  return (
    leftSlices.length === rightSlices.length &&
    leftSlices.every(
      (slice, index) =>
        slice.originalStartByte === rightSlices[index]?.originalStartByte &&
        slice.suppliedStartByte === rightSlices[index]?.suppliedStartByte &&
        slice.byteLength === rightSlices[index]?.byteLength,
    )
  );
}

function validateLabels(labels: readonly L5ContextLabel[]): void {
  const ids = new Set<string>();
  for (const label of labels) {
    if (label.labelId.length === 0 || ids.has(label.labelId)) {
      throw new InvalidL5ContextObservationError(
        `Context label id must be unique and non-empty: ${label.labelId}`,
      );
    }
    ids.add(label.labelId);
    if (
      label.classification !== "required" &&
      label.classification !== "forbidden"
    ) {
      throw new InvalidL5ContextObservationError(
        `Unknown context label classification: ${String(label.classification)}`,
      );
    }
    const selector = label.selector;
    if (
      selector.kind !== "whole_artifact" &&
      selector.kind !== "line_range" &&
      selector.kind !== "content"
    ) {
      throw new InvalidL5ContextObservationError(
        `Unknown context selector kind: ${String((selector as { kind?: unknown }).kind)}`,
      );
    }
    if (selector.path.length === 0) {
      throw new InvalidL5ContextObservationError(
        `Context selector path must be non-empty: ${label.labelId}`,
      );
    }
    if (selector.kind === "line_range") {
      if (
        !Number.isInteger(selector.startLine) ||
        !Number.isInteger(selector.endLine) ||
        selector.startLine < 1 ||
        selector.endLine < selector.startLine
      ) {
        throw new InvalidL5ContextObservationError(
          "Invalid line_range selector",
        );
      }
    } else if (selector.kind === "content" && selector.content.length === 0) {
      throw new InvalidL5ContextObservationError(
        "content selector must not be empty",
      );
    }
  }
}

function normalizeIntervals(
  intervals: readonly Interval[],
): readonly Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result: Interval[] = [];

  for (const interval of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || interval.start > previous.end) {
      result.push(interval);
      continue;
    }
    result[result.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, interval.end),
    };
  }
  return result;
}

function intersect(left: Interval, right: Interval): Interval | undefined {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  return end > start ? { start, end } : undefined;
}

function intervalLength(intervals: readonly Interval[]): number {
  return intervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0,
  );
}

function complement(
  intervals: readonly Interval[],
  byteLength: number,
): readonly Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const interval of normalizeIntervals(intervals)) {
    if (cursor < interval.start)
      result.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < byteLength) result.push({ start: cursor, end: byteLength });
  return result;
}

function overlappingBytes(
  left: readonly Interval[],
  right: readonly Interval[],
): number {
  let total = 0;
  for (const leftInterval of left) {
    for (const rightInterval of right) {
      const overlap = intersect(leftInterval, rightInterval);
      if (overlap !== undefined) total += overlap.end - overlap.start;
    }
  }
  return total;
}

function lineRangeInterval(
  content: Buffer,
  originalStartLine: number,
  startLine: number,
  endLine: number,
): Interval | undefined {
  if (
    !Number.isInteger(originalStartLine) ||
    originalStartLine < 1 ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new InvalidL5ContextObservationError("Invalid line_range selector");
  }

  const starts = [0];
  for (let offset = 0; offset < content.length; offset += 1) {
    if (content[offset] === 0x0a) starts.push(offset + 1);
  }
  const localStart = startLine - originalStartLine;
  const localEnd = endLine - originalStartLine;
  if (localEnd < 0 || localStart >= starts.length) return undefined;

  const clampedStart = Math.max(localStart, 0);
  const clampedEnd = Math.min(localEnd, starts.length - 1);
  return {
    start: starts[clampedStart] ?? content.length,
    end: starts[clampedEnd + 1] ?? content.length,
  };
}

function contentIntervals(
  content: Buffer,
  selected: string,
): readonly Interval[] {
  if (selected.length === 0) {
    throw new InvalidL5ContextObservationError(
      "content selector must not be empty",
    );
  }
  const needle = Buffer.from(selected, "utf8");
  const intervals: Interval[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const found = content.indexOf(needle, offset);
    if (found === -1) break;
    intervals.push({ start: found, end: found + needle.length });
    offset = found + 1;
  }
  return normalizeIntervals(intervals);
}

function selectorIntervals(
  candidate: L5ContextCandidateObservation,
  selector: L5ContextSelector,
): readonly Interval[] {
  if (selector.path !== candidate.path) return [];
  const original = Buffer.from(candidate.originalContent, "utf8");
  if (selector.kind === "whole_artifact") {
    return original.length === 0 ? [] : [{ start: 0, end: original.length }];
  }
  if (selector.kind === "content") {
    return contentIntervals(original, selector.content);
  }
  const interval = lineRangeInterval(
    original,
    candidate.originalStartLine ?? 1,
    selector.startLine,
    selector.endLine,
  );
  return interval === undefined ? [] : [interval];
}

function normalizeSelected(
  candidate: L5ContextCandidateObservation,
  observation: L5SelectedContextObservation,
): NormalizedSelected {
  const original = Buffer.from(candidate.originalContent, "utf8");
  const supplied = Buffer.from(observation.suppliedContent, "utf8");
  const suppliedSlices = observation.sourceSlices;
  const slices =
    suppliedSlices === undefined
      ? candidate.originalContent === observation.suppliedContent
        ? [
            {
              originalStartByte: 0,
              suppliedStartByte: 0,
              byteLength: original.length,
            },
          ]
        : (() => {
            throw new InvalidL5ContextObservationError(
              `Selected candidate ${candidate.candidateId} needs sourceSlices because suppliedContent differs from originalContent`,
            );
          })()
      : [...suppliedSlices];

  const ordered = slices.sort(
    (left, right) =>
      left.suppliedStartByte - right.suppliedStartByte ||
      left.originalStartByte - right.originalStartByte,
  );
  let suppliedEnd = 0;
  for (const [index, slice] of ordered.entries()) {
    assertNonNegativeInteger(slice.originalStartByte, "originalStartByte");
    assertNonNegativeInteger(slice.suppliedStartByte, "suppliedStartByte");
    assertNonNegativeInteger(slice.byteLength, "byteLength");
    const originalEnd = slice.originalStartByte + slice.byteLength;
    const nextSuppliedEnd = slice.suppliedStartByte + slice.byteLength;
    if (originalEnd > original.length || nextSuppliedEnd > supplied.length) {
      throw new InvalidL5ContextObservationError(
        `Source slice for ${candidate.candidateId} is out of bounds`,
      );
    }
    if (index > 0 && slice.suppliedStartByte < suppliedEnd) {
      throw new InvalidL5ContextObservationError(
        `Source slices for ${candidate.candidateId} overlap in suppliedContent`,
      );
    }
    if (
      !original
        .subarray(slice.originalStartByte, originalEnd)
        .equals(supplied.subarray(slice.suppliedStartByte, nextSuppliedEnd))
    ) {
      throw new InvalidL5ContextObservationError(
        `Source slice for ${candidate.candidateId} does not preserve bytes`,
      );
    }
    suppliedEnd = nextSuppliedEnd;
  }

  return { observation, slices: ordered };
}

function selectedIntervalsFor(
  candidate: L5ContextCandidateObservation,
  selected: NormalizedSelected,
  selectors: readonly L5ContextSelector[],
): readonly Interval[] {
  const originalIntervals = normalizeIntervals(
    selectors.flatMap((selector) => selectorIntervals(candidate, selector)),
  );
  const suppliedIntervals: Interval[] = [];
  for (const slice of selected.slices) {
    const originalSlice = {
      start: slice.originalStartByte,
      end: slice.originalStartByte + slice.byteLength,
    };
    for (const originalInterval of originalIntervals) {
      const overlap = intersect(originalSlice, originalInterval);
      if (overlap === undefined) continue;
      suppliedIntervals.push({
        start:
          slice.suppliedStartByte + (overlap.start - slice.originalStartByte),
        end: slice.suppliedStartByte + (overlap.end - slice.originalStartByte),
      });
    }
  }
  return normalizeIntervals(suppliedIntervals);
}

function emptyStage(): L5StageTotals {
  return { items: 0, estimatedTokens: 0 };
}

function emptyTruncation(): L5TruncationTotals {
  return {
    items: 0,
    originalEstimatedTokens: 0,
    suppliedEstimatedTokens: 0,
    droppedEstimatedTokens: 0,
  };
}

function emptyBucket(): L5ContextBucket {
  return {
    offered: emptyStage(),
    scored: emptyStage(),
    selected: emptyStage(),
    omitted: emptyStage(),
    truncated: emptyTruncation(),
  };
}

function addStage(left: L5StageTotals, tokens: number): L5StageTotals {
  return {
    items: left.items + 1,
    estimatedTokens: left.estimatedTokens + tokens,
  };
}

function addRowToBucket(
  bucket: L5ContextBucket,
  row: L5ContextDetailRow,
  originalTokens: number,
  suppliedTokens: number,
): L5ContextBucket {
  return {
    offered: addStage(bucket.offered, originalTokens),
    scored: row.scored
      ? addStage(bucket.scored, originalTokens)
      : bucket.scored,
    selected: row.selected
      ? addStage(bucket.selected, suppliedTokens)
      : bucket.selected,
    omitted: row.omitted
      ? addStage(bucket.omitted, originalTokens)
      : bucket.omitted,
    truncated: row.truncated
      ? {
          items: bucket.truncated.items + 1,
          originalEstimatedTokens:
            bucket.truncated.originalEstimatedTokens + originalTokens,
          suppliedEstimatedTokens:
            bucket.truncated.suppliedEstimatedTokens + suppliedTokens,
          droppedEstimatedTokens:
            bucket.truncated.droppedEstimatedTokens +
            Math.max(0, originalTokens - suppliedTokens),
        }
      : bucket.truncated,
  };
}

function bucketsFor<T extends string>(
  keys: readonly T[],
): Record<T, L5ContextBucket> {
  return Object.fromEntries(keys.map((key) => [key, emptyBucket()])) as Record<
    T,
    L5ContextBucket
  >;
}

function sameStage(left: L5StageTotals, right: L5StageTotals): boolean {
  return (
    left.items === right.items && left.estimatedTokens === right.estimatedTokens
  );
}

function sumBuckets(buckets: readonly L5ContextBucket[]): L5ContextBucket {
  return buckets.reduce<L5ContextBucket>(
    (total, bucket) => ({
      offered: {
        items: total.offered.items + bucket.offered.items,
        estimatedTokens:
          total.offered.estimatedTokens + bucket.offered.estimatedTokens,
      },
      scored: {
        items: total.scored.items + bucket.scored.items,
        estimatedTokens:
          total.scored.estimatedTokens + bucket.scored.estimatedTokens,
      },
      selected: {
        items: total.selected.items + bucket.selected.items,
        estimatedTokens:
          total.selected.estimatedTokens + bucket.selected.estimatedTokens,
      },
      omitted: {
        items: total.omitted.items + bucket.omitted.items,
        estimatedTokens:
          total.omitted.estimatedTokens + bucket.omitted.estimatedTokens,
      },
      truncated: {
        items: total.truncated.items + bucket.truncated.items,
        originalEstimatedTokens:
          total.truncated.originalEstimatedTokens +
          bucket.truncated.originalEstimatedTokens,
        suppliedEstimatedTokens:
          total.truncated.suppliedEstimatedTokens +
          bucket.truncated.suppliedEstimatedTokens,
        droppedEstimatedTokens:
          total.truncated.droppedEstimatedTokens +
          bucket.truncated.droppedEstimatedTokens,
      },
    }),
    emptyBucket(),
  );
}

function sameBucket(left: L5ContextBucket, right: L5ContextBucket): boolean {
  return (
    sameStage(left.offered, right.offered) &&
    sameStage(left.scored, right.scored) &&
    sameStage(left.selected, right.selected) &&
    sameStage(left.omitted, right.omitted) &&
    left.truncated.items === right.truncated.items &&
    left.truncated.originalEstimatedTokens ===
      right.truncated.originalEstimatedTokens &&
    left.truncated.suppliedEstimatedTokens ===
      right.truncated.suppliedEstimatedTokens &&
    left.truncated.droppedEstimatedTokens ===
      right.truncated.droppedEstimatedTokens
  );
}

export function accountL5Context(
  input: L5ContextAccountingInput,
): L5ContextAccounting {
  validateLabels(input.labels);
  const offered = new Map<string, L5ContextCandidateObservation>();
  for (const candidate of input.offered) {
    if (candidate.candidateId.length === 0) {
      throw new InvalidL5ContextObservationError(
        "offered contains an empty id",
      );
    }
    if (offered.has(candidate.candidateId)) {
      throw new InvalidL5ContextObservationError(
        `Duplicate offered candidate id: ${candidate.candidateId}`,
      );
    }
    reportReasonFor(candidate.reason);
    factFamilyFor(candidate.reason, candidate.provenanceSource);
    if (
      candidate.originalStartLine !== undefined &&
      (!Number.isInteger(candidate.originalStartLine) ||
        candidate.originalStartLine < 1)
    ) {
      throw new InvalidL5ContextObservationError(
        `Invalid originalStartLine for ${candidate.candidateId}`,
      );
    }
    offered.set(candidate.candidateId, candidate);
  }

  const scored = uniqueIds(input.scoredCandidateIds, "scoredCandidateIds");
  const omitted = uniqueIds(input.omittedCandidateIds, "omittedCandidateIds");
  for (const id of [...scored, ...omitted]) {
    if (!offered.has(id)) {
      throw new InvalidL5ContextObservationError(`Unknown candidate id: ${id}`);
    }
  }

  const selectedById = new Map<string, L5SelectedContextObservation>();
  for (const selection of input.selected) {
    if (!scored.has(selection.candidateId)) {
      throw new InvalidL5ContextObservationError(
        `Selected candidate was not scored: ${selection.candidateId}`,
      );
    }
    const previous = selectedById.get(selection.candidateId);
    if (previous !== undefined) {
      if (!sameSelection(previous, selection)) {
        throw new InvalidL5ContextObservationError(
          `Conflicting duplicate selection: ${selection.candidateId}`,
        );
      }
      continue;
    }
    selectedById.set(selection.candidateId, selection);
  }

  for (const id of scored) {
    const isSelected = selectedById.has(id);
    const isOmitted = omitted.has(id);
    if (isSelected === isOmitted) {
      throw new InvalidL5ContextObservationError(
        `Scored candidate ${id} must be exactly one of selected or omitted`,
      );
    }
  }
  for (const id of omitted) {
    if (!scored.has(id)) {
      throw new InvalidL5ContextObservationError(
        `Omitted candidate was not scored: ${id}`,
      );
    }
  }

  const normalizedSelections = new Map<string, NormalizedSelected>();
  for (const [id, selection] of selectedById) {
    const candidate = offered.get(id);
    if (candidate === undefined)
      throw new Error("validated selected candidate");
    normalizedSelections.set(id, normalizeSelected(candidate, selection));
  }

  const byReason = bucketsFor(L5_REPORT_REASONS);
  const byFamily = bucketsFor(L5_FACT_FAMILIES);
  let totals = emptyBucket();
  const details: L5ContextDetailRow[] = [];

  for (const candidate of input.offered) {
    const selection = normalizedSelections.get(
      candidate.candidateId,
    )?.observation;
    const originalTokens = estimateTokens(candidate.originalContent);
    const suppliedTokens =
      selection === undefined ? 0 : estimateTokens(selection.suppliedContent);
    const reportReason = reportReasonFor(candidate.reason);
    const factFamily = factFamilyFor(
      candidate.reason,
      candidate.provenanceSource,
    );
    const row: L5ContextDetailRow = {
      candidateId: candidate.candidateId,
      path: candidate.path,
      productionReason: productionReason(candidate.reason),
      reportReason,
      factFamily,
      offeredEstimatedTokens: originalTokens,
      scored: scored.has(candidate.candidateId),
      selected: selection !== undefined,
      omitted: omitted.has(candidate.candidateId),
      selectedEstimatedTokens: suppliedTokens,
      truncated: selection?.truncated ?? false,
    };
    details.push(row);
    totals = addRowToBucket(totals, row, originalTokens, suppliedTokens);
    byReason[reportReason] = addRowToBucket(
      byReason[reportReason],
      row,
      originalTokens,
      suppliedTokens,
    );
    byFamily[factFamily] = addRowToBucket(
      byFamily[factFamily],
      row,
      originalTokens,
      suppliedTokens,
    );
  }

  const requiredSelectors = input.labels
    .filter((label) => label.classification === "required")
    .map((label) => label.selector);
  const forbiddenSelectors = input.labels
    .filter((label) => label.classification === "forbidden")
    .map((label) => label.selector);
  let usefulBytes = 0;
  let usefulCharacters = 0;
  let irrelevantBytes = 0;
  let irrelevantCharacters = 0;
  let unlabelledBytes = 0;
  let unlabelledCharacters = 0;

  for (const [id, selection] of normalizedSelections) {
    const candidate = offered.get(id);
    if (candidate === undefined)
      throw new Error("validated selected candidate");
    const supplied = Buffer.from(selection.observation.suppliedContent, "utf8");
    const useful = selectedIntervalsFor(
      candidate,
      selection,
      requiredSelectors,
    );
    const irrelevant = selectedIntervalsFor(
      candidate,
      selection,
      forbiddenSelectors,
    );
    if (overlappingBytes(useful, irrelevant) > 0) {
      throw new InvalidL5ContextObservationError(
        `Required and forbidden selectors overlap for ${candidate.candidateId}`,
      );
    }
    const labelled = normalizeIntervals([...useful, ...irrelevant]);
    const unlabelled = complement(labelled, supplied.length);
    usefulBytes += intervalLength(useful);
    irrelevantBytes += intervalLength(irrelevant);
    unlabelledBytes += intervalLength(unlabelled);
    usefulCharacters += useful.reduce(
      (total, interval) =>
        total +
        supplied.subarray(interval.start, interval.end).toString("utf8").length,
      0,
    );
    irrelevantCharacters += irrelevant.reduce(
      (total, interval) =>
        total +
        supplied.subarray(interval.start, interval.end).toString("utf8").length,
      0,
    );
    unlabelledCharacters += unlabelled.reduce(
      (total, interval) =>
        total +
        supplied.subarray(interval.start, interval.end).toString("utf8").length,
      0,
    );
  }

  const selectedBytes = [...normalizedSelections.values()].reduce(
    (total, selection) =>
      total + Buffer.byteLength(selection.observation.suppliedContent, "utf8"),
    0,
  );
  if (usefulBytes + irrelevantBytes + unlabelledBytes !== selectedBytes) {
    throw new InvalidL5ContextObservationError(
      "Selected byte classifications do not reconcile",
    );
  }

  const reasonSum = sumBuckets(L5_REPORT_REASONS.map((key) => byReason[key]));
  const familySum = sumBuckets(L5_FACT_FAMILIES.map((key) => byFamily[key]));
  if (!sameBucket(reasonSum, totals) || !sameBucket(familySum, totals)) {
    throw new InvalidL5ContextObservationError(
      "Reason or family totals do not reconcile",
    );
  }

  const usefulEstimatedTokens =
    usefulCharacters === 0 ? 0 : Math.ceil(usefulCharacters / 4);
  const selectedEstimatedTokens = totals.selected.estimatedTokens;
  return {
    schemaVersion: L5_CONTEXT_SCHEMA_VERSION,
    totals,
    byReason,
    byFamily,
    details,
    duplicatesSuppressed: input.offered.length - scored.size,
    selectedClassification: {
      all: {
        items: normalizedSelections.size,
        estimatedTokens: selectedEstimatedTokens,
      },
      usefulBytes,
      usefulEstimatedTokens,
      irrelevantBytes,
      irrelevantEstimatedTokens:
        irrelevantCharacters === 0 ? 0 : Math.ceil(irrelevantCharacters / 4),
      unlabelledBytes,
      unlabelledEstimatedTokens:
        unlabelledCharacters === 0 ? 0 : Math.ceil(unlabelledCharacters / 4),
      contextEfficiency:
        selectedEstimatedTokens === 0
          ? UNDEFINED_RATIO
          : usefulEstimatedTokens / selectedEstimatedTokens,
    },
    reconciliation: {
      scoredPartition: true,
      reasonRows: true,
      familyRows: true,
      selectedBytes: true,
    },
  };
}
