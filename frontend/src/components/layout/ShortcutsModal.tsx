import { Modal } from "@/components/ui/Modal";

const groups = [
  {
    title: "General",
    items: [
      { keys: ["⌘", "K"], label: "Open search" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["Esc"], label: "Close dialog or menu" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["G", "E"], label: "Go to Explore" },
      { keys: ["G", "D"], label: "Go to Dashboard" },
      { keys: ["G", "R"], label: "Go to Repositories" },
      { keys: ["G", "T"], label: "Go to Triage" },
      { keys: ["G", "S"], label: "Go to Security" },
    ],
  },
  {
    title: "Search results",
    items: [
      { keys: ["↑", "↓"], label: "Move between results" },
      { keys: ["↵"], label: "Open the highlighted result" },
    ],
  },
];

export function ShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-faint">
              {group.title}
            </h3>
            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-fg-muted">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.keys.map((key) => (
                      <kbd
                        key={key}
                        className="min-w-[22px] rounded border border-line bg-canvas px-1.5 py-0.5 text-center font-mono text-2xs text-fg-muted"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
