import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { FeedbackButton } from "@/components/layout/SecurityBanner";
import { TopBarActions } from "@/components/layout/TopBar";
import { securityActivity } from "@/data/security";

const outcomeTone = {
  Success: "success",
  Failed: "danger",
  Skipped: "neutral",
} as const;

const actors = ["All", ...new Set(securityActivity.map((event) => event.actor))];
const actions = ["All", ...new Set(securityActivity.map((event) => event.action))];

export function SecurityActivityLog() {
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState("All");
  const [action, setAction] = useState("All");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return securityActivity.filter((event) => {
      if (actor !== "All" && event.actor !== actor) return false;
      if (action !== "All" && event.action !== action) return false;
      if (!needle) return true;
      return (
        event.target.toLowerCase().includes(needle) ||
        event.detail.toLowerCase().includes(needle) ||
        event.action.toLowerCase().includes(needle)
      );
    });
  }, [query, actor, action]);

  return (
    <Page>
      <TopBarActions>
        <FeedbackButton />
        <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />}>
          Export
        </Button>
      </TopBarActions>

      <PageHeader
        title="Activity Log"
        description="Every scan, status change, and security action taken in this organization."
      />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search activity..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="w-full max-w-xs"
        />
        <FilterSelect label="Actor" value={actor} options={actors} onChange={setActor} />
        <FilterSelect
          label="Action"
          value={action}
          options={actions}
          onChange={setAction}
        />
      </div>

      <div className="mt-3">
        <TableShell>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Outcome</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={6}>No activity matches those filters.</TableEmpty>
              ) : (
                rows.map((event) => (
                  <Tr key={event.id}>
                    <Td className="whitespace-nowrap font-mono text-xs">
                      {new Date(event.at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Td>
                    <Td>{event.actor}</Td>
                    <Td className="font-medium text-fg">{event.action}</Td>
                    <Td className="font-mono text-xs">{event.target}</Td>
                    <Td>
                      <Badge tone={outcomeTone[event.outcome]} dot>
                        {event.outcome}
                      </Badge>
                    </Td>
                    <Td className="max-w-md">{event.detail}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </TableShell>
      </div>
    </Page>
  );
}
