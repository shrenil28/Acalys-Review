/**
 * The enforcement state for the review currently on screen.
 *
 * # Freshness is part of the answer
 *
 * A pre-merge result is only meaningful for the revision it evaluated. Without
 * that check:
 *
 * ```
 * head H1 → checks pass
 * new push, head H2
 * H1's response arrives late
 * → the page shows "merge allowed" for code nobody evaluated
 * ```
 *
 * So a response whose `reviewRunId` is not the one being displayed becomes
 * `unknown`, never `not_blocked`. The backend has been careful about revision
 * identity from ingestion onward; losing it at the final enforcement surface
 * would waste all of it.
 *
 * The abort handles the common case, but not the race where a response for the
 * previous review is already in flight when the identity changes — which is
 * exactly when a stale "allowed" would be most convincing.
 */

import { useEffect, useState } from "react";

import { gateFrom, type MergeGate } from "@/lib/premerge";

import { createApiClient } from "./client.js";
import { resolveDataMode } from "./config.js";
import { listPreMergeChecks } from "./preMergeChecks.js";
import type { ApiResult } from "./result.js";
import type { PreMergeCheckDto } from "@acalys/contracts/api/v1";

export type MergeGateState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly gate: MergeGate };

/**
 * What a response means for the review on screen.
 *
 * Exported, and a pure function, because it is the only implementation of
 * "a result for another revision is not permission" — and while it lived
 * inside the effect, deleting the freshness check left every test green. A
 * rule nothing can execute is a rule nothing defends.
 *
 * It decides only whether the response can be believed. What makes a gate
 * `blocked` rather than `not_blocked` is `gateFrom`'s business, and through it
 * the contract's; nothing about that policy is restated here.
 */
export function gateFromApiResult(
  result: ApiResult<{
    readonly items: readonly PreMergeCheckDto[];
    readonly nextCursor?: string;
  }>,
  reviewId: string,
): MergeGate {
  if (result.kind !== "ok") {
    // Every failure is `unknown`. A transport error means the frontend cannot
    // say whether merging is safe — which is not the same as knowing that it
    // is.
    return { kind: "unknown", reason: result.detail };
  }

  // A pre-merge result is only meaningful for the revision it evaluated. A
  // response for `run-OLD` displayed against `run-NEW` would read as
  // permission to merge code nobody checked.
  const stale = result.value.items.filter(
    (check) => check.reviewRunId !== reviewId,
  );
  if (stale.length > 0) {
    return {
      kind: "unknown",
      reason: "the checks returned were evaluated for another revision",
    };
  }

  return gateFrom(result.value.items);
}

export function useMergeGate(reviewId?: string): MergeGateState {
  const [state, setState] = useState<MergeGateState>({ status: "loading" });

  useEffect(() => {
    const mode = resolveDataMode();

    if (mode.kind === "misconfigured") {
      setState({
        status: "ready",
        gate: { kind: "unknown", reason: mode.detail },
      });
      return;
    }

    if (mode.kind === "fixtures") {
      // No backend to ask, so nothing is known about enforcement. Not
      // `not_blocked`: the app has no basis for saying a merge is safe.
      setState({
        status: "ready",
        gate: {
          kind: "unknown",
          reason: "pre-merge checks are not available in this build",
        },
      });
      return;
    }

    if (reviewId === undefined) {
      // `api` mode with no review to ask about: no request was made, so
      // nothing was evaluated. Its own reason rather than the fixtures one,
      // because the remedy differs — but the same answer, since both are ways
      // of not knowing. `useDeepScanFindings` splits the identical condition
      // the same way.
      setState({
        status: "ready",
        gate: {
          kind: "unknown",
          reason: "no review was given, so no pre-merge checks were requested",
        },
      });
      return;
    }

    const controller = new AbortController();
    const client = createApiClient({ baseUrl: mode.baseUrl });

    void listPreMergeChecks(client, reviewId, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({
          status: "ready",
          gate: gateFromApiResult(result, reviewId),
        });
      })
      .catch((error: unknown) => {
        // Without this, a throw inside the `.then` left the state at
        // `loading` forever, and the badge renders nothing while loading —
        // silence that looks identical to "nothing to report" instead of the
        // `unknown` this failure actually is.
        if (controller.signal.aborted) return;
        setState({
          status: "ready",
          gate: {
            kind: "unknown",
            reason:
              error instanceof Error ? error.message : "the request failed",
          },
        });
      });

    return () => {
      controller.abort();
    };
  }, [reviewId]);

  return state;
}
