import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";
const Fixture = lazy(() => import("./AiDeepScanFixture").then((module) => ({ default: module.AiDeepScanPage })));
export function AiDeepScanPage({ reviewId }: { reviewId?: string }) {
  return <DeferredFeaturePage title="AI Deep Scan" description="Live security data is not fabricated from demo fixtures." owner="Phase 5 + Phase 6" reason="Deep scan execution and evidence require the sandboxed-tool and review-breadth phases." fixture={<Fixture reviewId={reviewId} />} />;
}
