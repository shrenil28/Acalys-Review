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
import { resolveDataMode } from "./config.js";
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
  | { readonly status: "failed"; readonly detail: string }
  /**
   * The build does not say where its data comes from.
   *
   * Its own state rather than `failed`, because the remedy is a deployment
   * variable and not a retry — and because it must never resolve to fixtures.
   */
  | { readonly status: "misconfigured"; readonly detail: string };

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
    const mode = resolveDataMode();

    if (mode.kind === "misconfigured") {
      // Never fixtures. A build that cannot say where its data comes from must
      // not pick the option that looks like working software.
      setState({ status: "misconfigured", detail: mode.detail });
      return;
    }

    if (mode.kind === "fixtures") {
      setState({ status: "ready", findings: deepScanFindings });
      return;
    }

    if (reviewId === undefined) {
      // ── `api` mode with nothing to ask about ──────────────────────────
      //
      // This condition used to share a branch with `fixtures`, and the caller
      // passes no `reviewId`: a correctly configured production build showed
      // seven hand-written fabrications as the user's security posture. The
      // two conditions are not the same fact. `fixtures` is a data source
      // somebody selected; a missing review id in `api` mode means no request
      // was made, and nothing was learned.
      //
      // So it reports not knowing, exactly as `useMergeGate` reports
      // `unknown` for the same condition. Fixtures are a deliberately
      // selected data source, never a fallback.
      setState({
        status: "misconfigured",
        detail:
          "an API is configured but this view was not given a review to load",
      });
      return;
    }

    const controller = new AbortController();
    const client = createApiClient({ baseUrl: mode.baseUrl });

    void listReviewFindings(client, reviewId, {
      signal: controller.signal,
    }).then((result) => {
      // Aborted means this request was superseded or the component unmounted.
      // Neither is a failure, and rendering one would flash "could not load"
      // during ordinary navigation — and would let a late response from a
      // previous request overwrite the current one.
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
    })
      .catch((error: unknown) => {
        // A throw inside the `.then` — or one from the client before it ever
        // returns a result — used to leave the page on the skeleton forever,
        // which reads as "still working" rather than "this failed". An
        // unfinished load must not be indistinguishable from a slow one.
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          detail:
            error instanceof Error ? error.message : "the request failed",
        });
      });

    return () => {
      controller.abort();
    };
  }, [reviewId]);

  return state;
}
