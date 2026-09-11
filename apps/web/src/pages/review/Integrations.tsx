import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CircleDot, Copy, Info, Loader2, Server, Ticket, Trash2, Unplug } from "lucide-react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { GitHubIcon, LinearIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import {
  beginLinearAuthorization,
  connectCircleCi,
  createJiraInstallationChallenge,
  createMcpServer,
  disconnectDashboardIntegration,
  loadDashboardIntegrations,
  loadProviderConnections,
  removeMcpServer,
  updateCircleCiIntegration,
  updateLinearIntegration,
  type DashboardIntegrationView,
} from "@/lib/api/dashboardAdmin";
import { resolveDataConfig } from "@/lib/api/config";
import { copyToClipboard } from "@/lib/clipboard";
import { useRepositoryDirectory } from "@/lib/api/liveDashboard";

const FixtureIntegrations = lazy(() =>
  import("./IntegrationsFixture").then((module) => ({ default: module.IntegrationsPage })),
);

type ProviderConnection = {
  readonly id: string;
  readonly provider: string;
  readonly externalAccountId: string;
  readonly installationRef: string | null;
  readonly status: "active" | "suspended" | "revoked";
  readonly updatedAt: string;
};

type LoadState = "loading" | "ready" | "failed";

function failureMessage(result: { readonly kind: string; readonly detail?: string }): string {
  if (result.kind === "misconfigured") return result.detail ?? "Dashboard API is not configured.";
  if (result.kind === "transport" || result.kind === "contract") return result.detail ?? "The request failed.";
  if (result.kind === "rejected") return "The server rejected the integration change. Reload and try again.";
  return "The integration change could not be completed.";
}

function integrationByKey(
  integrations: readonly DashboardIntegrationView[],
  key: DashboardIntegrationView["key"],
): DashboardIntegrationView | undefined {
  return integrations.find((entry) => entry.key === key);
}

function teamKeysFrom(integration: DashboardIntegrationView | undefined): string[] {
  const value = integration?.config["teamKeys"];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}


type McpServerView = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly guidance: string;
  readonly auth: "none" | "api_key";
  readonly headerNames: readonly string[];
};

function mcpServersFrom(integration: DashboardIntegrationView | undefined): McpServerView[] {
  const value = integration?.config["servers"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row["id"] !== "string" || typeof row["label"] !== "string" || typeof row["url"] !== "string" ||
      typeof row["guidance"] !== "string" || (row["auth"] !== "none" && row["auth"] !== "api_key") ||
      !Array.isArray(row["headerNames"]) || row["headerNames"].some((name) => typeof name !== "string")
    ) return [];
    return [{
      id: row["id"], label: row["label"], url: row["url"], guidance: row["guidance"], auth: row["auth"],
      headerNames: row["headerNames"] as string[],
    }];
  });
}

function jiraMetadataFrom(integration: DashboardIntegrationView | undefined): { siteOrigin?: string; cloudId?: string } {
  const siteOrigin = integration?.config["siteOrigin"];
  const cloudId = integration?.config["cloudId"];
  return {
    ...(typeof siteOrigin === "string" ? { siteOrigin } : {}),
    ...(typeof cloudId === "string" ? { cloudId } : {}),
  };
}

type McpForm = {
  readonly label: string; readonly url: string; readonly guidance: string;
  readonly auth: "none" | "api_key"; readonly apiKey: string; readonly headers: string;
};
const EMPTY_MCP_FORM: McpForm = { label: "", url: "", guidance: "", auth: "none", apiKey: "", headers: "" };

function parseMcpHeaders(value: string): Record<string, string> {
  if (value.trim() === "") return {};
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Headers must be a JSON object.");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") throw new Error(`Header ${name} must have a string value.`);
    headers[name] = headerValue;
  }
  return headers;
}

function projectSlugsFrom(integration: DashboardIntegrationView | undefined): Record<string, string> {
  const value = integration?.config["projectSlugs"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function IntegrationsPage() {
  const config = resolveDataConfig();
  if (config.kind === "fixtures") {
    return (
      <Suspense fallback={null}>
        <FixtureIntegrations />
      </Suspense>
    );
  }
  if (config.kind === "misconfigured") {
    return (
      <Page className="max-w-[1040px]">
        <LiveMisconfiguredState detail={config.detail} />
      </Page>
    );
  }
  return <LiveIntegrations />;
}

function LiveIntegrations() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const repositories = useRepositoryDirectory();
  const [state, setState] = useState<LoadState>("loading");
  const [connections, setConnections] = useState<readonly ProviderConnection[]>([]);
  const [integrations, setIntegrations] = useState<readonly DashboardIntegrationView[]>([]);
  const [linearKeys, setLinearKeys] = useState("");
  const [circleMappings, setCircleMappings] = useState<Record<string, string>>({});
  const [circleToken, setCircleToken] = useState("");
  const [circleOpen, setCircleOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpForm, setMcpForm] = useState<McpForm>(EMPTY_MCP_FORM);
  const [jiraChallenge, setJiraChallenge] = useState<{ readonly secret: string; readonly expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const linear = integrationByKey(integrations, "linear");
  const circleci = integrationByKey(integrations, "circleci");
  const mcp = integrationByKey(integrations, "mcp");
  const jira = integrationByKey(integrations, "jira");
  const mcpServers = mcpServersFrom(mcp);
  const jiraMetadata = jiraMetadataFrom(jira);
  const repositoryList = repositories.status === "ready" ? repositories.value : [];

  const refresh = async (signal?: AbortSignal) => {
    const [providerResult, integrationResult] = await Promise.all([
      loadProviderConnections(signal),
      loadDashboardIntegrations(signal),
    ]);
    if (signal?.aborted) return;
    if (providerResult.kind !== "ok" || integrationResult.kind !== "ok") {
      setState("failed");
      return;
    }
    setConnections(providerResult.value.items);
    setIntegrations(integrationResult.value.items);
    const currentLinear = integrationByKey(integrationResult.value.items, "linear");
    const currentCircle = integrationByKey(integrationResult.value.items, "circleci");
    setLinearKeys(teamKeysFrom(currentLinear).join(", "));
    setCircleMappings(projectSlugsFrom(currentCircle));
    setState("ready");
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const outcome = params.get("linear");
    if (outcome !== "connected" && outcome !== "failed") return;
    toast(
      outcome === "connected"
        ? { title: "Linear connected" }
        : { title: "Linear connection failed", tone: "error" },
    );
    const next = new URLSearchParams(params);
    next.delete("linear");
    setParams(next, { replace: true });
    if (outcome === "connected") void refresh();
  }, [params, setParams, toast]);

  const normalizedTeamKeys = useMemo(
    () =>
      [...new Set(linearKeys.split(/[\s,]+/u).map((key) => key.trim().toUpperCase()).filter(Boolean))],
    [linearKeys],
  );

  const replaceIntegration = (next: DashboardIntegrationView) => {
    setIntegrations((current) => [
      ...current.filter((entry) => entry.key !== next.key),
      next,
    ]);
  };

  const connectLinear = async () => {
    setBusy("linear-connect");
    const result = await beginLinearAuthorization();
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "Could not start Linear authorization", description: failureMessage(result), tone: "error" });
      return;
    }
    window.location.assign(result.value.url);
  };

  const saveLinear = async () => {
    if (linear === undefined) return;
    setBusy("linear-save");
    const result = await updateLinearIntegration({ expectedRevision: linear.revision, teamKeys: normalizedTeamKeys });
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "Linear settings were not saved", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    setLinearKeys(teamKeysFrom(result.value.integration).join(", "));
    toast({ title: "Linear settings saved" });
  };

  const disconnect = async (key: "linear" | "circleci", revision: number) => {
    setBusy(`${key}-disconnect`);
    const result = await disconnectDashboardIntegration(key, revision);
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: `Could not disconnect ${key === "linear" ? "Linear" : "CircleCI"}`, description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    toast({ title: `${key === "linear" ? "Linear" : "CircleCI"} disconnected` });
  };

  const saveCircleMappings = async () => {
    if (circleci === undefined) return;
    const projectSlugs = Object.fromEntries(
      Object.entries(circleMappings).map(([id, slug]) => [id, slug.trim()]).filter(([, slug]) => slug !== ""),
    );
    setBusy("circle-save");
    const result = await updateCircleCiIntegration({ expectedRevision: circleci.revision, projectSlugs });
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "CircleCI mappings were not saved", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    setCircleMappings(projectSlugsFrom(result.value.integration));
    toast({ title: "CircleCI mappings saved" });
  };

  const connectCircle = async () => {
    if (circleToken.trim() === "") return;
    const projectSlugs = Object.fromEntries(
      Object.entries(circleMappings).map(([id, slug]) => [id, slug.trim()]).filter(([, slug]) => slug !== ""),
    );
    setBusy("circle-connect");
    const result = await connectCircleCi({
      expectedRevision: circleci?.revision ?? 0,
      token: circleToken,
      projectSlugs,
    });
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "CircleCI connection failed", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    setCircleToken("");
    setCircleOpen(false);
    setCircleMappings(projectSlugsFrom(result.value.integration));
    toast({ title: "CircleCI connected" });
  };

  const connectMcp = async () => {
    let headers: Record<string, string>;
    try {
      headers = parseMcpHeaders(mcpForm.headers);
    } catch (error) {
      toast({ title: "MCP headers are invalid", description: error instanceof Error ? error.message : "Headers must be valid JSON.", tone: "error" });
      return;
    }
    setBusy("mcp-connect");
    const result = await createMcpServer(mcp?.revision ?? 0, {
      label: mcpForm.label,
      url: mcpForm.url,
      guidance: mcpForm.guidance,
      auth: mcpForm.auth,
      ...(mcpForm.auth === "api_key" ? { apiKey: mcpForm.apiKey } : {}),
      headers,
    });
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "MCP server was not registered", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    setMcpForm(EMPTY_MCP_FORM);
    setMcpOpen(false);
    toast({ title: "MCP server registered", description: "Credential values were accepted by the server and are not readable from this page." });
  };

  const removeMcp = async (serverId: string) => {
    if (mcp === undefined) return;
    setBusy(`mcp-remove:${serverId}`);
    const result = await removeMcpServer(serverId, mcp.revision);
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "MCP server was not removed", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    toast({ title: "MCP server removed" });
  };

  const issueJiraChallenge = async () => {
    setBusy("jira-challenge");
    const result = await createJiraInstallationChallenge(jira?.revision ?? 0);
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "Could not create Jira installation capability", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    setJiraChallenge(result.value);
    toast({ title: "Jira installation capability created", description: "This secret is shown only in this browser state and expires automatically." });
  };

  const disconnectJira = async () => {
    if (jira === undefined) return;
    setBusy("jira-disconnect");
    const result = await disconnectDashboardIntegration("jira", jira.revision);
    setBusy(null);
    if (result.kind !== "ok") {
      toast({ title: "Could not disconnect Jira", description: failureMessage(result), tone: "error" });
      await refresh();
      return;
    }
    replaceIntegration(result.value.integration);
    setJiraChallenge(null);
    toast({ title: "Jira disconnected" });
  };

  /**
   * The MCP and Jira sections are built but deliberately not rendered: both stay
   * stored-only until their authenticated control-plane and review-runtime paths
   * exist, as the note at the foot of this page says. Their state, readers and
   * handlers are held here so the capability is deferred rather than deleted,
   * and this reference keeps that deferral explicit instead of unused.
   */
  void [
    mcpOpen,
    setMcpOpen,
    mcpServers,
    connectMcp,
    removeMcp,
    jiraChallenge,
    jiraMetadata,
    issueJiraChallenge,
    disconnectJira,
    Copy,
    Server,
    Ticket,
    Trash2,
    Textarea,
    copyToClipboard,
  ];


  return (
    <Page className="max-w-[1040px]">
      <PageHeader
        title="Integrations"
        description="Connect review context providers and manage the credentials used by this organization."
      />

      {state === "loading" ? (
        <div className="mt-6 rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">
          Loading integrations…
        </div>
      ) : state === "failed" ? (
        <div className="mt-6 rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">
          Acalys could not load the authoritative integration state.
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid gap-3 md:grid-cols-2">
            <section className="rounded-lg border border-line bg-surface p-4">
              <header className="flex items-center gap-2.5">
                <LinearIcon className="h-4 w-4 text-fg" />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium text-fg">Linear</h2>
                  <p className="text-xs text-fg-subtle">Issue context for the exact admitted review subject</p>
                </div>
                <Badge tone={linear?.status === "connected" ? "success" : "neutral"}>
                  {linear?.status === "connected" ? "Connected" : "Not connected"}
                </Badge>
              </header>

              {linear?.status === "connected" ? (
                <>
                  <label className="mt-4 block">
                    <span className="text-xs font-medium text-fg">Linear team keys</span>
                    <Input
                      value={linearKeys}
                      onChange={(event) => setLinearKeys(event.target.value)}
                      placeholder="ENG, PLATFORM"
                      wrapperClassName="mt-1.5"
                    />
                    <span className="mt-1.5 block text-xs text-fg-subtle">
                      Only issue identifiers from these teams are resolved into untrusted review context.
                    </span>
                  </label>
                  <div className="mt-4 flex gap-2">
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void saveLinear()}>
                      {busy === "linear-save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      Save
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => void disconnect("linear", linear.revision)}>
                      Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <div className="mt-4">
                  <p className="text-sm leading-relaxed text-fg-muted">
                    Authorize Acalys with Linear using PKCE. Access and refresh credentials are encrypted and never returned to this page.
                  </p>
                  <Button className="mt-4" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void connectLinear()}>
                    {busy === "linear-connect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Connect Linear
                  </Button>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-line bg-surface p-4">
              <header className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--cr-hover)]">
                  <CircleDot className="h-4 w-4 text-fg" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium text-fg">CircleCI</h2>
                  <p className="text-xs text-fg-subtle">Exact head-SHA and pull-request CI evidence</p>
                </div>
                <Badge tone={circleci?.status === "connected" ? "success" : "neutral"}>
                  {circleci?.status === "connected" ? "Connected" : "Not connected"}
                </Badge>
              </header>

              {circleci?.status === "connected" ? (
                <>
                  <RepositoryMappings
                    repositories={repositoryList}
                    mappings={circleMappings}
                    setMappings={setCircleMappings}
                  />
                  <div className="mt-4 flex gap-2">
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void saveCircleMappings()}>
                      {busy === "circle-save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      Save mappings
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => void disconnect("circleci", circleci.revision)}>
                      Disconnect
                    </Button>
                  </div>
                </>
              ) : (
                <div className="mt-4">
                  <p className="text-sm leading-relaxed text-fg-muted">
                    Connect a CircleCI personal API token. Acalys verifies the token identity before encrypting it.
                  </p>
                  <Button className="mt-4" size="sm" variant="secondary" disabled={busy !== null} onClick={() => setCircleOpen(true)}>
                    Connect CircleCI
                  </Button>
                </div>
              )}
            </section>
          </div>

          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">Source control connections</h2>
            <div className="space-y-2">
              {connections.length === 0 ? (
                <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-subtle">
                  No source-control provider connections are registered for this organization.
                </div>
              ) : connections.map((connection) => (
                <div key={connection.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--cr-hover)]">
                    {connection.provider === "github" ? <GitHubIcon className="h-4 w-4" /> : connection.provider.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium capitalize text-fg">{connection.provider}</span>
                    <span className="block truncate text-xs text-fg-subtle">
                      Account {connection.externalAccountId}{connection.installationRef ? ` · Installation ${connection.installationRef}` : ""}
                    </span>
                  </span>
                  <Badge tone={connection.status === "active" ? "success" : "neutral"}>{connection.status}</Badge>
                </div>
              ))}
            </div>
          </section>

          <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-4 py-3 text-xs text-fg-subtle">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              MCP and Jira remain stored-only until their authenticated control-plane and review-runtime consumption paths are reconstructed. This live page does not simulate those connections.
            </span>
          </div>
        </div>
      )}

      <Modal
        open={circleOpen}
        onClose={() => { if (busy === null) setCircleOpen(false); }}
        title="Connect CircleCI"
        description="The token is verified against CircleCI before it is encrypted."
        footer={(
          <>
            <Button variant="outline" onClick={() => setCircleOpen(false)} disabled={busy !== null}>Cancel</Button>
            <Button variant="secondary" onClick={() => void connectCircle()} disabled={circleToken.trim() === "" || busy !== null}>
              {busy === "circle-connect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Connect
            </Button>
          </>
        )}
      >
        <label className="block">
          <span className="text-xs font-medium text-fg">Personal API token</span>
          <Input
            type="password"
            autoComplete="off"
            value={circleToken}
            onChange={(event) => setCircleToken(event.target.value)}
            placeholder="CircleCI API token"
            wrapperClassName="mt-1.5"
          />
        </label>
        <RepositoryMappings repositories={repositoryList} mappings={circleMappings} setMappings={setCircleMappings} />
      </Modal>
    </Page>
  );
}

function RepositoryMappings({
  repositories,
  mappings,
  setMappings,
}: {
  readonly repositories: readonly { readonly id: string; readonly name: string }[];
  readonly mappings: Readonly<Record<string, string>>;
  readonly setMappings: (next: Record<string, string>) => void;
}) {
  return (
    <div className="mt-4">
      <div className="flex items-end justify-between gap-3">
        <span className="text-xs font-medium text-fg">Repository project slugs</span>
        <span className="text-[11px] text-fg-subtle">Optional until CI evidence is needed</span>
      </div>
      {repositories.length === 0 ? (
        <p className="mt-2 text-xs text-fg-subtle">No live repositories are available to map.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {repositories.map((repository) => (
            <div key={repository.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-center gap-2">
              <span className="truncate text-xs text-fg-muted" title={repository.name}>{repository.name}</span>
              <Input
                value={mappings[repository.id] ?? ""}
                onChange={(event) => setMappings({ ...mappings, [repository.id]: event.target.value })}
                placeholder="gh/org/project"
                aria-label={`CircleCI project slug for ${repository.name}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
