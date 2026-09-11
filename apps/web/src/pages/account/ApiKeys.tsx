import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Copy, Key, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, SearchInput } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Checkbox, Switch } from "@/components/ui/Misc";
import { Table, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { useDashboardSession } from "@/components/auth/DashboardSessionGate";
import { copyToClipboard } from "@/lib/clipboard";
import {
  createDashboardApiKey,
  dashboardScopeOptions,
  loadDashboardApiKeys,
  revokeDashboardApiKey,
  type DashboardApiKeyView,
  type DashboardScopeValue,
} from "@/lib/api/dashboardAdmin";
import { resolveDataConfig } from "@/lib/api/config";

const FixtureApiKeys = lazy(() => import("./ApiKeysFixture").then((module) => ({ default: module.ApiKeysPage })));

export function ApiKeysPage() {
  const config = resolveDataConfig();
  if (config.kind === "fixtures") return <Suspense fallback={null}><FixtureApiKeys /></Suspense>;
  if (config.kind === "misconfigured") return <Page className="max-w-5xl"><LiveMisconfiguredState detail={config.detail} /></Page>;
  return <LiveApiKeys />;
}

function LiveApiKeys() {
  const session = useDashboardSession();
  const [keys, setKeys] = useState<readonly DashboardApiKeyView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [query, setQuery] = useState("");
  const [showMemberKeys, setShowMemberKeys] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<DashboardScopeValue[]>(["reviews:read"]);
  const [organizationOwned, setOrganizationOwned] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DashboardApiKeyView | null>(null);
  const toast = useToast();
  const canAdmin = session?.role === "owner" || session?.role === "admin";
  const selectableScopes = useMemo(
    () => session?.role === "read_only" ? dashboardScopeOptions.filter((scope) => !scope.endsWith(":write")) : dashboardScopeOptions,
    [session?.role],
  );

  const refresh = async () => {
    const result = await loadDashboardApiKeys();
    if (result.kind === "ok") { setKeys(result.value.items as readonly DashboardApiKeyView[]); setState("ready"); }
    else setState("failed");
  };
  useEffect(() => { void refresh(); }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return keys.filter((key) => {
      const own = key.ownerKind === "organization" || key.userId === session?.user.id;
      if (!showMemberKeys && !own) return false;
      return !needle || key.name.toLowerCase().includes(needle) || key.prefix.toLowerCase().includes(needle) || key.scopes.some((scope) => scope.includes(needle));
    });
  }, [keys, query, session?.user.id, showMemberKeys]);

  const create = async () => {
    const result = await createDashboardApiKey({ name: label.trim() || "Untitled key", scopes, ownerKind: organizationOwned ? "organization" : "user" });
    if (result.kind !== "ok") { toast({ title: "API key was not created", description: "Acalys rejected or could not persist this key." }); return; }
    setIssued(result.value.token); setLabel(""); setCreating(false); setOrganizationOwned(false); await refresh();
  };
  const revoke = async (key: DashboardApiKeyView) => {
    const result = await revokeDashboardApiKey(key.id);
    setPendingDelete(null);
    if (result.kind === "ok") { setKeys((current) => current.filter((entry) => entry.id !== key.id)); toast({ title: "API key revoked" }); }
    else toast({ title: "API key was not revoked" });
  };

  return (
    <Page className="max-w-5xl">
      <PageHeader title="API Keys" description="Keys are stored hashed; the full credential is returned only once at creation." />
      <div className="flex flex-wrap items-center gap-4 pt-6">
        <SearchInput placeholder="Search API keys…" value={query} onChange={(event) => setQuery(event.target.value)} wrapperClassName="w-full max-w-[230px]" />
        {canAdmin && <label className="flex items-center gap-2.5 text-sm text-fg-muted">Show member keys <Switch checked={showMemberKeys} onChange={setShowMemberKeys} label="Show member keys" /></label>}
        <Button className="ml-auto" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>Create API Key</Button>
      </div>
      <div className="mt-4">
        {state === "loading" ? <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Loading live API keys…</div> : state === "failed" ? <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Acalys could not load API keys.</div> : rows.length === 0 ? <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-line bg-surface px-6 py-16 text-center"><Key className="h-7 w-7 text-fg-subtle"/><h2 className="mt-4 text-base font-semibold text-fg">No API keys</h2><p className="mt-2 text-sm text-fg-subtle">Create a scoped key for CI or external API access.</p></div> :
          <TableShell><Table><thead><tr><Th>Label</Th><Th>Key</Th><Th>Owner</Th><Th>Scopes</Th><Th>Created</Th><Th>Last used</Th><Th align="right">Actions</Th></tr></thead><tbody>{rows.map((key) => <Tr key={key.id}>
            <Td className="font-medium text-fg">{key.name}</Td><Td className="font-mono text-xs">{key.prefix}…</Td><Td>{key.ownerKind === "organization" ? "Organization" : key.userId === session?.user.id ? "You" : "Member"}</Td>
            <Td><span className="flex max-w-[320px] flex-wrap gap-1">{key.scopes.map((scope) => <Badge key={scope} tone="outline" className="font-mono text-2xs">{scope}</Badge>)}</span></Td>
            <Td className="text-fg-subtle">{new Date(key.createdAt).toLocaleDateString()}</Td><Td className="text-fg-subtle">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}</Td>
            <Td align="right"><Button size="icon-sm" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => setPendingDelete(key)}><Trash2 className="h-3.5 w-3.5" /></Button></Td>
          </Tr>)}</tbody></Table></TableShell>}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create API key" description="The full key is shown once, immediately after creation." footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="brand" onClick={() => void create()} disabled={scopes.length === 0}>Create key</Button></>}>
        <div className="space-y-4"><Field label="Label"><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="CI pipeline" /></Field>
          {canAdmin && <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm text-fg-muted"><span><span className="block text-fg">Organization-owned key</span><span className="block text-xs text-fg-subtle">Not tied to your membership; use only for managed service credentials.</span></span><Switch checked={organizationOwned} onChange={setOrganizationOwned} label="Organization-owned key" /></label>}
          <div><p className="mb-2 text-xs font-medium text-fg">Scopes</p><ul className="space-y-1.5">{selectableScopes.map((scope) => <li key={scope} className="flex items-center gap-2.5"><Checkbox checked={scopes.includes(scope)} onChange={() => setScopes((current) => current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope])} label={scope}/><span className="font-mono text-xs text-fg-muted">{scope}</span></li>)}</ul></div>
        </div>
      </Modal>
      <Modal open={issued !== null} onClose={() => setIssued(null)} title="Copy your key now" description="Acalys does not store a recoverable copy of this token." footer={<Button variant="brand" onClick={() => setIssued(null)}>Done</Button>}>
        <div className="flex items-center gap-2 rounded-md border border-line bg-canvas p-3"><code className="min-w-0 flex-1 overflow-x-auto text-xs text-fg">{issued}</code><Button size="icon-sm" variant="ghost" aria-label="Copy API key" onClick={() => issued && void copyToClipboard(issued)}><Copy className="h-4 w-4" /></Button></div>
      </Modal>
      <Modal open={pendingDelete !== null} onClose={() => setPendingDelete(null)} title="Revoke API key" description="Requests using this key will stop authenticating immediately." footer={<><Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button><Button variant="danger" onClick={() => pendingDelete && void revoke(pendingDelete)}>Revoke</Button></>}><p className="text-sm text-fg-muted">Revoke <strong className="text-fg">{pendingDelete?.name}</strong>?</p></Modal>
    </Page>
  );
}
