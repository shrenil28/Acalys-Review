import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";

const Fixture = lazy(() => import("./ExploreFixture").then((module) => ({ default: module.ExplorePage })));

export function ExplorePage() {
  return <DeferredFeaturePage title="Explore" description="Product overview and recent review activity." owner="Phase 13" reason="Aggregate activity, usage, and overview metrics require the analytics backend." fixture={<Fixture />} />;
}
