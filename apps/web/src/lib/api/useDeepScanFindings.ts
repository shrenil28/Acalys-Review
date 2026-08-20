/**
 * Where the deep-scan page gets its findings.
 *
 * Fetching lives here rather than in a component, so the presentational tree
 * stays exactly what it was and the same components render fixtures, real data,
 * and test data without knowing which they were given.
 *
 * # The one fallback, and where it is chosen
 *
 * With no `VITE_ACALYS_API_URL`, this returns the fixtures the app has always
 * rendered. That fallback is chosen at **configuration** time, when no backend
 * exists to ask.
 *
 * There is deliberately no fallback at **failure** time. If an API is
 * configured and the request fails, this reports `failed` — it does not quietly
 * show fixtures, because a surface that substitutes plausible data for a failed
 * request is lying in the most convincing way available to it.
 *
 * That is the frontend restatement of a rule the backend already enforces: a
 * verifier outage must not read as a clean review.
 */

import { useEffect, useState } from "react";

import { deepScanFindings, type DeepScanFinding } from "@/data/security";
import { toFindingViews, type FindingView } from "@/lib/findings";

import { createApiClient } from "./client.js";
import { apiBaseUrl } from "./config.js";
import { listReviewFindings } from "./reviewFindings.js";

export type DeepScanState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly findings: readonly DeepScanFinding[] }
  /**
   * The request did not produce an answer.
   *
   * Its own state, never an empty list: "the review found nothing" is a
   * success the product reports proudly, and reaching it from a failure would
   * make an outage indistinguishable from good news.
   */
  | { readonly status: "failed"; readonly detail: string };

/**
 * Fills the fields the API does not yet carry.
 *
 * `FindingDto` has no `subsystem`, `remediation`, `cwe` or repository name —
 * they are tier-2 and tier-3 work on the backend, recorded in the P1-K
 * inventory. They are left empty rather than invented: a plausible-looking
 * value here would be indistinguishable from a real one.
 */
function toDeepScanFinding(view: FindingView): DeepScanFinding {
  return {
    id: view.id,
    category: view.category,
    repo: "",
    subsystem: "",
    status: view.status,
    severity: view.severity,
    file: view.file,
    line: view.line,
    summary: view.title,
    detail: view.explanation,
    remediation: "",
    detectedAt: view.detectedAt,
  };
}

export function useDeepScanFindings(reviewId?: string): DeepScanState {
  const [state, setState] = useState<DeepScanState>({ status: "loading" });

  useEffect(() => {
    const baseUrl = apiBaseUrl();

    if (baseUrl === undefined || reviewId === undefined) {
      // No backend to ask. The app renders what it has always rendered.
      setState({ status: "ready", findings: deepScanFindings });
      return;
    }

    const controller = new AbortController();
    const client = createApiClient({ baseUrl });

    void listReviewFindings(client, reviewId, {
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setState(
        result.kind === "ok"
          ? {
              status: "ready",
              findings: toFindingViews(result.value.items).map(
                toDeepScanFinding,
              ),
            }
          : { status: "failed", detail: result.detail },
      );
    });

    return () => {
      controller.abort();
    };
  }, [reviewId]);

  return state;
}
