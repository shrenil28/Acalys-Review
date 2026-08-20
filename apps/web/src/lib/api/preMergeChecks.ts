/**
 * Pre-merge check results for a review.
 *
 * Deliberately its own endpoint. Deriving enforcement from the findings
 * response — "some published finding is critical, so the merge is blocked" —
 * would rebuild the policy in the browser and undo the separation the backend
 * spent P1-I establishing.
 */

import {
  pageDtoSchema,
  preMergeCheckDtoSchema,
} from "@acalys/contracts/api/v1";
import type { PreMergeCheckDto } from "@acalys/contracts/api/v1";

import type { ApiClient } from "./client.js";
import type { ApiResult } from "./result.js";

const responseSchema = pageDtoSchema(preMergeCheckDtoSchema);

export function listPreMergeChecks(
  client: ApiClient,
  reviewId: string,
  init?: { readonly signal?: AbortSignal | undefined },
): Promise<
  ApiResult<{ items: readonly PreMergeCheckDto[]; nextCursor?: string }>
> {
  return client.get(
    `/reviews/${encodeURIComponent(reviewId)}/pre-merge-checks`,
    responseSchema,
    init,
  );
}
