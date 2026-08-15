import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserRound,
} from "lucide-react";
import { Avatar } from "@/components/ui/Misc";
import { Popover } from "@/components/ui/Menu";
import { currentUser, workspaces } from "@/lib/session";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const themes: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light theme" },
  { value: "dark", icon: Moon, label: "Dark theme" },
  { value: "system", icon: Monitor, label: "System theme" },
];

function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("cr:theme", theme);
}

export function UserMenu({ collapsed }: { collapsed?: boolean } = {}) {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("cr:theme") as Theme) ?? "dark",
  );

  return (
    <div className={cn(collapsed ? "p-2" : "border-t border-line p-2")}>
      <Popover
        panelClassName={cn(
          "bottom-full mb-1 mt-0 w-[268px] p-0 overflow-hidden",
          // In the rail the panel opens beside the avatar rather than over it.
          collapsed && "left-full bottom-0 ml-1 mb-0",
        )}
        trigger={({ open, toggle }) =>
          collapsed ? (
            <button
              type="button"
              onClick={toggle}
              aria-label="Account menu"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--cr-hover)]",
                open && "bg-[var(--cr-hover)]",
              )}
            >
              <Avatar src={currentUser.avatarUrl} name={currentUser.name} size={24} />
            </button>
          ) : (
            <button
              type="button"
              onClick={toggle}
              className={cn(
                "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-[var(--cr-hover)]",
                open && "bg-[var(--cr-hover)]",
              )}
            >
              <Avatar src={currentUser.avatarUrl} name={currentUser.name} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-fg">
                  {currentUser.name}
                </span>
                <span className="block text-2xs text-fg-subtle">
                  {currentUser.role}
                </span>
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            </button>
          )
        }
      >
        {(close) => (
          <>
            <div className="flex items-center gap-2.5 px-3 py-3">
              <Avatar src={currentUser.avatarUrl} name={currentUser.name} size={34} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg">
                  {currentUser.name}
                </p>
                <p className="truncate text-xs text-fg-subtle">
                  {workspaces[0].name}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
              <span className="text-sm text-fg-muted">Theme</span>
              <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
                {themes.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    aria-label={entry.label}
                    aria-pressed={theme === entry.value}
                    onClick={() => {
                      setTheme(entry.value);
                      applyTheme(entry.value);
                    }}
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded transition-colors",
                      theme === entry.value
                        ? "bg-[var(--cr-active)] text-fg"
                        : "text-fg-subtle hover:text-fg",
                    )}
                  >
                    <entry.icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-line p-1">
              <MenuRow
                icon={<UserRound className="h-4 w-4" />}
                onClick={() => {
                  navigate("/settings");
                  close();
                }}
              >
                Profile Settings
              </MenuRow>
              <MenuRow
                icon={<ExternalLink className="h-4 w-4" />}
                onClick={close}
              >
                Refer and Earn
              </MenuRow>
              <MenuRow
                icon={<LogOut className="h-4 w-4" />}
                onClick={() => {
                  navigate("/login");
                  close();
                }}
              >
                Log out
              </MenuRow>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}

function MenuRow({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded px-2 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
    >
      <span className="shrink-0 text-fg-subtle">{icon}</span>
      {children}
    </button>
  );
}
