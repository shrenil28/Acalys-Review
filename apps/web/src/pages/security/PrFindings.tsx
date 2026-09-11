import { lazy, Suspense } from "react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Page } from "@/components/layout/PageHeader";
import { resolveDataMode } from "@/lib/api/config";
import { PrFindingsLive } from "./PrFindingsLive";
const Fixture = lazy(() => import("./PrFindingsFixture").then((module) => ({ default: module.PrFindingsPage })));
export function PrFindingsPage() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={null}><Fixture /></Suspense>;
  if (mode.kind === "misconfigured") return <Page><LiveMisconfiguredState detail={mode.detail} /></Page>;
  return <PrFindingsLive />;
}
