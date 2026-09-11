import type { LiveFailure } from "@/lib/api/liveDashboard";
import { lazy, Suspense, useEffect, useState } from "react";
import { LiveFailureState, LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, Field } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Misc";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { resolveDataConfig } from "@/lib/api/config";
import { useDashboardSession } from "@/components/auth/DashboardSessionGate";
import {
  loadNotificationPreferences,
  updateNotificationPreferences,
  type DashboardNotificationPreferences,
} from "@/lib/api/dashboardAdmin";

const FixtureSettings = lazy(() => import("./SettingsFixture").then((module) => ({ default: module.SettingsPage })));

type NotificationKey = "reviewComplete" | "criticalFinding" | "weeklyDigest" | "productUpdates";
const notificationRows: readonly [NotificationKey, string, string][] = [
  ["reviewComplete", "Review complete", "When a review finishes on a PR you authored."],
  ["criticalFinding", "Critical finding", "As soon as a critical security finding opens."],
  ["weeklyDigest", "Weekly digest", "A Monday summary of last week's review activity."],
  ["productUpdates", "Product updates", "Occasional notes about new Acalys features."],
];

export function SettingsPage() {
  const config = resolveDataConfig();
  if (config.kind === "fixtures") return <Suspense fallback={null}><FixtureSettings /></Suspense>;
  if (config.kind === "misconfigured") return <Page className="max-w-3xl"><LiveMisconfiguredState detail={config.detail} /></Page>;
  return <LiveSettings />;
}

function LiveSettings() {
  const session = useDashboardSession();
  const toast = useToast();
  const [baseline, setBaseline] = useState<DashboardNotificationPreferences | null>(null);
  const [draft, setDraft] = useState<DashboardNotificationPreferences | null>(null);
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadNotificationPreferences(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") { setBaseline(result.value); setDraft(result.value); setFailure(null); return; }
      if (result.kind === "rejected") setFailure({ kind: "rejected", status: result.status, category: result.category, detail: result.detail });
      else if (result.kind === "transport" || result.kind === "contract") setFailure({ kind: result.kind, detail: result.detail });
      else setFailure({ kind: "contract", detail: result.detail });
    });
    return () => controller.abort();
  }, []);

  if (session === null) return null;
  const dirty = baseline !== null && draft !== null && notificationRows.some(([key]) => baseline[key] !== draft[key]);
  const save = async () => {
    if (baseline === null || draft === null || saving) return;
    setSaving(true);
    const result = await updateNotificationPreferences({ ...draft, revision: baseline.revision });
    if (result.kind === "ok") {
      setBaseline(result.value); setDraft(result.value); setSaving(false);
      toast({ title: "Notification preferences saved", tone: "success" }); return;
    }
    const authoritative = await loadNotificationPreferences();
    if (authoritative.kind === "ok") { setBaseline(authoritative.value); setDraft(authoritative.value); }
    else { setDraft(baseline); }
    setSaving(false);
    toast({ title: "Notification preferences were not saved", description: `${result.detail} The authoritative preferences were restored.`, tone: "error" });
  };

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Settings" description="Your personal account. Organization-wide review behaviour lives in Review → Organization Settings." />
      <div className="mt-6 space-y-4 pb-16">
        <Card>
          <CardHeader title="Profile" description="Identity fields are synchronized by your sign-in provider." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name"><Input value={session.user.displayName ?? "—"} readOnly className="text-fg-subtle" /></Field>
            <Field label="Email"><Input value={session.user.email ?? "—"} readOnly className="text-fg-subtle" /></Field>
            <Field label="Provider"><Input value={session.user.provider} readOnly className="text-fg-subtle" /></Field>
            <Field label="Organization"><Input value={session.organization.name} readOnly className="text-fg-subtle" /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Notifications" description="Personal preferences are versioned per organization membership." />
          <CardBody className="divide-y divide-line py-0">
            {failure !== null && draft === null ? <div className="py-4"><LiveFailureState failure={failure} /></div> : null}
            {draft === null && failure === null ? <p className="py-4 text-sm text-fg-subtle">Loading notification preferences…</p> : null}
            {draft !== null ? notificationRows.map(([key, title, description]) => (
              <div key={key} className="flex items-start justify-between gap-6 py-3">
                <div><p className="text-sm text-fg">{title}</p><p className="mt-0.5 text-xs text-fg-subtle">{description}</p></div>
                <Switch checked={draft[key]} disabled={saving} onChange={(value) => setDraft((current) => current === null ? current : { ...current, [key]: value })} label={title} />
              </div>
            )) : null}
            {draft !== null ? <div className="flex items-center justify-between gap-3 py-3">
              <p className="text-xs text-fg-subtle">Revision {baseline?.revision ?? 0}{baseline?.updatedAt ? ` · updated ${new Date(baseline.updatedAt).toLocaleString()}` : " · using defaults"}</p>
              <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => baseline !== null && setDraft(baseline)}>Reset</Button><Button size="sm" variant="brand" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></div>
            </div> : null}
          </CardBody>
        </Card>
      </div>
    </Page>
  );
}
