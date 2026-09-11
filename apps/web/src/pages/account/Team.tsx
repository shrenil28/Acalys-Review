import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Copy, UserPlus } from "lucide-react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Field, Input, SearchInput } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Table, TableEmpty, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useDashboardSession } from "@/components/auth/DashboardSessionGate";
import {
  cancelDashboardInvitation,
  createDashboardInvitation,
  loadDashboardInvitations,
  loadDashboardMembers,
  removeDashboardMember,
  updateDashboardMemberRole,
  updateDashboardMemberAnalyticsTeam,
  type DashboardInvitationView,
  type DashboardMemberView,
} from "@/lib/api/dashboardAdmin";
import { resolveDataConfig } from "@/lib/api/config";

const FixtureTeam = lazy(() => import("./TeamFixture").then((module) => ({ default: module.TeamPage })));
const roles = ["owner", "admin", "member", "read_only"] as const;
const labelRole = (role: string) => role === "read_only" ? "Read only" : role[0]!.toUpperCase() + role.slice(1);

export function TeamPage() {
  const config = resolveDataConfig();
  if (config.kind === "fixtures") return <Suspense fallback={null}><FixtureTeam /></Suspense>;
  if (config.kind === "misconfigured") return <Page className="max-w-5xl"><LiveMisconfiguredState detail={config.detail} /></Page>;
  return <LiveTeam />;
}

function LiveTeam() {
  const session = useDashboardSession();
  const [members, setMembers] = useState<readonly DashboardMemberView[]>([]);
  const [invitations, setInvitations] = useState<readonly DashboardInvitationView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<typeof roles[number]>("member");
  const [issuedLink, setIssuedLink] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const toast = useToast();
  const canAdmin = session?.role === "owner" || session?.role === "admin";

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadDashboardMembers(controller.signal),
      canAdmin ? loadDashboardInvitations(controller.signal) : Promise.resolve(null),
    ]).then(([memberResult, invitationResult]) => {
      if (controller.signal.aborted) return;
      if (memberResult.kind !== "ok") { setState("failed"); return; }
      setMembers(memberResult.value.items);
      if (invitationResult?.kind === "ok") setInvitations(invitationResult.value.items);
      setState("ready");
    });
    return () => controller.abort();
  }, [canAdmin]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter((member) => [member.displayName ?? "", member.email ?? "", member.providerUserId, member.role].some((value) => value.toLowerCase().includes(needle)));
  }, [members, query]);

  const changeRole = async (member: DashboardMemberView, role: typeof roles[number]) => {
    setSaving(member.id);
    const result = await updateDashboardMemberRole(member.id, role);
    setSaving(null);
    if (result.kind === "ok") {
      setMembers((current) => current.map((entry) => entry.id === member.id ? result.value : entry));
      toast({ title: "Member role updated", description: `${member.displayName ?? member.email ?? member.providerUserId} is now ${labelRole(role)}.` });
    } else toast({ title: "Role change rejected", description: result.kind === "rejected" && result.status === 409 ? "The final organization owner cannot be demoted." : "Acalys could not apply that role change." });
  };

  const changeAnalyticsTeam = async (member: DashboardMemberView, raw: string) => {
    const team = raw.trim() === "" ? null : raw.trim();
    if (team === member.analyticsTeam) return;
    setSaving(member.id);
    const result = await updateDashboardMemberAnalyticsTeam(member.id, team);
    setSaving(null);
    if (result.kind === "ok") {
      setMembers((current) => current.map((entry) => entry.id === member.id ? result.value : entry));
      toast({ title: "Analytics team updated", description: team === null ? "Removed this member from the analytics team dimension." : `Analytics now groups this member under ${team}.` });
    } else toast({ title: "Team label rejected", description: "Acalys could not update that analytics team label." });
  };

  const removeMember = async (member: DashboardMemberView) => {
    setSaving(member.id);
    const result = await removeDashboardMember(member.id);
    setSaving(null);
    if (result.kind !== "ok") {
      toast({ title: "Member removal rejected", description: result.kind === "rejected" && result.status === 409 ? "The final organization owner cannot be removed." : "Acalys could not remove that membership." });
      return;
    }
    setMembers((current) => current.filter((entry) => entry.id !== member.id));
    toast({
      title: "Member removed",
      description: `Revoked ${result.value.revokedSessions} live session${result.value.revokedSessions === 1 ? "" : "s"} and ${result.value.revokedApiKeys} user API key${result.value.revokedApiKeys === 1 ? "" : "s"}.`,
    });
  };

  const createInvite = async () => {
    setInviteBusy(true);
    const result = await createDashboardInvitation(inviteEmail, inviteRole);
    setInviteBusy(false);
    if (result.kind !== "ok") {
      toast({ title: "Invitation not created", description: "Acalys could not issue that invitation capability." });
      return;
    }
    setInvitations((current) => [result.value.invitation, ...current.filter((entry) => entry.email.toLowerCase() !== result.value.invitation.email.toLowerCase())]);
    setIssuedLink(`${window.location.origin}/login?invite=${encodeURIComponent(result.value.token)}`);
  };

  const cancelInvite = async (invitation: DashboardInvitationView) => {
    setSaving(invitation.id);
    const result = await cancelDashboardInvitation(invitation.id);
    setSaving(null);
    if (result.kind === "ok") {
      setInvitations((current) => current.filter((entry) => entry.id !== invitation.id));
      toast({ title: "Invitation cancelled", description: `${invitation.email} can no longer redeem that invite.` });
    } else toast({ title: "Cancellation rejected", description: "Acalys could not cancel that invitation." });
  };

  const closeInvite = () => {
    setInviting(false);
    setInviteEmail("");
    setInviteRole("member");
    // The raw bearer capability is intentionally forgotten when the modal closes.
    setIssuedLink(null);
  };

  return (
    <Page className="max-w-5xl">
      <PageHeader title="Team" description="Live organization memberships, explicit invitations, and role-based access." />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search members…" value={query} onChange={(event) => setQuery(event.target.value)} wrapperClassName="w-full max-w-[260px]" />
        {canAdmin && <Button variant="secondary" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => setInviting(true)}>Invite member</Button>}
      </div>
      <div className="mt-4">
        {state === "loading" ? <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Loading live members…</div> : state === "failed" ? <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">Acalys could not load organization members.</div> : (
          <TableShell><Table><thead><tr><Th>User</Th><Th>Email</Th><Th>Provider</Th><Th>Role</Th><Th>Analytics team</Th><Th>Access</Th></tr></thead><tbody>
            {rows.length === 0 ? <TableEmpty colSpan={6}>No members match this search.</TableEmpty> : rows.map((member) => <Tr key={member.id}>
              <Td className="font-medium text-fg">{member.displayName ?? member.providerUserId}</Td>
              <Td className="text-fg-subtle">{member.email ?? "—"}</Td>
              <Td className="text-fg-subtle">{member.provider}</Td>
              <Td>{canAdmin ? <Popover panelClassName="w-[190px]" trigger={({ toggle }) => <button type="button" disabled={saving === member.id} onClick={toggle} className="rounded px-1.5 py-0.5 text-fg hover:bg-[var(--cr-hover)] disabled:opacity-50">{labelRole(member.role)}</button>}>
                {(close) => <>{roles.filter((role) => session?.role === "owner" || role !== "owner").map((role) => <MenuItem key={role} selected={member.role === role} onClick={() => { close(); void changeRole(member, role); }}>{labelRole(role)}</MenuItem>)}<MenuItem tone="danger" onClick={() => { close(); void removeMember(member); }}>Remove from organization</MenuItem></>}
              </Popover> : labelRole(member.role)}</Td>
              <Td>{canAdmin ? <Input key={`${member.id}:${member.analyticsTeam ?? ""}`} defaultValue={member.analyticsTeam ?? ""} disabled={saving === member.id} placeholder="Unassigned" wrapperClassName="w-[150px] h-8" onBlur={(event) => void changeAnalyticsTeam(member, event.currentTarget.value)} /> : <span className="text-fg-subtle">{member.analyticsTeam ?? "—"}</span>}</Td>
              <Td className="text-fg-subtle">Membership-bound</Td>
            </Tr>)}
          </tbody></Table></TableShell>
        )}
      </div>

      {canAdmin && state === "ready" && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-fg">Pending invitations</h2>
          <p className="mt-1 text-xs text-fg-subtle">Only metadata is stored here. Raw invitation capabilities are shown once when created.</p>
          <div className="mt-3"><TableShell><Table><thead><tr><Th>Email</Th><Th>Role</Th><Th>Expires</Th><Th>Action</Th></tr></thead><tbody>
            {invitations.length === 0 ? <TableEmpty colSpan={4}>No pending invitations.</TableEmpty> : invitations.map((invitation) => <Tr key={invitation.id}>
              <Td className="font-medium text-fg">{invitation.email}</Td><Td>{labelRole(invitation.role)}</Td><Td className="text-fg-subtle">{new Date(invitation.expiresAt).toLocaleString()}</Td>
              <Td><Button size="xs" variant="danger" disabled={saving === invitation.id} onClick={() => void cancelInvite(invitation)}>Cancel</Button></Td>
            </Tr>)}
          </tbody></Table></TableShell></div>
        </div>
      )}

      <Modal
        open={inviting}
        onClose={closeInvite}
        title={issuedLink === null ? "Invite member" : "Invitation created"}
        size="sm"
        footer={issuedLink === null ? <><Button variant="ghost" onClick={closeInvite}>Cancel</Button><Button variant="secondary" disabled={inviteBusy || !inviteEmail.trim()} onClick={() => void createInvite()}>{inviteBusy ? "Creating…" : "Create invite link"}</Button></> : <Button variant="secondary" onClick={closeInvite}>Done</Button>}
      >
        {issuedLink === null ? <div className="space-y-4">
          <p className="text-sm leading-relaxed text-fg-muted">The recipient must sign in with a provider account that reports this email as verified. Acalys does not implicitly link accounts by email.</p>
          <Field label="Email"><Input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" wrapperClassName="h-9" /></Field>
          <Field label="Role"><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof roles[number])} className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg">
            {roles.filter((role) => session?.role === "owner" || role !== "owner").map((role) => <option key={role} value={role}>{labelRole(role)}</option>)}
          </select></Field>
        </div> : <div className="space-y-3">
          <p className="text-sm leading-relaxed text-fg-muted">Copy this link now. The bearer capability is not stored in recoverable form and will not be shown again.</p>
          <div className="flex gap-2"><Input readOnly value={issuedLink} wrapperClassName="min-w-0 flex-1 h-9" /><Button size="icon" variant="secondary" aria-label="Copy invitation link" onClick={() => void navigator.clipboard.writeText(issuedLink)}><Copy className="h-4 w-4" /></Button></div>
        </div>}
      </Modal>
    </Page>
  );
}
