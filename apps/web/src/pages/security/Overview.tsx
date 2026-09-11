import { lazy, Suspense } from "react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Page } from "@/components/layout/PageHeader";
import { resolveDataMode } from "@/lib/api/config";
import { SecurityOverviewLive } from "./OverviewLive";
const Fixture = lazy(() => import("./OverviewFixture").then((module) => ({ default: module.SecurityOverview })));
export function SecurityOverview() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={null}><Fixture /></Suspense>;
  if (mode.kind === "misconfigured") return <Page><LiveMisconfiguredState detail={mode.detail} /></Page>;
  return <SecurityOverviewLive />;
}
