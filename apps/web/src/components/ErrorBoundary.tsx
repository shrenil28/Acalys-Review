import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * Contains a render failure to the subtree it wraps, so one broken widget
 * degrades in place instead of blanking the page. `resetKey` clears the error
 * when the surrounding context changes (navigating to another route).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string; compact?: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Contained render error:", error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const retry = () => this.setState({ error: null });

    if (this.props.compact)
      return (
        <button
          type="button"
          onClick={retry}
          title={error.message}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-fg-subtle transition-colors hover:text-fg"
        >
          <TriangleAlert className="h-3.5 w-3.5 text-warn" />
          {this.props.label ?? "Failed to load"}
          <RotateCcw className="h-3 w-3" />
        </button>
      );

    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line px-6 py-12 text-center">
        <TriangleAlert className="h-6 w-6 text-warn" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-fg">
            {this.props.label ?? "This section could not be shown"}
          </p>
          <p className="mx-auto max-w-md text-xs leading-relaxed text-fg-subtle">
            The rest of the page is unaffected. Try again, or move on and come
            back to it.
          </p>
        </div>
        <pre className="max-w-full overflow-x-auto rounded border border-line bg-canvas px-2.5 py-1.5 font-mono text-2xs text-fg-muted">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Try again
        </button>
      </div>
    );
  }
}
