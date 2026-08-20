import { Badge } from "@/components/ui/Badge";
import { useMergeGate } from "@/lib/api/useMergeGate";

/**
 * Whether this review blocks merging, when that is known.
 *
 * # Silence, not reassurance
 *
 * Renders **nothing** when the gate is `unknown` — a failed request, an
 * unfinished check, a result for another revision, or a build with no backend.
 * The alternative is a badge reading "not blocked", which would be a claim the
 * app has no basis for.
 *
 * ```
 * merging is allowed, and we know it     say so
 * we do not know                         say nothing
 * ```
 *
 * Absence is honest. A green badge derived from a failed request is the
 * enforcement equivalent of reporting an outage as a clean review — the same
 * defect this seam already fixed once on the findings surface.
 *
 * It follows that this renders nothing in the fixtures build, which is
 * correct: nothing has evaluated anything, so there is nothing to report. The
 * existing UI is therefore unchanged until a backend is configured.
 *
 * # Nothing here decides anything
 *
 * Blocking comes from the backend's own result. This does not read findings,
 * does not consult severity, and counts nothing — re-deriving enforcement from
 * what is displayed is the last remaining way to undo the separation P1-I
 * established.
 */
export function MergeGateBadge({ reviewId }: { reviewId?: string }) {
  const state = useMergeGate(reviewId);

  if (state.status === "loading") return null;
  if (state.gate.kind === "unknown") return null;

  return state.gate.kind === "blocked" ? (
    <Badge tone="danger" dot>
      Merge blocked
    </Badge>
  ) : (
    <Badge tone="success" dot>
      Merge not blocked
    </Badge>
  );
}
