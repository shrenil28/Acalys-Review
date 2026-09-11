import {
  evidenceStrengthSchema,
  evidenceTypeSchema,
  findingCategorySchema,
  findingSeveritySchema,
} from "@acalys/contracts/domain";
import { REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES } from "@acalys/database";
import {
  CORRECTNESS_FAMILIES,
  SUPPRESSION_REASONS,
  type AnalysisCache,
  type AnalysisResult,
} from "@acalys/review-engine";
import { z } from "zod";

const cacheLocationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  side: z.enum(["base", "head"]).optional(),
}).refine((value) => value.endLine >= value.startLine, {
  message: "cache finding location endLine must not precede startLine",
});

const cacheEvidenceSchema = z.strictObject({
  type: evidenceTypeSchema,
  strength: evidenceStrengthSchema,
  observation: z.string().min(1),
  location: cacheLocationSchema.optional(),
});

const cacheFindingSchema = z.strictObject({
  ruleId: z.string().min(1),
  category: findingCategorySchema,
  family: z.enum(CORRECTNESS_FAMILIES),
  claim: z.string().min(1),
  causal: z.strictObject({
    anchor: cacheLocationSchema,
    steps: z.array(z.string().min(1)).min(1),
    trigger: z.string().min(1),
    consequence: z.string().min(1),
  }),
  remediation: z.string().min(1),
  counterfactual: z.strictObject({
    existsWithoutChange: z.boolean(),
    because: z.string(),
  }),
  proposedSeverity: findingSeveritySchema,
  confidenceScore: z.number().finite().min(0).max(1),
  location: cacheLocationSchema,
  evidence: z.array(cacheEvidenceSchema).min(1),
  identityHint: z.string().min(1),
  clusterId: z.string().min(1),
});

const cacheAnalysisResultSchema = z.strictObject({
  findings: z.array(cacheFindingSchema),
  suppressions: z.array(z.strictObject({
    reason: z.enum(SUPPRESSION_REASONS),
    ruleId: z.string().min(1),
    clusterId: z.string().min(1),
    detail: z.string().min(1),
  })),
  degradations: z.array(z.strictObject({
    clusterId: z.string().min(1),
    reason: z.string().min(1),
  })),
});

/**
 * Treat persisted cache rows as untrusted optimization data.
 *
 * A malformed or oversized row must never become review input. Invalid cache
 * state therefore returns undefined and the caller recomputes the cluster.
 */
export function decodeAnalysisCachePayload(value: unknown): AnalysisResult | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES
  ) {
    return undefined;
  }
  const parsed = cacheAnalysisResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface PreloadedAnalysisCache {
  readonly cache: AnalysisCache;
  readonly hits: Set<string>;
  readonly writes: Map<string, AnalysisResult>;
}

export function createPreloadedAnalysisCache(
  entries: readonly { readonly fingerprint: string; readonly payload: unknown }[],
): PreloadedAnalysisCache {
  const values = new Map<string, AnalysisResult>();
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}$/u.test(entry.fingerprint)) continue;
    const parsed = decodeAnalysisCachePayload(entry.payload);
    if (parsed !== undefined) values.set(entry.fingerprint, parsed);
  }
  const hits = new Set<string>();
  const writes = new Map<string, AnalysisResult>();
  return {
    hits,
    writes,
    cache: {
      get(fingerprint) {
        const value = values.get(fingerprint);
        if (value !== undefined) hits.add(fingerprint);
        return value;
      },
      set(fingerprint, result) {
        values.set(fingerprint, result);
        writes.set(fingerprint, result);
      },
    },
  };
}
