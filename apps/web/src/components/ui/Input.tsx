import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, icon, wrapperClassName, ...props }, ref) => (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-2.5 transition-colors focus-within:border-line-strong",
        wrapperClassName,
      )}
    >
      {icon && <span className="shrink-0 text-fg-subtle">{icon}</span>}
      <input
        ref={ref}
        className={cn(
          "w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle",
          className,
        )}
        {...props}
      />
    </div>
  ),
);
Input.displayName = "Input";

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(
  (props, ref) => (
    <Input ref={ref} icon={<Search className="h-3.5 w-3.5" />} type="search" {...props} />
  ),
);
SearchInput.displayName = "SearchInput";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-md border border-line bg-canvas px-2.5 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-line-strong",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
    </label>
  );
}
