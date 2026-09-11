import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";
const fixtureModule = () => import("./PlanPagesFixture");
const FixtureDiscover = lazy(() => fixtureModule().then((module) => ({ default: module.PlanDiscover })));
const FixtureNew = lazy(() => fixtureModule().then((module) => ({ default: module.NewPlan })));
const FixturePlans = lazy(() => fixtureModule().then((module) => ({ default: module.PlansList })));
const FixtureConfigurations = lazy(() => fixtureModule().then((module) => ({ default: module.PlanConfigurations })));
const reason = "The current roadmap has no approved implementation phase for the coding planner. Phase 4 records this gap instead of inventing a browser-only backend.";
export function PlanDiscover() { return <DeferredFeaturePage title="Discover plans" description="Discover coding-plan opportunities." owner="Roadmap gap — phase approval required" reason={reason} fixture={<FixtureDiscover />} />; }
export function NewPlan() { return <DeferredFeaturePage title="New plan" description="Generate a coding plan from an issue or brief." owner="Roadmap gap — phase approval required" reason={reason} fixture={<FixtureNew />} />; }
export function PlansList() { return <DeferredFeaturePage title="Plans" description="Saved coding plans." owner="Roadmap gap — phase approval required" reason={reason} fixture={<FixturePlans />} />; }
export function PlanConfigurations() { return <DeferredFeaturePage title="Plan configurations" description="Planner rulesets and defaults." owner="Roadmap gap — phase approval required" reason={reason} fixture={<FixtureConfigurations />} />; }
