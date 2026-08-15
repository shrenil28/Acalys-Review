import { useState } from "react";
import { Check, ChevronsUpDown, PanelLeftClose, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/Misc";
import { Button } from "@/components/ui/Button";
import { MenuLabel, MenuSeparator, Popover } from "@/components/ui/Menu";
import { GitHubIcon, GitLabIcon } from "@/components/icons";
import { workspaces } from "@/lib/session";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher({ onCollapse }: { onCollapse: () => void }) {
  const [active, setActive] = useState(workspaces[0]);

  return (
    <div className="flex items-center gap-1 px-2 pt-2">
      <Popover
        className="min-w-0 flex-1"
        panelClassName="w-[248px]"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-[var(--cr-hover)]",
              open && "bg-[var(--cr-hover)]",
            )}
          >
            <Avatar src={active.avatarUrl} name={active.name} size={22} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {active.name}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>Organizations</MenuLabel>
            {workspaces.map((workspace) => {
              const ProviderIcon =
                workspace.provider === "gitlab" ? GitLabIcon : GitHubIcon;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => {
                    setActive(workspace);
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
                >
                  <Avatar src={workspace.avatarUrl} name={workspace.name} size={20} />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <ProviderIcon className="h-3 w-3 text-fg-faint" />
                  {workspace.id === active.id && (
                    <Check className="h-3.5 w-3.5 text-brand" />
                  )}
                </button>
              );
            })}
            <MenuSeparator />
            <button
              type="button"
              onClick={close}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" />
              Add organization
            </button>
          </>
        )}
      </Popover>

      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Collapse sidebar"
        onClick={onCollapse}
      >
        <PanelLeftClose className="h-4 w-4" />
      </Button>
    </div>
  );
}
