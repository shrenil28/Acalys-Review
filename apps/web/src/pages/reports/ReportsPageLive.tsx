import { useEffect, useState } from "react";
import { FileText, Play, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { useToast } from "@/components/ui/Toast";
import { deleteDashboardReport, generateDashboardReport, loadDashboardReports, type DashboardReportDefinition } from "@/lib/api/dashboardAdmin";

export function ReportsPageLive() {
  const navigate=useNavigate(); const toast=useToast();
  const [reports,setReports]=useState<readonly DashboardReportDefinition[]>([]);
  const [state,setState]=useState<"loading"|"ready"|"failed">("loading");
  const [picking,setPicking]=useState(false); const [kind,setKind]=useState<"recurring"|"ondemand">("recurring");
  const [busy,setBusy]=useState<string|null>(null);
  const reload=async()=>{const result=await loadDashboardReports(); if(result.kind==="ok"){setReports(result.value.items);setState("ready");}else setState("failed");};
  useEffect(()=>{void reload();},[]);
  const remove=async(report:DashboardReportDefinition)=>{setBusy(report.id);const result=await deleteDashboardReport(report.id,report.revision);setBusy(null);if(result.kind==="ok"){setReports((items)=>items.filter((item)=>item.id!==report.id));toast({title:"Report deleted",tone:"info"});}else toast({title:"Report deletion rejected",description:"The report changed or could not be removed."});};
  const generate=async(report:DashboardReportDefinition)=>{setBusy(report.id);const result=await generateDashboardReport(report.id,report.revision);setBusy(null);if(result.kind==="ok"){toast({title:"Snapshot generated",description:`${result.value.snapshot.summary.reviews} review runs · ${result.value.snapshot.summary.findings} findings. Delivery is not configured in this checkpoint.`});void reload();}else toast({title:"Generation failed",description:"Acalys could not generate this report from the current live analytics snapshot."});};
  return <Page>
    <PageHeader title="Reports" description="Durable report definitions and manually generated evidence snapshots from live review analytics." />
    <TopBarActions><Button size="sm" variant="brand" icon={<Plus className="h-3.5 w-3.5"/>} onClick={()=>setPicking(true)}>Create report</Button></TopBarActions>
    {state==="loading"?<div className="mt-6 rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Loading live reports…</div>:state==="failed"?<div className="mt-6 rounded-lg border border-danger/30 bg-surface p-8 text-sm text-fg-subtle">Acalys could not load report definitions.</div>:reports.length===0?<div className="mt-8 flex min-h-[50vh] items-center justify-center"><div className="w-full max-w-xl rounded-xl border border-dashed border-line px-6 py-14 text-center"><FileText className="mx-auto h-9 w-9 text-fg-subtle"/><h2 className="mt-3 text-lg font-semibold text-fg">Create your first report</h2><p className="mt-2 text-sm text-fg-subtle">Reports snapshot the same authoritative analytics visible in the dashboard.</p><Button className="mt-5" variant="primary" onClick={()=>setPicking(true)}>Create report</Button></div></div>:<div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{reports.map((report)=><Card key={report.id}><CardBody className="space-y-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-medium text-fg">{report.name}</h3><p className="mt-1 text-xs text-fg-subtle">{report.kind==="recurring"?"Recurring definition":"On-demand"} · {report.destination.channel} · {report.groupBy==="none"?"No grouping":`Group by ${report.groupBy}`}</p></div><Badge tone={report.automationStatus==="manual"?"success":"neutral"}>{report.automationStatus==="manual"?"Manual":"Dispatcher unavailable"}</Badge></div><p className="text-xs text-fg-subtle">{report.lastGeneratedAt===null?"No snapshot generated yet":`Last generated ${new Date(report.lastGeneratedAt).toLocaleString()}`}</p><p className="text-xs text-fg-faint">Delivery status: not delivered</p><div className="flex items-center justify-end gap-1"><Button size="xs" variant="secondary" icon={<Play className="h-3 w-3"/>} disabled={busy===report.id} onClick={()=>void generate(report)}>{busy===report.id?"Working…":"Generate snapshot"}</Button><Button size="icon-sm" variant="ghost" aria-label={`Delete ${report.name}`} disabled={busy===report.id} onClick={()=>void remove(report)}><Trash2 className="h-3.5 w-3.5"/></Button></div></CardBody></Card>)}</div>}
    <Modal open={picking} onClose={()=>setPicking(false)} title="Select Report Type" size="sm" footer={<Button variant="primary" onClick={()=>{setPicking(false);navigate(`/reports/${kind}/new`);}}>Create report</Button>}><div className="space-y-2">{(["recurring","ondemand"] as const).map((value)=><button key={value} type="button" onClick={()=>setKind(value)} className={`w-full rounded-md border p-3 text-left ${kind===value?"border-brand bg-[var(--cr-hover)]":"border-line"}`}><p className="text-sm font-medium text-fg">{value==="recurring"?"Recurring":"On-demand test"}</p><p className="mt-1 text-xs text-fg-subtle">{value==="recurring"?"Store a schedule definition. Automatic dispatch remains unavailable until the report dispatcher is implemented.":"Create a definition and immediately generate a one-time live analytics snapshot."}</p></button>)}</div></Modal>
  </Page>;
}
