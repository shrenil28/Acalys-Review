import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, BookOpen, Info, ListChecks, Plus, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { FormSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { GitHubIcon, JiraIcon, LinearIcon } from "@/components/icons";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import {
  ciIntegrations,
  issueTrackers,
  mcpServers,
  type Capability,
} from "@/data/integrations";
import { McpServerModal } from "@/components/integrations/McpServerModal";
import {
  CircleCiModal,
  JiraInstallModal,
} from "@/components/integrations/ConnectModals";
import { cn } from "@/lib/utils";

const tabs = [
  { slug: "mcp", label: "MCP Servers" },
  { slug: "integrations", label: "Issue Tracking" },
  { slug: "ci-cd", label: "CI/CD" },
] as const;

type TabSlug = (typeof tabs)[number]["slug"];

/** Brand mark where we have one, otherwise a lettered tile. */
function ServiceMark({ id, letter }: { id: string; letter: string }) {
  const shared = "h-4 w-4 text-fg";
  if (id === "copilot") return <GitHubIcon className={shared} />;
  if (id === "linear") return <LinearIcon className={shared} />;
  if (id === "jira") return <JiraIcon className={shared} />;
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-[var(--cr-active)] text-[9px] font-semibold text-fg">
      {letter}
    </span>
  );
}

function CapabilityTile({ capability }: { capability: Capability }) {
  const Icon = capability.label === "Coding Plan" ? ListChecks : BookOpen;
  return (
    <Link
      to={capability.to}
      className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 transition-colors hover:bg-[var(--cr-hover)]"
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm text-fg">
          {capability.label}
          <ArrowRight className="h-3 w-3 text-fg-subtle" />
        </span>
        <span className="mt-0.5 block text-xs text-fg-subtle">
          {capability.description}
        </span>
      </span>
    </Link>
  );
}

export function IntegrationsPage() {
  const loading = usePageLoad();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [added] = useState<string[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [mcpModal, setMcpModal] = useState<{ name: string; host: string } | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [circleOpen, setCircleOpen] = useState(false);

  const tab = (tabs.find((entry) => entry.slug === params.get("tab"))?.slug ??
    "mcp");

  const setTab = (slug: TabSlug) => {
    const next = new URLSearchParams(params);
    if (slug === "mcp") next.delete("tab");
    else next.set("tab", slug);
    setParams(next, { replace: true });
  };

  const connect = (name: string, id: string) => {
    setConnected((current) => [...current, id]);
    toast({ title: `${name} connected` });
  };

  if (loading)
    return (
      <Page className="max-w-[1040px]">
        <FormSkeleton cards={3} />
      </Page>
    );

  return (
    <Page className="max-w-[1040px]">
      <TopBarActions>
        <Button
          size="sm"
          variant="outline"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => {
            setMcpModal(null);
            setMcpOpen(true);
          }}
        >
          New MCP Server
        </Button>
      </TopBarActions>

      {/* Segmented tabs, centred above the content */}
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
          {tabs.map((entry) => (
            <button
              key={entry.slug}
              type="button"
              onClick={() => setTab(entry.slug)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                entry.slug === tab
                  ? "bg-[var(--cr-active)] font-medium text-fg"
                  : "text-fg-subtle hover:text-fg",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "mcp" && (
        <div className="mt-6 space-y-2.5">
          <div
            className="flex items-start gap-3 rounded-lg border border-line px-4 py-3.5"
            style={{
              backgroundImage:
                "radial-gradient(var(--cr-line) 0.5px, transparent 0.5px)",
              backgroundSize: "5px 5px",
            }}
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
            <p className="text-sm leading-relaxed text-fg-muted">
              MCP server connections are shared across your organization. To
              maintain least privilege, we recommend configuring with a{" "}
              <strong className="font-semibold text-fg">service account</strong> or{" "}
              <strong className="font-semibold text-fg">scoped credentials</strong>.
            </p>
          </div>

          {mcpServers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3.5"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--cr-hover)]">
                <ServiceMark id={server.id} letter={server.letter} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">
                  {server.name}
                </span>
                <span className="block truncate font-mono text-xs text-fg-subtle">
                  {server.host}
                </span>
              </span>
              <Button
                size="sm"
                variant={added.includes(server.id) ? "outline" : "secondary"}
                icon={
                  added.includes(server.id) ? undefined : (
                    <PlusCircle className="h-3.5 w-3.5" />
                  )
                }
                onClick={() => {
                  setMcpModal({ name: server.name, host: server.host });
                  setMcpOpen(true);
                }}
              >
                {added.includes(server.id) ? "Added" : "Add"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {tab === "integrations" && (
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {issueTrackers.map((tracker) => (
            <section
              key={tracker.id}
              className="flex flex-col rounded-lg border border-line bg-surface p-4"
            >
              <header className="flex items-center gap-2.5">
                <ServiceMark id={tracker.id} letter={tracker.name[0]} />
                <h2 className="flex-1 text-sm font-medium text-fg">
                  {tracker.name}
                </h2>
                <Button
                  size="sm"
                  variant={connected.includes(tracker.id) ? "outline" : "secondary"}
                  onClick={() => (tracker.id === "jira" ? setJiraOpen(true) : connect(tracker.name, tracker.id))}
                  disabled={connected.includes(tracker.id)}
                >
                  {connected.includes(tracker.id) ? "Connected" : "Connect"}
                </Button>
              </header>

              <p className="mt-4 text-sm text-fg-muted">{tracker.tagline}</p>

              {tracker.note && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-xs text-fg-subtle">{tracker.note.text}</p>
                  <a
                    href={tracker.note.href}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-xs text-fg-muted underline underline-offset-2 hover:text-fg"
                  >
                    {tracker.note.linkLabel}
                  </a>
                </div>
              )}

              <p className="mt-3 text-xs text-fg-subtle">
                {tracker.name} integration capabilities:
              </p>

              <div className="mt-2 space-y-2">
                {tracker.capabilities.map((capability) => (
                  <CapabilityTile key={capability.label} capability={capability} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === "ci-cd" && (
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {ciIntegrations.map((entry) => (
            <section
              key={entry.id}
              className="rounded-lg border border-line bg-surface p-4"
            >
              <header className="flex items-center gap-2.5">
                <ServiceMark id={entry.id} letter="C" />
                <h2 className="flex-1 text-sm font-medium text-fg">{entry.name}</h2>
                <Button
                  size="sm"
                  variant={connected.includes(entry.id) ? "outline" : "secondary"}
                  onClick={() => setCircleOpen(true)}
                  disabled={connected.includes(entry.id)}
                >
                  {connected.includes(entry.id) ? "Connected" : "Connect"}
                </Button>
              </header>
              <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                {entry.description}
              </p>
            </section>
          ))}
        </div>
      )}
      <McpServerModal
        open={mcpOpen}
        preset={mcpModal}
        onClose={() => setMcpOpen(false)}
      />
      <JiraInstallModal open={jiraOpen} onClose={() => setJiraOpen(false)} />
      <CircleCiModal open={circleOpen} onClose={() => setCircleOpen(false)} />
    </Page>
  );
}
