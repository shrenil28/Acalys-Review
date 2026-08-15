import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarNav } from "./SidebarNav";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** Search sits in the nav list itself, styled like any other row. */
function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="px-2 pb-0.5 pt-2">
      <button
        type="button"
        onClick={onOpen}
        className="group flex h-8 w-full items-center gap-2 rounded px-2 text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded border border-line px-1 font-mono text-2xs text-fg-faint opacity-0 transition-opacity group-hover:opacity-100">
          ⌘K
        </kbd>
      </button>
    </div>
  );
}

export function Sidebar({
  onCollapse,
  onSearch,
  className,
}: {
  onCollapse: () => void;
  onSearch: () => void;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex w-[248px] shrink-0 flex-col bg-shell",
        className,
      )}
    >
      <WorkspaceSwitcher onCollapse={onCollapse} />
      <SearchTrigger onOpen={onSearch} />
      <SidebarNav />
      <UserMenu />
    </aside>
  );
}
