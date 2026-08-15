import { useMemo, useState } from "react";
import { Copy, ExternalLink, Key, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, SearchInput } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Checkbox, Switch } from "@/components/ui/Misc";
import { Table, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { TableSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { apiKeys as seed, type ApiKey } from "@/data/account";
import { currentUser } from "@/lib/session";

const availableScopes = [
  "reviews:read",
  "reviews:write",
  "reports:read",
  "findings:read",
  "findings:write",
];

export function ApiKeysPage() {
  const loading = usePageLoad();
  const [keys, setKeys] = useState<ApiKey[]>(seed);
  const [query, setQuery] = useState("");
  const [showMemberKeys, setShowMemberKeys] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["reviews:read"]);
  const [issued, setIssued] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiKey | null>(null);
  const toast = useToast();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return keys.filter((key) => {
      if (!showMemberKeys && key.createdBy !== currentUser.handle) return false;
      if (!needle) return true;
      return (
        key.label.toLowerCase().includes(needle) ||
        key.prefix.toLowerCase().includes(needle) ||
        key.scopes.some((scope) => scope.includes(needle))
      );
    });
  }, [keys, query, showMemberKeys]);

  const create = () => {
    const suffix = Math.random().toString(16).slice(2, 6);
    const token = `acl_live_${suffix}${Math.random().toString(16).slice(2, 26)}`;
    setKeys((current) => [
      {
        id: `k-${Date.now()}`,
        label: label.trim() || "Untitled key",
        prefix: `acl_live_${suffix}`,
        scopes,
        createdAt: new Date().toISOString().slice(0, 10),
        lastUsedAt: null,
        createdBy: currentUser.handle,
      },
      ...current,
    ]);
    setIssued(token);
    setLabel("");
    setCreating(false);
  };

  return (
    <Page className="max-w-5xl">
      <TopBarActions>
        <a
          href="https://docs.acalys.dev/api"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-brand transition-colors hover:bg-[var(--cr-hover)]"
        >
          API Reference
          <ExternalLink className="h-3 w-3" />
        </a>
      </TopBarActions>

      <div className="flex flex-wrap items-center gap-4 pt-6">
        <SearchInput
          placeholder="Search API keys..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="w-full max-w-[230px]"
        />
        <label className="flex items-center gap-2.5 text-sm text-fg-muted">
          Show member keys
          <Switch
            checked={showMemberKeys}
            onChange={setShowMemberKeys}
            label="Show member keys"
          />
        </label>
        {rows.length > 0 && (
          <Button
            className="ml-auto"
            variant="secondary"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setCreating(true)}
          >
            Create API Key
          </Button>
        )}
      </div>

      <div className="mt-4">
        {loading ? (
          <TableSkeleton rows={3} filters={0} />
        ) : rows.length === 0 ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-line bg-surface px-6 py-16 text-center">
            <Key className="h-7 w-7 text-fg-subtle" strokeWidth={1.5} />
            <h2 className="mt-5 text-lg font-semibold text-fg">Create an API Key</h2>
            <p className="mt-2 max-w-sm text-sm text-fg-subtle">
              {query.trim() || (!showMemberKeys && keys.length > 0)
                ? "No keys match the current search or filter."
                : "Create an API key to access the Acalys API."}
            </p>
            <Button
              className="mt-5"
              variant="secondary"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setCreating(true)}
            >
              Create API Key
            </Button>
          </div>
        ) : (
          <TableShell>
            <Table>
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th>Key</Th>
                  <Th>Scopes</Th>
                  <Th>Created</Th>
                  <Th align="right">Last used</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <Tr key={key.id}>
                    <Td className="font-medium text-fg">{key.label}</Td>
                    <Td className="font-mono text-xs">{key.prefix}…</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} tone="outline" className="font-mono text-2xs">
                            {scope}
                          </Badge>
                        ))}
                      </span>
                    </Td>
                    <Td className="text-fg-subtle">
                      {key.createdAt} by {key.createdBy}
                    </Td>
                    <Td align="right" className="text-fg-subtle">
                      {key.lastUsedAt ?? "Never"}
                    </Td>
                    <Td align="right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Revoke ${key.label}`}
                        onClick={() => setPendingDelete(key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create API key"
        description="The full key is shown once, right after it is created."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="brand" onClick={create} disabled={scopes.length === 0}>
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Label" hint="Name it after where it runs, so it is easy to revoke.">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="CI pipeline"
            />
          </Field>
          <div>
            <p className="mb-2 text-xs font-medium text-fg">Scopes</p>
            <ul className="space-y-1.5">
              {availableScopes.map((scope) => (
                <li key={scope} className="flex items-center gap-2.5">
                  <Checkbox
                    checked={scopes.includes(scope)}
                    onChange={() =>
                      setScopes((current) =>
                        current.includes(scope)
                          ? current.filter((entry) => entry !== scope)
                          : [...current, scope],
                      )
                    }
                    label={scope}
                  />
                  <span className="font-mono text-xs text-fg-muted">{scope}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Modal>

      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="Copy your key now"
        description="This is the only time the full key is shown. Store it in your secret manager."
        footer={
          <Button variant="brand" onClick={() => setIssued(null)}>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-2 rounded-md border border-line bg-canvas p-3">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-fg">
            {issued}
          </code>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copy key"
            onClick={() => issued && navigator.clipboard?.writeText(issued)}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Revoke ${pendingDelete?.label ?? ""}?`}
        description="Any script using this key stops working immediately. This cannot be undone."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setKeys((current) =>
                  current.filter((entry) => entry.id !== pendingDelete?.id),
                );
                toast({
                  title: "Key revoked",
                  description: `${pendingDelete?.label} can no longer call the API.`,
                  tone: "info",
                });
                setPendingDelete(null);
              }}
            >
              Revoke key
            </Button>
          </>
        }
      />
    </Page>
  );
}
