import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { ReportsPageLive } from "./ReportsPageLive";
const Fixture=lazy(()=>import("./ReportsPageFixture").then((module)=>({default:module.ReportsPage})));
export function ReportsPage(){const mode=resolveDataMode();return mode.kind==="fixtures"?<Suspense fallback={null}><Fixture/></Suspense>:<ReportsPageLive/>;}
