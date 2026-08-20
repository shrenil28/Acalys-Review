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

export type MergeGateState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly gate: MergeGate };

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

    if (mode.kind === "fixtures" || reviewId === undefined) {
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

    const controller = new AbortController();
    const client = createApiClient({ baseUrl: mode.baseUrl });

    void listPreMergeChecks(client, reviewId, {
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;

      if (result.kind !== "ok") {
        // Every failure is `unknown`. A transport error means the frontend
        // cannot say whether merging is safe — which is not the same as
        // knowing that it is.
        setState({
          status: "ready",
          gate: { kind: "unknown", reason: result.detail },
        });
        return;
      }

      const stale = result.value.items.filter(
        (check) => check.reviewRunId !== reviewId,
      );
      if (stale.length > 0) {
        setState({
          status: "ready",
          gate: {
            kind: "unknown",
            reason: "the checks returned were evaluated for another revision",
          },
        });
        return;
      }

      setState({ status: "ready", gate: gateFrom(result.value.items) });
    });

    return () => {
      controller.abort();
    };
  }, [reviewId]);

  return state;
}
