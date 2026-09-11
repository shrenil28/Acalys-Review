import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { CreateReportLive } from "./CreateReportLive";
const Fixture=lazy(()=>import("./CreateReportFixture").then((module)=>({default:module.CreateReport})));
export function CreateReport({kind}:{kind:"recurring"|"ondemand"}){const mode=resolveDataMode();return mode.kind==="fixtures"?<Suspense fallback={null}><Fixture kind={kind}/></Suspense>:<CreateReportLive kind={kind}/>;}
