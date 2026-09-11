import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Modal";
import { SearchInput } from "@/components/ui/Input";
import { Skeleton, usePageLoad } from "@/components/ui/Skeleton";
import { Table, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import {
  GitHubIcon,
  GitLabIcon,
  JiraIcon,
  LinearIcon,
} from "@/components/icons";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { connectorCatalogue, type Connector } from "@/data/integrations";

/** A connection the organization has authorized. */
interface Connection {
  id: string;
  connector: Connector;
  type: string;
  scopes: string;
}

const COLUMNS = ["Connection", "Connector", "Type", "Scopes"] as const;

/** Brand mark where the app ships one, otherwise a tinted lettered tile. */
function ConnectorMark({ connector }: { connector: Connector }) {
  const shared = "h-4 w-4 text-fg";
  if (connector.id === "github" || connector.id === "copilot")
    return <GitHubIcon className={shared} />;
  if (connector.id === "gitlab" || connector.id === "gitlab-self-hosted")
    return <GitLabIcon className={shared} />;
  if (connector.id === "jira") return <JiraIcon className={shared} />;
  if (connector.id === "linear") return <LinearIcon className={shared} />;
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 items-center justify-center rounded-[3px] text-[9px] font-semibold text-white"
      style={{ backgroundColor: connector.tone }}
    >
      {connector.letter}
    </span>
  );
}

/**
 * The table's own loading shape.
 *
 * The header row stays on screen while the body is pending, so the column
 * meaning is readable before any data arrives and the layout does not shift
 * when it does.
 */
function LoadingRows() {
  return (
    <tbody>
      {Array.from({ length: 6 }, (_, row) => (
        <Tr key={row}>
          {COLUMNS.map((column, index) => (
            <Td key={column}>
              <Skeleton
                className="h-3.5"
                style={{ width: index === 0 ? "58%" : "44%" }}
              />
            </Td>
          ))}
        </Tr>
      ))}
    </tbody>
  );
}

function AddConnectionDrawer({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (connector: Connector) => void;
}) {
  const [query, setQuery] = useState("");

  const categories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return connectorCatalogue;
    return connectorCatalogue
      .map((category) => ({
        ...category,
        connectors: category.connectors.filter((connector) =>
          connector.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((category) => category.connectors.length > 0);
  }, [query]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="wide"
      title={
        <>
          <h2 className="text-sm font-medium text-fg">Add connection</h2>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Choose a connector to get started.
          </p>
        </>
      }
      footer={
        <Button size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <SearchInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search connectors..."
        aria-label="Search connectors"
      />

      {categories.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg-subtle">
          No connectors match “{query.trim()}”.
        </p>
      ) : (
        categories.map((category) => (
          <section key={category.id} className="mt-5">
            <h3 className="text-xs font-medium text-fg-subtle">
              {category.label}
            </h3>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {category.connectors.map((connector) => (
                <button
                  key={connector.id}
                  type="button"
                  onClick={() => onSelect(connector)}
                  className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-[var(--cr-hover)]"
                >
                  <ConnectorMark connector={connector} />
                  <span className="min-w-0 truncate text-sm text-fg">
                    {connector.name}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </Drawer>
  );
}

export function IntegrationsPage() {
  const loading = usePageLoad();
  const toast = useToast();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const add = (connector: Connector) => {
    setPickerOpen(false);
    setConnections((current) => [
      ...current,
      {
        id: `${connector.id}-${String(current.length + 1)}`,
        connector,
        type: "OAuth",
        scopes: "Read",
      },
    ]);
    toast({ title: `${connector.name} connected` });
  };

  // Absence of data and absence of knowledge are different states: while the
  // request is pending the table shows its own shape, and only a settled empty
  // result is allowed to say there is nothing here.
  const empty = !loading && connections.length === 0;

  return (
    <Page className="max-w-[1140px]">
      <TopBarActions>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setPickerOpen(true)}
        >
          Add connection
        </Button>
      </TopBarActions>

      <Card>
        <CardHeader
          title="Connections"
          description="Manage the connections available to Review, Slack, and Discord."
        />
      </Card>

      {empty ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-fg">No connections yet</p>
          <p className="mt-1.5 text-sm text-fg-subtle">
            Connect your tools to let the agent access external services.
          </p>
          <Button
            className="mt-5"
            size="sm"
            variant="secondary"
            onClick={() => setPickerOpen(true)}
          >
            Add connection
          </Button>
        </div>
      ) : (
        <TableShell className="mt-4">
          <Table>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <Th key={column}>{column}</Th>
                ))}
              </tr>
            </thead>
            {loading ? (
              <LoadingRows />
            ) : (
              <tbody>
                {connections.map((connection) => (
                  <Tr key={connection.id}>
                    <Td>
                      <span className="text-fg">{connection.connector.name}</span>
                    </Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <ConnectorMark connector={connection.connector} />
                        <span className="truncate">
                          {connection.connector.name}
                        </span>
                      </span>
                    </Td>
                    <Td>{connection.type}</Td>
                    <Td>{connection.scopes}</Td>
                  </Tr>
                ))}
              </tbody>
            )}
          </Table>
        </TableShell>
      )}

      <AddConnectionDrawer
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={add}
      />
    </Page>
  );
}
