import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Settings, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, SearchInput } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Avatar, Pagination } from "@/components/ui/Misc";
import { RadioFilterChip } from "@/components/ui/RadioFilterChip";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page } from "@/components/layout/PageHeader";
import { CacheStatus } from "@/components/layout/CacheStatus";
import { TopBarActions } from "@/components/layout/TopBar";
import { TableSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { teamMembers, type TeamMember } from "@/data/account";
import { cn } from "@/lib/utils";

const userFilters = ["All", "Assigned users", "Unassigned users"];
const roleFilters = ["All", "Admin", "Member"];
const typeFilters = ["All Active", "Users", "Bots", "Non-Org Users", "Archived"];

const typeForFilter: Record<string, TeamMember["type"]> = {
  Users: "User",
  Bots: "Bot",
  "Non-Org Users": "Non-Org User",
  Archived: "Archived",
};

const optionalColumns = [
  { id: "type", label: "Type" },
  { id: "email", label: "Email" },
  { id: "lastActive", label: "Last active" },
] as const;

type ColumnId = (typeof optionalColumns)[number]["id"];

export function TeamPage() {
  const loading = usePageLoad();
  const [members, setMembers] = useState<TeamMember[]>(teamMembers);
  const [query, setQuery] = useState("");
  const [userFilter, setUserFilter] = useState("All");
  const [roleFilter, setRoleFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All Active");
  const [columns, setColumns] = useState<ColumnId[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [inviting, setInviting] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const toast = useToast();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members.filter((member) => {
      if (typeFilter === "All Active") {
        if (member.type === "Archived") return false;
      } else if (member.type !== typeForFilter[typeFilter]) {
        return false;
      }
      if (userFilter === "Assigned users" && member.team === "Unassigned") return false;
      if (userFilter === "Unassigned users" && member.team !== "Unassigned") return false;
      if (roleFilter !== "All" && member.role !== roleFilter) return false;
      if (!needle) return true;
      return (
        member.handle.toLowerCase().includes(needle) ||
        member.name.toLowerCase().includes(needle) ||
        member.email.toLowerCase().includes(needle)
      );
    });
  }, [members, query, userFilter, roleFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount);
  const visible = rows.slice((current - 1) * pageSize, current * pageSize);
  const shows = (id: ColumnId) => columns.includes(id);
  const columnCount = 3 + columns.length;

  const invite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    const handle = inviteName.trim() || email.split("@")[0];
    setMembers((entries) => [
      ...entries,
      {
        id: `m-${Date.now()}`,
        name: inviteName.trim() || handle,
        handle,
        email,
        role: "Member",
        team: "Unassigned",
        lastActive: "Invited",
        latestPr: "",
        type: "User",
      },
    ]);
    toast({ title: "Invite sent", description: `${email} was invited to shrenil28.` });
    setInviteName("");
    setInviteEmail("");
    setInviting(false);
  };

  return (
    <Page className="max-w-5xl">
      <TopBarActions>
        <CacheStatus />
      </TopBarActions>

      <div className="flex flex-wrap items-center gap-2 pt-6">
        <SearchInput
          placeholder="Search users..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          wrapperClassName="w-full max-w-[230px]"
        />
        <RadioFilterChip
          label="User"
          options={userFilters}
          value={userFilter}
          onChange={(next) => {
            setUserFilter(next);
            setPage(1);
          }}
        />
        <RadioFilterChip
          label="Role"
          options={roleFilters}
          value={roleFilter}
          onChange={(next) => {
            setRoleFilter(next);
            setPage(1);
          }}
        />
        <RadioFilterChip
          label="Type"
          options={typeFilters}
          value={typeFilter}
          onChange={(next) => {
            setTypeFilter(next);
            setPage(1);
          }}
        />

        <Button
          variant="secondary"
          icon={<UserPlus className="h-3.5 w-3.5" />}
          onClick={() => setInviting(true)}
        >
          Invite member
        </Button>

        <Popover
          align="end"
          panelClassName="w-[190px]"
          trigger={({ toggle }) => (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Table settings"
              onClick={toggle}
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        >
          <>
            <p className="px-2 py-1.5 text-2xs uppercase tracking-[0.08em] text-fg-faint">
              Extra columns
            </p>
            {optionalColumns.map((column) => (
              <MenuItem
                key={column.id}
                selected={shows(column.id)}
                onClick={() =>
                  setColumns((entries) =>
                    entries.includes(column.id)
                      ? entries.filter((entry) => entry !== column.id)
                      : [...entries, column.id],
                  )
                }
              >
                {column.label}
              </MenuItem>
            ))}
          </>
        </Popover>
      </div>

      {loading ? (
        <div className="mt-4">
          <TableSkeleton rows={4} />
        </div>
      ) : (
        <div className="mt-4">
          <TableShell>
            <Table>
              <thead>
                <tr>
                  <Th>Username</Th>
                  {shows("email") && <Th>Email</Th>}
                  {shows("type") && <Th>Type</Th>}
                  <Th>Latest Acalys PR</Th>
                  {shows("lastActive") && <Th>Last active</Th>}
                  <Th>Role</Th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <TableEmpty colSpan={columnCount}>
                    No users match those filters.
                  </TableEmpty>
                ) : (
                  visible.map((member) => (
                    <Tr key={member.id}>
                      <Td>
                        <span className="flex items-center gap-2.5">
                          <Avatar
                            src={member.avatarUrl}
                            name={member.name}
                            size={22}
                          />
                          <span className="truncate font-medium text-fg">
                            {member.handle}
                          </span>
                        </span>
                      </Td>
                      {shows("email") && (
                        <Td className="text-fg-subtle">{member.email}</Td>
                      )}
                      {shows("type") && (
                        <Td
                          className={cn(
                            member.type === "Archived" && "text-fg-faint",
                          )}
                        >
                          {member.type}
                        </Td>
                      )}
                      <Td className={member.latestPr ? undefined : "text-fg-subtle"}>
                        {member.latestPr || "Never"}
                      </Td>
                      {shows("lastActive") && (
                        <Td className="text-fg-subtle">{member.lastActive}</Td>
                      )}
                      <Td>
                        <Popover
                          panelClassName="w-[180px]"
                          trigger={({ toggle }) => (
                            <button
                              type="button"
                              onClick={toggle}
                              className="rounded px-1.5 py-0.5 text-fg transition-colors hover:bg-[var(--cr-hover)]"
                            >
                              {member.role}
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              {(["Admin", "Member"] as const).map((role) => (
                                <MenuItem
                                  key={role}
                                  selected={member.role === role}
                                  onClick={() => {
                                    setMembers((entries) =>
                                      entries.map((entry) =>
                                        entry.id === member.id
                                          ? { ...entry, role }
                                          : entry,
                                      ),
                                    );
                                    close();
                                  }}
                                >
                                  {role}
                                </MenuItem>
                              ))}
                              <MenuItem
                                tone="danger"
                                onClick={() => {
                                  setMembers((entries) =>
                                    entries.filter((entry) => entry.id !== member.id),
                                  );
                                  close();
                                }}
                              >
                                Remove from organization
                              </MenuItem>
                            </>
                          )}
                        </Popover>
                      </Td>
                    </Tr>
                  ))
                )}
              </tbody>
            </Table>
          </TableShell>

          <div className="mt-3 flex">
            <Pagination
              detached
              page={current}
              pageCount={pageCount}
              pageSize={pageSize}
              total={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </div>
        </div>
      )}

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite member"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={invite}
              disabled={!inviteEmail.trim()}
            >
              Send invite
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-fg-muted">
            If you want to invite someone who is not part of the organization in your
            git provider (GitHub / GitLab / Azure DevOps), you can invite them using
            their email address. They will receive an email and can sign in on{" "}
            <Link to="/login" className="text-brand hover:underline">
              this page
            </Link>
            .
          </p>
          <Field label="Full name">
            <Input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="Enter full name"
              wrapperClassName="h-9"
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@example.com"
              wrapperClassName="h-9"
            />
          </Field>
        </div>
      </Modal>
    </Page>
  );
}
