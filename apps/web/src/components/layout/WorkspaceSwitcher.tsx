import { lazy, Suspense } from "react";
import { Check, ChevronsUpDown, PanelLeftClose, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/Misc";
import { Button } from "@/components/ui/Button";
import { MenuLabel, MenuSeparator, Popover } from "@/components/ui/Menu";
import { GitHubIcon, GitLabIcon } from "@/components/icons";
import { useDashboardSession } from "@/components/auth/DashboardSessionGate";
import { resolveDataMode } from "@/lib/api/config";

const FixtureWorkspaceSwitcher = lazy(() => import("./WorkspaceSwitcherFixture").then((module) => ({ default: module.WorkspaceSwitcher })));
export function WorkspaceSwitcher({ onCollapse }: { onCollapse: () => void }) {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={null}><FixtureWorkspaceSwitcher onCollapse={onCollapse} /></Suspense>;
  if (mode.kind === "misconfigured") return null;
  return <LiveWorkspaceSwitcher onCollapse={onCollapse} />;
}
function LiveWorkspaceSwitcher({ onCollapse }: { onCollapse: () => void }) {
  const session = useDashboardSession();
  if (session === null) return null;
  const ProviderIcon = session.user.provider.toLowerCase() === "gitlab" ? GitLabIcon : GitHubIcon;
  return <div className="flex items-center gap-1 px-2 pt-2">
    <Popover className="min-w-0 flex-1" panelClassName="w-[248px]" trigger={({ open, toggle }) => <button type="button" onClick={toggle} className={`flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-[var(--cr-hover)] ${open ? "bg-[var(--cr-hover)]" : ""}`}><Avatar src="" name={session.organization.name} size={22} /><span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{session.organization.name}</span><ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" /></button>}>
      {(close) => <><MenuLabel>Organizations</MenuLabel><button type="button" onClick={close} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"><Avatar src="" name={session.organization.name} size={20} /><span className="min-w-0 flex-1 truncate">{session.organization.name}</span><ProviderIcon className="h-3 w-3 text-fg-faint" /><Check className="h-3.5 w-3.5 text-brand" /></button><MenuSeparator /><div className="flex items-center gap-2 px-2 py-1.5 text-sm text-fg-faint"><Plus className="h-3.5 w-3.5" /><span>Additional organizations are not available in this session.</span></div></>}
    </Popover>
    <Button size="icon-sm" variant="ghost" aria-label="Collapse sidebar" onClick={onCollapse}><PanelLeftClose className="h-4 w-4" /></Button>
  </div>;
}
