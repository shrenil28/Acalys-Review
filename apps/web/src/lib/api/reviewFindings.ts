/**
 * The one endpoint this slice reads: findings a review published.
 *
 * Deliberately one. The point of the first data path is to establish a
 * trustworthy seam, not an SDK — twelve endpoints built on an architecture
 * nobody has exercised is twelve endpoints to revisit.
 */

import { findingDtoSchema, pageDtoSchema } from "@acalys/contracts/api/v1";
import type { FindingDto } from "@acalys/contracts/api/v1";

import type { ApiClient } from "./client.js";
import type { ApiResult } from "./result.js";

const responseSchema = pageDtoSchema(findingDtoSchema);

export function listReviewFindings(
  client: ApiClient,
  reviewId: string,
  init?: { readonly signal?: AbortSignal | undefined },
): Promise<ApiResult<{ items: readonly FindingDto[]; nextCursor?: string }>> {
  return client.get(
    `/reviews/${encodeURIComponent(reviewId)}/findings`,
    responseSchema,
    init,
  );
}
