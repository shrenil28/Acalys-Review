import { useMemo, useState } from "react";
import { Panel } from "@/components/charts/Panel";
import { TableSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { Badge, severityTone } from "@/components/ui/Badge";
import { SearchInput } from "@/components/ui/Input";
import { Table, TableEmpty, Td, Th, Tr } from "@/components/ui/Table";
import { activeUserDetails, pullRequestDetails } from "@/data/analytics";
import { formatNumber } from "@/lib/utils";

const stateTone = {
  Open: "info",
  Merged: "purple",
  Draft: "neutral",
  Closed: "neutral",
} as const;

export function DataMetrics() {
  const loading = usePageLoad();
  const [userQuery, setUserQuery] = useState("");
  const [prQuery, setPrQuery] = useState("");

  const users = useMemo(() => {
    const needle = userQuery.trim().toLowerCase();
    if (!needle) return activeUserDetails;
    return activeUserDetails.filter(
      (row) =>
        row.user.toLowerCase().includes(needle) ||
        row.team.toLowerCase().includes(needle),
    );
  }, [userQuery]);

  const prs = useMemo(() => {
    const needle = prQuery.trim().toLowerCase();
    if (!needle) return pullRequestDetails;
    return pullRequestDetails.filter(
      (row) =>
        row.title.toLowerCase().includes(needle) ||
        row.repo.toLowerCase().includes(needle) ||
        row.author.toLowerCase().includes(needle) ||
        String(row.number).includes(needle),
    );
  }, [prQuery]);


  if (loading) return <TableSkeleton filters={1} rows={8} columns={4} />;

  return (
    <div className="space-y-3">
      <Panel
        title="Active User Details"
        actions={
          <SearchInput
            placeholder="Filter users"
            value={userQuery}
            onChange={(event) => setUserQuery(event.target.value)}
            wrapperClassName="h-7 w-44"
          />
        }
        bodyClassName="px-0 pb-0"
      >
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">User</Th>
                <Th>Team</Th>
                <Th align="right">Reviews</Th>
                <Th align="right">Comments</Th>
                <Th align="right">Accepted</Th>
                <Th align="right">Chat sessions</Th>
                <Th align="right" className="pr-4">
                  Last active
                </Th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <TableEmpty colSpan={7}>No users match that filter.</TableEmpty>
              ) : (
                users.map((row) => (
                  <Tr key={row.user}>
                    <Td className="pl-4 font-medium text-fg">{row.user}</Td>
                    <Td>{row.team}</Td>
                    <Td align="right" className="tabular-nums">
                      {row.reviews}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatNumber(row.comments)}
                    </Td>
                    <Td align="right" className="tabular-nums text-ok">
                      {row.accepted}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {row.chatSessions}
                    </Td>
                    <Td align="right" className="pr-4 text-fg-subtle">
                      {row.lastActive}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </div>
      </Panel>

      <Panel
        title="Pull Request Details"
        actions={
          <SearchInput
            placeholder="Filter pull requests"
            value={prQuery}
            onChange={(event) => setPrQuery(event.target.value)}
            wrapperClassName="h-7 w-52"
          />
        }
        bodyClassName="px-0 pb-0"
      >
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th className="pl-4">Pull request</Th>
                <Th>Repo</Th>
                <Th>Author</Th>
                <Th>State</Th>
                <Th align="right">Comments</Th>
                <Th>Max severity</Th>
                <Th align="right">Time to merge</Th>
                <Th align="right" className="pr-4">
                  Updated
                </Th>
              </tr>
            </thead>
            <tbody>
              {prs.length === 0 ? (
                <TableEmpty colSpan={8}>
                  No pull requests match that filter.
                </TableEmpty>
              ) : (
                prs.map((row) => (
                  <Tr key={`${row.repo}-${row.number}`}>
                    <Td className="pl-4">
                      <span className="font-mono text-xs text-fg-subtle">
                        #{row.number}
                      </span>{" "}
                      <span className="font-medium text-fg">{row.title}</span>
                    </Td>
                    <Td className="font-mono text-xs">{row.repo}</Td>
                    <Td>{row.author}</Td>
                    <Td>
                      <Badge tone={stateTone[row.state]}>{row.state}</Badge>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {row.comments}
                    </Td>
                    <Td>
                      <Badge tone={severityTone[row.severityMax]}>
                        {row.severityMax}
                      </Badge>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {row.timeToMergeHours ? `${row.timeToMergeHours}h` : "—"}
                    </Td>
                    <Td align="right" className="pr-4 text-fg-subtle">
                      {row.updatedAt}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
