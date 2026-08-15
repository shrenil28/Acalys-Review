import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import type { PathInstruction } from "@/data/orgSettings";

/**
 * The dotted "No items" placeholder the app shows for every list-shaped
 * setting before anything has been added.
 */
export function NoItems({
  onCreate,
  label = "Create item",
  title = "No items",
  description = "You haven't created any items yet.",
}: {
  onCreate: () => void;
  label?: string;
  title?: string;
  description?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-md border border-line px-4 py-10 text-center"
      style={{
        backgroundImage:
          "radial-gradient(var(--cr-line) 1px, transparent 1px)",
        backgroundSize: "10px 10px",
      }}
    >
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="text-xs text-fg-subtle">{description}</p>
      <Button variant="secondary" size="sm" className="mt-3" onClick={onCreate}>
        {label}
      </Button>
    </div>
  );
}

/**
 * Editable list of `path` → `instructions` pairs, used by docstring and unit
 * test generation as well as the review instruction sections.
 */
export function PathInstructionList({
  items,
  onChange,
  placeholderPath = "**/*.ts",
  placeholderInstruction = "Describe what CodeRabbit should do for files matching this path.",
  createLabel = "Create item",
}: {
  items: PathInstruction[];
  onChange: (items: PathInstruction[]) => void;
  placeholderPath?: string;
  placeholderInstruction?: string;
  createLabel?: string;
}) {
  const add = () =>
    onChange([
      ...items,
      { id: `pi-${Date.now()}`, path: "", instructions: "" },
    ]);

  if (items.length === 0) return <NoItems onCreate={add} label={createLabel} />;

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={item.id} className="rounded-md border border-line p-3">
          <div className="flex items-center gap-2">
            <Input
              value={item.path}
              placeholder={placeholderPath}
              className="font-mono text-xs"
              wrapperClassName="max-w-xs"
              onChange={(event) =>
                onChange(
                  items.map((entry, position) =>
                    position === index
                      ? { ...entry, path: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove instruction ${index + 1}`}
              className="ml-auto"
              onClick={() =>
                onChange(items.filter((_, position) => position !== index))
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Textarea
            rows={2}
            className="mt-2"
            value={item.instructions}
            placeholder={placeholderInstruction}
            onChange={(event) =>
              onChange(
                items.map((entry, position) =>
                  position === index
                    ? { ...entry, instructions: event.target.value }
                    : entry,
                ),
              )
            }
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="h-3.5 w-3.5" />}
        onClick={add}
      >
        Add another
      </Button>
    </div>
  );
}
