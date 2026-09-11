import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { useDashboardSession } from "@/components/auth/DashboardSessionGate";
import { resolveDataMode } from "@/lib/api/config";
import {
  loadOrganizationReviewSettings,
  updateOrganizationReviewSettings,
  type DashboardOrganizationReviewConfig,
  type DashboardOrganizationReviewSettings,
} from "@/lib/api/dashboardAdmin";
import { OrganizationSettingsEditor } from "./OrganizationSettingsEditor";

const Fixture = lazy(() => import("./OrganizationSettingsFixture").then((module) => ({ default: module.OrganizationSettingsPage })));

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly settings: DashboardOrganizationReviewSettings };

export function OrganizationSettingsPage() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={null}><Fixture /></Suspense>;
  if (mode.kind === "misconfigured") return <Page className="max-w-3xl"><LiveMisconfiguredState detail={mode.detail} /></Page>;
  return <LiveOrganizationSettings />;
}

function LiveOrganizationSettings() {
  const session = useDashboardSession();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const refresh = async (signal?: AbortSignal) => {
    const result = await loadOrganizationReviewSettings(signal);
    if (result.kind === "ok") {
      setState({ kind: "ready", settings: result.value });
      return result.value;
    }
    if (signal?.aborted) return undefined;
    setState({ kind: "failed", message: "Acalys could not load the authoritative organization review settings." });
    return undefined;
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  const previewAuthor = useMemo(() => {
    if (session === null) return undefined;
    return {
      name: session.user.displayName ?? session.user.email ?? session.user.providerUserId,
      avatarUrl: "",
    };
  }, [session]);

  if (state.kind === "loading") {
    return <Page className="max-w-3xl"><PageHeader title="Organization Settings" description="Loading authoritative review configuration…" /><div className="mt-6 rounded-lg border border-line bg-surface p-6 text-sm text-fg-subtle">Loading organization review settings…</div></Page>;
  }
  if (state.kind === "failed") {
    return <Page className="max-w-3xl"><PageHeader title="Organization Settings" description="Organization review configuration" /><div className="mt-6 rounded-lg border border-line bg-surface p-6"><p className="text-sm text-fg">Couldn’t load organization settings.</p><p className="mt-2 text-sm text-fg-subtle">{state.message}</p><button type="button" className="mt-4 rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-[var(--cr-hover)]" onClick={() => { setState({ kind: "loading" }); void refresh(); }}>Retry</button></div></Page>;
  }

  const save = async (config: DashboardOrganizationReviewConfig): Promise<DashboardOrganizationReviewConfig> => {
    const expectedRevision = state.settings.revision;
    const result = await updateOrganizationReviewSettings(expectedRevision, config);
    if (result.kind === "ok") {
      setState({ kind: "ready", settings: result.value });
      return result.value.config;
    }

    // A failed optimistic write must never remain displayed as if it were saved.
    const latest = await loadOrganizationReviewSettings();
    if (latest.kind === "ok") setState({ kind: "ready", settings: latest.value });

    if (result.kind === "rejected" && result.status === 409) {
      throw new Error("These settings changed on the server. The authoritative configuration has been restored.");
    }
    if (result.kind === "rejected" && result.status === 403) {
      throw new Error("Your current organization role cannot update review settings.");
    }
    throw new Error("Acalys could not save these settings. The last confirmed server configuration has been restored.");
  };

  const runtimeCount = state.settings.capabilities.filter((capability) => capability.runtimeEnforced).length;
  const summary = `${runtimeCount} settings groups currently affect review execution. Other persisted controls remain stored-only until their runtime owner is implemented.`;

  return (
    <OrganizationSettingsEditor
      initialConfig={state.settings.config}
      onApply={save}
      repositoryLabel={session?.organization.name ?? "this organization"}
      {...(previewAuthor === undefined ? {} : { previewAuthor })}
      capabilitySummary={summary}
    />
  );
}
